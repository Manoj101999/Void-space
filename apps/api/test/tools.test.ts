/**
 * FR-6.1–FR-6.4 and UC-09 — the third-party tools module.
 *
 * Two things are being guarded, and the first is the reason this file exists at all.
 *
 * **The module is mounted.** `modules/tools/` was complete — routes, service, vendor adapters, error
 * handling — and never registered in `app.ts`. Every route in it therefore answered
 * `404 … is not a known route` in a running API, while its own header described the paths as fixed
 * by the specification. Nothing else in the suite could see that: an unregistered module still
 * typechecks, lints, and passes its unit tests. So the first block asserts reachability, and the
 * rest only means something once it passes.
 *
 * **UC-09 does not fetch arbitrary URLs.** `POST /tools/import` makes the *server* request a URL the
 * caller chose, which is a server-side request forgery in the shape of a feature. The host check is
 * tested with a `fetch` that records every call, so a rejection can be asserted as "the URL was
 * never requested" rather than merely "we got a 400" — a 400 *after* the request has gone out is not
 * the property anyone wants.
 *
 * `fetch` is stubbed globally *before* the app is built, because the routes and the tools service
 * both capture their fetch implementation at registration time.
 */
import { randomUUID } from 'node:crypto';

import { buildGlbFixture, withTenant } from '@void-space/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEMO, DEMO_TENANT_IDS, cookieHeader, createTestApp, login, type TestApp } from './helpers';

/** Triangles in the fixture the happy-path import serves, so the measured figure is knowable. */
const FIXTURE_TRIANGLES = 120;

let context: TestApp;

/** What the stubbed `fetch` should do for the next call. Replaced per test. */
let respond: (url: string) => Promise<Response>;
/** Every URL the code under test actually tried to fetch. */
let requested: string[];

beforeAll(async () => {
  requested = [];
  respond = () => Promise.reject(new Error('this test did not set a fetch response'));

  vi.stubGlobal('fetch', (async (input: string | URL | { url: string }) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    return respond(url);
  }) as unknown as typeof fetch);

  context = await createTestApp();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await context?.close();
});

/** A creator's cookie — the role that holds `asset:upload-own`. */
async function creatorCookie(): Promise<string> {
  const creator = await login(context.app, DEMO.users.auroraCreator);
  return cookieHeader(creator.cookies, 'vs_access');
}

function importBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'sketchfab',
    externalId: 'abc123',
    downloadUrl: 'https://media.sketchfab.com/models/abc123/download.glb',
    name: `Imported ${randomUUID().slice(0, 8)}`,
    category: 'Prop',
    tags: ['imported'],
    ...overrides,
  };
}

/**
 * A vendor response carrying a real GLB, so the import goes through the same ingest measurement an
 * upload does and the asserted triangle count is one the code actually read.
 *
 * Wrapped in a `Blob` because Node's `Buffer` is not a `BodyInit`.
 */
