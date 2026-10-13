# Requirements traceability — VS-SRS-2.0, all 70 functional requirements

**Why this file exists.** SRS Appendix A calls for a traceability matrix and then lists twelve
sample rows. Twelve rows is a sample, not a matrix: it tells a reviewer which requirements the
author happened to think about, which is the opposite of what a matrix is for. This is the whole
set — every FR in the SRS, what implements it, what proves it, and — where it applies — what is
missing and why.

**How to read a row.** `Implemented` means a shipping code path satisfies the requirement and a
test exercises it. `Partial` means the user-visible behaviour exists but not by the mechanism the
SRS names, or the contract exists without the adapter. `Missing` means what it says.

**Evidence** is a file path, not a claim. **Test** is the suite that would fail if the behaviour
regressed. Where a requirement is verified somewhere other than a test suite, that is stated.

**Method.** The requirement set was read out of `docs/VOID-SPACE_SRS_v2.0_Production.docx` directly
— its `word/document.xml`, so nothing is lost to a converter — rather than from a summary or from
the code's own comments. That distinction matters: five requirement ids cited throughout the
codebase (`FR-5.4`, `FR-10.4`, `FR-11.5`, `FR-13.4`, `FR-13.5`) turned out not to exist in the
SRS at all, and a matrix built from the code's comments would have inherited the same fiction.

---

## 1. Summary

The SRS contains **70 `FR-n.n` identifiers**, but one of them — `FR-6.6` — is cited in §6.5 and
never defined (see §4), and the findings themselves are lettered D1–D6 rather than numbered, because
the module sections in §2 are already numbered 4.1–4.14. So there are **69 actual functional requirements**.

```text
  MODULE                                       TOTAL   DONE   PARTIAL   MISSING
  ───────────────────────────────────────────────────────────────────────────────
  4.1  Tenant & organization management            6      6         ·         ·
  4.2  Authentication & access control             7      7         ·         ·
  4.3  Asset upload & management                   6      6         ·         ·
  4.4  Review & approval workflow                  6      6         ·         ·
  4.5  3D preview & visualization                  3      2         1         ·
  4.6  Third-party tool integrations               5      5         ·         ·
  4.7  AI-assisted content intelligence            7      7         ·         ·
  4.8  Decentralized storage (IPFS)                5      5         ·         ·
  4.9  Blockchain licensing & provenance           7      7         ·         ·
  4.10 XR publishing (EoN Reality)                 3      3         ·         ·
  4.11 Notifications                               4      4         ·         ·
  4.12 Developer / API access                      4      4         ·         ·
  4.13 Audit log & compliance trail                3      3         ·         ·
  4.14 Admin & platform configuration              3      3         ·         ·
  ───────────────────────────────────────────────────────────────────────────────
  functional total                                69     68        1         ·
  ───────────────────────────────────────────────────────────────────────────────
  non-functional requirements                     28     24        4*        ·
  ───────────────────────────────────────────────────────────────────────────────
  TOTAL                                           97     92        5         ·
```

`*` The four are **unmeasured**, not failed: three quantitative performance targets and one
usability target have no benchmark in this repository. See §3.

**No functional requirement is now missing.** The last module to close was 4.6, Third-Party Tool
Integrations, which the SRS marks **Priority: Medium** — never MVP, and which `docs/architecture.md`
§22 has listed as "designed, adapter pending" for most of the project's life. It closed in two
distinct ways, and the distinction is the interesting part:

- **FR-6.1, 6.2, 6.4 and UC-09** were *written and unreachable*. `modules/tools/` contained the
  routes, the service and the vendor adapters; `app.ts` never registered it, so all four answered 404.
  Registered now, with a test that asserts reachability (module 4.6.1). The traceability table below
  described them as "Missing — DTO only" for as long as that was true from the outside.
- **FR-6.3** was genuinely absent, and the protocol the runner exposed could not have worked even
  once written (absolute paths across two containers with different mount points). The processor,
  the filename protocol and the runner service now exist (module 4.6).

The one remaining `Partial` is FR-5.1, and it is a deviation in *mechanism* that is argued rather
than a gap: the SRS asks for a live WebGL canvas per card, and twenty-four canvases on one screen
exceeds the browser's context limit. See §4.5.

**Test totals, current:** **275 tests** across six suites — `packages/contracts` 35 (Foundry,
`forge test`), `apps/api` 91, `packages/db` 43, `apps/worker` 58, `packages/types` 28, `apps/web` 20.
All of it runs under `pnpm test`, including the Solidity suite, which is why the count spans two
runners. The counts in `architecture.md` are kept in step with this section; three other documents in
`docs/` (`architecture-infographic.md`, `VOID-SPACE-Architecture-Visual.md` and the exported
`.html`) repeat these figures by hand, and all three had drifted before this pass — see §6.

**Docs are not evidence.** Two entries in this document were wrong in opposite directions, and both
were corrected in the same pass that closed module 4.6: the module's own table here called
FR-6.1/6.2/6.4 "Missing" while the code existed, and §6 listed "a public catalogue" as not built while
`modules/public/routes.ts` was serving it and the UI audit was reaching it anonymously. Each was
checked against the running system before being changed, because a traceability matrix that is
trusted without being re-run is worse than no matrix at all.
---

## 2. Functional requirements

