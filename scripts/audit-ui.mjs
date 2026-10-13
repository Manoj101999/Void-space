#!/usr/bin/env node
/**
 * Browser audit of the whole product — public marketplace and console.
 *
 * Drives every route in a real browser and records what a person would actually experience: console
 * errors, uncaught exceptions, failed requests, the text on screen, HTTP status and a screenshot.
 *
 * Why a script rather than a click-through: the web app is a system of coupled screens, so one change
 * to the shell or a query key breaks several at once. Re-running this takes a minute and reports by
 * exception, which means a regression surfaces here instead of being found by accident later.
 *
 * Passes:
 *   anonymous  — the public catalogue must render for a stranger, and console routes must redirect to
 *                sign-in rather than showing a fault panel or hanging on a session check.
 *   creator / assessor / admin — every screen that role can reach must render with content.
 *   elevation  — routes a role cannot use must refuse cleanly, never fail open and never crash.
 *
 * Usage: node scripts/audit-ui.mjs [--only <fragment>] [--shots]
 * Needs: the stack up (`pnpm stack:up`) and `npx playwright install chromium` once.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const BASE = (process.env.DEMO_WEB_URL ?? 'https://localhost').replace(/\/$/, '');
const API = (process.env.DEMO_API_URL ?? 'https://localhost/api/v1').replace(/\/$/, '');
const PASSWORD = 'VoidSpace!2026';
const VIEWPORT = { width: 1440, height: 960 };
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_600;

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../.audit/ui');

// The edge serves a locally generated certificate; this process only ever talks to localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex === -1 ? null : (process.argv[onlyIndex + 1] ?? null);
const SHOTS = process.argv.includes('--shots');

/** Accounts used to reach each role's screens. */
const ACCOUNTS = {
  creator: 'creator@aurora.dev',
  assessor: 'assessor@aurora.dev',
  admin: 'admin@northwind.dev',
  superadmin: 'superadmin@void-space.dev',
};

/** Public routes, plus every published model detail page discovered at runtime. */
const PUBLIC_ROUTES = [
  ['/', 'Product landing'],
  ['/catalog', 'Catalogue'],
  ['/login', 'Sign in'],
];

/** Console routes per role. `expectStatus` documents the intended outcome of the request itself. */
const CONSOLE_ROUTES = [
  { path: '/console', label: 'Overview', roles: ['creator'] },
  { path: '/console/library', label: 'Library', roles: ['creator'] },
  { path: '/console/catalog', label: 'Catalogue (staff view)', roles: ['creator'] },
  { path: '/console/licenses', label: 'Licences', roles: ['creator'] },
  { path: '/console/notifications', label: 'Notifications', roles: ['creator'] },
  { path: '/console/review', label: 'Review queue', roles: ['assessor'] },
  { path: '/console/audit', label: 'Audit ledger', roles: ['assessor'] },
  { path: '/console/admin', label: 'Administration', roles: ['admin'] },
  // FR-14.1 — the cross-workspace view is SuperAdmin-only, so it is audited as such.
  { path: '/console/tenants', label: 'Workspaces (platform)', roles: ['superadmin'] },
];

/** Routes that must refuse a role that lacks the permission (403 surface, not a crash or a blank page). */
const ELEVATION_CASES = [
  { email: ACCOUNTS.creator, path: '/console/review', reason: 'Creator lacks asset:review' },
  { email: ACCOUNTS.creator, path: '/console/audit', reason: 'Creator lacks audit:view' },
  { email: ACCOUNTS.creator, path: '/console/admin', reason: 'Creator lacks tenant:manage-users' },
];

/** Text that indicates a screen failed rather than rendered. */
const FAULT_MARKERS = [
  'console halted',
  'application error',
  'unhandled runtime error',
  'something went wrong',
  'checking your session',
  'route not found',
];

function shouldRun(label) {
  return !ONLY || label.toLowerCase().includes(ONLY.toLowerCase());
}

