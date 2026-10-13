/**
 * Geometry arithmetic shared by the 3D preview (SRS §6.3, FR-5.2, FR-8.1).
 *
 * Kept free of three.js and React on purpose. The preview needs to answer two questions that are
 * really arithmetic — "what did the browser decode from this file?" and "does that agree with the
 * record?" — and both of them are worth testing directly, without a WebGL context to render into.
 * So `measureScene` accepts anything with a `traverse` method, which a three.js `Object3D` and a
 * hand-written stub both satisfy.
 */

/** What the browser decoded from a model file, measured on the geometry that reached the GPU. */
export interface DecodedGeometry {
  readonly meshes: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly extent: { readonly x: number; readonly y: number; readonly z: number };
}

/** The slice of a three.js mesh this module reads. Structural, so it needs no three.js import. */
interface TraversableMesh {
  isMesh?: boolean;
  geometry?: {
    index?: { count: number } | null;
    attributes?: { position?: { count: number } };
    computeBoundingBox?: () => void;
    boundingBox?: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    } | null;
  };
}

/** Anything that can walk its own object graph — a three.js `Object3D`, or a test stub. */
export interface Traversable {
  traverse: (visit: (object: unknown) => void) => void;
}

export const EMPTY_GEOMETRY: DecodedGeometry = {
  meshes: 0,
  triangles: 0,
  vertices: 0,
  extent: { x: 0, y: 0, z: 0 },
};

/**
 * Measures a loaded scene: mesh count, triangles, vertices, and the bounds of the geometry itself.
 *
 * Triangles come from the index when there is one and from the position attribute when there is
 * not, because glTF permits either and exporters use both. A mesh with no position attribute
 * contributes nothing rather than a NaN, so a scene full of lights and empties measures as empty.
 */
export function measureScene(root: Traversable): DecodedGeometry {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  root.traverse((object) => {
    const mesh = object as TraversableMesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const geometry = mesh.geometry;
    meshes += 1;

    const positionCount = geometry.attributes?.position?.count ?? 0;
    vertices += positionCount;
    triangles += Math.floor((geometry.index ? geometry.index.count : positionCount) / 3);

    geometry.computeBoundingBox?.();
    const box = geometry.boundingBox;
    if (!box) return;
    min.x = Math.min(min.x, box.min.x);
    min.y = Math.min(min.y, box.min.y);
    min.z = Math.min(min.z, box.min.z);
    max.x = Math.max(max.x, box.max.x);
    max.y = Math.max(max.y, box.max.y);
    max.z = Math.max(max.z, box.max.z);
  });

  const span = (low: number, high: number) =>
    Number.isFinite(low) && Number.isFinite(high) ? high - low : 0;

  return {
    meshes,
    triangles,
    vertices,
    extent: { x: span(min.x, max.x), y: span(min.y, max.y), z: span(min.z, max.z) },
  };
}

export type AgreementStatus = 'match' | 'mismatch' | 'unknown';

export interface Agreement {
  readonly status: AgreementStatus;
  /** Signed difference: decoded − recorded. Zero unless the status is `mismatch`. */
  readonly delta: number;
  /** Human-readable explanation, shown as the tooltip on the readout. */
  readonly reason: string;
}

/**
 * Compares the triangle count held on the asset record with the one the browser decoded.
 *
 * A tolerance rather than exact equality. Re-exporting a GLB can split or merge primitives and
 * exporters disagree on whether the count means triangles or faces, so a hair of drift is not
 * evidence of anything. Past that, though, a version whose record does not describe its file is a
 * licence-integrity problem — the thing the user is being asked to trust is the record — so it is
 * reported rather than smoothed over.
 */
export function comparePolycount(recorded: number | null, decoded: number): Agreement {
  if (recorded === null || !Number.isFinite(recorded) || recorded <= 0) {
    return {
      status: 'unknown',
      delta: 0,
      reason: 'No triangle count is recorded for this version, so there is nothing to compare.',
    };
  }

  if (decoded === 0) {
    return {
      status: 'unknown',
      delta: 0,
      reason: 'The viewer decoded no geometry, so the record cannot be checked against it.',
    };
  }

  const delta = decoded - recorded;
  const tolerance = Math.max(TOLERANCE_FLOOR, recorded * TOLERANCE_RATIO);

  if (Math.abs(delta) <= tolerance) {
    return {
      status: 'match',
      delta,
      reason: `The record's ${formatCount(recorded)} triangles match the file in the gateway.`,
    };
  }

  return {
    status: 'mismatch',
    delta,
    reason:
      `The record says ${formatCount(recorded)} triangles; the file in the gateway decodes to ` +
      `${formatCount(decoded)}. One of the two is wrong — check the version rather than trusting ` +
      'the record.',
  };
}

/**
 * Tolerance for the triangle-count comparison.
 *
 * The floor keeps small models honest: 2% of a 40-triangle placeholder is under a single triangle,
 * so without it any sub-triangle rounding would read as a mismatch. The ratio then scales for
 * production scans, where exporters legitimately differ by a handful of polygons in the tens of
 * thousands.
 */
