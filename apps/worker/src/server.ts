/**
 * Worker entry point.
 *
 * The repository-root .env is loaded *before* anything that constructs a Prisma client is
 * imported. ESM imports are hoisted, so the loader has to run first and the rest of the
 * worker is pulled in dynamically — otherwise a processor's top-level `@void-space/db`
 * import would build a client with no DATABASE_URL.
 */
import { loadRootEnv } from '@void-space/db/env';

loadRootEnv();

const { main } = await import('./main');

await main();
