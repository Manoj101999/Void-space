# ---------------------------------------------------------------------------
# Fastify API image (SRS §9.2). This is the *containerized* alternative to
# running `pnpm dev` natively; the native path is the primary developer loop.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat openssl curl
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ---- dependencies (cached on the lockfile) --------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm install --frozen-lockfile

# ---- runtime --------------------------------------------------------------
FROM deps AS runtime
COPY . .
RUN pnpm --filter @void-space/db generate

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# Non-root runtime user (§2.5 minimises the local attack surface).
RUN addgroup -S void && adduser -S void -G void && chown -R void:void /app
USER void

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:4000/api/v1/health || exit 1

CMD ["pnpm", "--filter", "@void-space/api", "start"]
