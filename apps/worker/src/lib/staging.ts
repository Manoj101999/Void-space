/**
 * Staging-area helpers for the worker (SRS FR-3.1, FR-8.1).
 *
 * The worker reads the file the API staged, then removes it once the content is durably
 * on IPFS. Paths are treated as untrusted: a job payload comes from Redis, so the worker
 * only ever deletes inside the configured staging root.
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The configured staging root, resolved once per process. */
export function stagingRoot(): string {
  return resolve(process.env['STAGING_DIR'] ?? '.staging');
}

export function isInsideStaging(path: string): boolean {
  const root = stagingRoot();
  const resolved = resolve(path);
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * Removes a staged file and its now-empty per-version directory. Refuses to touch a path
 * outside the staging root, so a corrupted payload cannot delete arbitrary files.
 */
export async function removeStagedFile(path: string): Promise<void> {
  if (!isInsideStaging(path)) return;

  await rm(resolve(path), { force: true });
  // The parent is the per-version directory created by the API.
  await rm(resolve(path, '..'), { force: true, recursive: true }).catch(() => undefined);
}
