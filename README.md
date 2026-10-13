# VOID·SPACE

**AI-enhanced, multi-tenant 3D Digital Asset Management & XR publishing platform** — with
decentralized storage (IPFS) and on-chain licensing (ERC-721 on a local Anvil chain).

Implementation of **VS-SRS-2.0** (`docs/VOID-SPACE_SRS_v2.0_Production.docx`). The whole system —
web app, API, workers, database, cache, IPFS node and blockchain — runs locally from a single
`docker compose` stack with **no cloud dependency, no faucet and no paid RPC provider**.

---

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript | Server components call the API; the browser only ever reaches nginx |
| 3D | Three.js via React Three Fiber + drei | glTF/GLB thumbnails and full viewer |
| UI | Tailwind CSS + shadcn/ui conventions (Radix), `@void-space/ui` | Shared component library with a shared Tailwind preset |
| Client data | TanStack Query (server cache) + Zustand (local UI state) | |
| API | Fastify 4 + TypeScript, JSON-Schema-first, OpenAPI 3.1 | Single source of truth for authz, tenancy and business rules |
| Data | PostgreSQL 16 + Prisma 6 | Shared schema multi-tenancy with **native Row-Level Security** |
| Queue | Redis 7 + BullMQ | `ai-enrichment`, `ipfs-pin`, `blender-optimize`, `chain-license`, `xr-publish`, `notify` |
| Storage | IPFS (Kubo), cached by nginx | Content-addressed CIDs recorded per asset version |
| Chain | Anvil (Foundry) + Solidity ^0.8.24 | `AssetLicenseRegistry.sol` (ERC-721 licence per asset) |
| Edge | nginx (TLS, rate limiting, IPFS gateway cache) | Only service exposed to the host |
| Monorepo | pnpm workspaces + Turborepo | Shared types prevent FE/BE contract drift |

## Repository layout

```
void-space/
├─ apps/
│  ├─ web/        Next.js UI (Creator / Assessor / Admin)
│  ├─ api/        Fastify REST API  →  /api/v1
│  └─ worker/     BullMQ processors (AI, IPFS, Blender, chain, XR, notify)
├─ packages/
│  ├─ db/         Prisma schema, migrations, RLS policies, seed, tenant context
│  ├─ contracts/  Foundry: AssetLicenseRegistry.sol + tests + deploy scripts
│  ├─ types/      Shared DTOs, Zod schemas, RBAC matrix, queue contracts, generated ABI
│  ├─ ui/         Shared shadcn/ui-based components
│  └─ config/     Shared Tailwind preset and ESLint baseline
├─ docker/        Dockerfiles, nginx templates, IPFS entrypoint, cert script
├─ docs/          SRS + generated data-model / design notes
├─ models/        Bundled demo scans, seeded + pinned + licensed (see below)
├─ scripts/       dev-up.sh, dev-down.sh
└─ docker-compose.yml
```

**Package strategy:** internal packages (`types`, `ui`, `db`) export TypeScript **source** and are
consumed directly (`transpilePackages` in Next, `tsx` in the API/worker). This removes a build step
from the inner dev loop while keeping one source of truth for every shared contract. `db` runs
`prisma generate` as its build step; `contracts` is built by Foundry.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- Node.js 20 LTS (`.nvmrc` pins it; Node 20–24 works locally) and pnpm 9 (`corepack enable`)
- *Optional:* a native Foundry install (`forge`, `anvil`, `cast`) — `pnpm dev:up` prefers it and
  falls back to the containerized toolchain

## Quick start

```bash
pnpm install          # install workspace dependencies
pnpm dev:up           # start postgres, redis, ipfs, anvil, nginx + migrate + RLS + deploy contract
pnpm db:seed          # demo tenants, users, assets in every lifecycle state
pnpm dev              # api + worker + web in watch mode
```

Then open **https://localhost** (self-signed dev certificate — `pnpm certs` regenerates it; if you
have `mkcert`, the certificate is trusted automatically).

