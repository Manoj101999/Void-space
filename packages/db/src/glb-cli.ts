/**
 * Writes a valid demo GLB to disk — `pnpm --filter @void-space/db demo:glb [path]`.
 *
 * Kept as a CLI over `buildGlbFixture` rather than a separate script so the demo aid and the
 * seed fixtures cannot drift apart.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGlbFixture } from './glb-fixture';

const target = resolve(process.argv[2] ?? '/tmp/demo-cube.glb');
const triangles = Number.parseInt(process.argv[3] ?? '12', 10);

if (!Number.isInteger(triangles) || triangles < 1) {
  console.error(`[demo:glb] triangle count must be a positive integer (received: ${process.argv[3]})`);
  process.exitCode = 1;
} else {
  const glb = buildGlbFixture(triangles);
  writeFileSync(target, glb);
  console.log(`wrote ${target} (${glb.length} bytes, ${triangles} triangles)`);
}
