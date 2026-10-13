/**
 * Parametric shape library for demo fixtures.
 *
 * Why this exists
 * ---------------
 * The demo catalogue used to be built entirely by `buildGlbFixture`, which distributes a triangle
 * budget over a **sphere**. Every generated asset was therefore the same yellow ball: a helmet, a
 * tower crane and a traffic cone rendered identically. A marketplace where every listing looks the
 * same is not a marketplace — and worse, it hides real preview bugs behind "they all look like
 * that anyway".
 *
 * So each demo asset now names a *shape*, and this module builds it out of primitives: boxes,
 * cylinders, cones, spheres and tubes, arranged in a recipe. The geometry is solid and the parts
 * carry their own materials, so a rendered thumbnail reads as the object it claims to be.
 *
 * Triangle budgets
 * ----------------
 * A recipe's triangle count is a consequence of its detail level, not something that can be forced
 * to an arbitrary number. The seed therefore stores the **measured** count (see
 * `measuredColumns` in `seed-assets.ts`), which is what the interface should always have claimed.
 * `buildGlbFixture` keeps its exact-count contract for tests and for content that has no recipe.
 *
 * Everything here is deterministic — no randomness, no clock — so re-seeding yields identical bytes,
 * identical CIDs, and a no-op on an already-seeded database.
 */
import { Buffer } from 'node:buffer';

export type Vec3 = readonly [number, number, number];

/** Shapes a demo asset can ask for. `sphere` is the neutral fallback. */
export const SHAPE_NAMES = [
  'helmet',
  'crane',
  'drill',
  'cone',
  'plate',
  'fence',
  'scaffold',
  'sign',
  'harness',
  'excavator',
  'conveyor',
  'ladder',
  'anchor',
  'sphere',
] as const;

export type ShapeName = (typeof SHAPE_NAMES)[number];

export function isShapeName(value: string): value is ShapeName {
  return (SHAPE_NAMES as readonly string[]).includes(value);
}

/** A material, as it appears in the glTF `materials` array. */
export interface Material {
  readonly name: string;
  readonly baseColor: Vec3;
  readonly metallic: number;
  readonly roughness: number;
}

/**
 * One piece of a shape: flat-shaded triangles plus the material they are drawn with.
 *
 * Flat shading duplicates vertices per triangle, which is what a modelling tool exports for
 * hard-edged geometry and what makes a low-poly render read as a solid object rather than a
 * smooth blob.
 */
class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  /** Adds one triangle, computing its geometric normal. Degenerate triangles are dropped. */
  addTriangle(a: Vec3, b: Vec3, c: Vec3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];

    // Cross product gives the face normal, CCW winding facing outward.
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);

    // A sliver below this threshold contributes nothing visible but costs three vertices.
    if (length < 1e-9) return;
    nx /= length;
    ny /= length;
    nz /= length;

    const base = this.positions.length / 3;
    for (const point of [a, b, c]) {
      this.positions.push(point[0], point[1], point[2]);
      this.normals.push(nx, ny, nz);
    }
    this.indices.push(base, base + 1, base + 2);
  }

  /** Adds a planar quad as two triangles. Corners must be given in order around the face. */
  addQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }
}

const TAU = Math.PI * 2;

/** Rotates a point about the Y axis, in radians. */
function rotateY(point: Vec3, radians: number): Vec3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0] * cos + point[2] * sin, point[1], -point[0] * sin + point[2] * cos];
}

/** Rotates a point about the X axis, in radians. */
function rotateX(point: Vec3, radians: number): Vec3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0], point[1] * cos - point[2] * sin, point[1] * sin + point[2] * cos];
}

/** Rotates a point about the Z axis, in radians. */
function rotateZ(point: Vec3, radians: number): Vec3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos, point[2]];
}

interface Placement {
  readonly offset?: Vec3 | undefined;
  readonly rotateX?: number | undefined;
  readonly rotateY?: number | undefined;
  readonly rotateZ?: number | undefined;
  readonly scale?: number | undefined;
}

/** Applies a placement to a local point, in scale → rotate → translate order. */
function place(point: Vec3, placement: Placement): Vec3 {
  const scale = placement.scale ?? 1;
  let result: Vec3 = [point[0] * scale, point[1] * scale, point[2] * scale];
  if (placement.rotateX) result = rotateX(result, placement.rotateX);
  if (placement.rotateY) result = rotateY(result, placement.rotateY);
  if (placement.rotateZ) result = rotateZ(result, placement.rotateZ);
  const offset = placement.offset ?? [0, 0, 0];
  return [result[0] + offset[0], result[1] + offset[1], result[2] + offset[2]];
}

// ---------------------------------------------------------------- primitives