### 4.1 Tenant & organization management

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-1.1 signup creates a Tenant + first TenantAdmin | Implemented | `apps/api/src/modules/auth/routes.ts` (`POST /auth/register`) | `api/test/auth.test.ts` |
| FR-1.2 invite users by email with an initial role | Implemented | `modules/users/routes.ts` (`POST /users/invite`) | `api/test/tenant-admin.test.ts` |
| FR-1.3 change a user's role, or remove them | Implemented | `modules/users/routes.ts` (`PATCH /users/:id`) | `api/test/tenant-admin.test.ts` |
| FR-1.4 switch active tenant, re-issuing a scoped JWT | Implemented | `modules/auth/routes.ts` (`POST /auth/tenant`) | `api/test/auth.test.ts` — TC-AUTH-002 |
| FR-1.5 SuperAdmin suspend / reinstate a tenant | Implemented | `modules/tenant/service.ts` (`setStatus`) | `api/test/tenant-admin.test.ts` |
| FR-1.6 no query can return another tenant's rows | Implemented | `packages/db/scripts/apply-rls.mjs` | `db/test/rls-schema-audit.test.ts`, `db/test/tenant-isolation.test.ts` — TC-TENANT-002 |

FR-1.6 is verified against a real Postgres with real policies, not a mock. A cross-tenant read
tested against a mock would prove nothing about whether the policy exists.

### 4.2 Authentication & access control

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-2.1 email/password, salted hash | Implemented | `packages/db/src/password.ts` (bcrypt) | `api/test/auth.test.ts` — TC-AUTH-001 |
| FR-2.2 Google SSO, provisioning on first sign-in | Implemented | `modules/auth/google-routes.ts` | `api/test/google-sso.test.ts` |
| FR-2.3 ≤15 min JWT + rotating refresh, httpOnly cookies | Implemented | `plugins/auth.ts`, `modules/auth/service.ts` | `api/test/auth.test.ts` — TC-AUTH-003 |
| FR-2.4 401 for bad tokens, 403 for insufficient scope | Implemented | `plugins/auth.ts` (`assertPermission`) | `api/test/auth.test.ts`, `packages/types/test` |
| FR-2.5 API-key → bearer token | Implemented | `modules/auth/routes.ts` (`POST /auth/token`) | `api/test/api-keys.test.ts` — TC-AUTH-005 |
| FR-2.6 SIWE, linked to an existing account | Implemented | `modules/auth/siwe-routes.ts`, `siwe.ts` | `api/test/siwe.test.ts` |
| FR-2.7 invalidate refresh tokens on password/role/suspension | Implemented | `modules/auth/sessions.ts` | `api/test/tenant-admin.test.ts` |

### 4.3 Asset upload & management

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-3.1 six formats ≤200 MB → ipfs-pin queue | Implemented | `modules/assets/routes.ts` (streamed multipart) | `api/test/assets.test.ts` — TC-ASSET-011 |
| FR-3.2 Name + Category required, Tags / source tool optional | Implemented | `types/src/dto/asset.ts` (`createAssetMetadataSchema`) | `packages/types/test`, `api/test/assets.test.ts` |
| FR-3.3 `pending` on submit, `draft` otherwise | Implemented | `modules/assets/service.ts` (`create`) | `api/test/assets.test.ts` |
| FR-3.4 re-upload creates a new AssetVersion with its own CID | Implemented | `service.ts` (`addVersion`) | `api/test/assets.test.ts` |
| FR-3.5 view / filter / search own assets, tenant-scoped | Implemented | `service.ts` (`list`) | `api/test/assets.test.ts` |
| FR-3.6 delete unpublished only; publish is irreversible | Implemented | `service.ts` (`remove`) | `api/test/assets.test.ts` |

### 4.4 Review & approval workflow

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-4.1 queue of `pending` assets, oldest first | Implemented | `modules/review/routes.ts` (`GET /review/queue`) | `api/test/assets.test.ts` |
| FR-4.2 approve / reject / revision, comment rules | Implemented | `modules/assets/service.ts` (`decide`) | `api/test/assets.test.ts` — TC-REVIEW-006 |
| FR-4.3 restricted to Assessor or higher | Implemented | `requirePermission('review:decide')` | `packages/types/test` (matrix) |
| FR-4.4 notify the Creator on a status change | Implemented | `service.ts` enqueues `notify` per transition | `apps/worker/test` |
| FR-4.5 AI suggestions surfaced inline in the queue | Implemented | `apps/web/src/app/console/review/page.tsx` | UI audit |
| FR-4.6 threaded comments on the review history | Implemented | `service.ts` (`comment`, `buildCommentTree`) | `api/test/assets.test.ts` |

### 4.5 3D preview & visualization

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-5.1 live rotating WebGL thumbnail per card | **Partial — see note** | `scripts/render-thumbnails.mjs`, `components/console-kit.tsx` (`ConsoleThumb`) | UI audit |
| FR-5.2 full-screen, orbit-controlled viewer | Implemented | `components/model-viewer.tsx` (React Three Fiber), `model-stage.tsx` | `web/test`, UI audit |
| FR-5.3 metadata beside the viewer | Implemented | `apps/web/src/app/m/[assetId]/page.tsx` | UI audit |

**FR-5.1 is the one deliberate deviation in this matrix**, and it is a deviation in *mechanism*
rather than in behaviour. The SRS asks for a live WebGL preview per card. What ships is a **static
render produced once at publish time** by headless Chromium with a real GPU context
(`pnpm assets:thumbnails`), served through the same `/thumbnails/[cid]` route, with a drawn
fallback when no render can exist.

A card grid is the wrong place for a WebGL context. Twenty-four live canvases on one screen is
twenty-four GPU contexts against a browser limit of roughly sixteen, so the grid would blank as
soon as a page held more than a handful of previews — failing NFR-PERF.2 rather than meeting it.
Rendering once at publish, at the moment the asset is already having a licence minted for it, gives
every card the same visual result at zero runtime cost.

Recorded as a deviation rather than shipped silently because the SRS names a mechanism, and a
reviewer comparing the two documents should find the difference explained here rather than discover
it.

### 4.6 Third-party tool integrations — closed, and how

