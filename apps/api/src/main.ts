/**
 * Process lifecycle for the API: validate configuration, run preflight checks,
 * serve, and shut down cleanly on SIGINT/SIGTERM (so `docker compose down` and
 * Ctrl-C release the pools instead of leaving them half-open).
 */
import { disconnectAll } from '@void-space/db';

import { buildApp, preflight } from './app';
import { loadEnv } from './env';

export async function main(): Promise<void> {
  const env = loadEnv();

  const warnings = await preflight(env);
  const app = await buildApp(env);

  for (const warning of warnings) app.log.info(`preflight: ${warning}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    try {
      await app.close();
      await disconnectAll();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`VOID·SPACE API listening on :${env.API_PORT} (${env.NODE_ENV})`);
}
