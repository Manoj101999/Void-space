#!/usr/bin/env node
/**
 * Renders exactly one thumbnail. This is the entry point the ingest pipeline runs.
 *
 *   node scripts/render-thumbnail.mjs <cid> [format]
 *
 * Why a separate process
 * ----------------------
 * A render needs a real browser, and a browser belongs neither inside the API request that would
 * have to wait for it nor inside the worker's own module graph — `@playwright/test` is a root
 * devDependency, so the worker cannot resolve it, and a worker in the containerised stack has no
 * Chromium to resolve anyway. Spawning a script that *starts at the repo root* keeps the dependency
 * where it already is, gives the render its own lifetime (the pin job must not block on a 13 MB
 * download), and means a render that never comes back costs nothing but a process.
 *
 * Why it retries
 * --------------
 * The render runs seconds after `ipfs-pin` commits, which is exactly when the gateway is busiest:
 * the same Kubo node is serving a multi-megabyte object that was written moments earlier. One such
 * attempt failed with exit code 1 while a manual re-run twenty minutes later succeeded on the first
 * try — a genuine transient, and because nothing retried it, that asset kept its drawn placeholder
 * permanently. A preview is cheap to retry and expensive to get wrong (the Library has no second
 * chance: its card latches the first `onError` for the lifetime of the page), so attempts are made
 * until one succeeds.
 *
 * Every attempt prints its own error, and the final failure prints the last one. The worker pipes
 * stderr back and logs it, so a failure that does recur says *why* instead of just `code: 1`.
 *
 * Usage: node scripts/render-thumbnail.mjs <cid> [format] [--source <path>]   (format defaults to .glb)
 * Needs: the stack up (`pnpm stack:up` / `pnpm dev`), and `npx playwright install chromium` once.
 */
import { chromium } from '@playwright/test';
import { stat } from 'node:fs/promises';

import {
  isRenderableFormat,
  renderThumbnail,
  RENDERER_ARGS,
  WEB_BASE_URL,
} from './lib/thumbnail-render.mjs';

/**
 * `--source` is the staged upload the pin job offered this render. It is read — and only read:
 * the file is deleted by the pin job itself, once this process has exited, because that is where
 * the check that it is genuinely a staged file lives. A renderer that deleted whatever it was
 * handed would put an unguarded unlink behind a path that came out of a job payload.
 */
const argv = process.argv.slice(2);
const positional = [];
let sourcePath = null;

for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--source') {
    sourcePath = argv[index + 1] ?? null;
    index += 1;
  } else {
    positional.push(argv[index]);
  }
}

const [cid, format = '.glb'] = positional;

/** Four attempts, then give up and let the card keep its drawn fallback. */
const MAX_ATTEMPTS = 4;
/**
 * First attempt immediately; retries wait, because the two observed failures were both
 * environmental rather than deterministic — the renderer crashed while the dev server was
 * compiling routes — and a retry that lands during the same burst fails for the same reason.
 * The delays therefore outlast a compile, and the whole thing is detached, so none of it is
 * on anyone's critical path.
 */
const RETRY_DELAY_MS = [0, 5_000, 15_000, 30_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!cid) {
  console.error('usage: node scripts/render-thumbnail.mjs <cid> [format] [--source <path>]');
  process.exit(2);
}

if (sourcePath) {
  // A missing file is not fatal: the gateway still has the content, it is just slower to reach.
  // This also matters on a retry — the staging area is cleaned up while a long render is running.
  try {
    await stat(sourcePath);
  } catch {
    console.error(`source ${sourcePath} is gone — falling back to the gateway`);
    sourcePath = null;
  }
}

if (!isRenderableFormat(format)) {
  // Not an error worth a stack trace: the caller should not have asked for a format the render
  // surface cannot decode, and the card's drawn fallback is the correct outcome.
  console.error(`skipping ${cid}: ${format} has no preview surface`);
  process.exit(0);
}

// The edge serves a locally generated certificate; this process only ever talks to localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let lastError = null;
let rendered = null;

for (let attempt = 1; attempt <= MAX_ATTEMPTS && !rendered; attempt += 1) {
  if (RETRY_DELAY_MS[attempt - 1] > 0) {
    console.error(
      `attempt ${attempt - 1} failed for ${cid}; retrying in ${RETRY_DELAY_MS[attempt - 1]}ms`,
    );
    await sleep(RETRY_DELAY_MS[attempt - 1]);
  }

  let browser = null;
  try {
    browser = await chromium.launch({ args: RENDERER_ARGS });
  } catch (error) {
    lastError = error;
    console.error(`attempt ${attempt} could not launch a browser: ${error?.message ?? error}`);
    continue;
  }

  try {
    rendered = await renderThumbnail(browser, {
      cid,
      format,
      baseUrl: WEB_BASE_URL,
      sourcePath,
    });
  } catch (error) {
    lastError = error;
    console.error(`attempt ${attempt} failed for ${cid}: ${error?.message ?? error}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

const hadSource = Boolean(sourcePath);

if (rendered) {
  console.log(
    `rendered ${cid} -> ${rendered.path} (${(rendered.bytes / 1024).toFixed(0)} KB${
      hadSource ? ' from the staged file' : ''
    })`,
  );
  process.exit(0);
}

console.error(
  `render failed for ${cid} after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? lastError}`,
);
process.exit(1);
