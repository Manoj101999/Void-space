/**
 * GLB fixture generator tests.
 *
 * These matter more than they look: the generator is what makes every seeded demo asset
 * previewable, and seeding is idempotent *because* the bytes are deterministic. A regression
 * here would either break the viewer or silently rewrite CIDs on every reseed.
 */
import { describe, expect, it } from 'vitest';

import { buildGlbFixture } from '../src/glb-fixture';

/** The subset of the glTF JSON document these tests read. */
interface GltfDocument {
  readonly asset: { readonly version: string };
  readonly meshes: { readonly primitives: { readonly attributes: Record<string, number> }[] }[];
  readonly accessors: {
    readonly count: number;
    readonly componentType: number;
    readonly min?: readonly number[];
    readonly max?: readonly number[];
  }[];
  readonly bufferViews: readonly { readonly byteOffset: number }[];
  readonly buffers: readonly { readonly byteLength: number }[];
}

/** Reads the JSON chunk out of a GLB. */
function readJsonChunk(glb: Buffer): GltfDocument {
  expect(glb.subarray(0, 4).toString('ascii')).toBe('glTF');
  expect(glb.readUInt32LE(4)).toBe(2); // version
  expect(glb.readUInt32LE(8)).toBe(glb.length); // declared length must match

  const jsonLength = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON'
  return JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as GltfDocument;
}

/**
 * Indexed access under `noUncheckedIndexedAccess`.
 *
 * The assertions below would otherwise be `possibly undefined` errors, and a missing element
 * should fail the test with a clear message rather than a type complaint.
 */
function at<T>(items: readonly T[], index: number, what: string): T {
  const found = items[index];
  if (found === undefined) throw new Error(`fixture is missing ${what} at index ${index}`);
  return found;
}

describe('buildGlbFixture', () => {
  it('emits a well-formed GLB', () => {
    const glb = buildGlbFixture(12);
    const gltf = readJsonChunk(glb);

    expect(gltf.asset.version).toBe('2.0');
    const primitive = at(at(gltf.meshes, 0, 'mesh').primitives, 0, 'primitive');
    expect(primitive.attributes).toEqual({ POSITION: 0, NORMAL: 1 });
    expect(at(gltf.buffers, 0, 'buffer').byteLength).toBeGreaterThan(0);
  });

  it('produces exactly the requested triangle count in the index accessor', () => {
    const gltf = readJsonChunk(buildGlbFixture(500));
    const indexAccessor = at(gltf.accessors, 2, 'index accessor');

    expect(indexAccessor.count).toBe(1500); // 3 indices per triangle
    expect(at(gltf.accessors, 0, 'position accessor').count).toBe(1500); // 3 vertices per triangle
  });

  it('declares POSITION min/max, which GLTFLoader requires', () => {
    const gltf = readJsonChunk(buildGlbFixture(8));

    const positionAccessor = at(gltf.accessors, 0, 'position accessor');
    expect(positionAccessor.min).toEqual([-0.5, -0.5, -0.5]);
    expect(positionAccessor.max).toEqual([0.5, 0.5, 0.5]);
  });

  it('uses 16-bit indices while vertices fit, and 32-bit beyond that', () => {
    const small = readJsonChunk(buildGlbFixture(100));
    const large = readJsonChunk(buildGlbFixture(100_000));

    expect(at(small.accessors, 2, 'index accessor').componentType).toBe(5123); // UNSIGNED_SHORT
    expect(at(large.accessors, 2, 'index accessor').componentType).toBe(5125); // UNSIGNED_INT
  });

  it('is byte-for-byte deterministic, so reseeding does not rewrite CIDs', () => {
    expect(buildGlbFixture(250).equals(buildGlbFixture(250))).toBe(true);
    expect(buildGlbFixture(250).equals(buildGlbFixture(251))).toBe(false);
  });

  it('aligns every buffer view to 4 bytes, as glTF requires', () => {
    const gltf = readJsonChunk(buildGlbFixture(37));

    for (const view of gltf.bufferViews) {
      expect(view.byteOffset % 4).toBe(0);
    }
  });

  it('rejects a non-positive or fractional triangle count', () => {
    expect(() => buildGlbFixture(0)).toThrow(/positive integer/);
    expect(() => buildGlbFixture(1.5)).toThrow(/positive integer/);
  });
});
