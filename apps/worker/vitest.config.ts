import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

// Load the repository-root .env before the workers spawn.
//
// The worker's own suite is mostly pure — queue policy, prompt building, custody rules — and needs
// none of this. But a *processor* test is only worth anything if it asserts the row the processor
// writes, and that means a real database. The Prisma clients are constructed at module-evaluation
// time, so this has to happen here rather than in a setup file (same approach as `packages/db` and
// `apps/api`).
const envPath = resolve(here, '../../.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The processor suites share the seeded workspace and write version rows into it, so they run
    // serially: two tests creating a derivative of the same asset would race on the
    // (assetId, versionNumber) unique index.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
