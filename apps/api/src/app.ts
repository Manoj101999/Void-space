/**
 * Fastify application factory (SRS §3.1 "API-first").
 *
 * Phase 0 provides the skeleton: logging with correlation ids, CORS restricted to
 * the edge origins, a health endpoint that reports dependency status, and a
 * startup assertion that the runtime database role is genuinely subject to
 * Row-Level Security. Feature modules (auth, assets, review, licensing, …) are
 * mounted here in later phases.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { MAX_ASSET_SIZE_BYTES, type HealthResponse } from '@void-space/types';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { assertRlsEnforced, prisma } from '@void-space/db';

import type { ApiEnv } from './env';
import { isAppError } from './lib/errors';
import { rateLimitKey } from './lib/rate-limit-key';
import { createJobProducer } from './lib/producer';
import { authPlugin } from './plugins/auth';
import { openApiPlugin } from './plugins/openapi';
import { auditRoutes } from './modules/audit/routes';
import { assetRoutes } from './modules/assets/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { developerRoutes } from './modules/developer/routes';
import { jobRoutes } from './modules/jobs/routes';
import { licensingRoutes } from './modules/licensing/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { publicRoutes } from './modules/public/routes';
import { reviewRoutes } from './modules/review/routes';
import { toolsRoutes } from './modules/tools/routes';
import { authRoutes } from './modules/auth/routes';
import { googleRoutes } from './modules/auth/google-routes';
import { siweRoutes } from './modules/auth/siwe-routes';
import { tenantRoutes } from './modules/tenant/routes';
import { userRoutes } from './modules/users/routes';

const API_VERSION = '2.0.0';

interface DependencyCheck {
  readonly status: 'up' | 'down' | 'disabled';
  readonly detail?: string;
}

async function checkPostgres(): Promise<DependencyCheck> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', detail: (error as Error).message };
  }
}

async function checkHttp(endpoint: string, init?: RequestInit): Promise<DependencyCheck> {
  try {
    const response = await fetch(endpoint, { ...init, signal: AbortSignal.timeout(1_500) });
    return response.ok ? { status: 'up' } : { status: 'down', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'down', detail: (error as Error).message };
  }
}

/** Anvil answers a JSON-RPC eth_blockNumber call — the documented readiness probe (§9.3). */
async function checkAnvil(rpcUrl: string): Promise<DependencyCheck> {
  return checkHttp(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
}

export async function buildApp(env: ApiEnv): Promise<FastifyInstance> {
  const app = Fastify({
    // Tests assert on responses, not logs; keeping the transport silent keeps the
    // vitest output readable.
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.LOG_LEVEL,
            // Correlation ids per request (§3.2 observability, NFR-MAINT.1).
            genReqId: (request) => {
              const header = request.headers['x-request-id'];
              return typeof header === 'string' && header.length > 0 ? header : crypto.randomUUID();
            },
            transport:
              env.NODE_ENV === 'development'
                ? {
                    target: 'pino-pretty',
                    options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
                  }
                : undefined,
          },
    trustProxy: true,
    disableRequestLogging: false,
  });

  await app.register(sensible);
  await app.register(cookie, { secret: env.JWT_REFRESH_SECRET });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // §3.1: the API is the only trusted boundary, so it rate-limits by default (NFR-SEC.6), and
  // FR-12.4 requires the bucket to follow the credential rather than the address on
  // bearer-authenticated calls. See `lib/rate-limit-key.ts` for the rule and why it is not inline.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Health checks come from nginx every few seconds.
    allowList: (request) => request.url.startsWith('/api/v1/health'),
    keyGenerator: (request) =>
      rateLimitKey({ headers: request.headers, ip: request.ip ?? undefined }),
  });

  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  await app.register(authPlugin, { accessTtl: env.JWT_ACCESS_TTL });

  // FR-3.1 — streamed multipart uploads with the 200 MB ceiling enforced at the parser
  // as well as while writing, so an oversized body is cut before it reaches memory.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ASSET_SIZE_BYTES,
      files: 1,
      fields: 25,
      parts: 30,
    },
  });

  // Dev/test-only discovery surface; the prose contract lives in docs/.
  await app.register(openApiPlugin, env);

  // One producer per process (it owns the Redis connection), shared by every module.
  const producer = createJobProducer(env);
  app.addHook('onClose', async () => {
    await producer.close();
  });

  // --- health (used by nginx/compose and by the web app) --------------------
  const startedAt = Date.now();
  app.get('/api/v1/health', async (): Promise<HealthResponse> => {
    const [postgres, ipfs, anvil] = await Promise.all([
      checkPostgres(),
      checkHttp(`${env.IPFS_API_URL}/api/v0/version`, { method: 'POST' }),
      checkAnvil(env.ANVIL_RPC_URL),
    ]);

    const dependencies = {
      postgres,
      ipfs,
      anvil,
      // Optional integrations degrade gracefully (NFR-REL.1).
      claude: env.ANTHROPIC_API_KEY
        ? ({ status: 'up', detail: 'api key configured' } as const)
        : ({ status: 'disabled', detail: 'offline enricher fallback in use' } as const),
      contract: env.CONTRACT_ADDRESS
        ? ({ status: 'up', detail: env.CONTRACT_ADDRESS } as const)
        : ({ status: 'disabled', detail: 'run pnpm dev:up to deploy' } as const),
    };

    const degraded = Object.values(dependencies).some((dependency) => dependency.status === 'down');

    return {
      status: degraded ? 'degraded' : 'ok',
      version: API_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      dependencies,
    };
  });

  // --- error handling --------------------------------------------------------
  // These MUST be installed before the feature modules are registered. Fastify captures
  // the error/not-found handler per encapsulation context at registration time, so a
  // handler installed afterwards never applies to routes registered inside their own
  // plugin: they would answer with Fastify's default `{statusCode, error, message}` body
  // and lose the `code`, `details` and `requestId` that clients branch on.

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody(request, 404, 'NOT_FOUND', 'Route not found', `${request.method} ${request.url} is not a known route`));
  });

  /**
   * One error envelope for every failure (FR-2.4): a stable machine-readable
   * `code`, a user-safe `message`, optional structured `details`, and the
   * correlation id. 5xx messages are never leaked to the caller.
   */
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'application error');
      } else {
        request.log.info({ code: error.code, statusCode: error.statusCode }, 'request rejected');
      }
      reply
        .status(error.statusCode)
        .send(
          errorBody(
            request,
            error.statusCode,
            error.code,
            error.expose ? error.message : 'Internal server error',
            error.details,
          ),
        );
      return;
    }

    if (error instanceof ZodError) {
      reply
        .status(400)
        .send(
          errorBody(request, 400, 'VALIDATION_ERROR', 'Request validation failed', {
            issues: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          }),
        );
      return;
    }

    // Fastify's own errors (body parse failures, rate limit, validation plugin).
    const statusCode = error.statusCode ?? 500;
    const code =
      statusCode === 429 ? 'RATE_LIMITED' : statusCode < 500 ? (error.code ?? 'BAD_REQUEST') : 'INTERNAL_ERROR';

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }

    reply
      .status(statusCode)
      .send(
        errorBody(request, statusCode, code, statusCode >= 500 ? 'Internal server error' : error.message, undefined),
      );
  });

  // --- feature modules (§6.4) ----------------------------------------------
  await app.register(authRoutes, { prefix: '/api/v1/auth', env });
  await app.register(googleRoutes, { prefix: '/api/v1/auth', env });
  await app.register(siweRoutes, { prefix: '/api/v1/auth', env });
  await app.register(userRoutes, { prefix: '/api/v1' });
  await app.register(tenantRoutes, { prefix: '/api/v1' });
  await app.register(auditRoutes, { prefix: '/api/v1' });
  await app.register(assetRoutes, { prefix: '/api/v1', env, producer });
  // FR-6.1–FR-6.4 and UC-09 — the third-party tools module. It was written, tested and code-reviewed
  // and then never mounted here, so every route in it answered 404 in a running API while its own
  // header claimed the paths were "fixed by the specification". `routes.test.ts` now asserts they
  // resolve, because nothing else can see an unregistered module: it typechecks, lints and passes
  // its unit tests whether or not it is reachable.
  await app.register(toolsRoutes, { prefix: '/api/v1', env, producer });
  await app.register(reviewRoutes, { prefix: '/api/v1', env, producer });
  await app.register(licensingRoutes, { prefix: '/api/v1', env, producer });
  await app.register(notificationRoutes, { prefix: '/api/v1' });
  await app.register(dashboardRoutes, { prefix: '/api/v1' });
  // FR-6.5 — polling for any long-running operation, and FR-12.3 — API key management.
  await app.register(jobRoutes, { prefix: '/api/v1' });
  await app.register(developerRoutes, { prefix: '/api/v1' });
  // §6.1 Public Catalog — the only unauthenticated surface, and the only one reading the
  // cross-tenant projection rather than tenant-scoped tables.
  await app.register(publicRoutes, { prefix: '/api/v1' });

  return app;
}