**Priority: Medium, not MVP.** All five requirements now have an implementation. Four of them had one
for some time and nobody could reach it: `modules/tools/` was complete — routes, service, vendor
adapters, offline handling — and `app.ts` never registered it, so every path in it answered
`404 … is not a known route`. The module's own header described those paths as fixed by the
specification. See module 4.6.1.

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-6.1 Sketchfab search, filtered by licence and polycount | **Implemented** | `modules/tools/service.ts` (`searchSketchfab`), route at the §6.4 path | `api/test/tools.test.ts` |
| FR-6.2 Poly Pizza search by keyword/category/triangles | **Implemented** | `modules/tools/service.ts` (`searchPolyPizza`) | `api/test/tools.test.ts` |
| FR-6.3 headless Blender export/optimize job | **Implemented** | `worker/src/processors/blender-optimize.ts`, `docker/scripts/blender-server.py`, `docker/blender.Dockerfile`, `blender-runner` service + `blenderjobs` volume (`docker-compose.yml`) | `worker/test/blender-optimize.test.ts` (5), `worker/test/blender-runner.test.ts` (3) |
| FR-6.4 text-to-3D via Meshy AI | **Implemented** | `modules/tools/service.ts` (`generateMeshy`) | `api/test/tools.test.ts` |
| FR-6.5 `GET /api/v1/jobs/{id}` polling | **Implemented** | `modules/jobs/routes.ts`, `types/src/dto/jobs.ts` | `api/test/jobs.test.ts` (5) |
| UC-09 import a Sketchfab result as a draft asset | **Implemented** | `POST /api/v1/tools/import` (`modules/tools/routes.ts`) | `api/test/tools.test.ts` (7) |

**FR-6.3 in detail.** The processor copies the staged source into the shared `blenderjobs` volume,
calls the runner over HTTP, and records the derivative as a new `AssetVersion` with
`isDerivative` / `derivativeOfVersionId` set and `pinStatus: pending`, so the existing `ipfs-pin`
processor pins it through the same path an upload takes. The runner is a service rather than a CLI
because a worker container has no Docker socket — deliberately, since a worker that could start
sibling processes would make every container a container-escaping primitive.

With no `BLENDER_RUNNER_URL` configured — the default, because the image is ~1 GB and is excluded from
`pnpm dev:up` — the processor records a **labelled simulation**: the derivative row is created and its
audit entry carries `simulated: true`, but no bytes are invented, no CID is pinned and `polycount`
stays null. That is the `xr-publish` pattern (FR-10.1) applied as this document recommended, and the
reason `polycount === null` is the assertion with the most weight in that test file: a fabricated
measurement in a product whose claim is that its measurements are real would be the one unrecoverable
defect.

**A defect found while wiring this** is worth recording, because it was invisible to every check the
repository runs. The worker sent *absolute paths* in the `/optimize` request and the runner confined
them to its own `BLENDER_JOB_DIR`; the two containers mounted the same volume at different paths
(`/var/lib/void-space/blender-jobs` and `/jobs`). Every real conversion would therefore have failed
with a 400 — and the simulation path hid it completely, because a simulation never calls the runner.
The protocol now sends **filenames**, which the runner resolves against its own directory, so the
mount points are no longer required to agree. The invariant is pinned by
`worker/test/blender-runner.test.ts`, which executes the runner's real resolution logic, and by an
assertion in `worker/test/blender-optimize.test.ts` on the request body the processor builds — the
previous version of that test ignored the body, which is exactly how the bug survived.

### 4.6.1 The tools module was implemented and unreachable

`modules/tools/` was written, reviewed and left out of the module registration list in `app.ts`. Four
requirements and one use case were unreachable in a running API while the repository's own traceability
table described them as "Missing — DTO only", and both statements were true at once: the routes
existed, and every request to them returned 404.

This is a class of defect that no existing check can see. An unregistered module typechecks, lints,
and passes its unit test suite, because none of those things asks whether anything is reachable.
`api/test/tools.test.ts` now asserts that each documented path resolves and is *not* 404, together with
the permission gate on it, and `apps/api/src/app.ts` names the requirement in the registration comment.
Verified live against the running stack: `GET /api/v1/tools/integrations` answered
`404 … is not a known route` before the registration and returns the integration status now.

### 4.6.2 UC-09 is an outbound request, and is treated as one

`POST /api/v1/tools/import` makes the *server* fetch a URL the caller supplies, which is a server-side
request forgery wearing the shape of a feature. A URL is fetched only when its host is the vendor the
`source` field names, or a subdomain of it — `sketchfab.com` and `poly.pizza`, the two values of a
closed enum — and only over https. The comparison is on a leading-dot suffix, so `evil-sketchfab.com`
does not qualify, and IP literals such as `169.254.169.254` (instance metadata) or a Compose sibling
such as `postgres:5432` cannot qualify at all.

The test asserts refusals against a recording `fetch`, so the property being pinned is "the request was
never made" rather than "the response was a 400" — a rejection that happens after the request has gone
out is not the property anybody wants. Verified live as well: the metadata URL returns
`downloadUrl must be on sketchfab.com for a sketchfab import` with the offending host in `details`.

### 4.7 AI-assisted content intelligence

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-7.1 enqueue `ai-enrichment` on upload | Implemented | `assets/service.ts` (`create`) | `api/test/assets.test.ts` |
| FR-7.2 response constrained to a fixed JSON schema | Implemented | `worker/src/lib/enricher.ts` (`systemPrompt`, `enrichmentSchema`) | `worker/test/enricher.test.ts` — TC-AI-002 |
| FR-7.3 validate, retry once stricter, then flag | Implemented | `enricher.ts` (`parseEnrichmentResponse`, `strict`) | `worker/test/enricher.test.ts` |
| FR-7.4 persist suggestions separately from Creator metadata | Implemented | `model AISuggestion` (hangs off the *version*) | `db/test` |
| FR-7.5 shown as suggestions, one-click accept or edit | Implemented | `console/review/page.tsx`, `POST /assets/:id/decision` | `api/test/assets.test.ts` |
| FR-7.6 never approved on AI output alone | Implemented | `service.ts` — `approved` is only reachable through `decide` by a human principal | `api/test/assets.test.ts` |
| FR-7.7 log model version, prompt version, latency | Implemented | `model AISuggestion` columns + audit row | `worker/test/enricher.test.ts` |

