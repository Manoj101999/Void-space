# VS-SDD-2.0 — Data Model & Tenancy Design

Companion document to **VS-SRS-2.0**. §1.6 and Appendix B of the SRS defer the full Prisma schema,
column-level types, indexes and RLS policy definitions to a *Software Design Document*
(VS-SDD-2.0) that did not exist when this implementation started. This file is that missing
artifact, written against the code that actually ships:

| Subject | Source of truth |
|---|---|
| Entities, enums, indexes, relations | `packages/db/prisma/schema.prisma` |
| Physical schema (DDL) | `packages/db/prisma/migrations/` |
| RLS policies, grants, append-only rule | `packages/db/prisma/sql/rls.sql` |
| Role provisioning | `docker/postgres/initdb/01-roles.sh` + `packages/db/scripts/apply-rls.mjs` |
| Tenant-isolation runtime | `packages/db/src/tenant.ts` |
| Audit trail helper | `packages/db/src/audit.ts` |
| RBAC matrix | `packages/types/src/roles.ts` |
| Asset lifecycle machine | `packages/types/src/assets.ts` |

Where this document and the SRS disagree, the disagreement is listed explicitly in
[§6 Deviations](#6-deviations-from-the-srs-text) — nothing is changed silently.

---

## 1. Entity inventory

### 1.1 Entities specified by SRS §5.1

| Entity | Table | Tenant-scoped | Notes |
|---|---|---|---|
| Tenant | `tenants` | — (root) | `slug` unique; `status` + suspension metadata for FR-1.5 |
| User | `users` | ✔ | **One row per (person, tenant)**; `@@unique([tenantId, email])`. A person in two tenants has two rows sharing an email — login resolves every row for that email and asks for a workspace when there is more than one (FR-1.4) |
| Role | `roles` | — | Fixed platform-defined set (§3.6); `name` unique |
| UserRole | `user_roles` | ✔ | `@@unique([userId, tenantId])` enforces *one active role per user per tenant*, as §5.1 requires |
| Wallet | `wallets` | ✔ | `type` = `managed` (tenant publisher signer, with a `derivationIndex`) or `linked` (user SIWE identity / licence recipient). The private key is never stored — only the derivation path (§3.9.3) |
| Asset | `assets` | ✔ | `status`, `currentVersionId`, plus `manifestUrl`/`xrManifestRef` for FR-10.3 |
| AssetVersion | `asset_versions` | ✔ | `@@unique([assetId, versionNumber])`; immutable once pinned; `isDerivative` self-relation models Blender outputs (FR-6.3) |
| AISuggestion | `ai_suggestions` | ✔ | One per asset version (`assetVersionId` unique); stores `modelVersion`, `promptVersion`, `latencyMs` (FR-7.7) and the accepted-on-click values (FR-7.5) |
| ReviewDecision | `review_decisions` | ✔ | Full history retained; `decision` ∈ {approved, rejected, revision} |
| License | `licenses` | ✔ | Off-chain mirror of the on-chain record; `@@unique([tenantId, tokenId])`; revocation fields for FR-9.5 |
| APIKey | `api_keys` | ✔ | `prefix` (public, for logs) + `hashedKey` (salted scrypt, `v1$scrypt$salt$hash`); raw key shown once (NFR-SEC.7) |
| Notification | `notifications` | ✔ | Backs FR-11.1–11.3 |
| AuditLog | `audit_logs` | ✔ | Append-only; `entityId` is **not** a foreign key so the trail outlives deleted entities; carries `txHash`/`blockNumber`/`gasUsed` (FR-9.6) |
| Job | `jobs` | ✔ | Durable mirror of BullMQ state; `id` **is** the BullMQ `jobId`, so both sides share one identifier |

### 1.2 Gap-fill entities (required by FRs, absent from §5.1)

The SRS entity list is incomplete relative to its own functional requirements. Each addition below is
the minimum needed to satisfy a numbered FR, and the schema marks which FR it serves.

| Entity | Table | Required by | Why it cannot be derived from an existing entity |
|---|---|---|---|
| ReviewComment | `review_comments` | **FR-4.6** threaded comments on an asset's review history | A thread (with `parentId`) has no home in `ReviewDecision`: decisions are one row per verdict, comments are many per thread and can exist before any verdict |
| TenantSettings | `tenant_settings` | **FR-14.3** tenant-level defaults (polycount budget, required metadata fields) | Tenant configuration must not be copied onto every Asset row |
| Webhook | `webhooks` | **FR-11.4** optional outbound webhook per tenant | Needs a URL, signing secret, event subscription list and enabled flag |
| Invite | `invites` | **FR-1.2 / UC-07** invite users by email with an initial role | The invitee has no `User` row yet, so the pending invitation (hashed token, role, expiry) needs its own table |

All four are tenant-scoped and therefore carry a `tenant_id` column and an RLS policy, consistent
with §5.3.

## 2. Relationships (SRS §5.2, verified in the schema)

```
Tenant 1─* User                 Tenant 1─* Asset               Tenant 1─* Wallet (managed)
User   *─1 Role via UserRole (per tenant)                     Tenant 1─1 TenantSettings
Asset  1─* AssetVersion         AssetVersion 0..1 AISuggestion
Asset  0..* ReviewDecision      AssetVersion 0..* ReviewDecision
Asset  0..* ReviewComment       AssetVersion 0..* License
User   0..1 Wallet (linked)     Tenant 1─* Notification / AuditLog / Job / ApiKey / Webhook / Invite
AssetVersion 0..* AssetVersion  (derivatives, e.g. a Blender-optimised output)
License → Asset + AssetVersion + approving User (assessor)
AuditLog → Tenant + User (both SET NULL so the trail survives)
```

Deliberate choices worth calling out:

- **`License` is per *version*, not per asset.** FR-9.4 forbids modifying the file a licence was
  minted for; a re-upload creates a new `AssetVersion` and, if published, a *new* licence. Several
  `licenses` rows can exist for one asset over time, so the active one is resolved by
  `status = active`.
- **Deletion semantics.** `Asset` → `AssetVersion` → `AISuggestion`/`ReviewDecision`/`License`/
  `ReviewComment` cascade, so deleting an unpublished asset (FR-3.6) leaves no orphan rows for the
  IPFS unpin sweep (FR-8.2). User references use `RESTRICT` where records must stay attributable
  (asset creator, assessor) and `SET NULL` where the record must survive (audit actor, notification
  recipient, comment author).
- **Publication is terminal in the UI.** `assets.status` has no `revoked` value (§5.1); a takedown
  flags `licenses.status = revoked` and leaves the asset `published`, exactly as §4.9.5 describes.

## 3. Tenancy enforcement

### 3.1 Runtime mechanics

```
Request → Fastify preHandler (permission check against the §3.6 matrix)
        → auth resolves the active tenant from the JWT claim
        → withTenant(tenantId, fn)                     [packages/db/src/tenant.ts]
             └─ prisma.$transaction(tx =>
                  SELECT set_config('app.current_tenant_id', $tenantId, true)   -- is_local
                  AsyncLocalStorage.run({ tenantId, db: tx }, fn))
                → every repository call inside `fn` uses tenantDb()
```

- `is_local => true` makes the setting **transaction-scoped**, which is what makes it safe with
  connection pooling: a connection returned to the pool can never carry a stale tenant.
- `tenantDb()` throws `TenantContextMissingError` outside a context, so a forgotten wrapper fails in
  the application layer too — not only in the database.
- `withPlatform()` is the only other data path. It uses the `void_platform` pool for operations that
  are inherently cross-tenant (identity resolution at login, workspace listing, SuperAdmin tenant
  administration), and PostgreSQL denies it asset/review/licence/job/notification/audit access
  regardless of what the code does.

### 3.2 Policies

Every tenant-scoped table gets:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;          -- the table owner is subject too
CREATE POLICY <t>_tenant_isolation ON <t>
  USING      (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`WITH CHECK` is what stops a *write* from smuggling another tenant's id — the write-side mirror of
FR-1.6. `tenants` carries no `tenant_id` (§5.3) and instead gets `tenants_active_only` keyed on
`id`; `roles` is left policy-free because it holds no tenant data.

**Fail-closed behaviour.** With no tenant context the policy cannot resolve
`app.current_tenant_id`, so the query is rejected instead of returning rows. Two concrete failure
modes are covered by tests: an "unrecognized configuration parameter" error on first use in a
session, and — because PostgreSQL keeps the GUC as an empty placeholder after a local `set_config`
transaction ends — an `invalid input syntax for type uuid: ""` error afterwards. Both mean "no rows,
loudly", which is the intended property.

### 3.3 Role privilege matrix (enforced in `rls.sql`)

| Table group | `void_app` | `void_platform` |
|---|---|---|
| All 16 tenant-scoped tables | SELECT/INSERT/UPDATE/DELETE, subject to RLS | **none** |
| `audit_logs` | SELECT + INSERT only (no UPDATE/DELETE/TRUNCATE — FR-13.3) | **none** |
| `tenants`, `roles`, `users`, `user_roles`, `wallets`, `invites` | full (RLS applies) | full (BYPASSRLS) |

`void_platform` carries `BYPASSRLS` because PostgreSQL has no per-table bypass; the guarantee the
SRS asks for ("BYPASSRLS only on Tenant-level administrative tables") is implemented by
**withholding table privileges** everywhere else — a stronger control than a policy, since it holds
even for a role that ignores policies. A test asserts this envelope so a future `GRANT` cannot widen
it unnoticed.

### 3.4 Audit trail

`recordAudit()` / `recordStatusChange()` write inside the caller's tenant transaction, so the entry
commits or rolls back atomically with the change it describes. Chain activity records `txHash`,
`blockNumber` and `gasUsed` (FR-9.6). The table is append-only at the *permission* level: an
integration test asserts that `UPDATE`/`DELETE` — single-row and bulk — are refused by PostgreSQL.

## 4. Asset lifecycle (Figure 4, encoded in `packages/types/src/assets.ts`)

```
draft ──submit──▶ pending ──decision──▶ approved | rejected | revision
                    │  ▲                    │            │          │
        ai-failure  │  └──resubmit──────────┼────────────┘          │
                    ▼                      │  approved ──publish──▶ published
        needs_manual_review ───decision────┘                       (licence minted, tx recorded)
                                                                   published ──takedown──▶ licence revoked
```

- `ALLOWED_STATUS_TRANSITIONS` is the single source of truth; the API validates every transition
  against it and the worker's publish step asserts `approved` before minting (FR-9.1, §3.10).
- Deleting is permitted only in `draft`, `pending`, `revision` and `rejected` (FR-3.6); `published`
  assets can only be taken down (FR-9.5).
- `commentRequiredFor(decision)` encodes FR-4.2: a comment is mandatory for `rejected`/`revision`
  and optional for `approved`.

## 5. Indexing and query patterns

Indexes exist for the access paths the FRs describe, each leading with `tenant_id` so RLS filtering
and the query predicate share the same prefix:

| Query (FR) | Index |
|---|---|
| Creator asset list filtered by status (FR-3.5) | `assets (tenant_id, status, created_at)` |
| Creator asset list scoped to owner | `assets (tenant_id, creator_id)` |
| Name search | `assets (tenant_id, name)` |
| Assessor review queue — pending, oldest first (FR-4.1) | `assets (tenant_id, status, created_at)`, `review_decisions (tenant_id, created_at)` |
| Version history | `asset_versions (asset_id, version_number)` unique |
| Pin sweep / retry visibility (FR-8.2, FR-8.5) | `asset_versions (tenant_id, pin_status)` |
| Audit log filters by actor/entity/date (FR-13.2) | `audit_logs (tenant_id, created_at)`, `(tenant_id, action, created_at)`, `(tenant_id, entity_type, entity_id)` |
| Job polling and admin views (FR-6.5) | `jobs (tenant_id, created_at)`, `(tenant_id, entity_type, entity_id)`, `(tenant_id, status)` |
| Licence lookup by token (FR-9.3) | `licenses (tenant_id, token_id)` unique |
| API-key authentication (FR-2.5) | `api_keys (hashed_key)` unique |

NFR-PERF.1 (p95 < 400 ms for ≤10 000 assets per tenant) is served by these indexes plus the fact
that every list endpoint is paginated with a bounded `pageSize` (default 24, max 100).

## 6. Deviations from the SRS text

| # | SRS text | Implementation | Reason |
|---|---|---|---|
| 1 | §3.9.2 `mintLicense(address,string,string,string)` and an event carrying `approver` | Signature kept **exactly**; `approver` in `LicenseMinted` is `msg.sender` (the platform signer), while the human Assessor is anchored in the `ipfs://` metadata document reachable via `tokenURI` and in `licenses.approver_id` | The Assessor's identity is off-chain PII; changing a signature the SRS fixes would have contradicted the documented interface. §3.9.2 already specifies that the `tokenURI` document contains "the approving Assessor" |
| 2 | §3.9.2 `tokenURI` returns the metadata URI | Added `setLicenseMetadataCid(tokenId, cid)` (publisher-only) | The document must contain the `tokenId`, which only exists after minting, so it cannot be pinned beforehand. `tokenURI` reverts until the CID is set, so a dangling URI is never served |
| 3 | §5.3 "granted BYPASSRLS only on Tenant-level administrative tables" | `void_platform` has the `BYPASSRLS` attribute (PostgreSQL has no per-table variant) but **no privileges at all** on non-administrative tables | Privilege withholding is strictly stronger than a policy and is what actually enforces the intent |
| 4 | §5.1 entity list | Added `ReviewComment`, `TenantSettings`, `Webhook`, `Invite` | Required by FR-4.6, FR-14.3, FR-11.4 and FR-1.2 respectively — see §1.2 |
| 5 | §5.1 `AssetVersion.format` unconstrained | Constrained to the six allowed extensions by validation | FR-3.1 restricts uploads to `.glb/.gltf/.obj/.fbx/.stl/.blend` |
| 6 | §3.11 "a one-shot deploy-contracts container" | Both paths exist: `pnpm dev:up` prefers native `forge` (fast inner loop) and falls back to `docker compose run deploy-contracts` | §9.1 already allows api/worker/web to run "natively or containerized, per the developer's preference"; the same flexibility is applied to the contract deploy |
| 7 | §2.5 no server-side GPU; Blender optional | The Blender runner is an opt-in compose profile (`--profile blender`) | Keeps `pnpm dev:up` light (the image is ~1 GB) while FR-6.3 stays fully implemented |
| 8 | §3.10 `blender-optimize` "1 retry" | Implemented as `attempts: 2` | Consistent with the table's "N retries" counting everywhere else (1 initial + N) |

Two details worth recording even though they are not deviations:

- **Managed wallets are not created by the seed.** Deriving an address needs secp256k1 + keccak256,
  i.e. the chain client that lives in `api`/`worker` (§3.9.3/§3.9.4). The API creates a tenant's
  managed wallet at tenant-creation time; the seed leaves it to that path rather than inventing a
  fake address.
- **`audit_logs.entity_id` is `text`, not a foreign key**, so the compliance trail survives deletion
  of the entity it describes (NFR-COMP.3).

## 7. Inconsistencies found in the SRS

Recorded for traceability. None blocked implementation, but they should be corrected in the next SRS
revision.

| Location | Issue | Resolution taken |
|---|---|---|
| §3.9.2 table | cites `FR-6.6`, but Module 6 defines only FR-6.1–FR-6.5 | Treated as a typo for **FR-9.2**, which the same row also cites |
| §5.1 vs §5.3 | §5.1's attribute lists omit `tenantId` on `AISuggestion`/`ReviewDecision`/`License`/`Job`, while §5.3 says every table except Tenant and Role carries it | Followed §5.3 and added `tenant_id` uniformly, so RLS applies consistently |
| §3.6 vs §5.3 | §3.6 grants SuperAdmin "View tenant audit log", but §5.3 forbids the platform role any AuditLog privilege | SuperAdmin reads a tenant's audit log under `void_app` with an explicit tenant context switch; the platform role genuinely has zero audit privileges |
| §5.1 `User` | leaves "one User row per tenant membership, or a UserTenant join — see SDD" open | Chose one row per (person, tenant) with `@@unique([tenantId, email])`; the same email appearing in two tenants is how the FR-1.4 workspace-switcher case is expressed |
| §4.3 (FR-3.6) | calls publishing "irreversible in the UI" while §4.9.5 defines takedown | Encoded as: `published` is a terminal asset status, revocation lives on the licence |
| §1.6 / Appendix B | defer the schema to "the companion SDD (VS-SDD-2.0)", which did not exist | Produced as this document |
| Figure 2 | acknowledged duplicate of Figure 1 | No action needed |
| §9.1 `pnpm dev:up` | described as wrapping `docker compose up -d`, yet the sequence also needs migrations and a contract deploy | `scripts/dev-up.sh` performs the full documented sequence and publishes `CONTRACT_ADDRESS` into `.env` |
| §5.3 | "`SuperAdmin` bypass … never for asset or review data" | Enforced twice: only `tenants`/`roles`/`users`/`user_roles`/`wallets`/`invites` are granted to `void_platform`, and the isolation policies stay in force for `void_app` |

## 8. Verification and traceability

| SRS requirement | Test | Location |
|---|---|---|
| FR-1.6 cross-tenant isolation (TC-TENANT-002) | 11 assertions: read/update/delete isolation, `WITH CHECK` rejection, fail-closed without context, no pool leakage, UUID guard | `packages/db/test/tenant-isolation.test.ts` |
| NFR-SEC.5 RLS on every tenant table (TC-SEC-009) | RLS enabled + forced + policy present on all 16 tables; platform-role privilege envelope; runtime role is a non-superuser that cannot bypass RLS | `packages/db/test/rls-schema-audit.test.ts` |
| FR-13.3 append-only audit log (TC-AUDIT-001) | single-row `UPDATE`, single-row `DELETE` and bulk `DELETE` all refused by PostgreSQL | `packages/db/test/audit-append-only.test.ts` |
| FR-9.2 minting restricted to the publisher (TC-CHAIN-001) | Foundry: a non-publisher mint reverts; grant/revoke of the publisher role is owner-only | `packages/contracts/test/AssetLicenseRegistry.t.sol` |
| FR-9.4 licensed content is immutable (TC-CHAIN-003) | Foundry: revocation flags the record without altering CID, terms hash or `tokenURI` | `packages/contracts/test/AssetLicenseRegistry.t.sol` |
| §3.9.2 ERC-721 semantics | Foundry: approvals, operator transfers, safe-transfer receiver checks, unknown-token reverts | `packages/contracts/test/AssetLicenseERC721.t.sol` |
| FR-9.3/9.6 deploy + mint on Anvil | `pnpm contracts:deploy` against a live chain, then verified with `cast` (`owner()`, `publishers()`, `mintLicense`, `getLicense`) | manual run, recorded in the build log |

Run everything locally:

```bash
pnpm --filter @void-space/contracts test     # 35 tests
pnpm --filter @void-space/db test            # 22 tests
```