/** Builds the single error shape every non-2xx response uses (see ApiErrorBody). */
function errorBody(
  request: { id: string },
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): Record<string, unknown> {
  return {
    statusCode,
    error: statusName(statusCode),
    code,
    message,
    ...(details === undefined ? {} : { details }),
    requestId: String(request.id),
    timestamp: new Date().toISOString(),
  };
}

function statusName(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 413:
      return 'Payload Too Large';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    case 503:
      return 'Service Unavailable';
    default:
      return statusCode >= 500 ? 'Internal Server Error' : 'Error';
  }
}

/**
 * Validates that the API can safely talk to its dependencies, then returns the
 * list of startup warnings (e.g. RLS not enforced ⇒ hard failure).
 */
export async function preflight(env: ApiEnv): Promise<string[]> {
  const warnings: string[] = [];

  // Hard failure: a superuser/BYPASSRLS connection would silently disable tenant
  // isolation (FR-1.6, NFR-SEC.5).
  const roleInfo = await assertRlsEnforced(prisma);
  warnings.push(`runtime role ${roleInfo.currentUser} (RLS enforced)`);

  if (!env.CONTRACT_ADDRESS) {
    warnings.push('CONTRACT_ADDRESS is unset — run `pnpm dev:up` to deploy the licence contract');
  }
  if (!env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY unset — AI enrichment will use the offline enricher');
  }
  return warnings;
}
