/**
 * Asset ingestion acceptance tests (SRS FR-3.x, FR-4.x, §5.1, NFR-SEC.3).
 *
 * Uploads are driven as real `multipart/form-data` bodies, so the tests exercise the same
 * streaming path a browser uses — including the extension/MIME checks and the documented
 * "fields before file" contract.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEMO,
  cookieHeader,
  createTestApp,
  DEMO_TENANT_IDS,
  login,
  removeTestAssets,
  type TestApp,
} from './helpers';
import { buildGlbFixture, withTenant } from '@void-space/db';

let context: TestApp;

/**
 * Uploads use genuinely renderable geometry (the same generator the seed uses) rather than a
 * synthetic container: the ingest path is then exercised against a file a viewer can also open.
 */
const FIXTURE_TRIANGLES = 2500;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  // Leave the development database as we found it.
  await removeTestAssets(DEMO_TENANT_IDS.aurora);
  await context?.close();
});

interface MultipartFile {
  readonly field: string;
  readonly filename: string;
  readonly mime: string;
  readonly content: Buffer;
}

/**
 * Builds a multipart body by hand. Field parts come first, which is the contract the
 * upload route documents (it validates only once the file has landed).
 */
function multipartBody(
  fields: Record<string, string>,
  file?: MultipartFile,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----voidspaceTest${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(
  cookie: string,
  fields: Record<string, string>,
  file: MultipartFile,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const { payload, headers } = multipartBody(fields, file);
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: { cookie, ...headers },
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

const glbFile = (name = 'helmet.glb', sizeMultiplier = 1): MultipartFile => ({
  field: 'file',
  filename: name,
  mime: 'model/gltf-binary',
  content: buildGlbFixture(FIXTURE_TRIANGLES * sizeMultiplier),
});

describe('FR-3.1 upload acceptance', () => {
  it('accepts a GLB, parses its mesh metadata and queues both jobs', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      {
        name: `Test Helmet ${randomUUID().slice(0, 6)}`,
        category: 'Safety Equipment',
        tags: 'helmet,safety',
        sourceTool: 'Blender',
        submitForReview: 'true',
      },
      glbFile(),
    );

    expect(statusCode).toBe(201);
    const asset = body['asset'] as Record<string, unknown>;
    expect(asset['status']).toBe('pending');

    const version = asset['currentVersion'] as Record<string, unknown>;
    expect(version['format']).toBe('.glb');
    expect(version['versionNumber']).toBe(1);
    expect(version['pinStatus']).toBe('pending');
    // §6.3 — geometry is read from the GLB's JSON chunk at ingest.
    expect(version['polycount']).toBe(FIXTURE_TRIANGLES);

    // `jobs[].queue` is the §3.10 vocabulary, not the `jobs.queue` column spelling: the API
    // normalises `ipfs_pin` to `ipfs-pin` through `queueNameFromDb`, so the same job is named
    // the same way here, in the publish response's `chainLicenseJobId` and in GET /jobs/{id}.
    // This assertion previously pinned the leaked enum value, which is how the inconsistency
    // survived: a test can preserve a bug as easily as it can catch one.
    const queues = (asset['jobs'] as { queue: string }[]).map((job) => job.queue);
    expect(queues).toContain('ipfs-pin');
    expect(queues).toContain('ai-enrichment');

    const actions = (asset['auditTrail'] as { action: string }[]).map((entry) => entry.action);
    expect(actions).toContain('asset.created');
    expect(actions).toContain('asset.submitted');
  });

  it('saves a draft when submission is not requested', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: `Draft ${randomUUID().slice(0, 6)}`, category: 'Prop', submitForReview: 'false' },
      glbFile('draft.glb'),
    );

    expect(statusCode).toBe(201);
    const asset = body['asset'] as Record<string, unknown>;
    expect(asset['status']).toBe('draft');
    // No AI enrichment for a draft: it is not in the review path yet.
    const queues = (asset['jobs'] as { queue: string }[]).map((job) => job.queue);
    expect(queues).toContain('ipfs-pin');
    expect(queues).not.toContain('ai-enrichment');
  });

  it('rejects an unsupported extension with the allowed list (NFR-SEC.3)', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: 'Malicious', category: 'Prop', submitForReview: 'true' },
      {
        field: 'file',
        filename: 'payload.exe',
        mime: 'application/octet-stream',
        content: Buffer.from('MZ'),
      },
    );

    expect(statusCode).toBe(400);
    expect(body['code']).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body['details'])).toContain('.glb');
  });

  it('rejects a declared MIME type that contradicts the extension', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: 'Mislabelled', category: 'Prop', submitForReview: 'true' },
      { field: 'file', filename: 'model.glb', mime: 'text/html', content: buildGlbFixture(FIXTURE_TRIANGLES) },
    );

    expect(statusCode).toBe(400);
    expect(String(body['message'])).toContain('not accepted');
  });

  it('rejects a category the workspace does not allow (FR-14.3)', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: 'Wrong category', category: 'Not A Real Category', submitForReview: 'true' },
      glbFile(),
    );

    expect(statusCode).toBe(409);
    expect(body['code']).toBe('CATEGORY_NOT_ALLOWED');
    expect(JSON.stringify(body['details'])).toContain('Machinery');
  });

  it('rejects an upload with no file part', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { payload, headers } = multipartBody({ name: 'No file', category: 'Prop' });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { cookie, ...headers },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('No file part');
  });

  it('refuses uploads from a role without asset:upload-own', async () => {
    const viewer = await login(context.app, DEMO.users.auroraViewer);
    const cookie = cookieHeader(viewer.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: 'Viewer upload', category: 'Prop', submitForReview: 'true' },
      glbFile(),
    );

    expect(statusCode).toBe(403);
    expect(body['code']).toBe('READ_ONLY_TOKEN');
  });
});

