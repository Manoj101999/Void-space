/**
 * The 3D preview's arithmetic (SRS §6.3, FR-8.1).
 *
 * The preview shows an operator that a licensed file really is the geometry its record describes.
 * That claim only means something if the measurement and the comparison are right, so both are
 * tested here directly — with stubbed meshes rather than a WebGL context, which is the reason
 * `measureScene` takes anything with a `traverse` method.
 */
import { describe, expect, it } from 'vitest';

import {
  comparePolycount,
  formatCount,
  measureScene,
  TOLERANCE_FLOOR,
  TOLERANCE_RATIO,
} from '../src/lib/geometry';

/** A stand-in for three.js: only the shape `measureScene` reads. */
function mesh(options: {
  indexCount?: number | null;
  positionCount?: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] } | null;
}) {
  const { indexCount = null, positionCount = 0, bounds = null } = options;

  return {
    isMesh: true,
    geometry: {
      index: indexCount === null ? null : { count: indexCount },
      attributes: { position: { count: positionCount } },
      computeBoundingBox(this: { boundingBox?: unknown }) {
        if (!bounds) return;
        this.boundingBox = {
          min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
          max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
        };
      },
      boundingBox: null as null | {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
      },
    },
  };
}

/** A scene is anything that can walk itself; extra non-mesh nodes are the point of some cases. */
function scene(...objects: unknown[]) {
  return {
    traverse(visit: (object: unknown) => void) {
      for (const object of objects) visit(object);
    },
  };
}

