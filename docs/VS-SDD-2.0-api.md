# VS-SDD-2.0 — REST API contract (Phase 3)

**Companion to** `VOID-SPACE_SRS_v2.0_Production.docx` — satisfies §3.1 ("a documented,
versioned REST API") and §6.4. Authority order: the SRS is normative; this document
describes how the API implements it. Anything marked *Gap-fill* is not enumerated in
the SRS and carries a justification.

Base path: `/api/v1` (version in the path; **all** routes below are relative to it).
Interactive discovery: `GET /api/v1/docs` (Swagger UI, non-production only).

---

## 1. Conventions

### 1.1 Error envelope

Every non-2xx response has the same shape (`apiErrorSchema` in `@void-space/types`):

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "code": "INSUFFICIENT_PERMISSION",
  "message": "Missing permission: audit:view",
  "details": { "required": "audit:view", "granted": ["asset:upload-own", "api:call", "catalog:view"] },
  "requestId": "req-12",
  "timestamp": "2026-09-21T09:12:44.031Z"
}
```

`code` is the stable discriminator — clients branch on it, never on `message`.
`requestId` matches the API log line, so a UI error report can be traced (§3.2).

### 1.2 Status codes in use

| Code | Meaning in this API | Representative `code` values |
|---|---|---|
| 400 | Malformed body/params/query | `VALIDATION_ERROR` |
| 401 | Missing, expired or malformed credential | `NO_TOKEN`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `REFRESH_INVALID`, `REFRESH_REUSE_DETECTED`, `API_KEY_INVALID`, `ONBOARDING_EXPIRED` |
| 403 | Authenticated but not permitted | `INSUFFICIENT_PERMISSION`, `READ_ONLY_TOKEN`, `TENANT_SUSPENDED`, `ROLE_ESCALATION_BLOCKED`, `NOT_A_MEMBER`, `WALLET_SOLE_METHOD` |
| 404 | Unknown resource (also used for a consumed invite token) | `NOT_FOUND` |
| 409 | State conflict | `SLUG_TAKEN`, `LAST_ADMIN`, `CANNOT_REMOVE_SELF`, `INVITE_ALREADY_USED`, `ROLE_UNCHANGED` |
| 429 | Rate limited | `RATE_LIMITED` |
| 503 | Optional capability not configured | `GOOGLE_NOT_CONFIGURED`, `SIWE_DISABLED`, `ROLES_NOT_SEEDED` |

### 1.3 Authentication

| Client | Credential | Where it lives |
|---|---|---|
| Browser | `vs_access` (≤15 min JWT) + `vs_refresh` (rotating, 7 d) | httpOnly, Secure, SameSite=Lax cookies; refresh cookie scoped to `/api/v1/auth` (FR-2.3, §2.5) |
| Machine | API key → short-lived bearer token | `POST /auth/token`, then `Authorization: Bearer <token>` (FR-2.5) |

An `Authorization` header, when present, is authoritative: a bad one yields 401 and the
request never silently falls back to the cookie.

Roles and permissions are **re-read from the database on every request**, so a role
change, a removed membership or a suspended workspace takes effect on the next request
rather than at token expiry (FR-2.7, FR-1.5).

---

## 2. Endpoints

Legend — 🔓 public · 🔐 authenticated · 🔑 permission required (see the §3.6 matrix)

### 2.1 Authentication — `apps/api/src/modules/auth`

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | 🔓 | FR-1.1 self-service signup: creates tenant + first TenantAdmin + settings in one transaction, returns a session |
| POST | `/auth/login` | 🔓 | FR-2.1 email/password. Returns `{ requiresTenantSelection: true, tenants: [...] }` when the person belongs to several workspaces (FR-1.4); re-post with `tenantId` to complete |
| POST | `/auth/refresh` | 🔓 | FR-2.3 rotation. Replaying a superseded token returns `REFRESH_REUSE_DETECTED` and revokes the whole session family (§3.7) |
| POST | `/auth/logout` | 🔓 | Revokes the presented refresh token; clears cookies |
| POST | `/auth/logout-all` | 🔐 | FR-2.7 "sign out everywhere" |
| POST | `/auth/token` | 🔓 | FR-2.5 API key → bearer token (no cookie session) |
| POST | `/auth/tenant` | 🔐 | FR-1.4 switch active workspace, issuing a new tenant-scoped session |
| GET | `/auth/me` | 🔐 | §6.1 session shell: user, active tenant, roles, permissions, `readOnly` |
| PATCH | `/auth/password` | 🔐 | FR-2.7 change password; revokes **all** the user's refresh tokens |
| GET | `/auth/sessions` | 🔐 | Active sessions for account settings |
| POST | `/auth/invite/accept` | 🔓 | FR-2.6 accept an invitation (sets name + password, returns a session) |
| GET | `/auth/providers` | 🔓 | Which login methods are configured (password / Google / wallet) |
| GET | `/auth/google/start` | 🔓 | FR-2.2 redirect to Google (503 when unconfigured) |
| GET | `/auth/google/callback` | 🔓 | Code exchange; signs in, or sets the onboarding cookie on first sign-in |
| POST | `/auth/google/complete` | 🔓¹ | FR-2.2 first SSO: create the workspace (¹ requires the httpOnly onboarding cookie) |
| POST | `/auth/siwe/nonce` | 🔓 | FR-2.6 EIP-4361 challenge for an address |
| POST | `/auth/siwe/verify` | 🔓/🔐 | With a session: **links** the wallet. Without: **signs in** an already-linked wallet |
| GET | `/auth/wallets` | 🔐 | Linked wallets |
| DELETE | `/auth/wallets/:id` | 🔐 | Unlink (detaches; the wallet row survives for provenance) |

Rate limits: login 10/min, register 5/hour, refresh 60/min per client. The `test`
environment relaxes them (`TEST_LIMITS` in `modules/auth/routes.ts`) because every
`inject()` request shares one IP.

### 2.2 Tenant administration — `apps/api/src/modules/tenant`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/tenant` | 🔐 | Current workspace: settings, suspended reason, counts (users, assets, licences, awaiting review) |
| PATCH | `/tenant/settings` | 🔑 `tenant:manage` | FR-14.3 upload defaults + webhook endpoint |
| GET | `/tenants` | 🔑 `tenant:manage` | FR-14.1 platform tenant list |
| PATCH | `/tenants/:id/status` | 🔑 `tenant:manage` | FR-1.5 suspend/reinstate; revokes every session in the tenant |

