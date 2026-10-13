/**
 * Serves marketplace thumbnail images.
 *
 * Why this is a route handler rather than a file in `public/`:
 *
 * Next's production server enumerates `public/` **once, at boot**. A thumbnail generated afterwards
 * — which is exactly what `scripts/render-thumbnails.mjs` does, because a render needs a browser and
 * therefore cannot run inside the web server — is served as 404 until the server restarts. That
 * silently emptied every marketplace card whose render was produced after the last deploy, which is
 * the single worst failure mode for a visual catalogue.
 *
 * Reading the file per request removes the boot-time coupling entirely, and lets the response carry
 * a content type and cache policy of its own. The images are content-addressed by CID, so they are
 * immutable: a given URL can never mean different bytes.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Content addressing means a thumbnail is always a file lookup, never a database query. */
export const dynamic = 'force-dynamic';

/**
 * Repo-root `.thumbnails/` in development (the web app's cwd is `apps/web`). A container build lays
 * the tree out differently, so `THUMBNAIL_DIR` overrides it rather than hard-coding one layout.
 */
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR
  ? resolve(process.env.THUMBNAIL_DIR)
  : resolve(process.cwd(), '..', '..', '.thumbnails');

/**
 * A CID is base32 (bafy…) or base58 (Qm…) — letters and digits only, no separators. Validating it
 * before touching the filesystem is what makes path traversal (`../.env`) unrepresentable rather
 * than merely unlikely.
 */
const CID_PATTERN = /^[a-zA-Z0-9]{32,128}$/;

export async function GET(
  _request: Request,
  { params }: { params: { cid: string } },
): Promise<Response> {
  const { cid } = params;

  if (!CID_PATTERN.test(cid)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const bytes = await readFile(join(THUMBNAIL_DIR, `${cid}.jpg`));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        // Immutable: the URL is the content hash, so a stale copy is impossible by construction.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    // No render yet — the card falls back to its placeholder. Not an error worth logging per request.
    return new Response('Not found', { status: 404 });
  }
}
