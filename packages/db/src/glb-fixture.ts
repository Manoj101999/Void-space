/**
 * Deterministic GLB fixture generator.
 *
 * Why this exists: the demo workspace must actually *preview*. A hand-written GLB whose
 * accessors are declared but whose binary chunk is empty is not a model — three.js rejects it
 * (`Invalid typed array length`), so every seeded asset landed on the viewer's fault panel.
 *
 * The generator produces a faceted sphere with an exact triangle count, so the geometry agrees
 * with the `polycount` the seed records. Output is deterministic (no randomness), so re-running
 * the seed yields identical bytes and therefore an identical CID, keeping seeding idempotent.
 */
import { Buffer } from 'node:buffer';

const HEADER_BYTES = 12;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

/** Pads a buffer to a 4-byte boundary, as glTF requires between buffer views. */
function pad4(buffer: Buffer): Buffer {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder)]);
}

/**
 * Builds a GLB holding `triangles` flat-shaded triangles arranged over a sphere.
 *
 * Vertices are duplicated per triangle so each face gets a correct flat normal — the layout a
 * modelling tool exports for hard-edged geometry.
 */
export function buildGlbFixture(triangles: number): Buffer {
  if (!Number.isInteger(triangles) || triangles < 1) {
    throw new Error(`[glb-fixture] triangles must be a positive integer (received ${triangles})`);
  }

  const radius = 0.5;
  const plate = radius * 0.045;
  // Golden-angle spiral: an even, deterministic distribution over the sphere.
  const goldenAngle = Math.PI * (1 + Math.sqrt(5));

  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const indices = new Uint32Array(triangles * 3);

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const t = (triangle + 0.5) / triangles;
    const phi = Math.acos(1 - 2 * t);
    const theta = goldenAngle * triangle;

    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.sin(phi) * Math.sin(theta);
    const nz = Math.cos(phi);
    const center: readonly number[] = [nx * radius, ny * radius, nz * radius];

    // Tangent frame around the surface normal, used to lay each triangle flat on the sphere.
    const up: readonly number[] = Math.abs(nz) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const tx = (up[1] as number) * nz - (up[2] as number) * ny;
    const ty = (up[2] as number) * nx - (up[0] as number) * nz;
    const tz = (up[0] as number) * ny - (up[1] as number) * nx;
    const tLength = Math.hypot(tx, ty, tz) || 1;
    const u: readonly number[] = [tx / tLength, ty / tLength, tz / tLength];
    const v: readonly number[] = [
      ny * (u[2] as number) - nz * (u[1] as number),
      nz * (u[0] as number) - nx * (u[2] as number),
      nx * (u[1] as number) - ny * (u[0] as number),
    ];

    // An equilateral triangle centred on the surface point.
    const offsets: readonly (readonly [number, number])[] = [
      [0, (2 / 3) * plate],
      [(-Math.sqrt(3) / 3) * plate, (-1 / 3) * plate],
      [(Math.sqrt(3) / 3) * plate, (-1 / 3) * plate],
    ];

    for (let corner = 0; corner < 3; corner += 1) {
      const [a, b] = offsets[corner] as readonly [number, number];
      const base = (triangle * 3 + corner) * 3;
      positions[base] = (center[0] as number) + (u[0] as number) * a + (v[0] as number) * b;
      positions[base + 1] = (center[1] as number) + (u[1] as number) * a + (v[1] as number) * b;
      positions[base + 2] = (center[2] as number) + (u[2] as number) * a + (v[2] as number) * b;
      normals[base] = nx;
      normals[base + 1] = ny;
      normals[base + 2] = nz;
    }

    const indexBase = triangle * 3;
    indices[indexBase] = triangle * 3;
    indices[indexBase + 1] = triangle * 3 + 1;
    indices[indexBase + 2] = triangle * 3 + 2;
  }

  return assembleGlb({ positions, normals, indices, radius, triangles });
}

interface MeshBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly radius: number;
  readonly triangles: number;
}

/** Serialises the mesh into a single-buffer GLB with its JSON chunk. */
function assembleGlb(mesh: MeshBuffers): Buffer {
  const positionBuffer = Buffer.from(mesh.positions.buffer);
  const normalBuffer = Buffer.from(mesh.normals.buffer);
  // Uint16 indices are only valid while every vertex index fits in 16 bits.
  const needsWideIndices = mesh.triangles * 3 > 65_535;
  const indexBuffer = Buffer.from(
    needsWideIndices ? mesh.indices.buffer : new Uint16Array(mesh.indices).buffer,
  );

  const positionPadded = pad4(positionBuffer);
  const normalPadded = pad4(normalBuffer);
  const indexPadded = pad4(indexBuffer);
  const binary = Buffer.concat([positionPadded, normalPadded, indexPadded]);

  const gltf = {
    asset: { version: '2.0', generator: 'void-space/glb-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'DemoGeometry' }],
    meshes: [
      {
        name: 'DemoGeometry',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'Placeholder',
        pbrMetallicRoughness: {
          baseColorFactor: [0.85, 0.55, 0.15, 1],
          metallicFactor: 0.1,
          roughnessFactor: 0.75,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: FLOAT,
        count: mesh.positions.length / 3,
        type: 'VEC3',
        // min/max are mandatory for POSITION; omitting them is a GLTFLoader warning.
        min: [-mesh.radius, -mesh.radius, -mesh.radius],
        max: [mesh.radius, mesh.radius, mesh.radius],
      },
      { bufferView: 1, componentType: FLOAT, count: mesh.normals.length / 3, type: 'VEC3' },
      {
        bufferView: 2,
        componentType: needsWideIndices ? UNSIGNED_INT : UNSIGNED_SHORT,
        count: mesh.indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: positionPadded.length,
        byteLength: normalBuffer.length,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: positionPadded.length + normalPadded.length,
        byteLength: indexBuffer.length,
        target: 34963,
      },
    ],
    buffers: [{ byteLength: binary.length }],
  };

  // JSON chunks are space-padded (0x20), binary chunks zero-padded.
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (json.length % 4 !== 0) {
    json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  }

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  const body = Buffer.concat([jsonHeader, json, binaryHeader, binary]);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(HEADER_BYTES + body.length, 8);

  return Buffer.concat([header, body]);
}
