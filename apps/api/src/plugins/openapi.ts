/**
 * OpenAPI surface (SRS §3.1: "a documented, versioned REST API", §6.4).
 *
 * Registered in development and test only. The generated document lists every route
 * with its tags; the prose contract — request/response shapes, error codes and the
 * RBAC requirement per endpoint — lives in docs/VS-SDD-2.0-api.md, which is the
 * document the frontend and the QA matrix are written against.
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { ApiEnv } from '../env';

/** Where the Swagger UI is mounted. Single source of truth for the route + its index page. */
const DOCS_PREFIX = '/api/v1/docs';

/**
 * The index page for `/api/v1/docs` — the URL **without** a trailing slash.
 *
 * `@fastify/swagger-ui` builds its own index from the request URL: when the URL has no
 * trailing slash it emits prefix-relative assets (`./api/v1/docs/static/swagger-ui.css`),
 * which a browser resolves against the current *directory* (`/api/v1/`) and therefore
 * requests at `/api/v1/api/v1/docs/static/…` → 404 → no CSS, no JS, a blank page.
 *
 * The slashless URL is the one everybody hits: every in-app link points at it (header nav,
 * footer, landing page) and Next.js answers `/api/v1/docs/` with a 308 back to the
 * slashless form, so redirecting here instead would loop forever behind the web app.
 * Root-absolute asset URLs render correctly from either URL, behind Next *or* the nginx edge.
 * The sibling route `/api/v1/docs/` keeps serving the plugin's own template untouched.
 */
const docsIndexHtml = `<!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset="UTF-8">
      <title>Swagger UI</title>
      <link rel="stylesheet" type="text/css" href="${DOCS_PREFIX}/static/swagger-ui.css" />
      <link rel="stylesheet" type="text/css" href="${DOCS_PREFIX}/static/index.css" />
      <link rel="icon" type="image/png" href="${DOCS_PREFIX}/static/favicon-32x32.png" sizes="32x32" />
      <link rel="icon" type="image/png" href="${DOCS_PREFIX}/static/favicon-16x16.png" sizes="16x16" />
      </head>
      <body>
      <div id="swagger-ui"></div>
      <script src="${DOCS_PREFIX}/static/swagger-ui-bundle.js" charset="UTF-8"></script>
      <script src="${DOCS_PREFIX}/static/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
      <script src="${DOCS_PREFIX}/static/swagger-initializer.js" charset="UTF-8"></script>
      </body>
      </html>`;

/**
 * Registered through `fp` on purpose: swagger collects routes with an `onRoute` hook,
 * which only sees routes registered *inside its own encapsulation context*. Without
 * `fp` the document comes out with zero paths — the plugin's scope would contain no
 * routes at all.
 */
export const openApiPlugin = fp<ApiEnv>(
  async (app: FastifyInstance, env: ApiEnv) => {
    if (env.NODE_ENV === 'production') return;

    await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'VOID·SPACE API',
        description:
          'Multi-tenant 3D asset lifecycle API: ingestion, AI-assisted metadata, review, ' +
          'IPFS-backed storage and on-chain licensing. Authentication is cookie-based for ' +
          'browsers (httpOnly access + rotating refresh) and bearer-token based for machines ' +
          '(API keys exchanged at POST /api/v1/auth/token). See docs/VS-SDD-2.0-api.md.',
        version: '2.0.0',
      },
      servers: [{ url: 'https://localhost/api/v1', description: 'Local stack (nginx edge)' }],
      tags: [
        { name: 'auth', description: 'Sign-in, sessions, SSO, API keys (FR-2.x)' },
        { name: 'users', description: 'Tenant members and roles (FR-1.2, FR-1.3, §3.6)' },
        { name: 'tenant', description: 'Workspace settings and platform administration (FR-1.5, FR-14.x)' },
        { name: 'audit', description: 'Append-only audit log (FR-13.x)' },
      ],
      components: {
        securitySchemes: {
          accessCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'vs_access',
            description: 'httpOnly access JWT set by /auth/login (FR-2.3).',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Short-lived token from POST /auth/token (FR-2.5).',
          },
        },
      },
    },
  });

    await app.register(swaggerUi, {
      routePrefix: DOCS_PREFIX,
      uiConfig: { docExpansion: 'list', deepLinking: true },
      staticCSP: true,
      /**
       * Answer the slashless docs URL with the index above (see `docsIndexHtml` for why the
       * plugin's own template cannot be served there). Every other docs route — `/`, `/json`,
       * `/yaml` and the static assets — falls through to the plugin unchanged.
       */
      uiHooks: {
        onRequest: (request, reply, done) => {
          const path = request.url.split('?')[0];
          if (path !== DOCS_PREFIX) {
            done();
            return;
          }
          // Sending from an onRequest hook stops the chain, so `done()` is not called here.
          reply.type('text/html; charset=utf-8').send(docsIndexHtml);
        },
      },
    });
  },
  { name: 'void-space-openapi' },
);