/** Axis-aligned box of the given full size, centred on the placement origin. */
function addBox(builder: MeshBuilder, size: Vec3, placement: Placement = {}): void {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const corners = {
    // Lower ring (y = -hy), then upper ring (y = +hy), counter-clockwise seen from above.
    a: place([-hx, -hy, hz], placement),
    b: place([hx, -hy, hz], placement),
    c: place([hx, -hy, -hz], placement),
    d: place([-hx, -hy, -hz], placement),
    e: place([-hx, hy, hz], placement),
    f: place([hx, hy, hz], placement),
    g: place([hx, hy, -hz], placement),
    h: place([-hx, hy, -hz], placement),
  };

  builder.addQuad(corners.a, corners.b, corners.c, corners.d); // bottom
  builder.addQuad(corners.e, corners.h, corners.g, corners.f); // top
  builder.addQuad(corners.a, corners.e, corners.f, corners.b); // +z
  builder.addQuad(corners.c, corners.g, corners.h, corners.d); // -z
  builder.addQuad(corners.b, corners.f, corners.g, corners.c); // +x
  builder.addQuad(corners.d, corners.h, corners.e, corners.a); // -x
}

/** Triangular prism: an extruded triangle, used for gussets, webs and teeth. */
function addPrism(
  builder: MeshBuilder,
  points: readonly [Vec3, Vec3, Vec3],
  depth: number,
  placement: Placement = {},
): void {
  const half = depth / 2;
  const front = points.map((p) => place([p[0], p[1], half], placement)) as [Vec3, Vec3, Vec3];
  const back = points.map((p) => place([p[0], p[1], -half], placement)) as [Vec3, Vec3, Vec3];

  builder.addTriangle(front[0], front[1], front[2]);
  builder.addTriangle(back[2], back[1], back[0]);
  for (let edge = 0; edge < 3; edge += 1) {
    const next = (edge + 1) % 3;
    builder.addQuad(front[edge] as Vec3, front[next] as Vec3, back[next] as Vec3, back[edge] as Vec3);
  }
}

/**
 * Capped cylinder along local +Y, its base at the origin.
 *
 * `segments` is the radial resolution: 6 reads as a scaffolding tube, 24 as a machined fitting.
 */
function addCylinder(
  builder: MeshBuilder,
  radius: number,
  height: number,
  segments: number,
  placement: Placement = {},
  options: { readonly capped?: boolean } = {},
): void {
  const capped = options.capped ?? true;
  const ring = (y: number): Vec3[] =>
    Array.from({ length: segments }, (_, index) => {
      const angle = (index / segments) * TAU;
      return place([Math.cos(angle) * radius, y, Math.sin(angle) * radius], placement);
    });

  const bottom = ring(0);
  const top = ring(height);

  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    builder.addQuad(bottom[index] as Vec3, top[index] as Vec3, top[next] as Vec3, bottom[next] as Vec3);
  }

  if (capped) {
    const baseCentre = place([0, 0, 0], placement);
    const topCentre = place([0, height, 0], placement);
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      builder.addTriangle(baseCentre, bottom[next] as Vec3, bottom[index] as Vec3);
      builder.addTriangle(topCentre, top[index] as Vec3, top[next] as Vec3);
    }
  }
}

/** Cone along local +Y, base at the origin — the honest way to draw a traffic cone. */
function addCone(
  builder: MeshBuilder,
  radius: number,
  height: number,
  segments: number,
  placement: Placement = {},
): void {
  const apex = place([0, height, 0], placement);
  const baseCentre = place([0, 0, 0], placement);
  const ring = Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * TAU;
    return place([Math.cos(angle) * radius, 0, Math.sin(angle) * radius], placement);
  });

  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    builder.addTriangle(ring[index] as Vec3, ring[next] as Vec3, apex);
    builder.addTriangle(baseCentre, ring[next] as Vec3, ring[index] as Vec3);
  }
}

/** UV sphere centred on the placement origin. `rings` is the latitude resolution. */
function addSphere(
  builder: MeshBuilder,
  radius: number,
  segments: number,
  rings: number,
  placement: Placement = {},
): void {
  const at = (latitude: number, longitude: number): Vec3 => {
    const phi = (latitude / rings) * Math.PI;
    const theta = (longitude / segments) * TAU;
    return place(
      [
        Math.sin(phi) * Math.cos(theta) * radius,
        Math.cos(phi) * radius,
        Math.sin(phi) * Math.sin(theta) * radius,
      ],
      placement,
    );
  };

  for (let latitude = 0; latitude < rings; latitude += 1) {
    for (let longitude = 0; longitude < segments; longitude += 1) {
      const nextLongitude = (longitude + 1) % segments;
      const topLeft = at(latitude, longitude);
      const topRight = at(latitude, nextLongitude);
      const bottomLeft = at(latitude + 1, longitude);
      const bottomRight = at(latitude + 1, nextLongitude);

      if (latitude === 0) {
        builder.addTriangle(topLeft, bottomLeft, bottomRight);
      } else if (latitude === rings - 1) {
        builder.addTriangle(topLeft, bottomLeft, topRight);
      } else {
        builder.addQuad(topLeft, bottomLeft, bottomRight, topRight);
      }
    }
  }
}

/**
 * A strut between two arbitrary points — the connective tissue of lattice work.
 *
 * Built as a cylinder along +Y, then rotated so +Y maps onto the segment direction, then
 * translated to `from`. This is what makes a crane mast read as a lattice rather than a box.
 */
