'use client';

/**
 * 3D inspection studio (SRS §6.3, FR-5.2, FR-8.1).
 *
 * The model is fetched from `/ipfs/<cid>` — the nginx-cached gateway route (FR-8.3) — never from the
 * IPFS node directly, so a repeat preview comes from cache.
 *
 * Why this is a studio and not a spinning picture
 * ----------------------------------------------
 * The person licensing a 3D asset is a 3D artist, and they do not judge a file by how it looks under
 * one light. They want to know whether the topology is clean, whether the normals face outward,
 * whether the UVs are unfolded or a collapsed mess, what the true dimensions are, how many materials
 * and texture maps they are taking on, and whether it animates. Every one of those questions is
 * answerable from the file we are already serving, so the viewer answers them:
 *
 *   - **Shading modes.** Shaded, shaded-with-edges, wireframe, normals, UVs, matcap and unlit each
 *     expose a different failure.
 *   - **Helpers.** Grid, origin axes, bounds, ground shadow and a light/dark stage, because a dark
 *     model on a dark stage is a silhouette.
 *   - **Camera.** Seven standard viewpoints, an orthographic option for checking real proportions
 *     without perspective foreshortening, turntable, and re-frame.
 *   - **Inventory.** Triangle and vertex counts, extent in model units, and the material list with
 *     colour swatches, metalness/roughness and whether each one is textured.
 *   - **Animation.** If the GLB carries clips, they can be selected, scrubbed and speed-adjusted.
 *
 * It also keeps its integrity readout: the triangle count the *record* claims, against the one the
 * browser decoded from the bytes in the gateway. Those are different claims and the difference is
 * the point.
 */
import {
  ContactShadows,
  Grid,
  OrbitControls,
  OrthographicCamera,
  useAnimations,
  useGLTF,
  useProgress,
} from '@react-three/drei';
import { Canvas, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  EMPTY_SUMMARY,
  comparePolycount,
  formatCount,
  measureScene,
  summariseScene,
  type DecodedGeometry,
  type SceneSummary,
} from '@/lib/geometry';
import { shortCid } from '@/lib/format';

/**
 * Kinds of model the viewer can draw.
 *
 * Not a property of the file so much as of the loaders shipped with it: glTF is decoded by
 * `GLTFLoader`, and OBJ, FBX and STL by their own decoders. `.blend` is the one accepted upload
 * format with no browser decoder, so it — and only it — falls back to the download card.
 */
const NATIVE_FORMATS = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl']);

export function canPreviewNatively(format: string): boolean {
  return NATIVE_FORMATS.has(format.toLowerCase().replace(/^\.+/, ''));
}

/** How the surface is drawn. Each one answers a different question about the file. */
export type ShadeMode = 'shaded' | 'edges' | 'wireframe' | 'normals' | 'uv' | 'matcap' | 'unlit';

interface ModeSpec {
  readonly id: ShadeMode;
  readonly label: string;
  /** Keyboard shortcut, shown on the button so the tool is learnable. */
  readonly key: string;
  readonly hint: string;
}

const SHADE_MODES: readonly ModeSpec[] = [
  {
    id: 'shaded',
    label: 'Shaded',
    key: '1',
    hint: 'Lit surface, as the texture author intended it',
  },
  {
    id: 'edges',
    label: 'Edges',
    key: '2',
    hint: 'Shaded surface with the triangulation drawn over it',
  },
  {
    id: 'wireframe',
    label: 'Wireframe',
    key: '3',
    hint: 'Topology only — the fastest way to spot n-gons and stray triangles',
  },
  {
    id: 'normals',
    label: 'Normals',
    key: '4',
    hint: 'Surface direction as colour. Inverted or flipped faces show as banding',
  },
  {
    id: 'uv',
    label: 'UV',
    key: '5',
    hint: 'A checker laid out over the UVs. Stretching and overlaps are visible immediately',
  },
  {
    id: 'matcap',
    label: 'MatCap',
    key: '6',
    hint: 'Neutral lit sphere, so form reads without the asset\u2019s own textures',
  },
  {
    id: 'unlit',
    label: 'Unlit',
    key: '7',
    hint: 'Albedo only, no lighting — catches baked-in shading in the texture',
  },
] as const;

/** Standard viewpoints. `iso` is the three-quarter view a thumbnail should use. */
export type CameraView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

const VIEW_DIRECTIONS: Record<CameraView, readonly [number, number, number]> = {
  iso: [0.55, 0.37, 0.74],
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
};

/**
 * All six orthographic viewpoints plus the three-quarter hero view.
 *
 * A modeller inspecting their own export expects to be able to look at the model from every
 * axis — "front and right" is not enough to check a symmetric part, and a bottom view is the
 * only way to see whether a base has been hollowed out.
 */
const VIEW_BUTTONS: readonly { id: CameraView; label: string; key: string }[] = [
  { id: 'iso', label: 'Isometric', key: '0' },
  { id: 'front', label: 'Front', key: 'F' },
  { id: 'back', label: 'Back', key: 'B' },
  { id: 'left', label: 'Left', key: 'L' },
  { id: 'right', label: 'Right', key: 'R' },
  { id: 'top', label: 'Top', key: 'T' },
  { id: 'bottom', label: 'Bottom', key: 'D' },
];

/**
 * Overlays are capped by triangle budget, not by hope.
 *
 * Drawing every edge of a 247k-triangle scan means about 1.5 million line segments built on the main
 * thread; the tab stops responding. Below the budget the overlay is offered, above it the control is
 * disabled and says why. Silently rendering a two-second freeze would be worse than the missing
 * feature.
 */
const EDGE_TRIANGLE_BUDGET = 150_000;

/**
 * The overlay's line colour, chosen per backdrop rather than fixed.
 *
 * The bounds helper already draws in `#6ea8fe`, so the edge overlay stays in that annotation family
 * instead of introducing a colour of its own. The light value is the same hue driven much darker:
 * at one pixel wide, `#6ea8fe` over the `paper` backdrop is about 2.2:1 and effectively disappears,
 * which would make the mode look broken on the one background where it is easiest to notice.
 */
const EDGE_LINE_NIGHT = '#6ea8fe';
const EDGE_LINE_DAY = '#0f3f96';

/** Backgrounds. A dark asset on a dark stage needs the light option. */
type Backdrop = 'stage' | 'night' | 'paper';

const BACKDROPS: Record<Backdrop, string> = {
  stage: 'radial-gradient(120% 90% at 50% 0%, #1e1e24 0%, #131317 52%, #0c0c0f 100%)',
  night: '#0a0a0c',
  paper: 'radial-gradient(120% 90% at 50% 0%, #f4f4f6 0%, #dcdce1 60%, #c9c9d0 100%)',
};

const BACKDROP_LABEL: Record<Backdrop, string> = { stage: 'Stage', night: 'Dark', paper: 'Light' };

/* ============================================================================================
 * Procedural textures
 *
 * The UV-checker and the matcap are drawn into a canvas at runtime rather than shipped as image
 * files and rather than fetched from a CDN. Two reasons: a few hundred bytes of code beats two
 * binary assets in the bundle, and a viewer that needs the network to draw its *own UI* is broken on
 * the locked-down networks this platform is deployed into.
 * ========================================================================================== */

let uvTextureCache: THREE.Texture | null = null;
let matcapTextureCache: THREE.Texture | null = null;

/**
 * The checker used by the UV mode.
 *
 * Deliberately high-contrast and asymmetric: a red square marks the UV origin, so a flipped or
 * rotated layout is obvious at a glance instead of merely looking "fine".
 */
function getUvTexture(): THREE.Texture {
  if (uvTextureCache) return uvTextureCache;

  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();

  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#2f6fd0' : '#eef0f4';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  ctx.fillStyle = '#ff4d4d';
  ctx.fillRect(0, 0, cell, cell);
  ctx.strokeStyle = '#0a0a0c';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);

  uvTextureCache = new THREE.CanvasTexture(canvas);
  uvTextureCache.colorSpace = THREE.SRGBColorSpace;
  uvTextureCache.wrapS = THREE.RepeatWrapping;
  uvTextureCache.wrapT = THREE.RepeatWrapping;
  uvTextureCache.anisotropy = 4;
  return uvTextureCache;
}

