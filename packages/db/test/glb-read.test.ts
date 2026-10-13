/**
 * GLB reader tests (`packages/db/src/glb-read.ts`).
 *
 * Two levels of coverage on purpose:
 *
 *  - `metadataFromGltfJson` is asserted against hand-written documents, which is where the
 *    interesting cases live: several meshes, non-triangle primitives, and a document without
 *    POSITION min/max (the reader must report a null bounding box rather than Infinity).
 *  - `readGlbMetadata` / `metadataFromGlbBuffer` are asserted against a *real* container built by
 *    `buildGlbFixture`, so the header, chunk offsets and padding are exercised too.
 */
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGlbFixture } from '../src/glb-fixture';
import {
  exceedsPolycountBudget,
  metadataFromGlbBuffer,
  metadataFromGltfJson,
  readGlbMetadata,
} from '../src/glb-read';

const FIXTURE_TRIANGLES = 2500;

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'void-space-glb-'));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeTemp(name: string, content: Buffer): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, content);
  return path;
}

describe('readGlbMetadata', () => {
  it('reads triangle count and bounds from a real GLB on disk', async () => {
    const path = await writeTemp('fixture.glb', buildGlbFixture(FIXTURE_TRIANGLES));
    const metadata = await readGlbMetadata(path);

    expect(metadata?.polycount).toBe(FIXTURE_TRIANGLES);
    expect(metadata?.vertices).toBe(FIXTURE_TRIANGLES * 3);
    expect(metadata?.boundingBox).toEqual({
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    });
  });

  it('scales with the geometry rather than the file size', async () => {
    const path = await writeTemp('bigger.glb', buildGlbFixture(FIXTURE_TRIANGLES * 2));
    expect((await readGlbMetadata(path))?.polycount).toBe(FIXTURE_TRIANGLES * 2);
  });

  it('returns null for a file that only claims to be a GLB', async () => {
    const path = await writeTemp('fake.glb', Buffer.from('not really a glb', 'utf8'));
    expect(await readGlbMetadata(path)).toBeNull();
  });

  it('returns null for a truncated header', async () => {
    const path = await writeTemp('short.glb', buildGlbFixture(12).subarray(0, 8));
    expect(await readGlbMetadata(path)).toBeNull();
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await readGlbMetadata(join(workdir, 'absent.glb'))).toBeNull();
  });
});

describe('metadataFromGlbBuffer', () => {
  it('agrees with the on-disk reader', async () => {
    const glb = buildGlbFixture(96);
    const path = await writeTemp('buffer.glb', glb);

    expect(metadataFromGlbBuffer(glb)).toEqual(await readGlbMetadata(path));
  });

  it('returns null for a buffer that is not a GLB', () => {
    expect(metadataFromGlbBuffer(Buffer.from('nope'))).toBeNull();
  });
});

describe('metadataFromGltfJson', () => {
  it('sums triangles and vertices across several meshes', () => {
    const metadata = metadataFromGltfJson({
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
        { primitives: [{ attributes: { POSITION: 2 }, indices: 3 }] },
      ],
      accessors: [
        { count: 1200, type: 'VEC3' },
        { count: 6000, type: 'SCALAR' },
        { count: 300, type: 'VEC3' },
        { count: 1500, type: 'SCALAR' },
      ],
      materials: [{}, {}],
      animations: [{}],
      textures: [{ source: 0 }],
      images: [{ name: 'albedo' }],
    });

    expect(metadata.polycount).toBe(2500);
    expect(metadata.vertices).toBe(1500);
    expect(metadata.materials).toBe(2);
    expect(metadata.animations).toBe(1);
    expect(metadata.textures).toBe(1);
  });

  it('ignores primitives that are not triangles', () => {
    const metadata = metadataFromGltfJson({
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 1 }] }],
      accessors: [{ count: 900 }, { count: 900 }],
    });

    expect(metadata.polycount).toBeNull();
    expect(metadata.vertices).toBe(900);
  });

  it('counts an unindexed primitive by its vertices', () => {
    const metadata = metadataFromGltfJson({
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 300 }],
    });

    expect(metadata.polycount).toBe(100);
  });

  it('reports a null bounding box when POSITION min/max are absent', () => {
    const metadata = metadataFromGltfJson({
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 300 }],
    });

    expect(metadata.boundingBox).toBeNull();
  });

  it('reports a null bounding box for an empty document', () => {
    const metadata = metadataFromGltfJson({ asset: {} });

    expect(metadata.polycount).toBeNull();
    expect(metadata.vertices).toBeNull();
    expect(metadata.boundingBox).toBeNull();
  });
});

describe('exceedsPolycountBudget', () => {
  const over = { polycount: 128_400 } as never;
  const under = { polycount: 12_000 } as never;

  it('compares against the workspace budget when both are present', () => {
    expect(exceedsPolycountBudget(over, 50_000)).toBe(true);
    expect(exceedsPolycountBudget(under, 50_000)).toBe(false);
  });

  it('stays silent when either side is unknown', () => {
    expect(exceedsPolycountBudget(over, null)).toBe(false);
    expect(exceedsPolycountBudget(null, 50_000)).toBe(false);
  });
});
