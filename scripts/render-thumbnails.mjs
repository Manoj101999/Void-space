#!/usr/bin/env node
/**
 * Renders marketplace thumbnails with a real browser.
 *
 * Why: a card in a 3D marketplace has to show the object. Mounting a live canvas per card would pull
 * hundreds of megabytes (one bundled model is 13.6 MB) and tank the page, so the preview is rendered
 * once, ahead of time, and served as a small image. This is the same trade every asset marketplace
 * makes.
 *
 * How: each asset with a CID in a natively viewable format is opened on the unauthenticated
 * /render/<cid> surface — one model, full-bleed, no chrome — and the canvas is screenshotted.
 * Every lifecycle state is walked, because the console Library shows a card for every asset,
 * not only the marketplace's published shelf. Output lands in .thumbnails/ at the repo
 * root, keyed by CID, and is served by the /thumbnails/[cid] route handler.
 *
 * Deliberately not `public/`: Next enumerates that directory once at boot, so a render produced after
 * the server started is served as 404 until a restart — which silently blanks every marketplace card.
 * The route handler reads from disk per request, so regenerating never needs a restart.
 *
 * Output is JPEG at ~q80 rather than PNG: these are photographs of a shaded 3D surface, and the first
 * PNGs this script produced were 424 KB–1 MB each, so a five-card grid cost ~4 MB.
 *
 * This script is the **bulk/backfill** path. It is no longer the only path: the worker renders each
 * asset as it is ingested (`apps/worker/src/lib/thumbnail.ts`), which is why a brand-new upload shows
 * a preview without anyone running anything. Reach for `--force` when a render needs redoing, or
 * when restoring `.thumbnails/` from scratch.
 *
 * Usage: node scripts/render-thumbnails.mjs [--force] [--only <name fragment>]
 * Needs: the stack up (`pnpm stack:up`), and `npx playwright install chromium` once.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { isRenderableFormat, renderThumbnail, RENDERER_ARGS, THUMBNAIL_DIR, WEB_BASE_URL } from './lib/thumbnail-render.mjs';

/**
 * The edge, addressed by loopback rather than `localhost` — the WSL port relay owns `::1:443` on a
 * Windows host, so the hostname stalls where the literal address does not (see `WEB_BASE_URL`).
 */
const API = process.env.DEMO_API_URL ?? 'https://127.0.0.1/api/v1';
const ASSESSOR = { email: 'assessor@aurora.dev', password: 'VoidSpace!2026' };

// The edge serves a locally generated certificate; this process only ever talks to loopback.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let cookies = '';

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';');
    cookies = cookies ? `${cookies}; ${pair}` : pair;
  }

  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

async function main() {
  const force = process.argv.includes('--force');
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

  const { mkdir } = await import('node:fs/promises');
  await mkdir(THUMBNAIL_DIR, { recursive: true });
  await api('/auth/login', { method: 'POST', body: ASSESSOR });

  const { items } = await api('/assets?pageSize=100');
  const targets = items
    .filter((item) => item.currentVersion?.ipfsCid)
    .filter((item) => (only ? item.name.includes(only) : true))
    .filter((item) => isRenderableFormat(item.currentVersion.format));

  console.log(
    `\n  Rendering ${targets.length} thumbnails into ${THUMBNAIL_DIR} (served by /thumbnails/[cid])\n`,
  );

  const browser = await chromium.launch({ args: RENDERER_ARGS });
  let rendered = 0;
  let skipped = 0;

  for (const item of targets) {
    const cid = item.currentVersion.ipfsCid;
    const target = join(THUMBNAIL_DIR, `${cid}.jpg`);

    if (!force && existsSync(target)) {
      console.log(`  skip   ${item.name.padEnd(30)} (already rendered)`);
      skipped += 1;
      continue;
    }

    process.stdout.write(`  render ${item.name.padEnd(30)} `);

    try {
      const { bytes } = await renderThumbnail(browser, {
        cid,
        format: item.currentVersion.format,
        baseUrl: WEB_BASE_URL,
        outDir: THUMBNAIL_DIR,
      });
      console.log(`${(bytes / 1024).toFixed(0)} KB`);
      rendered += 1;
    } catch (error) {
      console.log(`FAILED — ${error.message}`);
    }
  }

  await browser.close();

  // The card falls back to its placeholder when a render is missing, so there is no manifest to
  // publish: the presence of the file *is* the manifest.
  console.log(`\n  ${rendered} rendered · ${skipped} already present\n`);
}

main().catch((error) => {
  console.error(`\n  render-thumbnails failed — ${error.message}\n`);
  process.exitCode = 1;
});
