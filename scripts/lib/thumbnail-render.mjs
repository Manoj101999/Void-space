/**
 * The single-thumbnail render, shared by the bulk script and the ingest-time renderer.
 *
 * Why this lives in one place
 * ---------------------------
 * `scripts/render-thumbnails.mjs` used to be the only thing that could produce a preview, so a
 * freshly uploaded asset had no image until somebody remembered to run it by hand — the card fell
 * back to its drawn placeholder indefinitely. The worker now renders at ingest (see
 * `apps/worker/src/lib/thumbnail.ts`), and two implementations of "wait until the model is on
 * screen, then shoot" would drift apart the first time either was fixed. The hard-won parts — the
 * 4:3 viewport, the explicit `undefined` argument to `waitForFunction`, the settle after readiness
 * — are therefore written once, here.
 *
 * This module deliberately imports nothing from Playwright: it takes an already-launched browser,
 * so the caller owns the dependency. That is what lets the worker spawn a script at the repo root
 * (where `@playwright/test` resolves) instead of carrying a browser of its own.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

/**
 * 4:3, matching `.mk-card-media` exactly.
 *
 * This has to match or `object-fit: cover` silently crops every card: the renders used to be 1200×750
 * (16:10) in a 4:3 well, so a seventh of every model's width was cut off — and because the crop is
 * invisible in the markup, it reads as "the models are framed inconsistently" rather than as cropping.
 */
export const VIEWPORT = { width: 1200, height: 900 };
export const RENDER_TIMEOUT_MS = 90_000;

/**
 * The page the browser drives. The edge serves a locally generated certificate.
 *
 * `127.0.0.1` rather than `localhost`, for the reason documented on `GATEWAY_URL` in
 * `apps/web/src/app/ipfs/[cid]/route.ts`: on a Windows host the WSL port relay owns `::1:443`,
 * and `localhost` resolves there first. The TCP connect is accepted and then left to time out, so
 * `page.goto` died with `net::ERR_TIMED_OUT` before the render page ever painted and *every*
 * ingest-time thumbnail failed for a reason that had nothing to do with the model. The page context
 * is created with `ignoreHTTPSErrors`, so the edge certificate not listing this address is harmless.
 */
export const WEB_BASE_URL = process.env.DEMO_WEB_URL ?? 'https://127.0.0.1';

/**
 * Repo-root `.thumbnails/`, keyed by CID, served by the `/thumbnails/[cid]` route handler.
 *
 * `THUMBNAIL_DIR` overrides it for layouts that differ (a container build) — the same variable the
 * route handler reads, so the writer and the reader cannot disagree about where images live.
 */
export const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR
  ? resolve(process.env.THUMBNAIL_DIR)
  : join(REPO_ROOT, '.thumbnails');

export function thumbnailPath(cid, outDir = THUMBNAIL_DIR) {
  return join(outDir, `${cid}.jpg`);
}

/**
 * The formats `/render/<cid>` can decode, and therefore the formats a preview image can exist for.
 *
 * The render surface is the same `ModelViewer` the console uses, so this list tracks the loaders it
 * ships (see `NATIVE_FORMATS`): glTF, OBJ, FBX and STL. `.blend` has no browser decoder, and asking
 * for it would screenshot the "cannot preview" card rather than a model — worse than no image at all.
 */
export const VIEWABLE_FORMATS = ['.glb', '.gltf', '.obj', '.fbx', '.stl'];

export function isRenderableFormat(format) {
  return VIEWABLE_FORMATS.includes(String(format ?? '').toLowerCase());
}

/**
 * What the gateway answers with for each format.
 *
 * Only used when a render is fed from a local file (see `sourcePath`): the bytes are intercepted
 * before they reach the network, and the header is set to the one the served copy would have
 * carried so the page cannot tell the difference. The decoders choose text versus binary from
 * their own `responseType`, so this is fidelity rather than function — with one exception worth
 * keeping honest: an `.obj` asked for as binary would be read as garbage.
 */
const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'application/json',
  '.obj': 'text/plain',
  '.fbx': 'application/octet-stream',
  '.stl': 'application/sla',
};

