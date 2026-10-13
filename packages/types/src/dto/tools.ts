import { z } from 'zod';
import { booleanishSchema } from './common';

/** FR-6.1: Sketchfab search filtered by license and polygon count. */
export const sketchfabSearchSchema = z.object({
  q: z.string().max(120).default(''),
  license: z
    .enum(['cc0', 'by', 'by-sa', 'by-nd', 'by-nc', 'any'])
    .default('cc0'),
  maxPolycount: z.coerce.number().int().positive().max(5_000_000).optional(),
  minPolycount: z.coerce.number().int().nonnegative().optional(),
  downloadable: booleanishSchema.default(true),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});
export type SketchfabSearchQuery = z.infer<typeof sketchfabSearchSchema>;

/** FR-6.2: Poly Pizza search by keyword, category and triangle count. */
export const polyPizzaSearchSchema = z.object({
  q: z.string().max(120).default(''),
  category: z.string().max(60).optional(),
  maxTriangles: z.coerce.number().int().positive().max(5_000_000).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});
export type PolyPizzaSearchQuery = z.infer<typeof polyPizzaSearchSchema>;

/** Shared shape for a third-party search result (FR-6.1/6.2). */
export interface ExternalAssetResult {
  readonly source: 'sketchfab' | 'poly-pizza' | 'meshy';
  readonly externalId: string;
  readonly name: string;
  readonly author: string | null;
  readonly license: string | null;
  readonly polycount: number | null;
  readonly thumbnailUrl: string | null;
  readonly downloadUrl: string | null;
  readonly sourceUrl: string | null;
  readonly downloadable: boolean;
  readonly attribution: string | null;
}

/** FR-6.3: trigger a headless Blender export/optimization job. */
export const blenderOptimizeSchema = z.object({
  assetVersionId: z.string().uuid(),
  /** Target triangle budget; falls back to the tenant default (FR-14.3). */
  polycountBudget: z.coerce.number().int().positive().max(5_000_000).optional(),
  targetFormat: z.enum(['glb', 'gltf']).default('glb'),
  generateLods: booleanishSchema.default(false),
});
export type BlenderOptimizeInput = z.infer<typeof blenderOptimizeSchema>;

/** FR-6.4: text-to-3D generation request via Meshy AI (optional integration). */
export const meshyGenerateSchema = z.object({
  prompt: z.string().min(5).max(600),
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(60).optional(),
  artStyle: z.enum(['realistic', 'sculpture', 'pbr']).default('realistic'),
});
export type MeshyGenerateInput = z.infer<typeof meshyGenerateSchema>;

/** Import a staged third-party result as a new draft asset (UC-09). */
export const importExternalAssetSchema = z.object({
  source: z.enum(['sketchfab', 'poly-pizza']),
  externalId: z.string().min(1).max(200),
  downloadUrl: z.string().url().max(2000),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(60).default('Other'),
  tags: z.array(z.string().min(1).max(40)).max(25).default([]),
  license: z.string().max(120).optional(),
  attribution: z.string().max(500).optional(),
  sourceUrl: z.string().url().max(1000).optional(),
});
export type ImportExternalAssetInput = z.infer<typeof importExternalAssetSchema>;

export interface IntegrationStatus {
  readonly sketchfab: boolean;
  readonly polyPizza: boolean;
  readonly meshy: boolean;
  readonly blender: boolean;
  readonly eon: boolean;
  readonly claude: boolean;
  /** true when the adapter is running in deterministic offline mode (NFR-REL.1). */
  readonly offlineFallbacks: readonly string[];
}