> The platform role is denied the asset/review/licence tables by database grant (§5.3),
> so `/tenants` reports user counts only. Content counts come from the tenant-scoped
> `/tenant` endpoint.

### 2.3 Users & roles — `apps/api/src/modules/users`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/users` | 🔑 `tenant:manage-users` | FR-1.2 member list |
| POST | `/users/invite` | 🔑 `tenant:manage-users` | FR-1.2 invite by email + role (supersedes a pending invite) |
| GET | `/users/invites` | 🔑 `tenant:manage-users` | Pending/completed invitations |
| PATCH | `/users/:id` | 🔑 `tenant:manage-users` | FR-1.3 set role; revokes that user's sessions (FR-2.7) |
| PATCH | `/users/:id/status` | 🔑 `tenant:manage-users` | Activate/deactivate; deactivation revokes sessions |
| DELETE | `/users/:id` | 🔑 `tenant:manage-users` | FR-1.3 remove from workspace (soft: membership removed, account suspended — FR-13.1 keeps the history) |
| GET | `/roles` | 🔐 | The §3.6 catalogue with each role's permissions |

Guards beyond RBAC: only a SuperAdmin may grant/revoke `SuperAdmin`
(`ROLE_ESCALATION_BLOCKED`); a workspace must always keep one active administrator
(`LAST_ADMIN`); you cannot remove your own membership (`CANNOT_REMOVE_SELF`).