describe('error envelope contract', () => {
  it('returns code, details and requestId for a failing route, not Fastify’s default body', async () => {
    // Regression guard: the error handler has to be installed *before* the feature modules
    // are registered, otherwise plugin-scoped routes fall back to Fastify's
    // `{statusCode, error, message}` shape and silently lose `code`/`details`/`requestId`.
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: 'Bad file', category: 'Prop', submitForReview: 'true' },
      {
        field: 'file',
        filename: 'evil.exe',
        mime: 'application/octet-stream',
        content: Buffer.from('MZ'),
      },
    );

    expect(statusCode).toBe(400);
    expect(typeof body['code']).toBe('string');
    expect(typeof body['requestId']).toBe('string');
    expect(typeof body['timestamp']).toBe('string');
    expect(body['details']).toBeDefined();
    expect(JSON.stringify(body['details'])).toContain('.blend');
  });

  it('returns the same envelope from a JSON endpoint', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });

    const body = response.json() as Record<string, unknown>;
    expect(response.statusCode).toBe(400);
    expect(body['code']).toBe('VALIDATION_ERROR');
    expect(body['requestId']).toBeTruthy();
    expect(JSON.stringify(body['details'])).toContain('email');
  });
});

describe('form boolean parsing', () => {
  it('honours submitForReview=false sent as a form field', async () => {
    // `z.coerce.boolean()` would read the string "false" as true; this asserts the fix.
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');

    const { statusCode, body } = await upload(
      cookie,
      { name: `Explicit false ${randomUUID().slice(0, 5)}`, category: 'Prop', submitForReview: 'false' },
      glbFile('explicit-false.glb'),
    );

    expect(statusCode).toBe(201);
    expect((body['asset'] as { status: string }).status).toBe('draft');
  });
});

/**
 * FR-9.5/FR-9.6 — a takedown has to actually take the asset down.
 *
 * Revoking a licence does not move the asset out of `published`: §5.1 defines no transition out of
 * that status, and the fact that it was published is worth keeping. So the licence is what gates
 * the catalogue, and this asserts it — otherwise a revoked asset stays on the shelf, rendered with
 * no licence at all because the card reads the *active* one.
 *
 * The licence rows are written directly rather than minted: the question here is the listing
 * query, and driving a real mint would make this test depend on a running chain and the worker
 * for something that is a `where` clause.
 */
describe('marketplace licence gate (FR-9.5)', () => {
  it('lists a published asset only while its licence is active', async () => {
    const creator = await login(context.app, DEMO.users.auroraCreator);
    const cookie = cookieHeader(creator.cookies, 'vs_access');
    const suffix = randomUUID().slice(0, 5);

    const { body } = await upload(
      cookie,
      { name: `Licence gate ${suffix}`, category: 'Prop' },
      glbFile('licence-gate.glb'),
    );
    const assetId = (body['asset'] as { id: string }).id;

    // Put it on the shelf by hand: published, with a licence the contract would call valid.
    await withTenant(DEMO_TENANT_IDS.aurora, async (db) => {
      const asset = await db.asset.findFirstOrThrow({
        where: { id: assetId },
        select: { currentVersion: { select: { id: true } } },
      });
      await db.asset.update({ where: { id: assetId }, data: { status: 'published' } });
      await db.license.create({
        data: {
          tenantId: DEMO_TENANT_IDS.aurora,
          assetId,
          assetVersionId: asset.currentVersion!.id,
          tokenId: BigInt(`0x${suffix}`.slice(0, 12)),
          contractAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
          licenseTermsHash: `0x${'a'.repeat(64)}`,
          licenseType: 'CC-BY',
          status: 'active',
        },
      });
    });

    const listed = async () => {
      const response = await context.app.inject({
        method: 'GET',
        url: '/api/v1/assets?publishedOnly=true&pageSize=100',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as { items: { id: string }[] };
      return page.items.some((item) => item.id === assetId);
    };

    expect(await listed(), 'a published, licensed asset belongs in the catalogue').toBe(true);

    // The takedown.
    await withTenant(DEMO_TENANT_IDS.aurora, (db) =>
      db.license.updateMany({ where: { assetId }, data: { status: 'revoked' } }),
    );

    expect(await listed(), 'a revoked licence must remove the asset from the catalogue').toBe(false);
  });
});