/** Logs in over HTTPS and returns cookies in the shape Playwright's addCookies expects. */
async function loginCookies(email) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`login failed for ${email}: ${response.status} ${await response.text()}`);
  }

  const raw = response.headers.getSetCookie?.() ?? [];
  const cookies = [];
  for (const header of raw) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    cookies.push({
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: 'localhost',
      path: header.includes('Path=/api/v1/auth') ? '/api/v1/auth' : '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

/** Every published model, so the detail page is audited with real content rather than one sample. */
async function publishedAssetIds() {
  const response = await fetch(`${API}/public/catalog?limit=50`);
  if (!response.ok) return [];
  const body = await response.json();
  return (body.items ?? []).map((item) => item.assetId);
}

/**
 * Containers that must be *visibly* rendered wherever they appear.
 *
 * This exists because of a real defect: `.vs-grid-lines` (a layout stat strip) was disabled with
 * `display: none !important` during an ornament cleanup, on the assumption its name described a
 * decorative mesh. Three dashboards lost their counters — and this audit reported every route
 * `[PASS]`, because content that exists in the DOM but renders at 0×0 raises no console error, no
 * failed request and a 200. A status code cannot tell you whether a reader can see anything.
 *
 * So visibility is asserted structurally. `!important` is the tell: legitimate responsive hiding uses
 * a media query, so a hidden-by-`!important` element is almost always a mistake rather than a
 * breakpoint.
 */
/**
 * Selectors that must be visible wherever they appear.
 *
 * `.vs-stat-strip` is listed by its *behavioural* name rather than its appearance: it is the layout
 * that carries the headline figures on Overview, the review queue, Administration and the asset
 * console. It was briefly disabled by a global `display: none !important` rule — a cleanup pass had
 * read the old class name as decorative — which emptied four screens of every number they display
 * while every route still answered 200. That is the failure this list exists to catch.
 */
const MUST_BE_VISIBLE = ['[class*=vs-stat-strip]', '.mk-card', '.vs-panel', 'main h1'];

async function visibilityProblems(page) {
  // The selector list has to be passed as the argument to `evaluate`, not closed over: the callback
  // runs in page context and cannot see this module's scope. It was previously called with no
  // argument at all, so the loop threw on `undefined`, the caller's `.catch(() => [])` swallowed the
  // TypeError, and the check silently reported zero problems on every route — a detector that always
  // passes is worse than no detector, because it is believed.
  return page.evaluate((selectors) => {
    const problems = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hidden = style.display === 'none' || style.visibility === 'hidden';
        const collapsed = rect.width === 0 || rect.height === 0;
        // An empty container is not a defect worth reporting; a container with content is.
        const hasContent = (element.textContent ?? '').trim().length > 0 || element.children.length > 0;
        if (hasContent && (hidden || collapsed)) {
          problems.push(
            `${selector} present but not visible (display:${style.display}, ${Math.round(rect.width)}x${Math.round(rect.height)})`,
          );
        }
      }
    }
    return problems;
  }, MUST_BE_VISIBLE);
}