### 2.4 Assets — `apps/api/src/modules/assets`

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/assets` | 🔑 `asset:upload-own` | FR-3.1 streamed `multipart/form-data` upload: metadata fields first, file last. Returns the full asset detail |
| GET | `/assets` | 🔑 `catalog:view` | FR-3.5 library: `q`, `status`/`statuses`, `tag`, `category`, `creatorId`, `format`, `publishedOnly`, paginated. A Creator is scoped to their own assets, a Viewer to published ones |
| GET | `/assets/:id` | 🔑 `catalog:view` | FR-3.4 detail: versions, AI suggestion, decisions, comment tree, jobs, audit trail, capabilities |
| PATCH | `/assets/:id` | 🔑 `asset:upload-own` | FR-3.2 edit metadata while the asset is still editable |
| POST | `/assets/:id/versions` | 🔑 `asset:upload-own` | FR-3.4 new version (multipart); earlier versions stay immutable |
| POST | `/assets/:id/submit` | 🔑 `asset:upload-own` | FR-3.3 move into the review queue and enqueue AI enrichment |
| DELETE | `/assets/:id` | 🔑 `asset:delete-own-unpublished` | FR-3.6 delete unpublished work; refused for approved/published/licensed assets |

Upload rules: extensions `.glb .gltf .obj .fbx .stl .blend`, ≤ 200 MB (FR-3.1), declared
MIME must agree with the extension (NFR-SEC.3), and the category must be one the workspace
allows (FR-14.3). Unpublished assets answer `404` rather than `403` to callers who may not
see them, so the API cannot be used to enumerate another workspace's work.

Asynchronous work enqueued by these routes: `ipfs-pin` (FR-8.1) and `ai-enrichment`
(FR-7.x). Each job is mirrored into `jobs` and surfaced on the asset detail, so the UI polls
one endpoint (FR-11.2).

### 2.5 Review — `apps/api/src/modules/review`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/review/queue` | 🔑 `review:decide` | FR-4.1–4.2 queue ordered oldest-first, filterable by `status`/`needsManualReview`, each row carrying the AI signal |
| POST | `/assets/:id/decisions` | 🔑 `review:decide` | FR-4.3–4.5 approve / revision / reject. Records the decision, applies the §5.1 transition, and accepts AI output in the same call (FR-7.5) |
| POST | `/assets/:id/comments` | 🔑 `review:comment` | FR-4.6 threaded comment (one level of replies) |
| GET | `/assets/:id/comments` | 🔑 `catalog:view` | Thread for the asset console |

A comment is **required** for `revision` and `rejected`, and self-approval is refused when the
caller is the asset's own creator (FR-4.4) — the two rules that keep the audit trail meaningful.

### 2.6 Publishing & licensing — `apps/api/src/modules/licensing`

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/assets/:id/publish` | 🔑 `asset:publish` | FR-5.1–5.2 + FR-9.1: approves a licence, mints the on-chain token and pins licence metadata, then enqueues the §5.1 `published` transition |
| POST | `/assets/:id/license/revoke` | 🔑 `asset:revoke-license` | FR-9.3: flags the token revoked on-chain and records the reason here. The NFT is not burned |
| GET | `/licenses` | 🔑 `catalog:view` | FR-9.5 licence registry with `status`, `holder`, `assetId` filters |
| GET | `/licenses/:tokenId` | 🔑 `catalog:view` | Single licence incl. `tokenUri` and `ipfsMetadataCid` |

Publishing is a **two-step** operation on purpose: the request commits the licence intent, then the
`chain-license` worker submits the transaction and only then transitions the asset. A chain
outage therefore cannot leave an asset marked `published` without a token.

### 2.7 Notifications — `apps/api/src/modules/notifications`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/notifications` | 🔒 any session | FR-6.2 inbox with `unreadOnly`; the bell polls `unreadCount` |
| POST | `/notifications/:id/read` | 🔒 any session | Mark one read |
| POST | `/notifications/read-all` | 🔒 any session | Mark all read |

Rows are written by the `notify` worker, not by the routes that cause them, so a notification
cannot be lost to an API crash and delivery is retried under the §3.10 policy.

### 2.8 Dashboard — `apps/api/src/modules/dashboard`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/dashboard` | 🔒 any session | FR-11.1 single aggregate for the overview: asset counts by lifecycle state, review backlog, ingest volume (FR-3.5), queue telemetry (§3.10), recent audit slice, platform counts (FR-14.1) |

One call rather than six keeps the console's first paint to a single round trip, and every
component in it is either tenant-scoped or derived from data the caller may already read.

### 2.9 Audit — `apps/api/src/modules/audit`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/audit` | 🔑 `audit:view` | FR-13.1–13.2 paginated log with `actorId`, `action`, `entityType`, `entityId`, `from`, `to` filters, plus `actions`/`actors` facets for the filter UI |

Read-only by construction: `UPDATE`/`DELETE` on `audit_logs` are revoked from the
runtime role at the database level (FR-13.3), so there is no write path to expose.

### 2.11 Public catalogue — `apps/api/src/modules/public`