/** A neutral lit-sphere matcap: bright key at upper-left, dark terminator, cool rim. */
function getMatcapTexture(): THREE.Texture {
  if (matcapTextureCache) return matcapTextureCache;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();

  const body = ctx.createRadialGradient(
    size * 0.34,
    size * 0.3,
    size * 0.02,
    size * 0.5,
    size * 0.52,
    size * 0.64,
  );
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.3, '#c8ccd6');
  body.addColorStop(0.68, '#585d6c');
  body.addColorStop(1, '#13151a');
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, size, size);

  const rim = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.34,
    size * 0.5,
    size * 0.5,
    size * 0.5,
  );
  rim.addColorStop(0, 'rgba(110,168,254,0)');
  rim.addColorStop(0.85, 'rgba(110,168,254,0.16)');
  rim.addColorStop(1, 'rgba(110,168,254,0.5)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  matcapTextureCache = new THREE.CanvasTexture(canvas);
  matcapTextureCache.colorSpace = THREE.SRGBColorSpace;
  return matcapTextureCache;
}

/* ============================================================================================
 * Shading modes
 *
 * The clone made when a scene loads is deep *including its materials*. `Object3D.clone(true)`
 * copies the object graph but shares material instances, so a material edited through one viewer
 * leaks into every other viewer on the page — and into the three.js loader cache for good. An
 * earlier revision of this file mutated wireframe on the clone and claimed it was isolated; it was
 * not. Materials are cloned here, once per load, and every mode change mutates only the clones.
 * ========================================================================================== */

/** The materials owned by one prepared scene: mesh → its private clone(s). */
type MaterialMap = Map<THREE.Mesh, THREE.Material | THREE.Material[]>;

/** Builds the substitute material for an inspection mode. */
function makeOverride(source: THREE.Material, mode: ShadeMode): THREE.Material {
  switch (mode) {
    case 'normals':
      return new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

    case 'uv':
      return new THREE.MeshBasicMaterial({
        map: getUvTexture(),
        side: THREE.DoubleSide,
        toneMapped: false,
      });

    case 'matcap':
      return new THREE.MeshMatcapMaterial({ matcap: getMatcapTexture() });

    case 'unlit': {
      const standard = source as THREE.MeshStandardMaterial;
      return new THREE.MeshBasicMaterial({
        map: standard.map ?? null,
        color: standard.color ? standard.color.clone() : new THREE.Color(0xffffff),
        side: standard.side,
        transparent: standard.transparent,
        toneMapped: false,
      });
    }

    default:
      return source;
  }
}

const LIT_MODES = new Set<ShadeMode>(['shaded', 'edges', 'wireframe']);

/**
 * Name stamped on the `LineSegments` an `edges` pass attaches to a mesh.
 *
 * It is how the *next* pass finds that overlay again. `applyShadeMode` runs on every mode change and
 * keeps no memory of what it drew last time, so looking the overlay up by name is what stops one
 * accumulating per click — and it is what lets every other mode guarantee it starts with none.
 */
const EDGE_OVERLAY_NAME = '__voidSpaceEdgeOverlay';

/**
 * Pushes a mesh's surface away from the camera, or puts it back.
 *
 * An edge overlay's vertices sit *exactly* on the surface they annotate, so without this the two
 * write the same depth and compete for every pixel the line occupies: the edges then flicker as the
 * camera moves, which reads as a broken renderer rather than as a hairline. Polygon offset applies
 * only to rasterised polygons, so the surface is the side that moves — the lines keep true depth and
 * simply win.
 */
function setSurfaceOffset(material: THREE.Material, offset: boolean): void {
  material.polygonOffset = offset;
  material.polygonOffsetFactor = offset ? 1 : 0;
  material.polygonOffsetUnits = offset ? 1 : 0;
}

/**
 * Removes and disposes the overlay a previous `edges` pass attached to `mesh`.
 *
 * Only the geometry goes: the line material is shared by every overlay in this viewer, so disposing
 * it here would blank the rest of the model's edges at the same moment.
 */
function dropEdgeOverlay(mesh: THREE.Mesh): void {
  for (let index = mesh.children.length - 1; index >= 0; index -= 1) {
    const child = mesh.children[index];
    if (!child || child.name !== EDGE_OVERLAY_NAME) continue;

    const lines = child as THREE.LineSegments;
    mesh.remove(lines);
    lines.geometry.dispose();
  }
}

/**
 * Draws `mesh`'s triangulation over its own shaded surface.
 *
 * Built at threshold 0, so *every* edge survives — shared and boundary alike. That is deliberate:
 * the mode exists to expose n-gons and stray triangles, and a feature-edge pass would omit exactly
 * the interior edges those are made of.
 *
 * This is also where the mode earns `EDGE_TRIANGLE_BUDGET`. Producing the geometry means hashing
 * every vertex of every edge on the main thread, which is the stall that constant's comment is
 * describing — whereas Wireframe is a boolean on the draw call that was already happening, which is
 * why the disabled control offers it as the way out.
 */
function addEdgeOverlay(mesh: THREE.Mesh, material: THREE.Material): void {
  // A mesh with no position attribute has nothing to derive an edge from, and asking three.js for
  // one throws — inside a traverse that would take the whole viewer down with it.
  if (!mesh.geometry.getAttribute('position')) return;

  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 0), material);
  lines.name = EDGE_OVERLAY_NAME;
  // Polygon offset is what actually wins the depth test; this only makes the draw order
  // deterministic instead of letting it fall out of material id.
  lines.renderOrder = 1;
  mesh.add(lines);
}

/**
 * Applies a mode to every mesh in a prepared scene.
 *
 * `generated` collects the substitute materials so they can be disposed when the mode changes: a
 * 40-material asset toggled ten times would otherwise leave 400 materials on the GPU. Edge overlays
 * are disposed where they are removed instead — see `dropEdgeOverlay`.
 *
 * The traversal may add and remove children; `Object3D.traverse` reads `children` after invoking the
 * callback on the parent, so a mesh's own overlay is created after that mesh has been visited and is
 * skipped when it is reached, and an overlay dropped in one pass is simply never reached at all.
 */
function applyShadeMode(
  root: THREE.Object3D,
  mode: ShadeMode,
  originals: MaterialMap,
  generated: THREE.Material[],
  edgeMaterial: THREE.Material,
): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const original = originals.get(mesh);
    if (!original) return;

    const list = Array.isArray(original) ? original : [original];

    // Baseline first. An overlay left behind by a previous `edges` pass would keep drawing over
    // whatever mode is applied now, and this is the one place that sees every transition.
    dropEdgeOverlay(mesh);

    if (LIT_MODES.has(mode)) {
      const withEdges = mode === 'edges';

      for (const material of list) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.wireframe = mode === 'wireframe';
        setSurfaceOffset(material, withEdges);
      }

      mesh.material = original;
      if (withEdges) addEdgeOverlay(mesh, edgeMaterial);
      return;
    }

    const substitutes = list.map((material) => {
      const substitute = makeOverride(material, mode);
      if (substitute !== material) generated.push(substitute);
      return substitute;
    });

    mesh.material = Array.isArray(original) ? substitutes : (substitutes[0] as THREE.Material);
  });
}

/**
 * Image-based lighting, generated in-process.
 *
 * `RoomEnvironment` ships inside three.js, so the studio gets real PBR reflections — which is what
 * makes metal read as metal rather than as flat grey — without downloading an HDRI. That matters
 * here: the deployment target is an air-gapped network, and a viewer that silently falls back to no
 * reflections would misrepresent every metal asset in the catalogue.
 */
function StudioEnvironment() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);

    scene.environment = target.texture;
    scene.environmentIntensity = 0.9;

    return () => {
      scene.environment = null;
      target.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  return null;
}

/* ============================================================================================
 * Animation
 * ========================================================================================== */

/** Everything the transport bar needs to drive a loaded clip. */
export interface ClipHandle {
  readonly names: readonly string[];
  readonly actions: Record<string, THREE.AnimationAction | null>;
  readonly durations: Record<string, number>;
  readonly mixer: THREE.AnimationMixer;
}

/* ============================================================================================
 * The model
 * ========================================================================================== */

interface ModelProps {
  readonly url: string;
  /** The version's extension — it decides which decoder runs. */
  readonly format: string;
  readonly mode: ShadeMode;
  /**
   * Which side of the backdrop the model is sitting on.
   *
   * It is passed down to the edge overlay, which is the one thing drawn at a single pixel wide: a
   * fixed colour works on two of the three backdrops and vanishes on the third.
   */
  readonly night: boolean;
  readonly onDecoded: (geometry: DecodedGeometry) => void;
  readonly onSummary: (summary: SceneSummary) => void;
  readonly onClips: (clips: ClipHandle | null) => void;
}