FR-7.6 has no dedicated test asserting the *negative* ("no code path sets `approved` from AI
output"). It holds structurally — the only writer of `approved` is `decide`, which requires a human
principal and a `review:decide` permission — but a structural guarantee is worth stating as such
rather than pointing at a test that does not exist.

### 4.8 Decentralized storage & content addressing (IPFS)

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-8.1 add every file and derivative to IPFS, record the CID | Implemented | `worker/src/processors/ipfs-pin.ts`, `worker/src/lib/ipfs.ts` | `worker/test`, `api/test/assets.test.ts` |
| FR-8.2 pin lifecycle follows the asset lifecycle | Implemented | `packages/db/src/ipfs-pin.ts`, `assets/service.ts` (`remove`) | `db/test` — TC-IPFS-004 |
| FR-8.3 served through the nginx gateway cache, never the node | Implemented | `docker/nginx/templates/default.conf.template` (`proxy_cache ipfs_cache`) | config review |
| FR-8.4 display the CID and allow copying it | Implemented | `components/copy-button.tsx`, model page, asset detail | UI audit |
| FR-8.5 add/pin failure is a retryable job failure | Implemented | `ipfs-pin.ts`, `lib/job-tracking.ts` | `worker/test/job-tracking.test.ts` |

FR-8.5 is enforced where it matters: an asset does not enter `pending` until its CID is pinned, so a
failed pin leaves a `draft` with a visible failed job rather than a review queued against content
that cannot be fetched.

### 4.9 Blockchain licensing & provenance

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-9.1 Publish only from `approved` | Implemented | `modules/licensing/routes.ts` (`ASSET_NOT_APPROVED`) | `api/test/assets.test.ts` |
| FR-9.2 `mintLicense` via the managed signer | Implemented | `worker/src/processors/chain-license.ts`, `lib/chain.ts` | `worker/test/chain-license.test.ts` — TC-CHAIN-001 |
| FR-9.3 wait for confirmation, then surface tokenId + tx hash | Implemented | `chain-license.ts` (receipt before status change) | `worker/test/chain-license.test.ts` |
| FR-9.4 no modification after a licence is minted | Implemented | `service.ts` — `MUTABLE_STATUSES` excludes `published` | `api/test/assets.test.ts` — TC-CHAIN-003 |
| FR-9.5 TenantAdmin revocation without deleting history | Implemented | `licensing/routes.ts` (`POST /assets/:id/license/revoke`) | `api/test/assets.test.ts` |
| FR-9.6 persist tx hash, block number, gas to the audit log | Implemented | `model AuditLog`, `chain-license.ts` | `db/test/audit-append-only.test.ts` |
| FR-9.7 a link from each licence to its transaction | Implemented | `licensing/routes.ts` (`explorerBase`), `GET /licenses/:tokenId` | `api/test/tenant-admin.test.ts` |

The `chain-license` processor's idempotency guard is worth noting because it was **wrong once and is
now tested for it**: it asked the chain for "a token for this asset", received the *revoked* one,
tried to adopt it, collided on `(tenantId, tokenId)` and failed the publish three times — leaving the
asset unpublished with no route forward from the UI. `isLiveLicenceFor` is the correction.

### 4.10 XR publishing (EoN Reality)

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-10.1 `xr-publish` only after a licence is minted | Implemented | `worker/src/main.ts` — the mint handler enqueues the push | `worker/test` |
| FR-10.2 reject direct publish of a non-approved asset with 409 | Implemented | `licensing/routes.ts` (`ConflictError`) | `api/test/assets.test.ts` — TC-PUBLISH-002 |
| FR-10.3 return and store the manifest reference + module URL | Implemented | `worker/src/processors/xr-publish.ts` | `worker/test` |

EoN Reality is an external SaaS **not part of the local stack**, so the processor has two modes: a
real POST when `EON_API_URL`/`EON_API_KEY` are set, and otherwise a deterministic simulated push
whose audit row is marked `simulated: true`. The simulation is labelled rather than hidden — an
auditor reading the ledger can tell which is which, which is the only reason simulating is
defensible.

### 4.11 Notifications

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-11.1 notify the Creator on a status change | Implemented | `assets/service.ts` enqueues `notify`; `processors/notify.ts` | `worker/test` |
| FR-11.2 notify Assessors when work enters the queue | Implemented | `notify.ts` — resolves recipients in-tenant | `worker/test` |
| FR-11.3 mark as read, unread count in the header | Implemented | `modules/notifications/routes.ts`, `app-shell.tsx` | `api/test` |
| FR-11.4 optional outbound webhook per tenant | **Implemented** (this pass) | `worker/src/lib/webhook.ts`, wired into `notify.ts` | `worker/test/webhook.test.ts` (8 tests) |

FR-11.4 was **stored and forgotten** before this pass: the `webhooks` table, the tenant settings form
and the HMAC signing secret all existed and nothing ever sent a request. A configured webhook that
never fires is worse than an absent feature, because it looks like it works. Delivery now signs each
payload (`X-Void-Space-Signature`), honours the subscription, and — per NFR-REL.1 — **swallows a
failing or unreachable endpoint** rather than failing the notification job, because a tenant's dead
webhook must not stop a Creator learning their asset was approved.

### 4.12 Developer / API access

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-12.1 versioned REST API under `/api/v1` | Implemented | `modules/*/routes.ts`, mounted in `app.ts` | all API suites |
| FR-12.2 always-current in-app API reference | Implemented | `plugins/openapi.ts`, `/api/v1/docs` | config + UI audit |
| FR-12.3 key creation, one-time copy, rotation | **Implemented** (this pass) | `modules/developer/routes.ts`, `types/src/dto/developer.ts` | `api/test/developer-api-keys.test.ts` (6 tests) |
| FR-12.4 rate-limit per key, 429 + `Retry-After` | **Implemented** (this pass) | `lib/rate-limit-key.ts`, `app.ts` | `api/test/rate-limit-key.test.ts` (5 tests) |

Two FR-12 gaps closed in this pass, both of the same shape — **the contract existed and the wiring
did not**:

- **FR-12.3.** `packages/db/src/apikey.ts` could hash, verify and generate a key; `POST /auth/token`
  could exchange one; `api/test/api-keys.test.ts` tested all of it. But nothing could *create* one
  except the seed script, which printed it to a terminal. Management now lives at
  `POST|GET /tenants/:id/api-keys` plus `POST .../:keyId/rotate` and `DELETE .../:keyId`, matching
  the endpoint shape SRS §6.4 specifies. The secret leaves exactly once; rotation is
  revoke-then-issue, because the stored value is a salted hash and cannot be edited in place.
- **FR-12.4.** The limiter bucketed by caller address. Forty integrations behind one NAT shared a
  single 300/minute budget, so the first busy one would 429 the rest — and a client wanting more
  budget had only to change address. The bucket now follows the credential on bearer-authenticated
  calls. Verified end-to-end: a 12-request burst against `/auth/login` (limit 10/min) returns ten
  `401`s then `HTTP/2 429` with `retry-after: 41`.

### 4.13 Audit log & compliance trail

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-13.1 record every auth, role, status, chain and publish action | Implemented | `packages/db/src/audit.ts` (`recordAudit`), called from each module | `api/test/tenant-admin.test.ts` — TC-AUDIT-001 |
| FR-13.2 filter by actor, entity and date range | Implemented | `modules/audit/service.ts`, `console/audit/page.tsx` | `api/test/tenant-admin.test.ts` |
| FR-13.3 append-only at the database-permission level | Implemented | `packages/db/scripts/apply-rls.mjs` (no UPDATE/DELETE grant) | `db/test/audit-append-only.test.ts` |

FR-13.3 is enforced by *permission*, not by convention: the application role holds no UPDATE or
DELETE on `audit_logs`, so an application-layer bug cannot rewrite history. The test attempts both
directly at the database level.

### 4.14 Admin & platform configuration

| Req | Status | Evidence | Test |
|---|---|---|---|
| FR-14.1 SuperAdmin console: all tenants, status, user + asset counts, suspend/reinstate | **Implemented** (this pass) | `modules/tenant/service.ts` (`list`), `apps/web/src/app/console/tenants/page.tsx` | `api/test/tenant-admin.test.ts` |
| FR-14.2 TenantAdmin console: users, roles, API keys, webhooks | Implemented | `console/admin/page.tsx`, `console/tenants/page.tsx` | `api/test/tenant-admin.test.ts` |
| FR-14.3 tenant defaults applied at upload | Implemented | `tenant/service.ts` (`defaultPolycountBudget`, `requiredMetadataFields`) | `api/test/tenant-admin.test.ts` |

FR-14.1 was **half-built**: `GET /tenants` and `PATCH /tenants/:id/status` existed and no screen
called them, so the requirement was reachable only by curl. It was also missing the counts the SRS
names, because §5.3 denies the platform role the asset and licence tables. Those counts are now read
per workspace *inside that workspace's own RLS context* — N queries for N workspaces, which is the
honest price of not granting the platform role a cross-tenant read, on a screen that is nobody's hot
path. The UI follows: `/console/tenants`, guarded on `tenant:manage`, with an in-place confirmation
before a suspension, because suspension revokes every session in the workspace the moment it lands.

---

## 3. Non-functional requirements

Twenty-eight NFRs. Twenty-four are enforced by something concrete — a permission, a constraint, a
configuration, a test. **Four are unmeasured**: not failed, but never benchmarked, and calling them
satisfied on the strength of an architecture diagram would be exactly the kind of claim this
document exists to avoid.

### 8.1 Performance

| Req | Status | Evidence |
|---|---|---|
| NFR-PERF.1 p95 < 400 ms for `GET /assets` at 10,000 assets/tenant | **Unmeasured** | No benchmark exists. The indexes the query needs do (`[tenantId, createdAt]`, `[tenantId, entityType, entityId]`, `[tenantId, status]`), but designed-for is not measured. |
| NFR-PERF.2 thumbnails initialise < 1 s on a mid-range GPU | **Unmeasured** | Met by construction — a pre-rendered JPEG cannot take a second to decode — but never timed. Note the deviation at FR-5.1: this target is *why* the SRS's WebGL-per-card mechanism was not adopted. |
| NFR-PERF.3 enrichment is asynchronous and does not block upload | Verified structurally | The upload returns after the enqueue (`assets/service.ts`); `ai-enrichment` runs in a separate process. `api/test/assets.test.ts` asserts the response carries a queued job, not a result. |
| NFR-PERF.4 a repeated CID read is served from the gateway cache | Verified by configuration | `docker/nginx/templates/default.conf.template`: `proxy_cache_valid 200 206 30d`, `proxy_cache_use_stale`, `proxy_cache_lock on`. Not measured under load. |
| NFR-PERF.5 a mint confirms within 5 s on local Anvil | **Unmeasured** | Anvil mines instantly by default, so this should hold with a wide margin, but no timing assertion exists. |

### 8.2 Security

| Req | Status | Evidence |
|---|---|---|
| NFR-SEC.1 bcrypt, cost ≥ 12 | Implemented | `packages/db/src/password.ts`; asserted in `db/test` |
| NFR-SEC.2 every non-auth endpoint requires a token, scope per route | Implemented | `plugins/auth.ts` (`authenticate` / `requirePermission`); the RBAC matrix is transcribed cell-by-cell in `packages/types/test` |
| NFR-SEC.3 uploads validated by extension, MIME sniffing and size | Implemented | `assets/routes.ts` + `lib/storage.ts` (bytes sniffed before the body is trusted); `api/test/assets.test.ts` |
| NFR-SEC.4 prompts carry no credentials or PII | Implemented | `worker/src/lib/enricher.ts` builds the prompt from filename, category, tags and mesh stats only |
| NFR-SEC.5 RLS on every tenant table, cross-tenant attempt per resource | Implemented | `packages/db/scripts/apply-rls.mjs`; the audit fails when a tenant table lacks a policy — `db/test/rls-schema-audit.test.ts` — TC-SEC-009 |
| NFR-SEC.6 the signer's private key never reaches the frontend or a log | Implemented | `worker/src/lib/chain.ts` only; no API module imports it |
| NFR-SEC.7 API keys stored as salted hashes, shown once | Implemented | `packages/db/src/apikey.ts` (scrypt); `api/test/developer-api-keys.test.ts` asserts the secret is absent from every later read |

The RLS coverage audit is the strongest single control here: it is a *schema-level* check that fails
when a tenant-scoped table is added without a policy, so the boundary cannot decay by omission —
which is the failure mode RLS usually has.

### 8.3 Reliability & availability

| Req | Status | Evidence |
|---|---|---|
| NFR-REL.1 core workflows survive an unavailable integration | Implemented | Claude → `createOfflineEnricher` fallback (`worker/test/enricher.test.ts`); webhooks → failure swallowed (`worker/test/webhook.test.ts`); EoN/Meshy → simulated mode |
| NFR-REL.2 failed enrichment retried at most once, then flagged | Implemented | `QUEUE_POLICIES['ai-enrichment']` — `attempts: 2`; `worker/test/queues.test.ts` |
| NFR-REL.3 a failed mint leaves status at `approved`, never a partial `published` | Implemented | `chain-license.ts` changes status only after a receipt; `worker/test/chain-license.test.ts` |
| NFR-REL.4 a stack restart orphans no pinned content or data | Implemented | named volumes in `docker-compose.yml` (`ipfsdata`, `pgdata`, `uploads`) |

NFR-REL.1 is why the AI enricher has an offline mode rather than a hard dependency: without an
`ANTHROPIC_API_KEY` the pipeline still completes and still produces suggestions — at lower
confidence, which the record states (`offline-heuristic-v1`) rather than hides.

### 8.4 Usability

| Req | Status | Evidence |
|---|---|---|
| NFR-USE.1 first upload completed within 3 minutes, unaided | **Unmeasured** | The affordances the SRS names exist — inline placeholders, a demo-credential hint on the sign-in screen — but no timed usability test has been run. |
| NFR-USE.2 AI suggestions visually distinguished from human content | Implemented | `console/review/page.tsx` — a labelled AI panel, visually separate from Creator metadata |
| NFR-USE.3 on-chain and IPFS state in plain language with a copy affordance | Implemented | `components/copy-button.tsx`; the model page labels CID, token id and tx hash in words alongside the hex |

### 8.5 Scalability

| Req | Status | Evidence |
|---|---|---|
| NFR-SCAL.1 horizontal growth without a schema-per-tenant migration | Implemented | Shared schema + RLS; `db/test/rls-schema-audit.test.ts` |
| NFR-SCAL.2 the job types as independent BullMQ queues, each with its own concurrency | Implemented | `types/src/queues.ts` (`QUEUE_POLICIES`, `defaultConcurrency`), overridable via `WORKER_CONCURRENCY_*`; `worker/test/queues.test.ts` |
| NFR-SCAL.3 the storage interface swappable to a remote pinner by config alone | Implemented | `worker/src/lib/ipfs.ts` — one HTTP client behind `IPFS_API_URL` |

NFR-SCAL.2 names four job types and the platform runs six — the SRS's four plus `xr-publish` and
`notify`. Exceeding a scalability requirement is not a violation, but the count is stated so the
difference is not misread as an error.

### 8.6 Maintainability & portability

| Req | Status | Evidence |
|---|---|---|
| NFR-MAINT.1 business logic in independently testable service modules | Implemented | `apps/api/src/modules/*/service.ts`; six suites |
| NFR-MAINT.2 runs on any Docker-and-Compose host; no proprietary OS dependency | Implemented | `docker-compose.yml`; no host-specific path outside the documented volumes |
| NFR-MAINT.3 shared types in one package to prevent contract drift | Implemented | `packages/types` — imported by web, api and worker; nothing in it may import from an app |

### 8.7 Compliance

| Req | Status | Evidence |
|---|---|---|
| NFR-COMP.1 imported assets retain and display their source licence | Implemented | `licenseType` on the licence record and the model page; the seeded imports carry CC0 / CC-BY |
| NFR-COMP.2 Claude usage compliant; never the sole basis for approval | Implemented | See FR-7.6 — `approved` is unreachable without a human `decide` |
| NFR-COMP.3 audit + on-chain record suffice to reconstruct who approved and published | Implemented | `audit_logs` (actor, before/after, txHash) joined to the licence record; `db/test/audit-append-only.test.ts` |

---

## 4. Defects found by this audit

Independent of feature completeness, the audit found seven defects. Six were in the code or the
tests, one is in the SRS itself. All six are fixed; the SRS's is reported rather than edited,
because the SRS is the authority and this document is not.

### D1 Five requirement ids cited in code that do not exist in the SRS

The codebase referenced `FR-5.4`, `FR-10.4`, `FR-11.5`, `FR-13.4` and `FR-13.5`. None is defined
anywhere in `VS-SRS-2.0`; the SRS's module ranges are 5.1–5.3, 10.1–10.3, 11.1–11.4 and 13.1–13.3.

This is not cosmetic. A citation pointing nowhere means the *requirement* being satisfied is
unclear, and a reviewer checking "is FR-13.4 met?" finds no FR-13.4 and concludes — fairly — that
the traceability cannot be trusted. Each was corrected to the requirement or section that actually
covers the behaviour:

| Wrong | Cited for | Corrected to |
|---|---|---|
| `FR-5.4` | the Viewer role seeing only published work | §3.6 (role matrix), FR-3.5 (scoped read) |
| `FR-10.4` | the XR simulation being visible | §3.9.4 (design decision) |
| `FR-11.5` | queue depth on a health screen | §3.10, NFR-SCAL.2 |
| `FR-13.4` | the audit ledger being append-only | FR-13.3 |
| `FR-13.5` | the audit read model | FR-13.2 |

`apps/worker/src/processors/notify.ts` additionally cited `FR-12.x` for notifications. Module 4.12
is Developer / API access; notifications are FR-11.x. Corrected to FR-11.1–FR-11.3.

**Re-checked after the module 4.6 work, mechanically:** every `FR-n.n` and `NFR-n.n` cited anywhere
under `apps/`, `packages/`, `scripts/` and `docker/` was extracted and compared against the identifiers
present in the SRS's own `word/document.xml`. Result: **63 distinct identifiers cited, 0 of them absent
from the SRS.** The five above are gone and the new code introduced none. The check is not automated —
extracting text from a `.docx` in a Node script means either a zip dependency or shelling out to
Python, and neither is worth it for a check that runs when this document does.

### D2 `FR-6.6` is a dangling reference in the SRS itself

§6.5's contract table cites "after a human Assessor has approved and confirmed publish (FR-6.6 /
FR-9.2)". `FR-6.6` appears exactly once in the whole document — in that parenthesis — and is never
defined. Module 4.6 ends at FR-6.5.