export const TOLERANCE_FLOOR = 16;
export const TOLERANCE_RATIO = 0.02;

/** Thousands-separated count, so a 247170-triangle scan reads as `247,170`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/* -------------------------------------------------------------------------------------------
 * Scene inventory
 *
 * `measureScene` answers "how big is this?". A 3D artist asking whether a file is fit to license
 * asks more than that: how many materials will I have to manage, are the textures embedded, is it
 * rigged, do I have to author lighting. Those are all countable from the object graph, so they are
 * counted here rather than guessed at in the viewer.
 * ----------------------------------------------------------------------------------------- */

/** One material as it will be presented in the studio's inventory panel. */
export interface MaterialSummary {
  readonly name: string;
  /** `#rrggbb`, or null when the material carries no colour (e.g. an untextured physical sheet). */
  readonly color: string | null;
  /** The three.js class, shortened for display: `MeshStandardMaterial` → `Standard`. */
  readonly kind: string;
  readonly metalness: number | null;
  readonly roughness: number | null;
  /** True when the material resolves any texture map at all. */
  readonly textured: boolean;
  /** True when the material is double-sided, which usually means thin geometry. */
  readonly doubleSided: boolean;
}

export interface SceneSummary {
  readonly materials: MaterialSummary[];
  /** Distinct texture maps referenced across every material. */
  readonly textures: number;
  /** Bones in the skeleton, so a rigged file is obvious before it is licensed. */
  readonly bones: number;
  readonly skinnedMeshes: number;
  /** Non-mesh, non-bone objects that only carry a transform — usually a messy export. */
  readonly emptyNodes: number;
}

export const EMPTY_SUMMARY: SceneSummary = {
  materials: [],
  textures: 0,
  bones: 0,
  skinnedMeshes: 0,
  emptyNodes: 0,
};

/** Shrinks a three.js material class name to the part a person recognises. */
export function shortMaterialKind(type: string): string {
  return type.replace(/^Mesh/, '').replace(/Material$/, '') || type;
}

/** Structural slice of a material this module reads. */
interface InspectableMaterial {
  type?: string;
  name?: string;
  color?: { getHexString?: () => string };
  metalness?: number;
  roughness?: number;
  side?: number;
  transparent?: boolean;
  map?: unknown;
  normalMap?: unknown;
  roughnessMap?: unknown;
  metalnessMap?: unknown;
  aoMap?: unknown;
  emissiveMap?: unknown;
  alphaMap?: unknown;
  [key: string]: unknown;
}

/**
 * Buckets every material, counts distinct textures, and finds rigging.
 *
 * Materials are deduplicated by identity: a GLB that instances one material across forty meshes
 * should report one material, not forty. Textures are counted by identity too, and only from the
 * map slots that actually carry image data, so a shadow-receiving `aoMap` on a plain colour is not
 * miscounted as a texture.
 */
export function summariseScene(root: Traversable): SceneSummary {
  const materials = new Map<InspectableMaterial, MaterialSummary>();
  const textures = new Set<unknown>();
  let bones = 0;
  let skinnedMeshes = 0;
  let emptyNodes = 0;

  const TEXTURE_SLOTS = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
    'alphaMap',
  ] as const;

  root.traverse((object) => {
    const node = object as {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      isBone?: boolean;
      isLight?: boolean;
      isCamera?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      children?: unknown[];
      material?: InspectableMaterial | InspectableMaterial[];
      skeleton?: { bones?: unknown[] };
    };

    if (node.isBone) {
      bones += 1;
      return;
    }

    if (node.isMesh) {
      if (node.isSkinnedMesh) skinnedMeshes += 1;

      const list = Array.isArray(node.material)
        ? node.material
        : node.material
          ? [node.material]
          : [];

      for (const material of list) {
        for (const slot of TEXTURE_SLOTS) {
          const texture = material[slot];
          if (texture) textures.add(texture);
        }

        if (materials.has(material)) continue;

        materials.set(material, {
          name: material.name && material.name.length > 0 ? material.name : '',
          color: material.color?.getHexString ? `#${material.color.getHexString()}` : null,
          kind: shortMaterialKind(material.type ?? 'Material'),
          metalness: typeof material.metalness === 'number' ? material.metalness : null,
          roughness: typeof material.roughness === 'number' ? material.roughness : null,
          textured: TEXTURE_SLOTS.some((slot) => Boolean(material[slot])),
          doubleSided: material.side === 2,
        });
      }
      return;
    }

    // A node with a transform but nothing to draw is dead weight in an export. Counting it is a
    // cheap way to show an artist that a file needs cleaning before it ships.
    if (
      node.children &&
      node.children.length === 0 &&
      !node.isLight &&
      !node.isCamera &&
      !node.isPoints &&
      !node.isLine &&
      !node.isBone
    ) {
      emptyNodes += 1;
    }
  });

  return {
    materials: [...materials.values()],
    textures: textures.size,
    bones,
    skinnedMeshes,
    emptyNodes,
  };
}