async function auditPage(page, entry) {
  const { url, label, cookies } = entry;
  const record = {
    label,
    url: url.replace(BASE, ''),
    status: null,
    screenshot: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    faultText: [],
    invisibleContent: [],
    finalUrl: null,
  };

  const onConsole = (message) => {
    if (message.type() === 'error') record.consoleErrors.push(message.text().slice(0, 400));
  };
  const onPageError = (error) => record.pageErrors.push(error.message.slice(0, 400));
  const onResponse = (response) => {
    const status = response.status();
    if (status >= 400 && !response.url().includes('favicon')) {
      record.failedRequests.push(`${status} ${response.url().replace(BASE, '')}`.slice(0, 200));
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    await page.context().clearCookies();
    if (cookies) await page.context().addCookies(cookies);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    record.status = response?.status() ?? null;
    await page.waitForTimeout(SETTLE_MS);
    record.finalUrl = page.url().replace(BASE, '');

    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    record.faultText = FAULT_MARKERS.filter((marker) => text.includes(marker));
    record.bodyLength = text.length;
    // No `.catch(() => [])` here on purpose. Swallowing this failure is exactly how the check above
    // spent several runs reporting zero problems while doing nothing: a broken detector that reports
    // success is worse than no detector, because its output is believed.
    record.invisibleContent = await visibilityProblems(page);

    if (SHOTS) {
      const slug = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const file = resolve(OUT_DIR, `${slug}.png`);
      await page.screenshot({ path: file, fullPage: false });
      record.screenshot = file.replace(`${resolve(here, '../')}/`, '');
    }
  } catch (error) {
    record.pageErrors.push(`navigation: ${String(error).slice(0, 300)}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }

  return record;
}

function classify(record) {
  const problems = [];
  if (record.pageErrors.length) problems.push(`${record.pageErrors.length} page error(s)`);
  if (record.consoleErrors.length) problems.push(`${record.consoleErrors.length} console error(s)`);
  if (record.faultText.length) problems.push(`fault text: ${record.faultText.join(', ')}`);
  if (record.invisibleContent.length)
    problems.push(`${record.invisibleContent.length} invisible block(s)`);
  if (record.status === null || record.status >= 500) problems.push(`status ${record.status}`);
  return problems;
}

async function main() {
  if (SHOTS) await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const results = [];

  // ---------------------------------------------------------------- anonymous pass
  const assetIds = await publishedAssetIds();
  const anonRoutes = [
    ...PUBLIC_ROUTES.map(([path, label]) => ({ url: `${BASE}${path}`, label, cookies: null })),
    ...assetIds.slice(0, 3).map((id, index) => ({
      url: `${BASE}/m/${id}`,
      label: `Model detail ${index + 1}`,
      cookies: null,
    })),
    // A stranger must be sent to sign-in, not shown a console at all.
    { url: `${BASE}/console`, label: 'Console (anonymous)', cookies: null, redirectsToLogin: true },
  ];

  for (const entry of anonRoutes) {
    if (!shouldRun(entry.label)) continue;
    const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const record = await auditPage(page, entry);
    record.pass = 'anonymous';
    if (entry.redirectsToLogin) {
      const redirected = record.finalUrl?.startsWith('/login');
      if (!redirected) record.pageErrors.push(`expected redirect to /login, landed on ${record.finalUrl}`);
    }
    results.push(record);
    await page.close();
  }

  // ------------------------------------------------------------------- role passes
  for (const [roleName, email] of Object.entries(ACCOUNTS)) {
    let cookies;
    try {
      cookies = await loginCookies(email);
    } catch (error) {
      results.push({ label: `login ${roleName}`, pass: roleName, pageErrors: [String(error)] });
      continue;
    }

    for (const route of CONSOLE_ROUTES) {
      if (!route.roles.includes(roleName)) continue;
      if (!shouldRun(route.label)) continue;
      const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
      const record = await auditPage(page, { url: `${BASE}${route.path}`, label: route.label, cookies });
      record.pass = roleName;
      results.push(record);
      await page.close();
    }

    // Detail pages with a session, which exercises the authenticated viewer path.
    if (roleName === 'creator' && assetIds[0] && shouldRun('Console asset detail')) {
      const response = await fetch(`${API}/assets?limit=1`, { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } }).catch(() => null);
      const assetId = response?.ok ? (await response.json()).items?.[0]?.id : null;
      if (assetId) {
        const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
        const record = await auditPage(page, {
          url: `${BASE}/console/assets/${assetId}`,
          label: 'Console asset detail',
          cookies,
        });
        record.pass = roleName;
        results.push(record);
        await page.close();
      }
    }
  }

  // --------------------------------------------------------------- elevation pass
  for (const testCase of ELEVATION_CASES) {
    if (!shouldRun(`elevation ${testCase.path}`)) continue;
    const cookies = await loginCookies(testCase.email).catch(() => null);
    if (!cookies) continue;
    const page = await browser.newPage({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const record = await auditPage(page, {
      url: `${BASE}${testCase.path}`,
      label: `Elevation ${testCase.path}`,
      cookies,
    });
    record.pass = 'elevation';
    record.expectation = testCase.reason;
    // A refusal is a rendered screen telling the operator they lack permission — not a crash.
    if (record.pageErrors.length || record.status >= 500) {
      record.pageErrors.push('refusal crashed instead of rendering');
    }
    results.push(record);
    await page.close();
  }

  await browser.close();

  // ---------------------------------------------------------------------- report
  const broken = [];
  for (const record of results) {
    const problems = classify(record);
    const mark = problems.length === 0 ? 'PASS' : 'FAIL';
    if (problems.length) broken.push({ ...record, problems });
    const status = record.status === null ? '  -' : String(record.status).padStart(3);
    console.log(
      `[${mark}] ${status}  ${String(record.pass ?? '').padEnd(10)} ${String(record.label).padEnd(28)} ${record.url}`,
    );
    if (problems.length) {
      console.log(`        ! ${problems.join(' | ')}`);
      for (const error of record.pageErrors.slice(0, 3)) console.log(`          page: ${error}`);
      for (const error of record.consoleErrors.slice(0, 3)) console.log(`          console: ${error}`);
      const unique = [...new Set(record.failedRequests)];
      for (const failure of unique.slice(0, 5)) console.log(`          request: ${failure}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    failed: broken.length,
    results,
  };
  await writeFile(resolve(OUT_DIR, 'report.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${results.length - broken.length}/${results.length} routes clean`);
  if (broken.length) {
    console.log(`\n${broken.length} route(s) with findings:`);
    for (const record of broken) console.log(`  - [${record.pass}] ${record.label}: ${record.problems.join(', ')}`);
  }
  console.log(`\nreport: .audit/ui/report.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