function glbResponse(triangles: number, contentType: string): Response {
  // A copy into a plain `Uint8Array` because `BlobPart` requires an `ArrayBuffer`-backed view, and
  // Node's `Buffer` is typed as `ArrayBufferLike` (which includes `SharedArrayBuffer`).
  const bytes = new Uint8Array(buildGlbFixture(triangles));
  return new Response(new Blob([bytes]), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

/** Removes an imported asset and everything hanging off it. */
async function dropAsset(assetId: string): Promise<void> {
  await withTenant(DEMO_TENANT_IDS.aurora, async (db) => {
    await db.job.deleteMany({ where: { tenantId: DEMO_TENANT_IDS.aurora, entityId: assetId } });
    await db.assetVersion.deleteMany({ where: { assetId } });
    await db.asset.deleteMany({ where: { id: assetId } });
  });
}

describe('tools module is mounted (§6.4)', () => {
  /*
   * Every path the specification names, plus the one this module adds. Asserting these are not 404
   * is the only thing that distinguishes "implemented" from "reachable", and the distinction is not
   * academic — it is how the whole module spent its life until now.
   */
  const endpoints = [
    ['GET', '/api/v1/tools/integrations'],
    ['POST', '/api/v1/tools/sketchfab/search'],
    ['POST', '/api/v1/tools/poly-pizza/search'],
    ['POST', '/api/v1/tools/meshy/generate'],
    ['POST', '/api/v1/tools/blender/optimize'],
    ['POST', '/api/v1/tools/import'],
  ] as const;

  for (const [method, url] of endpoints) {
    it(`${method} ${url} resolves`, async () => {
      const response = await context.app.inject({ method, url, payload: {} });
      // Unauthenticated, so 401 is the expected outcome — the point is that it is not 404.
      expect(response.statusCode).not.toBe(404);
    });
  }

  it('refuses a role without asset:upload-own', async () => {
    const viewer = await login(context.app, DEMO.users.auroraViewer);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/tools/integrations',
      headers: { cookie: cookieHeader(viewer.cookies, 'vs_access') },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('UC-09 import — the download URL is not a free-form fetch', () => {
  /*
   * Each case is refused *before* any request goes out, which is why the assertion is on `requested`
   * and not only on the status code.
   */
  const refusals = [
    ['a non-vendor host', 'https://evil.example.com/model.glb'],
    ['a look-alike domain', 'https://evil-sketchfab.com/model.glb'],
    ['the cloud metadata service', 'https://169.254.169.254/latest/meta-data/model.glb'],
    ['a Compose sibling', 'https://postgres:5432/model.glb'],
    ['plain http', 'http://media.sketchfab.com/model.glb'],
    ['a vendor that is not the claimed source', 'https://poly.pizza/model.glb'],
  ] as const;

  for (const [label, downloadUrl] of refusals) {
    it(`refuses ${label} without fetching it`, async () => {
      requested = [];
      const cookie = await creatorCookie();

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/v1/tools/import',
        headers: { cookie },
        payload: importBody({ downloadUrl }),
      });

      expect(response.statusCode).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_ERROR');
      expect(requested).toEqual([]);
    });
  }

  it('accepts a subdomain of the named vendor', async () => {
    // The guard allows subdomains deliberately — vendors serve downloads from a CDN host — so the
    // test pins that it is a *subdomain* rule and not an exact-host one.
    requested = [];
    respond = () => Promise.reject(new Error('unreachable in this test'));
    const cookie = await creatorCookie();

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tools/import',
      headers: { cookie },
      payload: importBody({ downloadUrl: 'https://cdn.deep.sketchfab.com/model.glb' }),
    });

    // It got as far as the fetch, which is the assertion. The download itself fails below.
    expect(requested).toEqual(['https://cdn.deep.sketchfab.com/model.glb']);
    expect(response.statusCode).toBe(503);
  });
});

describe('UC-09 import — a vendor result becomes a draft asset', () => {
  it('stages the file and records it as a draft with attribution', async () => {
    respond = async () => glbResponse(FIXTURE_TRIANGLES, 'model/gltf-binary');

    const cookie = await creatorCookie();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tools/import',
      headers: { cookie },
      payload: importBody({
        license: 'CC-BY-4.0',
        attribution: 'Model by A. Author',
        sourceUrl: 'https://sketchfab.com/3d-models/abc123',
      }),
    });

    expect(response.statusCode).toBe(201);
    const asset = (response.json() as { asset: Record<string, unknown> }).asset;
    const assetId = asset['id'] as string;

    try {
      // UC-09 — a *draft*. An unexamined third-party file must not appear in the review queue as
      // though its importer had vouched for it.
      expect(asset['status']).toBe('draft');

      const version = asset['currentVersion'] as Record<string, unknown>;
      expect(version['format']).toBe('.glb');
      // The extension came from the URL, and the geometry was measured by the same ingest path an
      // upload uses — which is the point of staging rather than writing rows directly.
      expect(version['polycount']).toBe(FIXTURE_TRIANGLES);
      expect(version['pinStatus']).toBe('pending');

      // NFR-COMP.1 — provenance travels with the asset.
      const row = await withTenant(DEMO_TENANT_IDS.aurora, (db) =>
        db.assetVersion.findUnique({
          where: { id: version['id'] as string },
          select: {
            sourceTool: true,
            sourceLicense: true,
            sourceAttribution: true,
            sourceUrl: true,
          },
        }),
      );
      expect(row?.sourceTool).toBe('Sketchfab');
      expect(row?.sourceLicense).toBe('CC-BY-4.0');
      expect(row?.sourceAttribution).toBe('Model by A. Author');
      expect(row?.sourceUrl).toBe('https://sketchfab.com/3d-models/abc123');
    } finally {
      await dropAsset(assetId);
    }
  });

  it('reports an unreachable vendor as 503, not as a failure of this service', async () => {
    respond = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const cookie = await creatorCookie();

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tools/import',
      headers: { cookie },
      payload: importBody(),
    });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { code: string }).code).toBe('VENDOR_UNREACHABLE');
  });

  it('reports a vendor refusal as 503, with the upstream status in details', async () => {
    respond = async () => new Response('gone', { status: 404 });
    const cookie = await creatorCookie();

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tools/import',
      headers: { cookie },
      payload: importBody(),
    });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { code: string; message: string; details: { status: number } };
    expect(body.code).toBe('VENDOR_DOWNLOAD_FAILED');
    /*
     * The message is deliberately generic, and asserting that is the point rather than an
     * inconvenience: the error handler's documented contract is that a 5xx message is never leaked,
     * because an upstream failure's text can carry a hostname. What a client branches on is `code`,
     * and what tells it *why* is `details` — so both are pinned here, and the generic message is
     * pinned too, so that exposing it later is a deliberate change rather than a quiet one.
     */
    expect(body.message).toBe('Internal server error');
    expect(body.details.status).toBe(404);
  });

  it('refuses a format it cannot identify, and creates nothing', async () => {
    // A vendor serving an opaque payload with no extension to fall back on. Guessing here would
    // produce a file whose format is a coin toss, so it is refused with what was actually seen.
    respond = async () => glbResponse(4, 'application/octet-stream');

    const cookie = await creatorCookie();
    const countAssets = () =>
      withTenant(DEMO_TENANT_IDS.aurora, (db) =>
        db.asset.count({ where: { tenantId: DEMO_TENANT_IDS.aurora } }),
      );
    const before = await countAssets();

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/tools/import',
      headers: { cookie },
      payload: importBody({ downloadUrl: 'https://media.sketchfab.com/models/abc/download' }),
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('Cannot tell what format');
    expect(await countAssets()).toBe(before);
  });
});