/** Everything the shared scene preparation needs, once a decoder has produced a scene. */
type PreparedProps = Omit<ModelProps, 'url' | 'format'> & {
  readonly scene: THREE.Object3D;
  readonly animations: THREE.AnimationClip[];
};

/**
 * The model, decoded by whichever loader the file's extension calls for.
 *
 * Dispatch is a component boundary rather than a conditional hook call, because `useGLTF`,
 * `useLoader(OBJLoader, …)` and friends are each hooks of their own: switching between them
 * inside one component would change the hook order between renders. Every branch below still
 * suspends, so `<Suspense>` and the fault boundary above it behave identically for all formats —
 * a decode that throws surfaces as the same "preview unavailable" panel, whatever made it throw.
 *
 * The part that is *not* duplicated — material cloning, shading modes, measurement, the readiness
 * signal the thumbnail renderer waits on — lives in `PreparedModel`, so a new format only has to
 * produce a scene.
 */
function Model({ url, format, ...rest }: ModelProps) {
  const kind = format.toLowerCase().replace(/^\.+/, '');

  if (kind === 'obj') return <ObjModel url={url} {...rest} />;
  if (kind === 'stl') return <StlModel url={url} {...rest} />;
  if (kind === 'fbx') return <FbxModel url={url} {...rest} />;
  // glTF is the default because it is the catalogue's own format and the one the record always
  // names: an unknown or missing extension should fall through to the loader that works.
  return <GltfModel url={url} {...rest} />;
}

function GltfModel({ url, ...rest }: Omit<PreparedProps, 'scene' | 'animations'> & { readonly url: string }) {
  const { scene, animations } = useGLTF(url);
  return <PreparedModel scene={scene} animations={animations} {...rest} />;
}

/** `.obj` — geometry and groups only. Without its `.mtl` sidecar it carries no material. */
function ObjModel({ url, ...rest }: Omit<PreparedProps, 'scene' | 'animations'> & { readonly url: string }) {
  const root = useLoader(OBJLoader, url) as THREE.Group;
  return <PreparedModel scene={root} animations={[]} {...rest} />;
}

/** `.fbx` — a group, and the one non-glTF format that can carry animation clips. */
function FbxModel({ url, ...rest }: Omit<PreparedProps, 'scene' | 'animations'> & { readonly url: string }) {
  const root = useLoader(FBXLoader, url) as THREE.Group & { readonly animations?: THREE.AnimationClip[] };
  return <PreparedModel scene={root} animations={root.animations ?? []} {...rest} />;
}

/**
 * `.stl` — a bare `BufferGeometry`, not a scene, so it is wrapped in a mesh before it is handed on.
 *
 * STL stores only triangles: no material, no texture, no UVs. The surface it gets here is a neutral
 * lit one, which is what the shading modes expect to find (they clone *and read* a standard
 * material), and it gives a printable part the same read as a scanned one rather than black.
 */
function StlModel({ url, ...rest }: Omit<PreparedProps, 'scene' | 'animations'> & { readonly url: string }) {
  const geometry = useLoader(STLLoader, url) as THREE.BufferGeometry;

  const scene = useMemo(() => {
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

    const group = new THREE.Group();
    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: '#c3c8d2', metalness: 0.04, roughness: 0.62 }),
      ),
    );
    return group;
  }, [geometry]);

  return <PreparedModel scene={scene} animations={[]} {...rest} />;
}

function PreparedModel({
  scene,
  animations,
  mode,
  night,
  onDecoded,
  onSummary,
  onClips,
}: PreparedProps) {
  const invalidate = useThree((state) => state.invalidate);

  /**
   * The scene is cloned for two reasons, and both matter.
   *
   * Materials must be cloned because three.js shares them through `Object3D.clone()`, so any change
   * made for one viewer would silently apply to every other viewer of the same asset. And the clone
   * has to be a `SkeletonUtils` clone, not a plain one: a plain clone of a skinned mesh shares the
   * original skeleton, so playing a clip in the preview would move bones the original still owns.
   *
   * The scene is measured here rather than in the reporting effect below because the edge-overlay
   * budget constrains work this component is about to do. Answering it from the object graph in the
   * same tick the graph appears keeps a dense model from being handed an overlay one render before
   * `onDecoded` lands and having it torn down again straight after — that would pay the whole build
   * cost to draw nothing.
   */
  const prepared = useMemo(() => {
    const root = SkeletonUtils.clone(scene) as THREE.Object3D;
    const originals: MaterialMap = new Map();

    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;

      const cloned = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();

      mesh.material = cloned;
      originals.set(mesh, cloned);
    });

    return { root, originals, measurement: measureScene(root) };
  }, [scene]);

  const live = useRef<THREE.Material[]>([]);

  /**
   * The single line material every edge overlay in this viewer draws with.
   *
   * Shared rather than one per mesh so that changing the backdrop is a write to one colour instead
   * of a walk over the scene, and so `dropEdgeOverlay` can release an overlay's geometry without
   * touching the material the other meshes are still using.
   */
  const edgeMaterial = useMemo(() => new THREE.LineBasicMaterial({ toneMapped: false }), []);

  // Re-tinted rather than rebuilt: the backdrop is a background, not a property of the model, and
  // rebuilding 150k triangles' worth of edges because the stage went light would be absurd.
  useEffect(() => {
    edgeMaterial.color.set(night ? EDGE_LINE_NIGHT : EDGE_LINE_DAY);
    invalidate();
  }, [edgeMaterial, night, invalidate]);

  useEffect(() => {
    const substitutes: THREE.Material[] = [];

    /*
      The budget is enforced here as well as on the control. `mode` outlives the model it was chosen
      for, and the keyboard reaches `edges` without consulting the disabled button, so the one place
      that can be trusted not to build an overlay the budget refuses is the place doing the building.
    */
    const effective =
      mode === 'edges' && prepared.measurement.triangles > EDGE_TRIANGLE_BUDGET ? 'shaded' : mode;

    applyShadeMode(prepared.root, effective, prepared.originals, substitutes, edgeMaterial);

    const stale = live.current;
    live.current = substitutes;

    for (const material of stale) {
      material.dispose();
    }

    invalidate();

    /*
      Runs before the next model is applied, and on unmount. Overlay geometry is built imperatively
      here rather than declared in JSX, so nothing else owns it: three.js disposes nothing by itself
      and the buffers this would leave behind are the largest thing the component allocates. The
      traversal below reaches only the root this run bound itself to, which is why the pass above
      still clears its own baseline.
    */
    return () => {
      prepared.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) dropEdgeOverlay(mesh);
      });
    };
  }, [prepared, mode, edgeMaterial, invalidate]);

  useEffect(
    () => () => {
      for (const material of live.current) material.dispose();
      live.current = [];
      // The one allocation not tracked per mesh.
      edgeMaterial.dispose();
    },
    [edgeMaterial],
  );

  // The summary is taken from the object graph, so it is derived once per load rather than per
  // frame. It describes the file, and the file cannot change while it is on screen.
  useEffect(() => {
    onDecoded(prepared.measurement);
    onSummary(summariseScene(prepared.root));
  }, [prepared, onDecoded, onSummary]);

  const { actions, mixer } = useAnimations(animations, prepared.root);

  useEffect(() => {
    if (animations.length === 0) {
      onClips(null);
      return;
    }

    const durations: Record<string, number> = {};
    const byName: Record<string, THREE.AnimationAction | null> = {};

    for (const clip of animations) {
      durations[clip.name] = clip.duration;
      byName[clip.name] = actions[clip.name] ?? null;
    }

    onClips({ names: animations.map((clip) => clip.name), durations, actions: byName, mixer });
  }, [animations, actions, mixer, onClips]);

  return <primitive object={prepared.root} />;
}

/* ============================================================================================
 * Camera
 * ========================================================================================== */

const FALLBACK_VIEW_DIRECTION = new THREE.Vector3(0.55, 0.37, 0.74).normalize();

/** A fit request. `view` is null when the current viewing angle should simply be kept. */
export interface FitRequest {
  readonly n: number;
  readonly view: CameraView | null;
}

/** The slice of OrbitControls the rig drives. Structural, so it needs no ref typing. */
interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