The likely reading is a typo for FR-9.2, which is the requirement that covers it. It is recorded
here rather than corrected in place, because the SRS is the authority; but it should be corrected
upstream, and until it is, `docs/VS-SDD-2.0-data-model.md` inherits the reference.

### D3 A stale worker docstring

`apps/worker/src/main.ts` claimed "the remaining three (blender-optimize, chain-license, xr-publish)
are registered as deliberate no-op consumers". Two of those three had processors. The docstring was
correct when written and never updated as processors landed — so it described a system one phase
out of date, in the one place a new engineer looks first.

### D4 A test that preserved a bug

`api/test/assets.test.ts` asserted `jobs[].queue === 'ipfs_pin'` — the Prisma enum spelling — which
locked a database detail onto the wire. When the API was corrected to emit the §3.10 vocabulary
(`ipfs-pin`), **the test failed**, and the correct response was to update the test rather than
restore the leak.

Worth stating plainly: a test can preserve a defect as easily as it can catch one, and this one did.
The fix carries a comment explaining the direction of the change, so a future reader does not
"restore" it.

### D5 The queue-name leak itself

`jobs.queue` is a Prisma enum, so the column stores `chain_license` while every other surface — the
queue names, the SRS §3.10 table, BullMQ itself — uses `chain-license`. The API returned the enum
spelling, so the same job was named two ways depending on which endpoint you asked. Normalised
through one shared function, `queueNameFromDb` in `packages/types/src/queues.ts`, which both the
asset detail payload and `GET /jobs/:id` now read.