describe('measureScene', () => {
  it('counts triangles from the index when the geometry is indexed', () => {
    const measured = measureScene(scene(mesh({ indexCount: 36, positionCount: 24 })));
    expect(measured.meshes).toBe(1);
    expect(measured.triangles).toBe(12);
    expect(measured.vertices).toBe(24);
  });

  it('counts triangles from the position attribute when the geometry is not indexed', () => {
    // glTF permits either, and exporters use both; a non-indexed cube must not measure as zero.
    const measured = measureScene(scene(mesh({ indexCount: null, positionCount: 36 })));
    expect(measured.triangles).toBe(12);
    expect(measured.vertices).toBe(36);
  });

  it('ignores lights, cameras and empties', () => {
    const measured = measureScene(
      scene({ isMesh: false }, { type: 'DirectionalLight' }, mesh({ indexCount: 3 })),
    );
    expect(measured.meshes).toBe(1);
    expect(measured.triangles).toBe(1);
  });

  it('measures a mesh with no position attribute as contributing nothing rather than NaN', () => {
    const measured = measureScene(scene(mesh({ indexCount: null })));
    expect(measured.triangles).toBe(0);
    expect(measured.vertices).toBe(0);
    expect(Number.isNaN(measured.triangles)).toBe(false);
  });

  it('sums across every mesh in the scene', () => {
    const measured = measureScene(
      scene(mesh({ indexCount: 36 }), mesh({ indexCount: 30, positionCount: 12 })),
    );
    expect(measured.meshes).toBe(2);
    expect(measured.triangles).toBe(12 + 10);
    expect(measured.vertices).toBe(12);
  });

  it('reports the extent of the union of the geometry bounds', () => {
    const measured = measureScene(
      scene(
        mesh({ indexCount: 3, bounds: { min: [-1, -2, -3], max: [1, 2, 3] } }),
        mesh({ indexCount: 3, bounds: { min: [-4, 0, 0], max: [1, 1, 1] } }),
      ),
    );
    // Union spans x: -4..1, y: -2..2, z: -3..3
    expect(measured.extent).toEqual({ x: 5, y: 4, z: 6 });
  });

  it('reports a zero extent for an empty scene instead of Infinity', () => {
    const measured = measureScene(scene());
    expect(measured).toEqual({
      meshes: 0,
      triangles: 0,
      vertices: 0,
      extent: { x: 0, y: 0, z: 0 },
    });
  });

  it('ignores a mesh whose geometry cannot produce bounds', () => {
    const measured = measureScene(scene(mesh({ indexCount: 3, bounds: null })));
    expect(measured.triangles).toBe(1);
    expect(measured.extent).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('measures the seeded heart scan the way the record describes it', () => {
    // models/heart.glb: 22,562 triangles, 12,013 vertices, 1 mesh.
    const measured = measureScene(scene(mesh({ indexCount: 22_562 * 3, positionCount: 12_013 })));
    expect(measured.triangles).toBe(22_562);
    expect(comparePolycount(22_562, measured.triangles).status).toBe('match');
  });

  it('measures the seeded whale scan the way the record describes it', () => {
    // models/blue_whale_skeleton.glb: 247,170 triangles across 10 primitives.
    const parts = Array.from({ length: 10 }, () =>
      mesh({ indexCount: Math.floor((247_170 * 3) / 10) }),
    );
    const measured = measureScene(scene(...parts));
    expect(measured.meshes).toBe(10);
    // Integer division across 10 primitives drops at most 9 triangles — well inside tolerance.
    expect(comparePolycount(247_170, measured.triangles).status).toBe('match');
  });
});

describe('comparePolycount', () => {
  it('matches an exact count', () => {
    expect(comparePolycount(22_562, 22_562)).toMatchObject({ status: 'match', delta: 0 });
  });

  it('tolerates a handful of polygons of drift on a large scan', () => {
    // Re-exporting can split primitives; a hair of drift is not evidence of anything.
    expect(comparePolycount(247_170, 247_166).status).toBe('match');
  });

  it('tolerates drift up to the ratio, and flags the first value past it', () => {
    const recorded = 100_000;
    const tolerance = Math.max(TOLERANCE_FLOOR, recorded * TOLERANCE_RATIO);

    expect(comparePolycount(recorded, recorded + tolerance).status).toBe('match');
    expect(comparePolycount(recorded, recorded + tolerance + 1).status).toBe('mismatch');
    expect(comparePolycount(recorded, recorded - tolerance - 1).status).toBe('mismatch');
  });

  it('applies a floor so small models are not flagged over a sub-triangle rounding', () => {
    // 2% of 40 triangles is under one triangle, so without the floor any rounding would mismatch.
    expect(TOLERANCE_FLOOR).toBeGreaterThan(1);
    expect(comparePolycount(40, 40 + TOLERANCE_FLOOR).status).toBe('match');
    expect(comparePolycount(40, 40 + TOLERANCE_FLOOR + 1).status).toBe('mismatch');
  });

  it('flags a wildly wrong record', () => {
    const agreement = comparePolycount(999, 22_562);
    expect(agreement.status).toBe('mismatch');
    expect(agreement.delta).toBe(22_562 - 999);
    // The explanation must name both numbers: the operator needs to see which side is which.
    expect(agreement.reason).toContain('999');
    expect(agreement.reason).toContain('22,562');
  });

  it('reports an unknown status when no count is recorded', () => {
    for (const recorded of [null, 0, -1, Number.NaN]) {
      expect(comparePolycount(recorded, 500)).toMatchObject({ status: 'unknown', delta: 0 });
    }
  });

  it('reports an unknown status when the viewer decoded nothing to compare against', () => {
    // A record of 5,000 against an empty scene is not a mismatch — there is nothing to check.
    expect(comparePolycount(5_000, 0).status).toBe('unknown');
  });

  it('signs the delta as decoded minus recorded', () => {
    expect(comparePolycount(100, 300).delta).toBe(200);
    expect(comparePolycount(300, 100).delta).toBe(-200);
  });
});

describe('formatCount', () => {
  it('groups thousands so a 247170-triangle scan reads as 247,170', () => {
    expect(formatCount(247_170)).toBe('247,170');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(0)).toBe('0');
  });

  it('rounds a fractional count rather than printing a decimal', () => {
    expect(formatCount(12.6)).toBe('13');
  });
});