/**
 * Which measure the camera fit uses.
 *
 * `box` (default) fits the bounding box and fills whichever axis binds first.
 *
 * `sphere` fits the circumscribed sphere, so the sphere subtends a constant angle regardless of the
 * model's proportions. This is *not* the same as a constant apparent size: an elongated subject has a
 * bounding sphere far larger than itself, so it renders small while a compact subject renders large.
 *
 * Measured on the catalogue renders (1200x900, four assets of very different proportions), comparing
 * each model's longest on-screen dimension, with `fill` 0.82:
 *
 *   sphere   drill 43%  crane 50%  whale 37%  heart 54%   — all models small and unrelated
 *   box      drill 83%  crane 72%  whale 74%  heart 75%   — every model ~1.8x larger
 *
 * The box fit was chosen on that measurement. It also keeps every silhouette at least 4.6% clear of
 * the frame edge, so nothing is cropped — which a sphere fit gets for free and a box fit does not, and
 * is the reason the margin was measured rather than assumed.
 *
 * Two further measures were implemented and rejected: normalising the *projected area*, and fitting
 * the projected *silhouette* by iterating vertices. Both look better on paper — a box is not a
 * silhouette, and a subject can sit off-centre inside its own box — but on screen the silhouette fit
 * disagreed with what three.js actually rendered (it predicted a 46% wide whale where the render was
 * 76%), and the cause was not found. An unexplained discrepancy in a camera fit is worse than a
 * simpler fit that measures correctly, so it was removed rather than shipped.
 */
export type FrameFit = 'box' | 'sphere';

/** Headroom below the frame edge that the fit is expected to leave, as a fraction of the dimension. */
export const FRAME_SAFE_MARGIN = 0.046;

/**
 * Frames whatever geometry actually loaded, and answers the standard viewpoints.
 *
 * Two measures, because the viewer serves two jobs:
 *
 * - **`box` (inspection).** Distance is derived from the object's *projected* extent — its width and
 *   height measured in the camera's own basis. Fitting the bounding sphere instead frames an
 *   elongated subject badly: the whale skeleton is 13 x 38 x 16 units, so its sphere is far larger
 *   than the animal and the animal ends up occupying a third of the frame. For someone checking
 *   topology, filling the frame wins.
 * - **`sphere` (catalogue).** The opposite trade, and the same reasoning in reverse. Box-fitting fills
 *   whichever axis binds first, so a wide model fills the width and a tall model fills the height —
 *   side by side in a grid at fixed 4:3, a crane and a heart render at visibly different scales and
 *   the grid reads as broken. Fitting the circumscribed sphere makes every model subtend the same
 *   angle regardless of proportions. Wasted frame is invisible in a grid; inconsistent scale is not.
 *
 * The subject is also parked on the origin, so the orbit target and the subject coincide for models
 * of any size or offset. Orthographic uses the same extents but converts them to a zoom factor,
 * because an orthographic camera has no field of view to solve against.
 */
function CameraRig({
  target,
  fill,
  mode,
  request,
  readyKey,
  onFramed,
}: {
  target: React.RefObject<THREE.Group>;
  fill: number;
  /** Which measure to fit. See the note above on when each is right. */
  mode: FrameFit;
  request: FitRequest;
  /**
   * Bumped once the geometry has been decoded and measured.
   *
   * Without it the rig fires its first fit against an empty group — the model arrives through
   * <Suspense>, so on mount there is nothing to measure, `Box3.setFromObject` is empty, and the
   * early return leaves the camera at the canvas's initial position *inside* the model. A 38-unit
   * whale skeleton then renders as a white wall. The refit is therefore driven by the same signal
   * that produces the triangle count, because that signal means "the geometry exists now".
   */
  readyKey: number;
  onFramed: (floor: number, box: THREE.Box3) => void;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    const object = target.current;
    if (!object) return;

    let cancelled = false;

    // One frame of grace: the model arrives through <Suspense>, so its matrix is not final on the
    // tick this effect runs.
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;

      object.position.set(0, 0, 0);
      object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;

      const centre = box.getCenter(new THREE.Vector3());
      object.position.copy(centre).multiplyScalar(-1);
      object.updateMatrixWorld(true);

      const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);

      /**
       * Circumscribed sphere about the recentred box. Used by sphere mode so that a model's apparent
       * size is a property of the model's overall extent rather than of its proportions.
       */
      const radius = half.length();
      const fillRatio = Math.max(0.3, Math.min(1, fill));

      const direction = new THREE.Vector3();
      if (request.view) {
        direction.fromArray(VIEW_DIRECTIONS[request.view] as unknown as number[]).normalize();
      } else if (camera.position.lengthSq() > 1e-6) {
        direction.copy(camera.position).normalize();
      } else {
        direction.copy(FALLBACK_VIEW_DIRECTION);
      }

      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), direction)
        .normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();

      // Support function: the box's half-extent measured along an arbitrary axis.
      const extentAlong = (axis: THREE.Vector3) =>
        Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;



      if (camera instanceof THREE.OrthographicCamera) {
        const span = Math.max(half.x, half.y, half.z);
        const distance = Math.max(extentAlong(direction) * 3, span * 6, 1);

        camera.position.copy(direction).multiplyScalar(distance);
        camera.lookAt(0, 0, 0);

        // drei sizes the orthographic frustum to the viewport in CSS pixels at zoom 1, so a world
        // extent of 2h occupies 2h * zoom pixels. Solve for the axis that binds first.
        const zoomVertical = (size.height * fillRatio) / Math.max(1e-6, 2 * extentAlong(up));
        const zoomHorizontal = (size.width * fillRatio) / Math.max(1e-6, 2 * extentAlong(right));
        // Sphere mode uses one zoom for both axes, so a model's apparent size does not depend on how
        // it happens to be proportioned.
        const zoomSphere =
          (Math.min(size.width, size.height) * fillRatio) / Math.max(1e-6, 2 * radius);
        camera.zoom =
          mode === 'sphere'
            ? Math.max(0.001, zoomSphere)
            : Math.max(0.001, Math.min(zoomVertical, zoomHorizontal));
        camera.near = 0.01;
        camera.far = distance * 4 + span * 8;
        camera.updateProjectionMatrix();
      } else {
        const perspective = camera as THREE.PerspectiveCamera;
        const aspect = Math.max(0.2, size.width / Math.max(1, size.height));
        const halfVertical = (perspective.fov * Math.PI) / 360;
        const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
        const tanVertical = Math.tan(halfVertical);
        const tanHorizontal = Math.tan(halfHorizontal);

        /*
          Box: fill whichever axis binds first (the model touches the frame on that side).
          Sphere: place the camera where the circumscribed sphere is tangent to the frustum sides —
          `radius / sin(halfAngle)` — so the projected radius is the same fraction of the shortest
          screen axis for every model, whatever its proportions.
          Silhouette/area: solve for the distance at which the projected *shape* covers `fill` of both
          dimensions multiplied together, then cap so the longer axis keeps a margin. A wide flat model
          and a compact one end up occupying comparable fractions of the tile, which is what makes a
          grid read as a set rather than a collection.
        */
        const distance =
          mode === 'sphere'
            ? radius / Math.sin(Math.min(halfVertical, halfHorizontal)) / fillRatio
            : Math.max(extentAlong(up) / tanVertical, extentAlong(right) / tanHorizontal) /
            fillRatio;

        perspective.position.copy(direction).multiplyScalar(distance);
        perspective.lookAt(0, 0, 0);
        perspective.near = Math.max(0.001, distance * 0.002);
        perspective.far = distance * 14;
        perspective.updateProjectionMatrix();
      }

      if (controls) {
        controls.target.set(0, 0, 0);
        controls.update();
      }

      // The studio positions its ground shadow from this, so it sits under whatever loaded.
      onFramed(-half.y, box);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [target, camera, size, fill, mode, request, readyKey, controls, onFramed]);

  return null;
}

/* ============================================================================================
 * Overlays (DOM, outside <Canvas>)
 *
 * The canvas is a three.js scene graph, not a DOM tree: a <div> or <button> placed inside it is read
 * as a THREE object and throws "Div is not part of the THREE namespace", taking the whole preview
 * down. Every piece of chrome below is therefore a sibling of the canvas, positioned over it.
 * ========================================================================================== */

/**
 * Progress readout shown while the model streams in.
 *
 * Visibility is the hard part, not the percentage. The overlay must appear for a cold 13 MB download
 * and must *not* appear for a model three.js already has in its loader cache — otherwise re-opening a
 * card flashes a progress bar for something already on screen, and a stalled "0%" reads as breakage.
 * So it is shown only once a transfer is genuinely observed in flight, with a short grace period.
 */
