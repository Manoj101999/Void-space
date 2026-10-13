/**
 * CLI entry point for `pnpm db:seed`.
 *
 * The root .env is loaded *before* the seed module is imported: Prisma clients are
 * constructed at module-evaluation time and would otherwise see an undefined
 * DATABASE_URL (ESM imports are hoisted, so the order here matters).
 */
import { loadRootEnv } from './env';

loadRootEnv();

const { runSeed, printSummary } = await import('./seed');

runSeed()
  .then((summary) => {
    printSummary(summary);
  })
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  });
