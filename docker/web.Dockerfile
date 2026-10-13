# ---------------------------------------------------------------------------
# Next.js web image (SRS §9.2). Talks to the API over the internal network;
# the browser only ever reaches nginx (§3.1).
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/config/package.json ./packages/config/package.json
# pnpm resolves the whole workspace graph, so the remaining manifests are needed
# even though this image only builds apps/web.
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @void-space/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=builder /app ./
RUN addgroup -S void && adduser -S void -G void && chown -R void:void /app
USER void
EXPOSE 3000
CMD ["pnpm", "--filter", "@void-space/web", "start"]
