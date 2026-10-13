/**
 * Ingest-time thumbnail rendering (FR-5.1 preview images).
 *
 * The preview used to exist only for whoever ran `pnpm assets:thumbnails` by hand, so every asset
 * uploaded after the last run showed the drawn placeholder in the Library — an empty-looking
 * catalogue that no amount of correct API plumbing could fix. The render now runs as part of
 * ingest: `ipfs-pin` has just written the CID, the staged upload is still on disk to draw from,
 * and the card has an image by the time anybody looks at it.
 *
 * Why this spawns a process instead of importing Playwright
 * ---------------------------------------------------------
 * Three reasons, and they are all load-bearing:
 *
 *  1. `@playwright/test` is a root devDependency. The worker's own `node_modules` cannot resolve
 *     it, so importing it would fail at build time. A script that *starts at the repo root* resolves
 *     it the same way `pnpm assets:thumbnails` always has.
 *  2. A render is slow — a 13 MB model over the gateway can take tens of seconds — and it belongs
 *     nowhere near the `ipfs-pin` job that has already succeeded. Fire-and-forget keeps the pin's
 *     latency at what it was and gives the browser its own lifetime, so a render that never returns
 *     cannot hold a worker slot.
 *  3. The containerised worker has no Chromium and no repo tree. `existsSync` on the renderer makes
 *     that a logged no-op rather than a crash: NFR-REL.1 wants graceful degradation, and a missing
 *     preview is cosmetic.
 *
 * Failure is never fatal by construction — nothing here is awaited by the caller, and every error
 * is caught. The card falls back to its drawn figure on a 404, which is the designed behaviour for
 * a render that does not exist yet.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVELY_VIEWABLE_EXTENSIONS, type AssetExtension } from '@void-space/types';
import type { Logger } from 'pino';

import { removeStagedFile } from './staging';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/worker/src/lib` -> repository root. Override for a layout this derivation cannot see. */
const REPO_ROOT = process.env.VOID_SPACE_ROOT
  ? resolve(process.env.VOID_SPACE_ROOT)
  : resolve(HERE, '..', '..', '..', '..');

const RENDER_SCRIPT = join(REPO_ROOT, 'scripts', 'render-thumbnail.mjs');

/**
 * Written where the `/thumbnails/[cid]` route reads from.
 *
 * `THUMBNAIL_DIR` is passed explicitly rather than left to the child's default so that the writer
 * and the reader cannot drift if this process and the web server disagree about their cwd.
 */
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR
  ? resolve(process.env.THUMBNAIL_DIR)
  : join(REPO_ROOT, '.thumbnails');

/** CIDs already being rendered in this process — a retry must not launch a second browser. */
const inFlight = new Set<string>();

/**
 * Every format the render surface can decode — glTF, OBJ, FBX and STL — and therefore every format
 * a real preview image can be generated from. `.blend` is the one accepted upload with no browser
 * decoder; it keeps the drawn fallback rather than being handed to a renderer that would only
 * screenshot the "cannot preview" card.
 */
function isRenderable(format: string | null | undefined): boolean {
  return NATIVELY_VIEWABLE_EXTENSIONS.includes(String(format ?? '').toLowerCase() as AssetExtension);
}

export function thumbnailExists(cid: string): boolean {
  return existsSync(join(THUMBNAIL_DIR, `${cid}.jpg`));
}

/**
 * Renders `.thumbnails/<cid>.jpg` in the background. Returns immediately.
 *
 * `sourcePath` is the staged upload the version was pinned from. When it is still on disk the
 * render is fed from those bytes rather than fetched back through the gateway: they are local, they
 * are content-addressed by this very CID, and the minutes right after an ingest are exactly when
 * the Kubo node is busiest serving the object that was written to it moments earlier — that race is
 * what used to fail a first attempt and turn a preview that should take seconds into one that took
 * two, once the retry backoff had had its say.
 *
 * Handing the file over is what the return value is for:
 *
 *   - `true`  — a render was launched **and given the file**. The caller must leave it alone: this
 *               module deletes it once the child exits, so nothing unlinks a file the browser may
 *               still be reading.
 *   - `false` — nothing took it. The caller keeps the cleanup it was already doing.
 *
 * Every guard returns `false` quietly: a preview is not worth a warning on its own, and the reasons
 * this can no-op (already rendered, unsupported format, no renderer in this environment, explicitly
 * disabled) are all normal.
 */