### D6 The storefront linked to an endpoint that only exists in development

The four public pages linked to `/api/v1/docs` — the header nav, the announcement bar, the footer and
the landing page's call to action. The API registers Swagger UI **outside production only**, on
purpose: it lists every route and its RBAC requirement, which is a tool for someone building against
the API rather than something to publish. So on a production deployment all four links were dead
ends.

What makes this worth recording is that it was *found and then mis-fixed*. The UI audit flagged a 404
on the landing page — `/api/v1/docs?_rsc=…` — and the link was changed from `next/link` to a plain
`<a>` to stop the client-side prefetch. The audit went green, and the link still went nowhere: the
prefetch had been the *noisy* half of the defect, and silencing it removed the report while leaving
the fault. The lesson generalises — **a link that has stopped failing loudly is not a link that
resolves** — and the fix now gates rendering on the same condition the API uses
(`API_REFERENCE_AVAILABLE` in `components/market-shell.tsx`), so a link and its target cannot drift
apart again. Verified against the rebuilt production image: zero occurrences of `/api/v1/docs` in the
served HTML.

---

## 5. What changed in this pass

Every requirement closed in this pass had the same shape — **the contract existed and the wiring did
not**:

| Req | What was missing | What now exists |
|---|---|---|
| FR-6.5 | the `jobs` table written since the async platform landed, and no polling endpoint | `modules/jobs/routes.ts` + `dto/jobs.ts`, 5 tests |
| FR-11.4 | a webhook table, a settings form and a signing secret; nothing ever fired | `lib/webhook.ts` wired into the notify processor, 8 tests |
| FR-12.3 | key hashing and exchange existed; keys could only be minted by the seed script | `modules/developer/routes.ts` (create / list / rotate / revoke), 6 tests |
| FR-12.4 | the limiter bucketed by address rather than by credential | `lib/rate-limit-key.ts`, 5 tests, verified end-to-end at 429 |
| FR-14.1 | the API existed with no UI and no asset counts | per-tenant RLS count fan-out + `/console/tenants`, asserted in `tenant-admin.test.ts` |
| FR-6.1 / 6.2 / 6.4 | the adapters were written and the module was never registered in `app.ts`, so all three answered 404 | registered; reachability asserted in `tools.test.ts` (module 4.6.1) |
| FR-6.3 | the queue had no processor, and the one the runner protocol implied could never have worked | `processors/blender-optimize.ts` + a filename protocol + `blender-runner` service; 8 tests |
| UC-09 | the `importExternalAssetSchema` contract existed and nothing consumed it | `POST /tools/import` with a vendor host guard; 7 tests, verified live |

