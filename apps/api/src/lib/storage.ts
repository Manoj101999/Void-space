/**
 * Upload staging area (SRS FR-3.1, FR-8.1, NFR-SEC.3).
 *
 * The API streams an upload straight to a staging path on disk rather than buffering
 * it in memory, then hands the path to the `ipfs-pin` worker. The bytes never enter
 * Postgres — the database only ever holds the resulting CID.
 *
 * Layout: `<STAGING_DIR>/<tenantId>/<versionId>/<sanitized-file-name>`
 *
 * Tenant- and version-scoped directories mean a staged file is attributable to
 * exactly one tenant and version with no lookup, and cleanup can remove a whole
 * tenant's staging area safely.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';

import {
  ALLOWED_ASSET_EXTENSIONS,
  ASSET_MIME_TYPES,
  MAX_ASSET_SIZE_BYTES,
  type AssetExtension,
} from '@void-space/types';

import { ValidationError } from './errors';

export interface StagedFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly extension: AssetExtension;
  /** The name as supplied by the client, sanitised for storage. */
  readonly originalName: string;
}

/** Strips directory parts and anything that is not a safe file-name character. */
export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = base.replace(/^[._]+/, '').slice(0, 120);
  return trimmed.length > 0 ? trimmed : 'upload';
}

export function extensionOf(name: string): string {
  return extname(name).toLowerCase();
}

export function isAllowedExtension(extension: string): extension is AssetExtension {
  return (ALLOWED_ASSET_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * NFR-SEC.3 — the extension alone is not trusted. Some clients report a generic
 * `application/octet-stream` or nothing at all, so the declared type is checked *when
 * present* against the accepted set for that extension.
 */
export function assertMimeAllowed(
  extension: AssetExtension,
  declaredMime: string | undefined,
): void {
  if (!declaredMime || declaredMime === 'application/octet-stream') return;

  const accepted = ASSET_MIME_TYPES[extension];
  const normalised = declaredMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!accepted.includes(normalised)) {
    throw new ValidationError(`A ${extension} file declared as ${normalised} is not accepted`, {
      extension,
      declaredMime: normalised,
      accepted,
    });
  }
}

export interface StorageOptions {
  readonly stagingDir: string;
}

export class StagingStorage {
  private readonly root: string;

  constructor(options: StorageOptions) {
    this.root = resolve(options.stagingDir);
  }

  get rootPath(): string {
    return this.root;
  }

  directoryFor(tenantId: string, versionId: string): string {
    return join(this.root, tenantId, versionId);
  }

  /**
   * Streams a request part to disk, enforcing the 200 MB ceiling (FR-3.1) *while*
   * writing rather than after, so an oversized upload cannot fill the disk first.
   *
   * @throws ValidationError for an unsupported extension, an inconsistent declared
   *         MIME type, an empty body, or a file over the cap.
   */
  async stage(params: {
    readonly tenantId: string;
    readonly versionId: string;
    readonly originalName: string;
    readonly declaredMime: string | undefined;
    readonly source: NodeJS.ReadableStream & { truncated?: boolean };
  }): Promise<StagedFile> {
    const extension = extensionOf(params.originalName);
    if (!isAllowedExtension(extension)) {
      throw new ValidationError(
        `Unsupported file type "${extension || params.originalName}". ` +
          `Allowed: ${ALLOWED_ASSET_EXTENSIONS.join(', ')}`,
        { allowed: ALLOWED_ASSET_EXTENSIONS },
      );
    }
    assertMimeAllowed(extension, params.declaredMime);

    const directory = this.directoryFor(params.tenantId, params.versionId);
    await mkdir(directory, { recursive: true });

    const safeName = sanitizeFileName(params.originalName);
    const target = join(directory, safeName);

    let written = 0;
    const counting = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        written += chunk.length;
        if (written > MAX_ASSET_SIZE_BYTES) {
          callback(
            new ValidationError(
              `File exceeds the ${Math.round(MAX_ASSET_SIZE_BYTES / (1024 * 1024))} MB limit`,
              { maxBytes: MAX_ASSET_SIZE_BYTES },
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(params.source as NodeJS.ReadableStream, counting, createWriteStream(target));
    } catch (error) {
      // Never leave a partial file behind.
      await rm(target, { force: true });
      throw error;
    }

    // `truncated` is set by @fastify/multipart when the stream was cut at its own cap.
    if (params.source.truncated) {
      await rm(target, { force: true });
      throw new ValidationError(
        `File exceeds the ${Math.round(MAX_ASSET_SIZE_BYTES / (1024 * 1024))} MB limit`,
        { maxBytes: MAX_ASSET_SIZE_BYTES },
      );
    }

    const stats = await stat(target);
    if (stats.size === 0) {
      await rm(target, { force: true });
      throw new ValidationError('The uploaded file is empty', {});
    }

    return { path: target, sizeBytes: stats.size, extension, originalName: safeName };
  }

  /** Readable stream for the pin worker (or the Blender runner). */
  open(path: string) {
    return createReadStream(path);
  }

  /** Removes a staged file once it has been pinned or abandoned. */
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Removes the whole per-version directory. */
  async removeVersionDirectory(tenantId: string, versionId: string): Promise<void> {
    await rm(this.directoryFor(tenantId, versionId), { force: true, recursive: true });
  }

  /** True when the path lives under this staging root (defence against traversal). */
  owns(path: string): boolean {
    const resolved = resolve(path);
    return resolved === this.root || resolved.startsWith(`${this.root}/`);
  }
}

/** Removes a staged version directory, tolerating a path outside the staging root. */
export async function discardStagedVersion(
  storage: StagingStorage,
  tenantId: string,
  versionId: string,
  path: string | null,
): Promise<void> {
  if (path && storage.owns(path)) {
    await rm(resolve(path), { force: true });
  }
  await storage.removeVersionDirectory(tenantId, versionId).catch(() => undefined);
}

/** A generated version id, exposed so routes can build the staging path up front. */
export function newVersionId(): string {
  return randomUUID();
}
