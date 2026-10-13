import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

// Load the repository-root .env before the workers spawn: the Prisma clients are
// constructed at module-evaluation time (same approach as packages/db).
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
    // The suites drive a real Fastify app against the dockerized Postgres, so keep
    // them serial (shared rate-limit buckets and audit rows).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