function LoadReporter({ onSettled }: { onSettled: () => void }) {
  const { active, progress, loaded, total } = useProgress();
  const [visible, setVisible] = useState(false);
  const sawTransfer = useRef(false);

  useEffect(() => {
    if (active) {
      sawTransfer.current = true;
      setVisible(true);
    }
  }, [active]);

  useEffect(() => {
    if (active) return;

    if (sawTransfer.current) {
      setVisible(false);
      onSettled();
      return;
    }

    const timer = setTimeout(() => {
      setVisible(false);
      onSettled();
    }, 1_200);

    return () => clearTimeout(timer);
  }, [active, onSettled]);

  if (!visible) return null;

  return (
    <div className="studio-loading" role="status" aria-live="polite">
      <div className="font-mono text-[12px] text-ink-dim">Decoding model</div>
      <div className="studio-loading-track">
        <i style={{ width: `${Math.max(4, progress)}%` }} />
      </div>
      {total > 0 ? (
        <div className="text-[12px] tracking-[0.01em] text-ink-faint">
          {(loaded / 1_048_576).toFixed(1)} of {(total / 1_048_576).toFixed(1)} MB ·{' '}
          {Math.round(progress)}%
        </div>
      ) : null}
    </div>
  );
}

/**
 * Error boundary: a file the viewer cannot decode explains itself instead of blanking the screen.
 *
 * It reports the fault upward as well as rendering it, because the toolbar belongs to the *canvas* —
 * leaving mode switches and view buttons next to a dead canvas invites the user to press controls
 * that cannot do anything.
 */
class ViewerBoundary extends Component<
  {
    children: ReactNode;
    label: string;
    sourceUrl: string | null;
    onFault?: ((message: string) => void) | undefined;
  },
  { failed: boolean; message: string }
> {
  override state = { failed: false, message: '' };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : 'unknown error' };
  }

  override componentDidCatch(error: unknown) {
    this.props.onFault?.(error instanceof Error ? error.message : 'unknown error');
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="studio-fault">
        <div className="studio-fault-inner">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-faint" style={{ color: 'var(--vs-rejected)' }}>
            Preview unavailable
          </div>
          <div className="font-medium leading-[1.1] tracking-[-0.021em] text-ink mt-2 text-2xl">
            This {this.props.label} could not be drawn here
          </div>
          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--vs-fg-dim)' }}>
            The asset itself is unaffected — it is pinned, and the licence on record is untouched. The
            geometry is either in a form this viewer cannot decode, or the preview failed to
            initialise.
          </p>
          <code>{this.state.message}</code>
          {this.props.sourceUrl ? (
            <a
              className="h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 mt-4 inline-flex"
              href={this.props.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Download the raw file
            </a>
          ) : null}
        </div>
      </div>
    );
  }
}

/**
 * Reports the decoded geometry, and whether it agrees with the asset record.
 *
 * Both the arithmetic and the wording live in `@/lib/geometry` so the comparison can be tested
 * without a WebGL context; this is only the presentation of its verdict. The distinction is the
 * point: the record is a claim made at ingest, the decode is what the bytes in the gateway actually
 * contain, and a licence is being sold on the two agreeing.
 */
function DecodeReadout({
  decoded,
  recorded,
}: {
  decoded: DecodedGeometry;
  recorded: number | null;
}) {
  const agreement = comparePolycount(recorded, decoded.triangles);

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span title={`${decoded.meshes} mesh(es), ${formatCount(decoded.vertices)} vertices`}>
        {formatCount(decoded.triangles)} tris decoded
      </span>
      {agreement.status === 'unknown' ? null : (
        <span
          className={agreement.status === 'mismatch' ? 'studio-warn' : 'studio-ok'}
          title={agreement.reason}
        >
          {agreement.status === 'mismatch'
            ? `≠ ${formatCount(recorded ?? 0)} on record`
            : 'matches the record'}
        </span>
      )}
    </span>
  );
}

/** Registers the canvas screenshot function with the toolbar's export button. */
function CaptureBridge({ register }: { register: (capture: (() => string) | null) => void }) {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    register(() => gl.domElement.toDataURL('image/png'));
    return () => register(null);
  }, [gl, register]);

  return null;
}

/* ============================================================================================
 * Scene helpers
 * ========================================================================================== */

/**
 * Rounds a span to a grid step a person would choose: 1, 2 or 5 times a power of ten.
 *
 * A fixed cell size cannot work across this catalogue — 0.5 units is a dense mat under a 12-triangle
 * cube and invisible under a 38-unit whale skeleton — so the step is derived from the model.
 */
export function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** The measurement rig, drawn under and around whatever loaded. */
function SceneHelpers({
  floor,
  span,
  box,
  showGrid,
  showAxes,
  showBounds,
  showShadow,
  animated,
  night,
}: {
  floor: number;
  span: number;
  box: THREE.Box3 | null;
  showGrid: boolean;
  showAxes: boolean;
  showBounds: boolean;
  showShadow: boolean;
  animated: boolean;
  night: boolean;
}) {
  const cell = niceStep(span / 8);
  const section = cell * 5;

  return (
    <>
      {showGrid ? (
        <Grid
          position={[0, floor, 0]}
          args={[span * 2, span * 2]}
          cellSize={cell}
          cellThickness={0.5}
          cellColor={night ? '#2b2b33' : '#b6b6c0'}
          sectionSize={section}
          sectionThickness={1}
          sectionColor={night ? '#42424e' : '#8e8e9c'}
          fadeDistance={span * 14}
          fadeStrength={1}
          infiniteGrid
        />
      ) : null}

      {/* Origin axes, coloured by axis so orientation is readable at a glance. */}
      {showAxes ? <axesHelper args={[span * 0.9]} /> : null}

      {showBounds && box ? (
        <box3Helper args={[box, new THREE.Color('#6ea8fe')]} />
      ) : null}

      {/*
        The ground shadow is what stops a model reading as a sticker. It is pinned to the model's
        own footprint and only re-rendered while a clip is playing: a 247k-triangle scan re-rendered
        into a shadow map every frame is a cost with nothing to show for it.
      */}
      {showShadow ? (
        <ContactShadows
          position={[0, floor, 0]}
          opacity={night ? 0.62 : 0.38}
          scale={span * 2.2}
          blur={2.6}
          far={span * 1.4}
          resolution={512}
          frames={animated ? Infinity : 1}
        />
      ) : null}
    </>
  );
}

/* ============================================================================================
 * Inventory panel
 * ========================================================================================== */

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="studio-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/**
 * What is actually inside the file.
 *
 * Docked beside the viewport rather than floating over it: this panel is long — geometry, materials,
 * textures, rig — and a long panel that covers the model defeats the purpose of opening it, since
 * every figure in here is meant to be checked against what you can see.
 *
 * Counts come from the decoded scene, not from the ingest record, because the two can disagree and
 * this panel exists to show it. The material list is the part an artist cannot get anywhere else on
 * this page: how many sheets they will have to manage, whether each one carries a texture, and
 * whether the metalness/roughness were authored or left at defaults.
 */