function addStrut(builder: MeshBuilder, from: Vec3, to: Vec3, radius: number, segments = 6): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return;

  // Yaw about Y then pitch about X places +Y onto the direction (x, y, z).
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.acos(Math.max(-1, Math.min(1, dy / length)));

  addCylinder(builder, radius, length, segments, { offset: from, rotateX: pitch, rotateY: yaw });
}

/** Convenience: a strut whose endpoints are specified as a lower-to-upper pair. */
function addRung(builder: MeshBuilder, y: number, a: Vec3, b: Vec3, radius: number): void {
  addStrut(builder, [a[0], y, a[2]], [b[0], y, b[2]], radius);
}

/** A closed regular polygon of struts in a horizontal plane — rings, guard frames, D-rings. */
function addRing(
  builder: MeshBuilder,
  centre: Vec3,
  radius: number,
  tube: number,
  sides: number,
  placement: Placement = {},
): void {
  const points: Vec3[] = Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * TAU;
    return place([Math.cos(angle) * radius, 0, Math.sin(angle) * radius], placement);
  });
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides;
    const a = points[index] as Vec3;
    const b = points[next] as Vec3;
    addStrut(builder, [a[0] + centre[0], a[1] + centre[1], a[2] + centre[2]], [b[0] + centre[0], b[1] + centre[1], b[2] + centre[2]], tube, 5);
  }
}

// ------------------------------------------------------------------ palette

const PALETTE = {
  steel: { name: 'Steel', baseColor: [0.52, 0.55, 0.58] as Vec3, metallic: 0.85, roughness: 0.42 },
  painted: { name: 'MachineryYellow', baseColor: [0.88, 0.62, 0.11] as Vec3, metallic: 0.15, roughness: 0.55 },
  safety: { name: 'SafetyOrange', baseColor: [0.92, 0.34, 0.08] as Vec3, metallic: 0.05, roughness: 0.6 },
  shell: { name: 'PolymerShell', baseColor: [0.93, 0.9, 0.32] as Vec3, metallic: 0.0, roughness: 0.45 },
  dark: { name: 'RubberBlack', baseColor: [0.13, 0.13, 0.15] as Vec3, metallic: 0.0, roughness: 0.85 },
  grey: { name: 'GalvanisedGrey', baseColor: [0.66, 0.68, 0.7] as Vec3, metallic: 0.6, roughness: 0.5 },
  white: { name: 'ReflectiveWhite', baseColor: [0.95, 0.95, 0.93] as Vec3, metallic: 0.0, roughness: 0.35 },
  blue: { name: 'EquipmentBlue', baseColor: [0.16, 0.34, 0.62] as Vec3, metallic: 0.2, roughness: 0.5 },
  glass: { name: 'CabGlass', baseColor: [0.42, 0.55, 0.62] as Vec3, metallic: 0.1, roughness: 0.15 },
} satisfies Record<string, Material>;

/** One drawable part: the material it uses and the geometry to add. */
interface Part {
  readonly material: Material;
  readonly build: (builder: MeshBuilder) => void;
}

/** Wraps a geometry callback with its material. */
function part(material: Material, build: (builder: MeshBuilder) => void): Part {
  return { material, build };
}

// ------------------------------------------------------------------- recipes
//
// Each recipe is authored at roughly real-world scale in metres, resting on or above y = 0. The
// viewer frames whatever it is given from the measured bounding box, so only the proportions and
// self-consistency matter, not the absolute size.

/** Industrial safety helmet: shell, brim, crown ridge and a chin strap. */
function helmetRecipe(): Part[] {
  return [
    part(PALETTE.shell, (b) => {
      // Crown: a sphere positioned so the brim hides its lower half.
      addSphere(b, 0.15, 22, 12, { offset: [0, 0.11, 0] });
    }),
    part(PALETTE.shell, (b) => {
      // Brim, tilted slightly forward like a real hard hat.
      addCylinder(b, 0.185, 0.014, 26, { offset: [0, 0.105, -0.012], rotateX: 0.08 });
    }),
    part(PALETTE.painted, (b) => {
      // Crown ridge — the moulding line down the middle of every hard hat.
      addBox(b, [0.026, 0.018, 0.24], { offset: [0, 0.235, 0], rotateX: 0.03 });
    }),
    part(PALETTE.dark, (b) => {
      addBox(b, [0.11, 0.006, 0.05], { offset: [0, 0.008, -0.135] });
    }),
  ];
}

/** Traffic cone: base slab, tapered body and a reflective collar. */
function coneRecipe(): Part[] {
  return [
    part(PALETTE.safety, (b) => {
      addBox(b, [0.34, 0.028, 0.34], { offset: [0, 0.014, 0] });
    }),
    part(PALETTE.safety, (b) => {
      addCone(b, 0.135, 0.52, 22, { offset: [0, 0.028, 0] });
    }),
    part(PALETTE.white, (b) => {
      // The reflective sleeve, sat where the cone is about 0.086 across.
      addCylinder(b, 0.086, 0.075, 22, { offset: [0, 0.26, 0] });
    }),
  ];
}