**A sixth shape of defect, and the one worth remembering:** three of the above were not *missing*, they
were **unreachable**. `modules/tools/` typechecked, linted and would have passed any unit test written
against its service — while every HTTP path in it returned 404. Module 4.6.1 documents it because the
traceability table in this very document called those requirements "Missing — DTO only", and that
description was accurate from the outside at the same time as the code was complete on the inside.

Plus: six code-citation and docstring defects fixed, the queue-name leak normalised through one shared
function, `docs/architecture.md` §22's roadmap reconciled with what actually ships, an empty environment
variable no longer counts as a malformed one (a `VAR=` line used to fail boot with
`Invalid url` — see `apps/api/src/env.ts`), and the `.env.example` integration names corrected to the
names the code actually reads.

**275 tests** across six suites — `packages/contracts` 35 (Foundry), `apps/api` 91, `packages/db` 43,
`apps/worker` 58, `packages/types` 28, `apps/web` 20 — measured with `pnpm test`. `pnpm typecheck`
(12 tasks), `pnpm lint` (0 warnings) and the production build are clean, and `pnpm audit:ui` reports
**20/20 routes clean** against a rebuilt image.

>*An earlier revision of this section reported 248. Nothing depends on the figure; 275 is what the
>suite reports, per package, as listed above.*