> **Browse via `https://localhost` only — do not use `http://localhost:3000`.**
> The browser reaches the API at the relative path `/api/v1` (SRS §3.1), which only resolves
> through the nginx edge. The Next dev server on `:3000` serves no `/api/v1` routes, so it
> answers those calls with its HTML 404 page and sign-in fails with
> `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.

> **The login form is pre-filled with `creator@aurora.dev`** — that account is Creator
> (uploads only, reduced nav). For every console page, including Review Queue, Audit and
> Administration, sign in as **`admin@aurora.dev`** instead.

Demo credentials (created by `pnpm db:seed`, password `VoidSpace!2026`):

| Email | Role | Tenant |
|---|---|---|
| `admin@aurora.dev` | TenantAdmin | Aurora Industrial Training |
| `creator@aurora.dev` | Creator | Aurora |
| `assessor@aurora.dev` | Assessor | Aurora |
| `developer@aurora.dev` | Developer | Aurora |
| `viewer@aurora.dev` | Viewer | Aurora |
| `admin@northwind.dev` | TenantAdmin | Northwind Safety XR |
| `priya@void-space.dev` | Creator in Aurora, Assessor in Northwind | both |
| `superadmin@void-space.dev` | SuperAdmin | platform |

## Services and ports

| Service | Container | Host port | Notes |
|---|---|---|---|
| nginx (edge) | `void-space-nginx-1` | 80, 443 | TLS termination, rate limit, IPFS gateway cache |
| web | run natively by `pnpm dev` | 3000 | Next dev server. Browse via `https://localhost`, never `:3000` — see the note above. |
| api | run natively by `pnpm dev` | 4000 | `GET /api/v1/health`, Swagger UI at `/api/v1/docs` |
| worker | run natively by `pnpm dev` | — | BullMQ processors |
| postgres | `…-postgres-1` | 5432 | dev only |
| redis | `…-redis-1` | 6379 | dev only |
| ipfs (Kubo) | `…-ipfs-1` | 5001 (API), 8080 (gateway) | dev only; browsers use nginx `/ipfs/<cid>` |
| anvil | `…-anvil-1` | 8545 | local EVM chain |

Everything is on a private Docker network; only nginx is exposed by default (§2.5).

Containerized alternative to `pnpm dev`:

```bash
docker compose --profile app up -d          # api + worker + web in containers
docker compose --profile blender up -d      # headless Blender runner (heavy image, on demand)
```

## Common tasks

| Command | What it does |
|---|---|
| `pnpm dev:up` | Start infra + edge, apply migrations and RLS, deploy the licence contract |
| `pnpm dev` | api + worker + web in watch mode (Turborepo) |
| `pnpm dev:down` | Stop containers, keep data volumes (`--volumes` for a clean slate) |
| `pnpm db:migrate` | Apply pending Prisma migrations (as the schema-owner role) |
| `pnpm db:rls` | Re-apply RLS policies + grants (idempotent; run after every migration) |
| `pnpm db:seed` | Seed demo tenants/users/assets and print an API key once |
| `pnpm db:reset` | Drop and recreate the schema (`--volumes` not required) |
| `pnpm db:studio` | Prisma Studio against the local database |
| `pnpm contracts:test` | Foundry test suite for `AssetLicenseRegistry.sol` |
| `pnpm contracts:abi` | Regenerate `packages/types/src/contracts/abi.generated.ts` from the compiled ABI |
| `pnpm test` | Everything: Foundry contracts, shared contracts (RBAC/lifecycle/queues), db isolation, API integration, worker wiring |
| `pnpm contracts:deploy` | Deploy (or redeploy) the contract to Anvil and publish its address |
| `pnpm typecheck` | `tsc --noEmit` across every workspace package |
| `pnpm test` | Vitest suites (data layer today; more layers as they land) |
| `pnpm lint` / `pnpm format` | ESLint 9 flat config / Prettier |

## Security model

Tenant isolation is enforced **twice** (defence in depth, §3.5, NFR-SEC.5):

1. **Application layer** — a Fastify `preHandler` checks the caller's permission for the route
   against the §3.6 role matrix, and every repository call happens inside `withTenant(...)`.
2. **Database layer** — PostgreSQL Row-Level Security policies on all 17 tenant-scoped tables, plus a policy on `tenants` itself
   compare `tenant_id` with the transaction-local `app.current_tenant_id` setting. `FORCE ROW
   LEVEL SECURITY` means even the table owner is subject to the policy.

Three database roles keep the blast radius small:

| Role | Used by | Privileges |
|---|---|---|
| `<POSTGRES_USER>` (owner) | migrations, RLS apply, `db:reset` | DDL only |
| `void_app` | api + worker runtime | Full CRUD on tenant-scoped tables, **subject to RLS**; no `UPDATE`/`DELETE` on `audit_logs` (append-only, FR-13.3) |
| `void_platform` | identity resolution at login, workspace switching, SuperAdmin tenant admin | Privileges only on `tenants`, `roles`, `users`, `user_roles`, `wallets`, `invites` — **none** on asset, review, licence, job, notification or audit data |

Additional guarantees worth knowing:

- `withTenant()` uses `set_config('app.current_tenant_id', …, is_local => true)` inside an
  interactive transaction, so the tenant never leaks to another request that borrows the same
  pooled connection.
- A tenant-scoped query issued **outside** `withTenant()` fails loudly (the policy cannot resolve
  the session variable) instead of silently returning cross-tenant rows.
- API startup calls `assertRlsEnforced()` and refuses to boot if the runtime connection is a
  superuser or has `BYPASSRLS` — a mis-set `DATABASE_URL` cannot silently disable isolation.
- Passwords are bcrypt (cost 12, NFR-SEC.1); API keys are salted scrypt hashes shown once
  (NFR-SEC.7); JWT access tokens are ≤15 min and delivered as httpOnly cookies (FR-2.3).

## Testing

```bash
pnpm test                                     # everything: 275 tests (240 TypeScript + 35 Foundry)
pnpm --filter @void-space/api test            # 91 API tests: auth, RBAC, tenancy, assets, review, tools
pnpm --filter @void-space/worker test         # 58 worker tests: enrichment, chain, queues, Blender
pnpm --filter @void-space/db test             # 43 tests: RLS/tenancy, audit, GLB fixture generation
pnpm --filter @void-space/contracts test      # 35 Foundry tests: minting, role gate, revocation, ERC-721
pnpm --filter @void-space/types test          # 28 tests: the §3.6 RBAC matrix and the §5.1 lifecycle
pnpm --filter @void-space/web test            # 20 tests: mesh statistics, formatting
```

The data-layer suite is the security regression net: cross-tenant read/update/delete attempts,
`WITH CHECK` rejection of smuggled tenant ids, fail-closed behaviour without a tenant context,
context leakage across pooled connections, an automated RLS schema audit, the platform role's
privilege envelope, and database-level append-only enforcement of the audit log.