export function requestThumbnail(params: {
  readonly cid: string;
  readonly format?: string | null;
  readonly logger: Logger;
  /** The staged upload this preview may be drawn from, if it still exists. */
  readonly sourcePath?: string | null;
}): boolean {
  const { cid, format, sourcePath, logger } = params;

  // `THUMBNAIL_RENDER=0` is the escape hatch for a CI run or a constrained host.
  if (process.env.THUMBNAIL_RENDER === '0') return false;
  if (!cid || !isRenderable(format)) return false;
  if (inFlight.has(cid) || thumbnailExists(cid)) return false;
  if (!existsSync(RENDER_SCRIPT)) {
    logger.debug(
      { cid, renderer: RENDER_SCRIPT },
      'thumbnail renderer not present in this environment — preview will fall back to the placeholder',
    );
    return false;
  }

  // Offered only if it is really there: a staging area that has already been cleaned up simply
  // leaves the render to the gateway, which has the same content under the same CID.
  const source = sourcePath && existsSync(sourcePath) ? sourcePath : null;

  /**
   * Whichever of the two callbacks gets there first releases the staged copy. Removing it twice is
   * harmless, and a failure to remove it is worth neither a warning nor a retry — the content is on
   * IPFS, so the worst case is one file left in the staging area.
   */
  const releaseStagedFile = (): void => {
    if (!source) return;
    void removeStagedFile(source).catch(() => undefined);
  };

  inFlight.add(cid);

  try {
    const args = [RENDER_SCRIPT, cid, String(format ?? '.glb')];
    if (source) args.push('--source', source);

    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, THUMBNAIL_DIR, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      // stdout is ignored (the renderer's progress is meaningless here) but **stderr is piped**:
      // it is the only place the renderer says *why* an attempt failed. Discarding it turned a
      // real failure into an opaque `code: 1`, which cost a long investigation to attribute to a
      // transient gateway race rather than a defect in this file.
      //
      // It has to be consumed as it arrives — an unread pipe fills and blocks the child — so the
      // buffer is capped; the renderer prints its last error last, so the tail is the useful part.
      stdio: ['ignore', 'ignore', 'pipe'],
      // Detached so the pin job (and, if the worker is shutting down, the worker) never waits on
      // a browser. The render finishes on its own or dies with the machine.
      detached: true,
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    // The pipe can outlive its reader if the worker is shutting down; that must not throw.
    child.stderr?.on('error', () => {});

    child.on('error', (error) => {
      inFlight.delete(cid);
      releaseStagedFile();
      logger.warn({ cid, err: error }, 'thumbnail render could not be launched');
    });

    // `close`, not `exit`: stderr is only fully flushed once the stdio streams have closed, and
    // the reason is the whole point of reading it. It is also the only moment when the child is
    // certainly done with the staged file, which is why the file is released here.
    child.on('close', (code, signal) => {
      inFlight.delete(cid);
      releaseStagedFile();
      if (code === 0) {
        logger.info({ cid, format, fromStagedFile: Boolean(source) }, 'thumbnail rendered');
        return;
      }
      const reason = stderr.trim().split('\n').slice(-4).join(' | ');
      logger.warn(
        { cid, format, code, signal, reason: reason || '(no stderr)' },
        'thumbnail render failed — the card keeps its placeholder until it is retried',
      );
    });

    return source !== null;
  } catch (error) {
    inFlight.delete(cid);
    releaseStagedFile();
    logger.warn({ cid, err: error }, 'thumbnail render threw before it could start');
    return false;
  }
}