function StatsPanel({
  decoded,
  summary,
  clips,
  ortho,
  onClose,
}: {
  decoded: DecodedGeometry | null;
  summary: SceneSummary;
  clips: ClipHandle | null;
  ortho: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="studio-dock" aria-label="Model inventory">
      <div className="studio-panel-head">
        <span>File inventory</span>
        <button type="button" className="studio-btn" onClick={onClose} aria-label="Hide inventory">
          Hide
        </button>
      </div>

      <div className="studio-panel-body">
        {decoded ? (
          <div className="studio-section">
            <StatRow label="Triangles" value={formatCount(decoded.triangles)} />
            <StatRow label="Vertices" value={formatCount(decoded.vertices)} />
            <StatRow label="Meshes" value={formatCount(decoded.meshes)} />
            <StatRow
              label="Extent"
              value={`${decoded.extent.x.toFixed(1)} × ${decoded.extent.y.toFixed(1)} × ${decoded.extent.z.toFixed(1)}`}
            />
            <StatRow label="Projection" value={ortho ? 'Orthographic' : 'Perspective'} />
          </div>
        ) : (
          <div className="studio-section">
            <StatRow label="Geometry" value="measuring…" />
          </div>
        )}

        <div className="studio-section">
          <StatRow label="Materials" value={formatCount(summary.materials.length)} />
          <StatRow label="Textures" value={formatCount(summary.textures)} />
          {summary.bones > 0 ? (
            <StatRow label="Bones" value={formatCount(summary.bones)} />
          ) : null}
          {summary.emptyNodes > 0 ? (
            <StatRow label="Empty nodes" value={formatCount(summary.emptyNodes)} />
          ) : null}
        </div>

        {summary.materials.length > 0 ? (
          <div className="studio-section">
            {summary.materials.map((material, index) => (
              <div
                className="studio-mat"
                key={`${material.name}-${material.kind}-${index}`}
                title={`${material.kind}${material.textured ? ' · textured' : ' · no texture'}${material.doubleSided ? ' · double-sided' : ''
                  }`}
              >
                <span>
                  {material.color ? (
                    <i className="studio-swatch" style={{ background: material.color }} />
                  ) : null}
                  {material.name.length > 0 ? material.name : `Material ${index + 1}`}
                </span>
                <em>
                  {material.kind}
                  {material.textured ? ' · tex' : ''}
                </em>
              </div>
            ))}
          </div>
        ) : null}

        {clips && clips.names.length > 0 ? (
          <div className="studio-section">
            <StatRow label="Animation clips" value={formatCount(clips.names.length)} />
            <div className="mt-1 flex flex-wrap gap-1">
              {clips.names.map((name) => (
                <span className="chip" key={name}>
                  {name}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/* ============================================================================================
 * Animation transport
 * ========================================================================================== */

function Transport({
  clips,
  clipName,
  playing,
  time,
  speed,
  onClip,
  onToggle,
  onScrub,
  onSpeed,
}: {
  clips: ClipHandle;
  clipName: string;
  playing: boolean;
  time: number;
  speed: number;
  onClip: (name: string) => void;
  onToggle: () => void;
  onScrub: (time: number) => void;
  onSpeed: (speed: number) => void;
}) {
  const duration = Math.max(0.001, clips.durations[clipName] ?? 0);

  return (
    <div className="studio-transport">
      <button
        type="button"
        className="studio-btn"
        onClick={onToggle}
        aria-label={playing ? 'Pause animation' : 'Play animation'}
      >
        {playing ? '❚❚' : '▶'}
      </button>

      <input
        type="range"
        min={0}
        max={duration}
        step={Math.max(0.001, duration / 600)}
        value={Math.min(time, duration)}
        onChange={(event) => onScrub(Number(event.target.value))}
        aria-label="Animation position"
      />

      <span className="studio-clip-time">
        {time.toFixed(2)}s / {duration.toFixed(2)}s
      </span>

      {clips.names.length > 1 ? (
        <select
          value={clipName}
          onChange={(event) => onClip(event.target.value)}
          aria-label="Animation clip"
        >
          {clips.names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <span className="studio-clip-time">{clipName}</span>
      )}

      <select
        value={speed}
        onChange={(event) => onSpeed(Number(event.target.value))}
        aria-label="Playback speed"
      >
        {[0.25, 0.5, 1, 1.5, 2].map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>
    </div>
  );
}

/* ============================================================================================
 * The studio
 * ========================================================================================== */

export interface ModelViewerProps {
  readonly cid: string | null;
  readonly format: string;
  /** Shown in the footer and in fault messages. */
  readonly label?: string | undefined;
  /** Measured extent recorded for this version, displayed as a scale readout. */
  readonly dimensions?: { x: number; y: number; z: number } | null;
  /**
   * Triangle count the asset record claims. When given, the footer compares it with what the browser
   * decoded, so a record that disagrees with the file is visible rather than silently trusted.
   */
  readonly recordedPolycount?: number | null;
  /**
   * Fires once the model is **decoded and framed** — the first moment the canvas shows the asset
   * rather than an empty stage.
   *
   * The headless thumbnail renderer needs exactly this, and nothing weaker. Its old condition was
   * "a canvas exists with non-zero size", which is true the instant the canvas mounts and therefore
   * says nothing about whether the model has arrived. On the largest asset in the catalogue (the
   * 16.7 MB whale scan) that produced a blank render whenever the file was slow to arrive, because
   * the script screenshotted an empty stage. Waiting for a genuine readiness signal is what makes a
   * render reproducible rather than a race.
   */
  readonly onReady?: () => void;
  /** Compact hides the whole toolbar (used for marketplace cards and the quick-look dialog). */
  readonly compact?: boolean;
  /** Fraction of the view the model is fitted to. */
  readonly fill?: number;
  /**
   * Which measure the fit uses. `box` (default) fills the frame — right for inspecting a model.
   * `sphere` normalises apparent size across models — right for a catalogue, where a grid of
   * cards must look like one set rather than a collection of different scales.
   */
  readonly frameFit?: FrameFit;
  /**
   * Gently rotates the model until the visitor touches it.
   *
   * For a showcase, a still frame reads as a photograph, and a marketplace whose subject never moves
   * is not obviously showing a 3D file. It stops the moment the visitor takes control, because a
   * camera that keeps drifting under your cursor is the opposite of helpful.
   */
  readonly autoRotate?: boolean;
  /**
   * Presentation chrome (marketplace storefront).
   *
   * The full studio — shading modes, camera axis buttons, measurement helpers, inventory, export —
   * is the right surface for inspecting a file, and the wrong one to greet a visitor with. A
   * storefront hero showing a file inventory panel and an "Axes" toggle reads as a developer tool,
   * so presentation mode keeps only what a *viewer* needs: the model, the orbit hint, and their own
   * ability to drag it. Everything else stays one click away on the model page.
   */
  readonly presentation?: boolean;
  readonly onDelete?: () => void;
}

export function ModelViewer({
  cid,
  format,
  label,
  dimensions,
  recordedPolycount = null,
  compact = false,
  fill = 0.8,
  frameFit = 'box',
  autoRotate = false,
  presentation = false,
  onReady,
  onDelete,
}: ModelViewerProps) {
  const previewable = canPreviewNatively(format);
  const url = cid ? `/ipfs/${cid}` : null;

  /* --- the file --------------------------------------------------------------------------- */
  const [mode, setMode] = useState<ShadeMode>('shaded');
  const [request, setRequest] = useState<FitRequest>({ n: 0, view: 'iso' });
  const [view, setView] = useState<CameraView>('iso');
  const [ortho, setOrtho] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>('stage');

  // The grid is a scale reference and earns its place; the origin axes are an authoring aid, and on a
  // public listing they just add three coloured lines through the model. Both stay one click away.
  const [showGrid, setShowGrid] = useState(!compact && !presentation);
  const [showAxes, setShowAxes] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  // The ground shadow stays on in presentation mode: it is the thing that stops a model reading as a
  // flat sticker, which matters more on a storefront than in a measurement viewport.
  const [showShadow, setShowShadow] = useState(true);

  const [spinning, setSpinning] = useState(autoRotate);
  const [panelOpen, setPanelOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hintVisible, setHintVisible] = useState(!compact);
  const [faulted, setFaulted] = useState(false);

  /* --- what was decoded ------------------------------------------------------------------- */
  const [decoded, setDecoded] = useState<DecodedGeometry | null>(null);
  const [readyKey, setReadyKey] = useState(0);
  const [summary, setSummary] = useState<SceneSummary>(EMPTY_SUMMARY);
  const [clips, setClips] = useState<ClipHandle | null>(null);
  const [clipName, setClipName] = useState('');
  const [playing, setPlaying] = useState(true);
  const [clipTime, setClipTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [floor, setFloor] = useState<number | null>(null);
  const [box, setBox] = useState<THREE.Box3 | null>(null);

  const wrapper = useRef<HTMLDivElement>(null);
  const modelRef = useRef<THREE.Group>(null);
  const captureRef = useRef<(() => string) | null>(null);

  const handleDecoded = useCallback((geometry: DecodedGeometry) => {
    setDecoded(geometry);
    // The geometry exists now, so the camera has something to frame. See CameraRig.readyKey.
    setReadyKey((value) => value + 1);
  }, []);
  const handleSummary = useCallback((next: SceneSummary) => setSummary(next), []);

  /**
   * `onReady` is held in a ref so the callback can change identity without re-running the camera rig.
   * It fires once per decoded model: `handleFramed` also runs on every manual re-frame, and the
   * renderer only cares about the first.
   */
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const readyFiredFor = useRef(-1);

  const handleFramed = useCallback(
    (nextFloor: number, nextBox: THREE.Box3) => {
      setFloor(nextFloor);
      setBox(nextBox);
      if (readyFiredFor.current === readyKey) return;
      readyFiredFor.current = readyKey;
      // A frame has been drawn by the time the rig reports back, so the next paint is the model.
      requestAnimationFrame(() => onReadyRef.current?.());
    },
    [readyKey],
  );
  const registerCapture = useCallback((capture: (() => string) | null) => {
    captureRef.current = capture;
  }, []);

  const handleClips = useCallback((next: ClipHandle | null) => {
    setClips(next);
    // Keep the current clip if it survived a reload, otherwise take the first the file offers.
    setClipName((previous) =>
      next && previous.length > 0 && next.names.includes(previous)
        ? previous
        : (next?.names[0] ?? ''),
    );
  }, []);

  /** The model's largest dimension — the unit every helper is sized against. */
  const span = useMemo(() => {
    if (!box) return 1;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 0.001);
  }, [box]);

  /* --- camera moves ----------------------------------------------------------------------- */
  const goToView = useCallback((next: CameraView) => {
    setView(next);
    setRequest((current) => ({ n: current.n + 1, view: next }));
  }, []);

  /** Re-frame without changing which way the camera looks — used by RESET-adjacent affordances. */
  const refitInPlace = useCallback(() => {
    setRequest((current) => ({ n: current.n + 1, view: null }));
  }, []);

  const toggleOrtho = useCallback(() => {
    setOrtho((value) => !value);
    // A new camera starts at its own default position, so the framing is re-solved for the view the
    // user was last looking from rather than left to chance.
    setRequest((current) => ({ n: current.n + 1, view }));
  }, [view]);

  const toggleExpanded = useCallback(async () => {
    const element = wrapper.current;
    if (!element) return;
    try {
      if (!document.fullscreenElement) await element.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // Fullscreen can be refused by policy; the studio stays usable without it.
    }
  }, []);

  const saveShot = useCallback(() => {
    const data = captureRef.current?.();
    if (!data) return;

    const slug = (label ?? 'model')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model';

    const link = document.createElement('a');
    link.href = data;
    link.download = `${slug}-${mode}.png`;
    link.click();
  }, [label, mode]);

  /* --- animation ------------------------------------------------------------------------ */
  useEffect(() => {
    if (!clips || clipName.length === 0) return;
    const action = clips.actions[clipName];
    if (!action) return;

    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.play();
    setClipTime(0);

    return () => {
      action.stop();
    };
  }, [clips, clipName]);

  useEffect(() => {
    if (!clips || clipName.length === 0) return;
    const action = clips.actions[clipName];
    if (action) action.paused = !playing;
  }, [clips, clipName, playing]);

  useEffect(() => {
    if (!clips || clipName.length === 0) return;
    const action = clips.actions[clipName];
    if (action) action.setEffectiveTimeScale(speed);
  }, [clips, clipName, speed]);

  // The transport reads the mixer rather than driving it: polled at 10 Hz, which is enough to look
  // continuous for a scrubber and costs nothing next to a per-frame React render.
  useEffect(() => {
    if (!playing || !clips || clipName.length === 0) return;
    const id = setInterval(() => {
      const action = clips.actions[clipName];
      if (action) setClipTime(action.time);
    }, 100);
    return () => clearInterval(id);
  }, [playing, clips, clipName]);

  const handleScrub = useCallback(
    (time: number) => {
      const action = clips?.actions[clipName];
      if (!action || !clips) return;
      action.time = time;
      clips.mixer.update(0);
      setClipTime(time);
    },
    [clips, clipName],
  );

  /* --- chrome behaviour ------------------------------------------------------------------- */
  useEffect(() => {
    if (!hintVisible) return;
    const timer = setTimeout(() => setHintVisible(false), 7_000);
    return () => clearTimeout(timer);
  }, [hintVisible]);

  useEffect(() => {
    const onChange = () => setExpanded(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /* --- surface shading --------------------------------------------------------------------- */

  const edgeDisabled = decoded !== null && decoded.triangles > EDGE_TRIANGLE_BUDGET;

  /**
   * The one way into `setMode`.
   *
   * The button already carries `disabled`, but the keyboard reaches `2` without going through it, so
   * the budget is checked here rather than at each call site — otherwise the two paths into Edges
   * would disagree and which one won would depend on how the mode was chosen.
   */
  const chooseShade = useCallback(
    (next: ShadeMode) => {
      if (next === 'edges' && edgeDisabled) return;
      setMode(next);
    },
    [edgeDisabled],
  );

  // `mode` outlives the model it was chosen for, so a dense file arriving under an active `edges`
  // drops back to Shaded rather than leaving the button lit over an overlay that was never drawn.
  // PreparedModel enforces the same budget on the work itself; this keeps the control honest about it.
  useEffect(() => {
    if (mode === 'edges' && edgeDisabled) setMode('shaded');
  }, [mode, edgeDisabled]);

  useEffect(() => {
    if (compact) return;

    /**
     * One keyboard scheme, printed on the buttons so it is discoverable:
     *
     *   1–7  surface shading      0 + F/B/L/R/T/D  camera views
     *   G A O H P  overlays       I inventory   S save PNG   M full screen
     *
     * Full screen moved to M (maximize) because F is the standard "front view" in every DCC
     * tool, and hijacking it for fullscreen cost the more useful binding.
     */
    const SHADE_KEYS: Record<string, ShadeMode> = {
      '1': 'shaded',
      '2': 'edges',
      '3': 'wireframe',
      '4': 'normals',
      '5': 'uv',
      '6': 'matcap',
      '7': 'unlit',
    };

    const VIEW_KEYS: Record<string, CameraView> = {
      '0': 'iso',
      f: 'front',
      b: 'back',
      l: 'left',
      r: 'right',
      t: 'top',
      d: 'bottom',
    };

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();

      const shade = SHADE_KEYS[key];
      if (shade) {
        chooseShade(shade);
        event.preventDefault();
        return;
      }

      const view = VIEW_KEYS[key];
      if (view) {
        goToView(view);
        event.preventDefault();
        return;
      }

      switch (key) {
        case 'v':
          toggleOrtho();
          break;
        case 'g':
          setShowGrid((value) => !value);
          break;
        case 'a':
          setShowAxes((value) => !value);
          break;
        case 'o':
          setShowBounds((value) => !value);
          break;
        case 'h':
          setShowShadow((value) => !value);
          break;
        case 'p':
          setSpinning((value) => !value);
          break;
        case 'i':
          setPanelOpen((value) => !value);
          break;
        case 's':
          saveShot();
          break;
        case 'm':
          void toggleExpanded();
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, chooseShade, goToView, saveShot, toggleExpanded, toggleOrtho]);

  const animated = Boolean(clips && playing);

  /* --- no preview possible ---------------------------------------------------------------- */
  if (!previewable || !url) {
    return (
      <div className="studio" style={{ background: BACKDROPS[backdrop] }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center p-7 text-center">
          <div>
            <div className="font-medium leading-[1.1] tracking-[-0.021em] text-ink text-xl">
              {previewable ? 'No pinned content to preview' : `${format.replace(/^\./, '').toUpperCase()} has no browser preview`}
            </div>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--vs-fg-dim)' }}>
              {url
                ? 'Download it from the gateway to inspect it in your own tool.'
                : 'This asset has no content-addressed copy yet.'}
            </p>
            {url ? (
              <a className="h-10 items-center justify-center gap-2 rounded-control border border-transparent bg-veil-8 px-4 text-[14px] font-semibold text-ink transition-all duration-200 ease-standard hover:bg-veil-12 mt-4 inline-flex" href={url} download>
                Download the file
              </a>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapper}
      className="studio"
      style={{ background: BACKDROPS[backdrop] }}
      onDoubleClick={refitInPlace}
    >
      <div className="studio-viewport">
        <ViewerBoundary
          label={label ?? 'model'}
          sourceUrl={url}
          onFault={() => setFaulted(true)}
        >
          <Canvas
            dpr={[1, 2]}
            /*
              Demand-driven rendering.
            
              A canvas that renders on its own animation frame forever holds the GPU awake for as long
              as the page is open, which on a laptop is a fan that never stops and a battery that
              drains while the reader is reading. Real 3D viewers stop when nothing is moving.
            
              `demand` is exactly that: R3F cancels its animation frame once nothing has invalidated
              the scene, and drei's OrbitControls invalidates on every change event, so orbiting and
              damping still animate. The two things here that genuinely need a continuous frame —
              turntable rotation and a playing animation clip — opt back into `always` while they run.
            */
            frameloop={spinning || animated ? 'always' : 'demand'}
            gl={{
              antialias: true,
              // Required by the export button: without it the drawing buffer is cleared after each
              // composite and toDataURL returns an empty image.
              preserveDrawingBuffer: true,
              powerPreference: 'high-performance',
            }}
            /*
              The initial position is only ever seen for the instant before the rig frames the
              model, so it is set far enough out that a large scan is not entered from the inside —
              the fit then moves the camera to wherever the geometry actually needs it.
            */
            camera={{ position: [14, 10, 20], fov: 42, near: 0.01, far: 5_000 }}
            onPointerDown={() => setSpinning(false)}
          >
            <StudioEnvironment />

            {/* A key/fill/rim rig. The environment map does the reflections; these do the shaping. */}
            <hemisphereLight args={['#dfe6f5', '#1b1b22', 0.5]} />
            <directionalLight position={[4, 7, 5]} intensity={2.2} />
            <directionalLight position={[-5, 2, -4]} intensity={0.6} />
            <directionalLight position={[0, -4, 3]} intensity={0.28} />

            {ortho ? (
              <OrthographicCamera makeDefault position={[3, 2, 4]} near={0.01} far={1_000} />
            ) : null}

            <Suspense fallback={null}>
              <group ref={modelRef}>
                <Model
                  url={url}
                  format={format}
                  mode={mode}
                  night={backdrop !== 'paper'}
                  onDecoded={handleDecoded}
                  onSummary={handleSummary}
                  onClips={handleClips}
                />
              </group>
            </Suspense>

            {floor !== null ? (
              <SceneHelpers
                floor={floor}
                span={span}
                box={showBounds ? box : null}
                showGrid={showGrid}
                showAxes={showAxes}
                showBounds={showBounds}
                showShadow={showShadow}
                animated={animated}
                night={backdrop !== 'paper'}
              />
            ) : null}

            <OrbitControls
              makeDefault
              enableDamping
              dampingFactor={0.08}
              enablePan
              autoRotate={spinning}
              autoRotateSpeed={0.9}
            />

            <CameraRig
              target={modelRef}
              fill={fill}
              mode={frameFit}
              request={request}
              readyKey={readyKey}
              onFramed={handleFramed}
            />
            <CaptureBridge register={registerCapture} />
          </Canvas>
        </ViewerBoundary>
      </div>

      <LoadReporter onSettled={() => setHintVisible(false)} />

      {!faulted && !compact ? (
        <>
          {!presentation ? (
            <div className="studio-top flex flex-col gap-2 w-full overflow-visible">
              <div className="studio-group flex flex-nowrap items-center gap-1 w-full min-w-0">
                <span className="studio-group-label shrink-0">Surface</span>
                {SHADE_MODES.map((spec) => (
                  <button
                    key={spec.id}
                    type="button"
                    className="studio-btn whitespace-nowrap shrink-0"
                    aria-pressed={mode === spec.id}
                    aria-keyshortcuts={spec.key}
                    title={
                      spec.id === 'edges' && edgeDisabled
                        ? `Too dense for an edge overlay: ${formatCount(decoded?.triangles ?? 0)} triangles is over the ${formatCount(EDGE_TRIANGLE_BUDGET)} budget. Wireframe costs nothing.`
                        : `${spec.hint}  ·  ${spec.key}`
                    }
                    disabled={spec.id === 'edges' && edgeDisabled}
                    onClick={() => chooseShade(spec.id)}
                  >
                    {spec.label}
                    <kbd>{spec.key}</kbd>
                  </button>
                ))}
              </div>

              <div className="studio-group flex flex-nowrap items-center gap-1 w-full min-w-0">
                <span className="studio-group-label shrink-0">Camera</span>
                {VIEW_BUTTONS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="studio-btn"
                    aria-pressed={view === entry.id}
                    aria-keyshortcuts={entry.key}
                    title={`Look at the model from the ${entry.label.toLowerCase()} and re-frame it  ·  ${entry.key}`}
                    onClick={() => goToView(entry.id)}
                  >
                    {entry.label}
                    <kbd>{entry.key}</kbd>
                  </button>
                ))}
                <span className="studio-divider" aria-hidden />
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={ortho}
                  title="Projection: orthographic shows true proportions with no perspective foreshortening — use it when measuring an export against its spec sheet  ·  V"
                  onClick={toggleOrtho}
                >
                  {ortho ? 'Orthographic' : 'Perspective'}
                  <kbd>V</kbd>
                </button>
              </div>

              <div className="studio-group flex flex-nowrap items-center gap-1 w-full min-w-0">
                <span className="studio-group-label shrink-0">Overlays</span>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={showGrid}
                  aria-keyshortcuts="G"
                  title="Measurement grid, stepped to this model's scale  ·  G"
                  onClick={() => setShowGrid((value) => !value)}
                >
                  Grid
                  <kbd>G</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={showAxes}
                  aria-keyshortcuts="A"
                  title="Origin axes — X red, Y green, Z blue  ·  A"
                  onClick={() => setShowAxes((value) => !value)}
                >
                  Axes
                  <kbd>A</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={showBounds}
                  aria-keyshortcuts="O"
                  title="Bounding box of the geometry as decoded, so you can check the export fits the volume it was authored for  ·  O"
                  onClick={() => setShowBounds((value) => !value)}
                >
                  Bounds
                  <kbd>O</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={showShadow}
                  aria-keyshortcuts="H"
                  title="Ground shadow, so the model does not read as a sticker  ·  H"
                  onClick={() => setShowShadow((value) => !value)}
                >
                  Shadow
                  <kbd>H</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={spinning}
                  aria-keyshortcuts="P"
                  title="Turntable — stops as soon as you take control  ·  P"
                  onClick={() => setSpinning((value) => !value)}
                >
                  Turntable
                  <kbd>P</kbd>
                </button>
              </div>

              <div className="studio-group flex flex-nowrap items-center gap-1 w-full min-w-0">
                <button
                  type="button"
                  className="studio-btn"
                  title={`Background: stage, dark or light. A dark asset needs the light one. Currently ${BACKDROP_LABEL[backdrop]}.`}
                  onClick={() =>
                    setBackdrop((value) =>
                      value === 'stage' ? 'night' : value === 'night' ? 'paper' : 'stage',
                    )
                  }
                >
                  <span className="studio-swatch" data-backdrop={backdrop} aria-hidden />
                  {BACKDROP_LABEL[backdrop]}
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={panelOpen}
                  aria-keyshortcuts="I"
                  title="File inventory — geometry, materials, textures, rig  ·  I"
                  onClick={() => setPanelOpen((value) => !value)}
                >
                  Inventory
                  <kbd>I</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-keyshortcuts="S"
                  title="Save the current view as a PNG at the canvas resolution  ·  S"
                  onClick={saveShot}
                >
                  Save PNG
                  <kbd>S</kbd>
                </button>
                <button
                  type="button"
                  className="studio-btn"
                  aria-pressed={expanded}
                  aria-keyshortcuts="M"
                  title="Full screen  ·  M"
                  onClick={() => void toggleExpanded()}
                >
                  {expanded ? 'Exit' : 'Full screen'}
                  <kbd>M</kbd>
                </button>
              </div>
            </div>
          ) : null}

          {!presentation && panelOpen ? (
            <StatsPanel
              decoded={decoded}
              summary={summary}
              clips={clips}
              ortho={ortho}
              onClose={() => setPanelOpen(false)}
            />
          ) : null}

          {clips && clips.names.length > 0 && clipName.length > 0 ? (
            <Transport
              clips={clips}
              clipName={clipName}
              playing={playing}
              time={clipTime}
              speed={speed}
              onClip={setClipName}
              onToggle={() => setPlaying((value) => !value)}
              onScrub={handleScrub}
              onSpeed={setSpeed}
            />
          ) : null}

          {hintVisible ? (
            <div className="studio-hint">
              {presentation ? (
                <>
                  <strong>Drag</strong> to orbit · <strong>scroll</strong> to zoom
                </>
              ) : (
                <>
                  <strong>Orbit</strong> drag · <strong>Zoom</strong> scroll ·{' '}
                  <strong>Re-frame</strong> double-click
                  <span className="studio-hint-sep" aria-hidden />
                  every control is also a key — they are printed on the buttons
                </>
              )}
            </div>
          ) : null}

          {!presentation ? (
            <div className="studio-bottom">
              <span className="studio-meta">
                {label ? <span>{label}</span> : null}
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${cid} — open the raw file from the gateway`}
                >
                  CID {shortCid(cid)}
                </a>
                {decoded ? (
                  <DecodeReadout decoded={decoded} recorded={recordedPolycount} />
                ) : (
                  <span>decoding…</span>
                )}
                {dimensions ? (
                  <span title="Extent recorded for this version, in model units">
                    {dimensions.x} × {dimensions.y} × {dimensions.z} units on record
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