export function contentTypeFor(format) {
  return CONTENT_TYPES[String(format ?? '').toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Chromium flags the renderer needs.
 *
 * `--allow-running-insecure-content` looks alarming and is scoped to this one headless browser.
 * A staged file is answered by a loopback HTTP server (see `serveStagedFile`) while the page itself
 * is served over HTTPS by the edge, which Chromium treats as mixed content and blocks. The bytes
 * never leave the machine and the flag is never given to a browser a person uses.
 */
export const RENDERER_ARGS = ['--allow-running-insecure-content'];

/**
 * Streams `filePath` over loopback HTTP and returns its URL plus a disposer.
 *
 * Why a server instead of `route.fulfill`
 * --------------------------------------
 * `page.route` + `route.fulfill({ path })` is the obvious way to answer a request from a local file,
 * and it works — right up to the point where the file is large. `fulfill` ships the entire body
 * through a single CDP message, so an 86 MB mesh is base64-encoded into one oversized frame and the
 * renderer dies with `Target page, context or browser has been closed`. Every attempt of every retry
 * failed the same way, which is why the largest upload in the catalogue had no preview at all while
 * every small asset rendered perfectly.
 *
 * Redirecting instead means the browser pulls the bytes itself, over a normal socket, at whatever
 * pace it can. The interception stays a few dozen bytes either way, and a 200 MB upload is no longer
 * a special case.
 *
 * Range requests are honoured because three.js issues them for large meshes, and a server that
 * answers 200 to a Range request makes the client re-fetch the whole object.
 */
export function serveStagedFile(filePath, contentType = 'application/octet-stream') {
  const { size } = statSync(filePath);

  const server = createServer((request, response) => {
    const range = request.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;

    let start = 0;
    let end = size - 1;

    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      } else {
        // `bytes=-N` is a suffix range: the final N bytes.
        start = Math.max(0, size - Number(match[2]));
      }

      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` });
        response.end();
        return;
      }

      end = Math.min(end, size - 1);
      response.writeHead(206, {
        'content-type': contentType,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
      });
    } else {
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
      });
    }

    createReadStream(filePath, { start, end }).pipe(response);
  });

  // Port 0 asks the OS for a free one: two renders may overlap, and a fixed port would make the
  // second fail for a reason that has nothing to do with the model.
  server.listen(0, '127.0.0.1');

  return {
    /** Resolves once the socket is accepting — a redirect issued earlier would be a connection error. */
    ready: new Promise((resolveReady) => server.once('listening', resolveReady)),
    url: () => `http://127.0.0.1:${server.address().port}/model`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * Renders `cid` into `.thumbnails/<cid>.jpg` and returns its size.
 *
 * `sourcePath` is the staged upload the pin job has just handed over. When given, the model request
 * is answered from that file instead of the gateway — which matters more than it looks:
 *
 *   - The whole point of this render is the minutes *right after* an upload, which is exactly when
 *     the Kubo node is still serving the object it wrote moments earlier. That race is why the
 *     first attempt after a pin used to be the one that failed, and why a "quick" preview could
 *     take two minutes once the retry backoff had its say.
 *   - The bytes were already read once to be added to IPFS. Fetching them back over HTTP to draw
 *     them is a second transfer of up to 200 MB for no benefit.
 *   - The file is content-addressed by that same CID, so serving it here cannot show different
 *     bytes than the gateway would.
 *
 * When it is absent — an already-pinned version being self-healed, or a staging area that has
 * already been cleaned up — the request simply goes to the gateway as before.
 *
 * Throws on failure — the caller decides whether that is fatal. For the bulk script it is a
 * reported per-asset failure; for the worker it is logged and swallowed, because a missing preview
 * must never fail an ingest that pinned the bytes correctly.
 */
export async function renderThumbnail(
  browser,
  {
    cid,
    format = '.glb',
    baseUrl = WEB_BASE_URL,
    outDir = THUMBNAIL_DIR,
    sourcePath = null,
  },
) {
  await mkdir(outDir, { recursive: true });
  const target = thumbnailPath(cid, outDir);

  /**
   * The staged file, if any, served from a loopback socket rather than pushed through CDP.
   *
   * Declared outside `try` so the disposer in `finally` can reach it even when the failure happens
   * between starting the server and installing the route.
   */
  let staged = null;

  // The edge serves a locally generated certificate, so the browser context must accept it:
  // `NODE_TLS_REJECT_UNAUTHORIZED` only affects Node's own sockets, never the browser's.
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });

  try {
    if (sourcePath) {
      staged = serveStagedFile(sourcePath, contentTypeFor(format));
      await staged.ready;

      /*
        Redirect, scoped to this CID's own path.

        The page, its scripts and its styles still come from the network; only the model is answered
        from disk. A 307 rather than a rewrite because the browser has to *pull* the bytes for them
        to stream — see `serveStagedFile` for why fulfilling them in one CDP frame kills the renderer
        on any file large enough to matter.

        307 (not 301/302) so the method and the request headers survive the hop: three.js issues a
        plain GET here, but a Range request must reach the loopback server intact or a large mesh
        would be re-fetched whole.
      */
      await page.route(
        (url) => url.pathname === `/ipfs/${cid}`,
        (route) =>
          route.fulfill({
            status: 307,
            headers: { location: staged.url() },
          }),
      );
    }

    /*
      `domcontentloaded`, not `networkidle`.

      The readiness signal below is the real gate — it fires when the geometry is decoded *and*
      framed, which no amount of network idleness can stand in for. `networkidle` was doing
      nothing that the readiness wait does not do better, and it fails badly rather than usefully:
      while the dev server is compiling this route (or the edge is busy with the object the pin
      job wrote seconds ago), the page keeps loading and `goto` spends its whole 90 s budget and
      then throws — turning what would be a slow first render into a failed attempt, a backoff,
      and a preview that arrives two minutes late. Waiting for the document instead lets the
      readiness signal do the waiting, on the condition that actually means "the model is on
      screen".
    */
    await page.goto(
      `${baseUrl}/render/${cid}?format=${encodeURIComponent(format)}`,
      { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS },
    );

    // Wait for the model to actually be on screen.
    //
    // The previous condition — "a canvas exists with non-zero size" — was true the instant the
    // canvas mounted, so it always passed immediately and the real wait was the fixed settle below.
    // That worked for small models and produced a blank render for the largest one (the 16.7 MB
    // whale scan) whenever the file was slow: the script screenshotted an empty stage. The render
    // surface now sets a flag when the geometry is decoded *and* framed, which is a genuine
    // readiness signal rather than a race.
    await page.waitForFunction(
      // Plain JavaScript: this callback is stringified and evaluated in the page, so TypeScript
      // syntax would be a runtime syntax error here.
      //
      // `undefined` for `arg` is load-bearing: waitForFunction's signature is
      // (pageFunction, arg, options), so passing the options object second would bind it to `arg`
      // and silently fall back to the 30 s default — which is exactly how the slow models
      // (the 17 MB whale scan) were timing out as blank failures.
      () => window.__voidSpaceRenderReady === true,
      undefined,
      { timeout: RENDER_TIMEOUT_MS, polling: 250 },
    );

    // The fit settles on the frame after readiness; give shadows a beat so the screenshot is not
    // taken mid-animation.
    await page.waitForTimeout(1_200);

    const canvas = await page.$('canvas');
    if (!canvas) throw new Error('no canvas');

    // JPEG, not PNG: a shaded surface is photographic data, and PNG stored it at 6–14x the size.
    await canvas.screenshot({ path: target, type: 'jpeg', quality: 80 });

    const { size } = await stat(target);
    return { path: target, bytes: size };
  } finally {
    // Cleanup must never replace the cause it is cleaning up after. When the target has crashed,
    // `page.close()` throws a protocol error of its own, and because this is a `finally` that error
    // became *the* reported failure — hiding the crash that actually mattered behind
    // "Failed to find context with id …".
    await page.close().catch(() => {});
    // Both are best-effort and both run even when the page already crashed: a loopback listener
    // left listening would keep this process alive after the render is over.
    await staged?.close().catch(() => {});
  }
}
