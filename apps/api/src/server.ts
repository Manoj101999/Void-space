/**
 * API entry point.
 *
 * The repository-root .env is loaded *before* anything that constructs a Prisma
 * client is imported (ESM imports are hoisted, so the loader has to run first and
 * the rest of the app is pulled in dynamically).
 */
import { loadRootEnv } from '@void-space/db/env';

loadRootEnv();

const { main } = await import('./main');

await main();