The API suite drives the *real* application — same plugins, guards and database — through
`app.inject()`, including multipart uploads and real EIP-4361 signatures. Because it runs against
the development database, it cleans up everything it creates: fixture assets, passwordless SIWE
accounts (and their detached wallets) and the workspaces the tenancy suite registers. A run leaves
3 workspaces and 9 members behind, exactly as it found them — verified, not assumed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL is not set` | `cp .env.example .env` (or run `pnpm dev:up`, which does it) |
| `refusing to start: role … bypassRls=true` | `DATABASE_URL` points at the owner role; use the `void_app` URL from `.env.example` |
| `relation "…" does not exist` | `pnpm db:migrate` then `pnpm db:rls` |
| `permission denied for table …` | RLS grants are stale — re-run `pnpm db:rls` |
| `invalid input syntax for type uuid: ""` | A tenant-scoped query ran outside `withTenant(...)`; that is the RLS net working |
| `nginx` container restarting in a loop | The dev certificate is missing — run `pnpm certs` (or `pnpm dev:up`, which generates it first) |
| `x-cache-status: MISS` on every `/ipfs/<cid>` read | Kubo is redirecting to subdomain-style gateway URLs; the committed `docker/scripts/ipfs-entrypoint.sh` disables that (`UseSubdomains: false`) — recreate the ipfs container |
| Compose says `no such service: …` for a profiled service | Pass the profiles: `docker compose --profile infra --profile edge …` |
| `CONTRACT_ADDRESS` empty | `pnpm dev:up`, or `pnpm contracts:deploy` + restart api/worker |
| Port 443/5432 in use | Stop the conflicting service or change the port in `.env` |
| Anvil state lost after restart | Expected — the chain is ephemeral by default (§3.9.1); enable the commented volume in `docker-compose.yml` |

## Implementation status

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo, Docker stack, nginx edge, dev scripts, app skeletons | ✅ |
| 1 | `AssetLicenseRegistry.sol`, deploy flow, generated ABI | ✅ |
| 2 | Prisma schema, RLS policies, tenant context, seed, isolation tests | ✅ |
| 3 | API core: auth (password/Google/SIWE), RBAC, tenancy, audit | ✅ |
| 4 | Assets, versions, streamed uploads, job infrastructure | ✅ |
| 5 | Workers: `ipfs-pin`, `ai-enrichment`, `notify`, `chain-license`, `xr-publish` | ✅ |
| 6 | Review workflow: queue, decisions, threaded comments | ✅ |
| 7 | Publishing & licensing: mint, IPFS metadata, catalog, revoke | ✅ |
| 8 | Dashboard: login → overview → library/upload → detail + 3D preview → review → catalog → licences | ✅ |
| 9–14 | Notifications UI, developer API, admin consoles, Blender/import tools, EoN publish, E2E | ⏳ |

### The dashboard

`apps/web` is the asset operations console. It is intentionally plain: no rounded cards, no
gradients, no spring animations — it reads as an instrument, because the people using it are
checking whether a licence really exists on-chain, not browsing a marketing site.

| Screen | What it does |
|---|---|
| `/login` | Sign-in, with the demo accounts listed for evaluation |
| `/` | Overview: lifecycle distribution, review backlog, ingest volume, queue telemetry, recent ledger |
| `/library` | Search + state filter, streamed upload panel, inline ingest results |
| `/assets/:id` | The asset console: 3D preview with a decode-vs-record integrity readout (drag to orbit, `WIREFRAME` to toggle), integrity data (CID, polycount, pin state), licence token + tx, review decision + AI acceptance, discussion, queue jobs, versions, ledger slice |
| `/review` | Assessor triage queue ordered oldest-first, with the AI signal and confidence per asset |
| `/catalog` | The marketplace: published assets with their licence and XR module, sortable by name or **complexity**, filterable by category, each card opening a 3D quick-look with its full manifest |
| `/licenses` | Licence registry with on-chain token id and transaction hash |
| `/admin` | Members, roles, invitations, workspace settings, counts |
| `/audit`, `/notifications` | Full ledger, and the alert inbox |

Controls are permission-gated client-side from the same §3.6 matrix the API enforces, so a
Creator never sees an approve button that would 403 — and the API refuses it anyway.

### The verified end-to-end journey (today)

```
creator signs in             ─▶  POST /auth/login           cookies HttpOnly; Secure; Lax
creator uploads cube.glb     ─▶  POST /assets               201, status=pending
        GLB JSON chunk parsed─▶  polycount 12 (no geometry loaded)
        ipfs-pin worker      ─▶  CID bafkrei…, pinStatus=pinned, staging cleared
        ai-enrichment worker ─▶  tags + description + confidence 0.35 (honest: no API key)
assessor approves in the UI  ─▶  POST /assets/:id/decisions  201, AI tags merged
assessor publishes           ─▶  POST /assets/:id/publish    202, XR module id assigned
        chain-license worker ─▶  mintLicense() tx 0x4b36…, token #4, gas 320005
        xr-publish worker    ─▶  EON-6E44AD26-V1