/** Lattice mounting plate: slab, stiffening ribs and four bolt bosses. */
function plateRecipe(): Part[] {
  const bosses: readonly Vec3[] = [
    [-0.17, 0, 0.11],
    [0.17, 0, 0.11],
    [-0.17, 0, -0.11],
    [0.17, 0, -0.11],
  ];
  return [
    part(PALETTE.steel, (b) => {
      addBox(b, [0.48, 0.022, 0.3], { offset: [0, 0.011, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Two ribs underneath: what makes it a mounting plate rather than a sheet.
      addBox(b, [0.44, 0.05, 0.018], { offset: [0, -0.014, 0.05] });
      addBox(b, [0.44, 0.05, 0.018], { offset: [0, -0.014, -0.05] });
    }),
    part(PALETTE.grey, (b) => {
      for (const boss of bosses) {
        addCylinder(b, 0.024, 0.03, 14, { offset: [boss[0], 0.022, boss[2]] });
      }
    }),
  ];
}

/** Emergency exit sign: post, illuminated panel and a mounting bracket. */
function signRecipe(): Part[] {
  return [
    part(PALETTE.grey, (b) => {
      addCylinder(b, 0.024, 0.95, 14);
    }),
    part(PALETTE.grey, (b) => {
      addBox(b, [0.34, 0.02, 0.02], { offset: [0, 0.93, 0] });
    }),
    part(PALETTE.blue, (b) => {
      // Panel body, standing proud of the post.
      addBox(b, [0.46, 0.34, 0.022], { offset: [0, 1.13, 0] });
    }),
    part(PALETTE.white, (b) => {
      // The illuminated face, inset so the blue reads as a frame.
      addBox(b, [0.41, 0.29, 0.006], { offset: [0, 1.13, 0.015] });
    }),
  ];
}

/** Cordless impact drill: barrel, grip, battery pack, chuck and bit. */
function drillRecipe(): Part[] {
  return [
    part(PALETTE.dark, (b) => {
      // Barrel laid along +X by rotating the cylinder onto its side.
      addCylinder(b, 0.043, 0.2, 18, { offset: [-0.1, 0.14, 0], rotateZ: Math.PI / 2 });
    }),
    part(PALETTE.painted, (b) => {
      addBox(b, [0.07, 0.14, 0.062], { offset: [-0.05, 0.06, 0], rotateZ: 0.06 });
    }),
    part(PALETTE.dark, (b) => {
      // Battery pack at the base, plus the trigger.
      addBox(b, [0.1, 0.075, 0.075], { offset: [-0.042, -0.02, 0] });
      addBox(b, [0.02, 0.012, 0.05], { offset: [-0.015, 0.13, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Chuck then bit, stepping down in diameter.
      addCylinder(b, 0.03, 0.05, 16, { offset: [0.1, 0.14, 0], rotateZ: Math.PI / 2 });
      addCylinder(b, 0.007, 0.11, 10, { offset: [0.15, 0.14, 0], rotateZ: Math.PI / 2 });
    }),
  ];
}

/** Extension ladder: two rails, eight rungs and non-slip feet. */
function ladderRecipe(): Part[] {
  const height = 2.3;
  const width = 0.34;
  const rungs = 8;
  return [
    part(PALETTE.grey, (b) => {
      addStrut(b, [-width / 2, 0, 0], [-width / 2, height, 0], 0.022, 8);
      addStrut(b, [width / 2, 0, 0], [width / 2, height, 0], 0.022, 8);
    }),
    part(PALETTE.grey, (b) => {
      for (let index = 0; index < rungs; index += 1) {
        const y = 0.18 + (index / (rungs - 1)) * (height - 0.36);
        addRung(b, y, [-width / 2, 0, 0], [width / 2, 0, 0], 0.014);
      }
    }),
    part(PALETTE.dark, (b) => {
      addBox(b, [0.07, 0.03, 0.07], { offset: [-width / 2, 0.015, 0] });
      addBox(b, [0.07, 0.03, 0.07], { offset: [width / 2, 0.015, 0] });
    }),
  ];
}

/** Stockless anchor: shank, stock, crown ring and two flukes. */
function anchorRecipe(): Part[] {
  return [
    part(PALETTE.steel, (b) => {
      addCylinder(b, 0.02, 0.62, 12, { offset: [0, 0.06, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Stock across the shank, near the top.
      addBox(b, [0.46, 0.028, 0.028], { offset: [0, 0.6, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Crown: the ring the rode shackles to. An octagon of struts reads as a ring at this scale.
      addRing(b, [0, 0.72, 0], 0.05, 0.014, 8);
    }),
    part(PALETTE.steel, (b) => {
      // Flukes: two triangular plates splayed from the base of the shank.
      addPrism(b, [[0, 0, 0.05], [0.05, -0.2, 0.05], [-0.05, -0.2, 0.05]], 0.03, {
        offset: [-0.1, 0.06, 0],
        rotateZ: 0.35,
      });
      addPrism(b, [[0, 0, 0.05], [0.05, -0.2, 0.05], [-0.05, -0.2, 0.05]], 0.03, {
        offset: [0.1, 0.06, 0],
        rotateZ: -0.35,
      });
    }),
  ];
}

/** Neutral fallback: a faceted sphere, for any asset with no recipe of its own. */
function sphereRecipe(): Part[] {
  return [
    part(PALETTE.grey, (b) => {
      addSphere(b, 0.5, 24, 14, { offset: [0, 0.5, 0] });
    }),
  ];
}

/** Tower crane: lattice mast, slewing platform, jib, counter-jib, cab and hook block. */
function craneRecipe(): Part[] {
  const mastHeight = 2.2;
  const half = 0.14;
  const corners: readonly Vec3[] = [
    [-half, 0, -half],
    [half, 0, -half],
    [half, 0, half],
    [-half, 0, half],
  ];
  const jibTip: Vec3 = [1.55, mastHeight + 0.34, 0];
  const jibRoot: Vec3 = [half, mastHeight + 0.16, 0];

  return [
    part(PALETTE.painted, (b) => {
      // Four uprights.
      for (const corner of corners) {
        addStrut(b, [corner[0], 0, corner[2]], [corner[0], mastHeight, corner[2]], 0.018, 6);
      }
      // Horizontal ties every 0.55 m, closing each face of the tower.
      for (let level = 1; level <= 4; level += 1) {
        const y = (level / 4) * mastHeight;
        for (let edge = 0; edge < 4; edge += 1) {
          const a = corners[edge] as Vec3;
          const c = corners[(edge + 1) % 4] as Vec3;
          addStrut(b, [a[0], y, a[2]], [c[0], y, c[2]], 0.009, 5);
        }
      }
      // Diagonal bracing, alternating direction per face — the pattern that reads as a crane.
      for (let edge = 0; edge < 4; edge += 1) {
        const a = corners[edge] as Vec3;
        const c = corners[(edge + 1) % 4] as Vec3;
        for (let level = 0; level < 4; level += 1) {
          const low = (level / 4) * mastHeight;
          const high = ((level + 1) / 4) * mastHeight;
          if (level % 2 === 0) {
            addStrut(b, [a[0], low, a[2]], [c[0], high, c[2]], 0.008, 4);
          } else {
            addStrut(b, [c[0], low, c[2]], [a[0], high, a[2]], 0.008, 4);
          }
        }
      }
    }),
    part(PALETTE.steel, (b) => {
      // Slewing platform the jib and cab sit on.
      addBox(b, [0.46, 0.07, 0.46], { offset: [0, mastHeight + 0.035, 0] });
    }),
    part(PALETTE.painted, (b) => {
      // Jib: two chords plus verticals and diagonals out to the tip.
      const bellyY = mastHeight + 0.1;
      addStrut(b, [jibRoot[0], jibRoot[1], -0.06], [jibTip[0], jibTip[1], -0.06], 0.012, 5);
      addStrut(b, [jibRoot[0], jibRoot[1], 0.06], [jibTip[0], jibTip[1], 0.06], 0.012, 5);
      addStrut(b, [jibRoot[0], bellyY, 0], [jibTip[0], bellyY - 0.06, 0], 0.012, 5);

      const segments = 7;
      for (let index = 0; index <= segments; index += 1) {
        const t = index / segments;
        const x = jibRoot[0] + (jibTip[0] - jibRoot[0]) * t;
        const yTop = jibRoot[1] + (jibTip[1] - jibRoot[1]) * t;
        const yBottom = bellyY + (bellyY - 0.06 - bellyY) * t;
        addStrut(b, [x, yTop, -0.06], [x, yBottom, 0], 0.007, 4);
        addStrut(b, [x, yTop, 0.06], [x, yBottom, 0], 0.007, 4);
        if (index < segments) {
          const nextT = (index + 1) / segments;
          const nextX = jibRoot[0] + (jibTip[0] - jibRoot[0]) * nextT;
          const nextYBottom = bellyY + (bellyY - 0.06 - bellyY) * nextT;
          addStrut(b, [x, yBottom, 0], [nextX, nextYBottom, 0], 0.007, 4);
        }
      }
    }),
    part(PALETTE.painted, (b) => {
      // Counter-jib with its counterweight slab.
      addStrut(b, [-half, mastHeight + 0.16, 0], [-0.62, mastHeight + 0.2, 0], 0.014, 5);
      addBox(b, [0.16, 0.22, 0.34], { offset: [-0.56, mastHeight + 0.09, 0] });
    }),
    part(PALETTE.glass, (b) => {
      // Operator cab, hung off the mast below the slewing platform.
      addBox(b, [0.2, 0.26, 0.24], { offset: [0.24, mastHeight - 0.14, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Hoist rope and hook block under the jib.
      const hookX = 1.1;
      addCylinder(b, 0.005, 0.42, 6, { offset: [hookX, mastHeight - 0.16, 0] });
      addBox(b, [0.07, 0.09, 0.04], { offset: [hookX, mastHeight - 0.2, 0] });
    }),
  ];
}

/** Tube-and-fitting scaffold: standards, ledgers, diagonal braces and a boarded deck. */
function scaffoldRecipe(): Part[] {
  const height = 2.0;
  const bay = 0.9;
  const width = 0.62;

  // Four standards, in plan: a bay wide, a width deep.
  const standards: readonly Vec3[] = [
    [-bay / 2, 0, -width / 2],
    [bay / 2, 0, -width / 2],
    [bay / 2, 0, width / 2],
    [-bay / 2, 0, width / 2],
  ];
  const liftHeights = [0.45, 0.95, 1.45, 1.95];

  return [
    part(PALETTE.grey, (b) => {
      for (const standard of standards) {
        addStrut(b, [standard[0], 0, standard[2]], [standard[0], height, standard[2]], 0.024, 8);
      }
    }),
    part(PALETTE.grey, (b) => {
      // Ledgers at every lift, on both long faces and both ends.
      for (const y of liftHeights) {
        for (let edge = 0; edge < 4; edge += 1) {
          const a = standards[edge] as Vec3;
          const c = standards[(edge + 1) % 4] as Vec3;
          addStrut(b, [a[0], y, a[2]], [c[0], y, c[2]], 0.016, 6);
        }
      }
    }),
    part(PALETTE.grey, (b) => {
      // Facade bracing: a zigzag up the outer face, which is what stops a scaffold racking.
      for (let index = 0; index < liftHeights.length; index += 1) {
        const low = index === 0 ? 0 : (liftHeights[index - 1] as number);
        const high = liftHeights[index] as number;
        const left = standards[0] as Vec3;
        const right = standards[1] as Vec3;
        if (index % 2 === 0) {
          addStrut(b, [left[0], low, left[2]], [right[0], high, right[2]], 0.013, 6);
        } else {
          addStrut(b, [right[0], low, right[2]], [left[0], high, left[2]], 0.013, 6);
        }
      }
    }),
    part(PALETTE.painted, (b) => {
      // Toe-boarded deck at the top lift.
      addBox(b, [bay, 0.03, width], { offset: [0, 1.98, 0] });
      addBox(b, [bay, 0.11, 0.02], { offset: [0, 2.05, width / 2] });
      addBox(b, [bay, 0.11, 0.02], { offset: [0, 2.05, -width / 2] });
    }),
  ];
}

/** Mesh safety fence: posts, top and bottom rails, and a welded mesh infill. */
function fenceRecipe(): Part[] {
  const span = 1.8;
  const height = 1.1;
  const posts = [-span / 2, 0, span / 2];

  return [
    part(PALETTE.painted, (b) => {
      for (const x of posts) {
        addCylinder(b, 0.026, height, 12, { offset: [x, 0, 0] });
        // Base plates, so the fence does not appear to balance on a point.
        addCylinder(b, 0.055, 0.016, 12, { offset: [x, 0, 0] });
      }
    }),
    part(PALETTE.painted, (b) => {
      addStrut(b, [-span / 2, height - 0.04, 0], [span / 2, height - 0.04, 0], 0.018, 6);
      addStrut(b, [-span / 2, 0.09, 0], [span / 2, 0.09, 0], 0.018, 6);
    }),
    part(PALETTE.grey, (b) => {
      // Welded mesh: vertical wires at 150 mm, horizontals at 125 mm.
      for (let x = -span / 2 + 0.15; x < span / 2 - 0.01; x += 0.15) {
        addStrut(b, [x, 0.09, 0], [x, height - 0.04, 0], 0.004, 4);
      }
      for (let y = 0.215; y < height - 0.05; y += 0.125) {
        addStrut(b, [-span / 2, y, 0], [span / 2, y, 0], 0.004, 4);
      }
    }),
  ];
}

/** Belt conveyor section: frame, belt, end rollers, side guards and adjustable legs. */
function conveyorRecipe(): Part[] {
  const length = 1.6;
  const breadth = 0.42;
  const beltY = 0.52;

  return [
    part(PALETTE.dark, (b) => {
      // The belt itself, running the length of the section.
      addBox(b, [length, 0.018, breadth * 0.62], { offset: [0, beltY, 0] });
    }),
    part(PALETTE.steel, (b) => {
      // Crowned end rollers, rotated onto their side.
      for (const x of [-length / 2 + 0.06, length / 2 - 0.06]) {
        addCylinder(b, 0.07, breadth * 0.72, 16, { offset: [x, beltY, -breadth * 0.36], rotateX: Math.PI / 2 });
      }
      // Side frame rails.
      addBox(b, [length, 0.05, 0.03], { offset: [0, beltY - 0.055, breadth * 0.32] });
      addBox(b, [length, 0.05, 0.03], { offset: [0, beltY - 0.055, -breadth * 0.32] });
    }),
    part(PALETTE.painted, (b) => {
      // Side guards, which is what makes it a safety-guarded conveyor rather than a band.
      addBox(b, [length, 0.13, 0.02], { offset: [0, beltY + 0.1, breadth * 0.36] });
      addBox(b, [length, 0.13, 0.02], { offset: [0, beltY + 0.1, -breadth * 0.36] });
    }),
    part(PALETTE.steel, (b) => {
      // Four splayed legs with feet.
      const legX = [-length / 2 + 0.2, length / 2 - 0.2];
      const legZ = [breadth * 0.3, -breadth * 0.3];
      for (const x of legX) {
        for (const z of legZ) {
          addStrut(b, [x, beltY - 0.08, z * 0.6], [x * 1.06, 0.02, z], 0.019, 6);
        }
      }
      addStrut(b, [-length / 2 + 0.2, 0.14, 0], [length / 2 - 0.2, 0.14, 0], 0.012, 5);
    }),
  ];
}

/** Full-body fall-arrest harness: shoulder straps, chest strap, waist belt, leg loops, D-ring. */
function harnessRecipe(): Part[] {
  return [
    part(PALETTE.safety, (b) => {
      // Webbing straps: two shoulders meeting at a back D-pad, plus a chest strap.
      addStrut(b, [-0.1, 0.1, 0], [-0.06, 0.52, 0.02], 0.016, 4);
      addStrut(b, [0.1, 0.1, 0], [0.06, 0.52, 0.02], 0.016, 4);
      addStrut(b, [-0.06, 0.52, 0.02], [0.06, 0.52, 0.02], 0.014, 4);
      addStrut(b, [-0.085, 0.34, 0.01], [0.085, 0.34, 0.01], 0.014, 4);
    }),
    part(PALETTE.safety, (b) => {
      // Waist belt as a band of struts, and two leg loops.
      addRing(b, [0, 0.14, 0], 0.115, 0.015, 12);
      addRing(b, [-0.07, 0.03, 0], 0.06, 0.014, 10, { rotateX: Math.PI / 2 });
      addRing(b, [0.07, 0.03, 0], 0.06, 0.014, 10, { rotateX: Math.PI / 2 });
    }),
    part(PALETTE.steel, (b) => {
      // Dorsal D-ring, at the top of the back pad.
      addRing(b, [0, 0.55, 0.03], 0.028, 0.008, 8);
      // Buckle plate on the chest strap.
      addBox(b, [0.05, 0.03, 0.012], { offset: [0, 0.34, 0.03] });
    }),
    part(PALETTE.dark, (b) => {
      // Back pad the straps run through.
      addBox(b, [0.13, 0.2, 0.02], { offset: [0, 0.44, -0.01] });
    }),
  ];
}

/** Tracked hydraulic excavator: tracks, slewing turret, cab, boom, stick and bucket. */
function excavatorRecipe(): Part[] {
  return [
    part(PALETTE.dark, (b) => {
      // Two track assemblies with raised idler ends.
      for (const z of [-0.19, 0.19]) {
        addBox(b, [0.72, 0.2, 0.16], { offset: [0, 0.1, z] });
        addCylinder(b, 0.1, 0.16, 14, { offset: [-0.36, 0.1, z - 0.08], rotateX: Math.PI / 2 });
        addCylinder(b, 0.1, 0.16, 14, { offset: [0.36, 0.1, z - 0.08], rotateX: Math.PI / 2 });
      }
      // Track frame between them.
      addBox(b, [0.5, 0.08, 0.26], { offset: [0, 0.13, 0] });
    }),
    part(PALETTE.painted, (b) => {
      // Slewing turret sitting on the tracks.
      addBox(b, [0.44, 0.16, 0.42], { offset: [0, 0.27, 0] });
      addBox(b, [0.3, 0.1, 0.34], { offset: [-0.24, 0.3, 0] });
    }),
    part(PALETTE.glass, (b) => {
      // Enclosed cab at the front-left of the turret.
      addBox(b, [0.24, 0.26, 0.24], { offset: [0.16, 0.48, 0] });
    }),
    part(PALETTE.painted, (b) => {
      // Boom rising from the turret, then the stick angling down to the bucket.
      addBox(b, [0.11, 0.62, 0.14], { offset: [0.06, 0.66, 0], rotateZ: 0.3 });
      addBox(b, [0.1, 0.46, 0.12], { offset: [0.3, 0.72, 0], rotateZ: -0.55 });
    }),
    part(PALETTE.steel, (b) => {
      // Bucket: a prism shell with teeth.
      addPrism(b, [[-0.08, 0, 0.07], [0.1, 0, 0.07], [0, -0.2, 0.07]], 0.14, {
        offset: [0.5, 0.42, 0],
        rotateZ: 0.4,
      });
      for (let tooth = 0; tooth < 3; tooth += 1) {
        addBox(b, [0.016, 0.03, 0.016], { offset: [0.56 + tooth * 0.012, 0.21, -0.04 + tooth * 0.04] });
      }
    }),
  ];
}

/** Maps each shape name to the recipe that draws it. */
const RECIPES: Record<ShapeName, () => Part[]> = {
  helmet: helmetRecipe,
  crane: craneRecipe,
  drill: drillRecipe,
  cone: coneRecipe,
  plate: plateRecipe,
  fence: fenceRecipe,
  scaffold: scaffoldRecipe,
  sign: signRecipe,
  harness: harnessRecipe,
  excavator: excavatorRecipe,
  conveyor: conveyorRecipe,
  ladder: ladderRecipe,
  anchor: anchorRecipe,
  sphere: sphereRecipe,
};

export interface ShapeStats {
  readonly triangles: number;
  readonly vertices: number;
  readonly materials: number;
}

/**
 * Every part of a shape, built and ready to serialise, with running statistics.
 *
 * Exported so a recipe's cost can be inspected without assembling a GLB, and so tests can assert
 * that a recipe actually describes a multi-part object rather than a single lump.
 */
export function buildShapeParts(shape: ShapeName): {
  parts: Part[];
  meshes: MeshBuilder[];
  stats: ShapeStats;
} {
  const parts = RECIPES[shape]();
  const meshes = parts.map((entry) => {
    const builder = new MeshBuilder();
    entry.build(builder);
    return builder;
  });

  return {
    parts,
    meshes,
    stats: {
      triangles: meshes.reduce((total, mesh) => total + mesh.triangleCount, 0),
      vertices: meshes.reduce((total, mesh) => total + mesh.positions.length / 3, 0),
      materials: new Set(parts.map((entry) => entry.material.name)).size,
    },
  };
}

const GLB_HEADER_BYTES = 12;
const GLB_FLOAT = 5126;
const GLB_UNSIGNED_SHORT = 5123;
const GLB_UNSIGNED_INT = 5125;

function padTo4(buffer: Buffer): Buffer {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder)]);
}

/**
 * Serialises a shape into a GLB.
 *
 * The layout is one shared binary buffer with a buffer view per attribute, and one glTF primitive
 * per part so each part keeps its own material. That is what lets a crane render as yellow lattice
 * with a glass cab and a steel hook rather than 3,000 triangles of a single colour.
 *
 * Indices widen to 32-bit only when a part actually needs it, which keeps files small without
 * risking the silent corruption a truncated Uint16 index would cause.
 */
export function buildShapeGlb(shape: ShapeName): Buffer {
  const { parts, meshes } = buildShapeParts(shape);

  const binaryChunks: Buffer[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] =
    [];
  const accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[] = [];
  const primitives: { attributes: Record<string, number>; indices: number; material: number }[] = [];

  meshes.forEach((mesh, index) => {
    const positionArray = new Float32Array(mesh.positions);
    const normalArray = new Float32Array(mesh.normals);
    const positionBuffer = Buffer.from(positionArray.buffer);
    const normalBuffer = Buffer.from(normalArray.buffer);

    const vertexCount = positionArray.length / 3;
    const indexArray =
      vertexCount > 65_535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    const indexBuffer = Buffer.from(indexArray.buffer);

    const positionPadded = padTo4(positionBuffer);
    const normalPadded = padTo4(normalBuffer);
    const indexPadded = padTo4(indexBuffer);
    const offset = binaryChunks.reduce((total, chunk) => total + chunk.length, 0);
    binaryChunks.push(positionPadded, normalPadded, indexPadded);

    // Position bounds are mandatory for POSITION, and a viewer relies on them to size the model.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let vertex = 0; vertex < positionArray.length; vertex += 3) {
      const x = positionArray[vertex] as number;
      const y = positionArray[vertex + 1] as number;
      const z = positionArray[vertex + 2] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const positionView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: positionBuffer.length,
      target: 34962,
    });
    const normalView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset + positionPadded.length,
      byteLength: normalBuffer.length,
      target: 34962,
    });
    const indexView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset + positionPadded.length + normalPadded.length,
      byteLength: indexBuffer.length,
      target: 34963,
    });

    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: GLB_FLOAT,
      count: vertexCount,
      type: 'VEC3',
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });
    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: normalView,
      componentType: GLB_FLOAT,
      count: normalArray.length / 3,
      type: 'VEC3',
    });
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      componentType: indexArray instanceof Uint32Array ? GLB_UNSIGNED_INT : GLB_UNSIGNED_SHORT,
      count: mesh.indices.length,
      type: 'SCALAR',
    });

    primitives.push({
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
      indices: indexAccessor,
      material: index,
    });
  });

  const binary = Buffer.concat(binaryChunks);
  const gltf = {
    asset: { version: '2.0', generator: 'void-space/glb-shapes' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: shape }],
    meshes: [{ name: shape, primitives }],
    materials: parts.map((entry) => ({
      name: entry.material.name,
      pbrMetallicRoughness: {
        baseColorFactor: [
          entry.material.baseColor[0],
          entry.material.baseColor[1],
          entry.material.baseColor[2],
          1,
        ],
        metallicFactor: entry.material.metallic,
        roughnessFactor: entry.material.roughness,
      },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };

  // JSON chunks are space-padded (0x20), binary chunks zero-padded.
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  const body = Buffer.concat([jsonHeader, json, binaryHeader, binary]);
  const header = Buffer.alloc(GLB_HEADER_BYTES);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(GLB_HEADER_BYTES + body.length, 8);

  return Buffer.concat([header, body]);
}