Anonymous. No session, no tenant context, no platform-role access — this is the read path behind
the marketplace at `/`, and it is what lets §6.1's "Public Catalog" be reachable by a stranger
following a shared link.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/public/catalog` | 🔓 | Published assets only: `category`, `tag`, `q`, `sort` (`newest`/`oldest`/`polycount`/`name`), `limit`, `offset`. Each row carries what a buyer decides on — `polycount`, `vertices`, `sizeBytes`, `materials`, `textures`, `animations`, `description` — plus the provenance triple `contractAddress`, `tokenId`, `txHash`, and the `licenseType`/`licenseTerms` that token commits to. |
| GET | `/public/facets` | 🔓 | Category and tag counts for the filter rail, computed over published assets only. |
| GET | `/public/stats` | 🔓 | Headline figures (licences, triangles indexed, bytes pinned, categories). |

**How it stays inside §5.3.** The obvious implementation — query `assets` across every tenant —
would need either the platform role or a bypass of row-level security, both of which the data model
deliberately denies. Instead `packages/db/src/public-catalog.ts` reads the publish-time projection,
which is written when an asset is published and holds only fields that are safe to make public. A
takedown removes the row, so revocation takes effect on the next request instead of at the next
cache expiry.

The field list is also the privacy boundary: no draft content, no member identities, no internal
ids beyond the asset's own. Anything added here should be checked against that rule first.

### 2.12 Health — `/health`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | 🔓 | Dependency status: Postgres, IPFS, Anvil, optional integrations (§9.3) |

---

## 3. Gap-fills introduced in Phase 3

Each of these is an implementation necessity that the SRS does not enumerate. They are
listed so a reviewer can accept or reject them explicitly rather than discovering them
in the code. Same treatment as the Phase 2 data-model gap-fills.

| Item | SRS reference | Justification |
|---|---|---|
| `sessions` table + `Session` model | FR-2.3, FR-2.7 | A rotating, revocable refresh token needs server-side state; a stateless JWT cannot be invalidated. Only a SHA-256 hash of the token is stored, and `replacedById` records the rotation chain. |
| API keys embed the tenant id (`vs_<label>_<tenantHex>_<secret>`) | FR-2.5 | `api_keys` is RLS-protected, so resolving a key to its tenant **before** any query keeps the platform role out of the key table (§5.3). The embedded id is an identifier, not a secret. |
| `tenant.user_reinstated`, `auth.wallet_unlinked` audit actions | FR-1.3, FR-2.6 | Both operations are reversible, and the audit log (FR-13.2) must be able to show a reinstatement or an unlink as a distinct event. |
| `/auth/providers`, `/tenant`, `/users/*`, `/roles` | §6.1, FR-1.2/1.3 | The SRS specifies the capabilities (workspace switcher, member administration, settings) without fixing paths; the frontend needs read models for them. |
| SIWE nonce store is in-process | FR-2.6 | Correct for the single-API-instance local stack; a horizontally scaled deployment moves this map to the Redis already in the compose stack. Recorded so it is not forgotten. |
| Wallet unlink detaches instead of deleting | FR-2.6, §3.9.2 | A minted licence may reference the address; deleting the row would break provenance. |
| `assets.description` + `assets.metadata` columns | FR-3.2, FR-7.5 | **Implemented** (migration `20260923050524_public_catalog_and_asset_description`). Accepting an AI suggestion writes `acceptedDescription` onto the asset as well as recording it on `ai_suggestions` (auditable), and the marketplace renders it. `metadata` is the JSON column FR-3.2's tenant-required fields will validate against. |
| Public catalogue read path | §6.1 "Public Catalog" | **Implemented** as `GET /api/v1/public/catalog` (`apps/api/src/modules/public`). The decision the earlier note flagged was made explicitly: the read goes through `packages/db/src/public-catalog.ts`, which reads the **publish-time projection** rather than tenant tables, so no tenant context and no platform-role access are needed (§5.3 stays intact). It exposes only published assets and only fields that are safe to publish — no draft content, no member identities. `GET /public/facets` and `GET /public/stats` back the catalogue's filters and headline figures. |
| Seed fixtures are generated and pinned by the seed itself | FR-3.1, FR-8.1 | Demo assets must actually render. Earlier the seed wrote placeholder CIDs that only resolved because content had been pinned by hand — a fresh clone produced links pointing at nothing. `buildGlbFixture` now emits valid geometry with exactly the recorded triangle count, and the seed pins it (falling back to a placeholder CID with a warning when IPFS is down). |
| Version `format` is the dotted extension (`.glb`) | §5.1 | The upload path stores `ALLOWED_ASSET_EXTENSIONS` values, and the `?format=` filter enum accepts only those. The seed previously stored the undotted form, which meant seeded assets could not be filtered by format and the viewer skipped them; both are now canonical, and the viewer normalises defensively. |

## 4. Open questions for the SRS owner

1. **FR-14.3 vs the §3.6 matrix.** The matrix grants "Manage tenants (create/suspend)"
   to SuperAdmin only, and gives TenantAdmin `tenant:manage-users`. As implemented, a
   TenantAdmin can administer members but cannot change their own workspace's upload
   defaults. Should `tenant:manage` be added to TenantAdmin, or does §3.6 stand?
2. **Invitation delivery.** §3.9 mentions Resend for transactional email. No provider is
   configured in this stack, so `POST /users/invite` returns the raw token once and the
   UI relays it out-of-band. Confirm whether mail delivery is in scope for this release.
3. **Per-session revocation.** FR-2.3 makes sessions visible; it does not say whether a
   user may revoke one other session from the UI. Only revoke-all is implemented.
4. **Job retention.** Redis keeps a bounded tail of completed jobs (§3.10), but the
   Postgres mirror grows without limit. Obsolete jobs can be pruned safely (§6), and
   expired jobs are the other candidate. Should the worker run a retention sweep, or is
   an operator-run prune acceptable for this release?

## 5. Test traceability (Phase 3)

| SRS test case | Where it is proven |
|---|---|
| TC-AUTH-001 (email/password) | `apps/api/test/auth.test.ts` |
| TC-AUTH-002 (tenant selection) | `apps/api/test/auth.test.ts` |
| TC-AUTH-003 (cookie flags, ≤15 min) | `apps/api/test/auth.test.ts` |
| TC-AUTH-004 (401/403) | `apps/api/test/auth.test.ts`, `tenant-admin.test.ts` |
| TC-AUTH-005 (API key → Developer scope) | `apps/api/test/api-keys.test.ts` |
| TC-AUTH-006 (password change kills sessions) | `apps/api/test/auth.test.ts` |
| TC-AUTH-007 (rotation, reuse detection) | `apps/api/test/auth.test.ts` |
| FR-2.2 SSO + onboarding | `apps/api/test/google-sso.test.ts` |
| FR-2.6 SIWE (real signatures) | `apps/api/test/siwe.test.ts` |
| FR-1.2/1.3/1.5, FR-2.7, FR-13.1 | `apps/api/test/tenant-admin.test.ts` |
| Cross-tenant isolation (NFR-SEC.5) | `packages/db/test/tenant-isolation.test.ts`, `tenant-admin.test.ts` |

## 6. Job lifecycle: failure and obsolescence

The `jobs` table mirrors queue state for the operator, so the rules that decide what it says matter
as much as the work itself. Three of them were wrong until they were exercised by deleting an asset
while its ingest was queued.

### An obsolete subject is not a failure to retry

`Job.entityId` is a loose `varchar`, not a foreign key, so an asset's queued work outlives the asset.
When a processor then finds no version, the work is moot: retrying cannot help, because a deleted
asset does not come back. Processors therefore raise BullMQ's `UnrecoverableError`, which stops the
retry immediately. The row records one attempt with a message that says what happened:

```
ipfs_pin   failed  attempts=1/3  AssetVersion … no longer exists (tenant …) — the asset was
                                 removed while its ingest was queued
```

Without this the queue spent all three attempts on work that could never succeed, and the dashboard
showed three failures for something that needed no attention.

### Terminal means terminal

`isTerminalFailure` treats a failure as the last one when the retry policy is spent *or* the error
is unrecoverable. Judging it by attempt count alone leaves the row reading "failed, will retry" for
a job BullMQ has already discarded — a spinner that never resolves, hiding a real problem behind a
fake one.

### Bookkeeping must not break the work

`ctx.fail` / `ctx.succeed` write the `jobs` row, which is an operator convenience; the pin, the
transaction and the licence are the work. A missing row is therefore reported and dropped rather
than thrown, so a completed pin cannot be turned into a failed job by a failure to describe it.

### The `catch` must cover the whole body

`test/processor-structure.test.ts` asserts that nothing sits between `ctx.markActive()` and the
`try` that follows it. `ai-enrichment` had its version lookup in that gap, so any failure there
escaped the handler entirely: the row stayed `active` with no error and no `finishedAt`, and — worse
— the retry/escalation logic never ran. This is a positional property, which is why the guard reads
the sources rather than exercising the happy path.

### Pruning

Postgres retains job history indefinitely, unlike the bounded Redis tail. Jobs whose subject no
longer exists are safe to prune:

```sql
delete from jobs j
 where j.entity_id is not null
   and not exists (select 1 from assets a         where a.id::text = j.entity_id)
   and not exists (select 1 from asset_versions v where v.id::text = j.entity_id);
```

A scheduled version of this is not implemented — see open question 4.