public catalog               ─▶  license CC-BY, CID + token + tx visible
gateway read                 ─▶  /ipfs/<cid> 200, byte-identical, MISS then HIT
```

Set `ANTHROPIC_API_KEY` in `.env` to swap the offline enricher for Claude; nothing else changes.

### The bundled models

`models/` carries two real scans, seeded, pinned and licensed on every `pnpm db:seed`:

| File | Triangles | Vertices | Textures | Extent |
|---|---|---|---|---|
| `heart.glb` (7.2 MB) | 22,562 | 12,013 | 3 | 2.171 × 3.211 × 1.764 |
| `blue_whale_skeleton.glb` (16.7 MB) | 247,170 | 136,005 | 37 | 13.266 × 38.432 × 16.346 |

They are measured from the file at seed time — not declared in a fixture — so the polycount, vertex,
material and texture counts in the interface are the artefact's own numbers. Both seed as `approved`
and publish in one click, which mints a real licence token on Anvil. The whale's original Sketchfab
export required re-exporting to render at all; see `models/README.md` for what changed and why.

The seed is honest about its other assets: the generated `.glb` fixtures are built to match their
declared triangle count exactly, and non-previewable formats get small placeholder bytes so every
gateway link still resolves. If IPFS is down the seed stores placeholder CIDs and says so rather
than failing. `pnpm --filter @void-space/db demo:glb /tmp/cube.glb 12000` generates a throwaway model.

### Verifying an artifact, not just viewing it

The 3D preview measures the geometry that actually reaches the GPU and prints it next to the record:

```
DECODED 22,562 TRI   = RECORD ✓
```

`DECODED` is read from the decoded three.js scene graph; `RECORD` is the polycount stored on the
version. When they disagree past a small tolerance the marker turns red and names both numbers
(`≠ RECORD 999`), because a version whose record does not describe its file is a licence-integrity
problem worth seeing rather than a display quirk. Tamper the record and the viewer says so.

### Licence lifecycle: revocation is not deletion

A revoked licence stays in the registry and stays on chain — the NFT is never burned, and
`isLicenseValid(tokenId)` simply starts returning `false` (`FR-9.6`). That has one consequence worth
knowing before you demo it: **republishing a revoked asset must mint a new token, not reuse the old
one.** A revoked token grants nothing, so adopting it would put the asset back into `published`
against a licence the contract reports as invalid, and the new content would never be licensed.

The worker enforces this by asking the chain only for *live* tokens
(`findTokenForAsset` → `isLiveLicenceFor`). The path is exercised end to end by the whale, which was
re-exported and therefore re-licensed:

```
REVOKE   token #5   tx 0x394c…   isLicenseValid(5) → false
PUBLISH  token #10  tx 0xb16a…   gas 337105   metadata → the new CID   isLicenseValid(10) → true
```

Re-running `pnpm db:seed` will not undo it either: the seed establishes a starting state, so it will
not move an asset *out* of `published`, which would otherwise leave an `approved` asset holding an
active licence — a combination no workflow can produce.

### What Phase 3 delivers

* **Authentication** (§3.7): email/password with bcrypt, Google OAuth2 SSO (FR-2.2),
  SIWE wallet linking and wallet sign-in (FR-2.6), rotating refresh tokens delivered
  as httpOnly/Secure/SameSite=Lax cookies (FR-2.3), and API keys exchanged for
  short-lived bearer tokens (FR-2.5).
* **Authorization** (§3.6): the full permission matrix enforced by a Fastify
  `preHandler`, with roles and permissions re-read from the database on every request
  so role changes, suspensions and removals apply immediately (FR-2.7, FR-1.5).
* **Tenancy** (FR-1.1–1.5): self-service signup, workspace switching, member
  invitation/role management, workspace suspension, and upload defaults.
* **Audit** (FR-13.1–13.3): append-only by database grant, queryable through
  `GET /api/v1/audit` with filters and pagination.

Documentation:

* **[`docs/architecture-infographic.md`](docs/architecture-infographic.md)** — the architecture as an
  infographic: 17 short sections, each one visual (ASCII diagrams and matrices that survive being
  pasted into Slack, Confluence or a PDF). **Start here if you want the picture rather than the prose.**
* **[`docs/architecture.md`](docs/architecture.md)** — the full platform architecture: the layered
  system, the authorisation pipeline, row-level security, the asset lifecycle state machine, the
  ingestion and licensing sequences, the blockchain subsystem and its Avalanche C-Chain migration
  path, the job platform, the data model, deployment topology, requirement traceability and an
  infographic atlas. Every diagram prints correctly under any Markdown → PDF converter;
  `pnpm docs:pdf` renders it (Mermaid twins live in a screen-only appendix).
* **[`docs/DEMO-CREDENTIALS.txt`](docs/DEMO-CREDENTIALS.txt)** — every demo login, its role, what that
  role can do, the seeded content inventory, and the running chain details.
* `docs/VS-SDD-2.0-api.md` — endpoint/error-code contract, gap-fills, open questions,
  and test traceability for Phase 3.
* `docs/VS-SDD-2.0-data-model.md` — the entity model, the gap-fills this
  implementation had to add (and why), and deviations from the SRS text.
* `https://localhost/api/v1/docs` — Swagger UI (non-production; 47 documented paths).