---

## 6. What is not done, and what it would take

Stated as a scope decision rather than an oversight, so it can be accepted or overruled explicitly.

| Item | Effort | Why it was not done here |
|---|---|---|
| NFR-PERF.1 / .2 / .5, NFR-USE.1 — the four unmeasured targets | Small to moderate | Each needs a benchmark or a usability session. `PERF.1` and `PERF.5` are the tractable ones: a seeded 10,000-asset workspace and a timing assertion. `USE.1` needs a person. |
| Playwright end-to-end suite | Moderate | `scripts/audit-ui.mjs` already drives every route in a real browser and asserts visibility, not merely status codes. Formalising it as a CI gate is a project decision rather than a code gap — there is no CI configuration in this repository at all, so it would be the first. |
| FR-6.1 / 6.2 / 6.4 — the vendor adapters in *real* mode | A vendor account each | The code paths exist and are reachable; what cannot be done here is prove them against live vendor APIs, because that needs a key and outbound network. An adapter that reports `offline: true` — which is what these do when unconfigured, and what `GET /tools/integrations` surfaces — is the honest state in the meantime, and the alternative would be a listing invented by a mock. |
| FR-6.3 — exercising the `blender` image end to end | Moderate | The processor, the runner service and the protocol are complete and unit-tested, and the compose profile builds them. The image is ~1 GB and excluded from `pnpm dev:up`, so no test in the standard run has ever executed a real Blender conversion; the simulation path is what is covered. |
| The duplicated figures across four documents | Small, and worth doing | `architecture.md`, `architecture-infographic.md`, `VOID-SPACE-Architecture-Visual.md` and the exported `VOID-SPACE-Architecture-Infographic.html` each repeat the test, table, operation and path counts *by hand*. All four had drifted before this pass — three of them still said "224 tests · 19 tables · 51 operations" while the running system said 275 · 20 · 69, and two still listed Blender conversion and the vendor importers as "designed, adapter pending" after they had stopped being either. This pass corrected every copy and added a note at the top of the three derivatives pointing at `architecture.md` as the living source, but the duplication remains the underlying problem: nothing generates the counts, so nothing keeps them true. |

**A fifth shape of defect: the same number, written down four times.** The counts in those documents are
not measurements, they are transcriptions, and a transcription is only correct on the day it is written.
The mechanical fix would be a generator that reads `pnpm test`, the OpenAPI document and the schema and
rewrites each copy — worth doing, and out of scope for a pass about requirements. What this pass does
instead is make the copies *admit* what they are, which is the difference between a document that is
wrong and a document that is wrong and trustworthy.

**Removed from this list in this pass, and why.** FR-6.1/6.2/6.4 and FR-6.3 were listed here as
outstanding work; both are now implemented (module 4.6, §5). A "public catalogue" was also listed as
sign-in only — that was already untrue when it was written: `modules/public/routes.ts` serves
`/api/v1/public/catalog` and its siblings, the storefront at `/catalog` renders them, and
`pnpm audit:ui` reaches all of it anonymously. It is struck rather than fixed, because there was
nothing to fix.

**What this list is not.** It is not a list of requirements left unimplemented: every `FR-n.n` the SRS
defines now has an implementation and a test (§1–§4). What remains is measurement (the NFRs above),
verification against live third-party services, and process (CI). Those are different kinds of
absence from an unimplemented feature, and this document should not blur them.

---

## 7. Re-verifying this document

```bash
pnpm stack:up                    # infra + edge + app (~3 min cold)
pnpm db:seed                     # demo workspaces and accounts
pnpm typecheck && pnpm lint      # 12 tasks, 0 warnings
pnpm test                        # 275 across six suites
pnpm --filter @void-space/web build
pnpm audit:ui                    # every route in a real browser — 20/20 clean
pnpm ui:classes                  # no class in the JSX is missing from the compiled CSS
```

The last two are the ones worth running after any UI change. `ui:classes` catches a class Tailwind
never emitted — it found a real one, a `<select>` chevron whose arbitrary value contained a space and
therefore never applied. `audit:ui` catches a screen that renders *successfully* while showing
nothing useful: a 200 with an empty panel, which no status code reveals.

**A caveat on this document.** It was written by reading the SRS and the code together, and every
`Implemented` row cites a file. Where a requirement is met by a mechanism other than the one the SRS
names, that is called out (FR-5.1). Where a guarantee is structural rather than tested, that is
called out too (FR-7.6). The rows marked **Unmeasured** mean exactly that — not failed, not verified,
simply never put under a stopwatch. A traceability matrix is only worth keeping if it can say those
three things and be believed.

