# VOID·SPACE — Architecture, visually

> **⚠ This file is a hand-maintained copy.** The living documents are `docs/architecture.md` (the
> reference) and `docs/FR-traceability.md` (requirement by requirement). The figures below — test
> counts, table counts, operation counts, and the roadmap in §14 — are duplicated from them by hand,
> which is exactly how they drifted: this file said "224 tests / 19 tables / 51 operations" for a pass
> after the running system said 275 / 20 / 69, and for two passes after Blender conversion and the
> vendor importers had stopped being "designed, adapter pending".
>
> They are correct as of the last pass, verified against the running system. **If you are reading this
> to check a number, read `architecture.md` instead** — or re-derive it (`pnpm test`, and the counts in
> §21 there). Nothing in this file is authoritative.

**The platform on one page.** Ingestion → AI-assisted classification → human review → content-addressed
storage on IPFS → on-chain licence → XR delivery.

```text
╔════════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                        ║
║           ██╗   ██╗  ██████╗ ██╗ ██████╗  ███████╗ ██████╗   █████╗   ██████╗ ███████╗ ║
║           ██║   ██║ ██╔═══██╗██║ ██╔══██╗  ██╔════╝ ██╔══██╗ ██╔══██╗ ██╔════╝ ██╔════ ║
║           ██║   ██║ ██║   ██║██║ ██║  ██║  ███████╗ ██████╔╝ ███████║ ██║      █████╗  ║
║           ╚██╗ ██╔╝ ██║   ██║██║ ██║  ██║  ╚════██║ ██╔═══╝  ██╔══██║ ██║      ██╔══╝  ║
║            ╚████╔╝  ╚██████╔╝██║ ██████╔╝  ███████║ ██║      ██║  ██║ ╚██████╗ ███████ ║
║             ╚═══╝    ╚═════╝ ╚═╝ ╚═════╝   ╚══════╝ ╚═╝      ╚═╝  ╚═╝  ╚═════╝ ╚══════ ║
║                                                                                        ║
║   PLATFORM ARCHITECTURE   ·   v2.0                                                     ║
║   Multi-tenant 3D / XR asset lifecycle platform                                        ║
║                                                                                        ║
║   ingest  ──▶  govern  ──▶  licence on chain  ──▶  deliver to XR                       ║
║                                                                                        ║
║   275 tests   ·   20 tables   ·   69 API operations   ·   6 queues   ·   18 RLS tables ║
║                                                                                        ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

> **The three sentences that matter.** A creator uploads a 3D model; the platform stores it by content
> hash, proposes tags with AI, and routes it to a human assessor. Only on approval does it mint a
> licence as an ERC-721 token whose metadata anyone can verify independently. Every step is recorded,
> and no customer can ever see another customer's unreleased models — the database itself refuses.

---

## 1. The whole system, in one picture

```text
┌─── CREATOR ────┐ ┌─── ASSESSOR ───┐ ┌─ TENANT ADMIN ─┐ ┌── DEVELOPER ───┐ ┌── SUPERADMIN ──┐
│upload·submit   │ │review·publish  │ │members·roles   │ │ REST + keys    │ │platform admin  │
│                │ │                │ │                │ │                │ │                │
└────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
        │                  │                  │                  │                  │
        ┌──────────────────┴──────────────────┬──────────────────┴──────────────────┴─┐
                                              ▼
┌─ EDGE · nginx :80 / :443 — TLS 1.2+, HSTS, per-address rate limits, cached /ipfs gateway ──┐
│                                                                                            │
└──────────────│──────────────────────────────│────────────────────────────────│─────────────┘
               ▼                              ▼                                ▼
┌── WEB · Next.js :3000 ───┐     ┌── API · Fastify :4000 ───┐     ┌ IPFS Kubo :5001 / :8080 ─┐
│   operations console     │     │   the single writer      │     │content addressed by CID  │
│ talks only to /api/v1    │     │    of domain state       │     │reads cached at the edge  │
└──────────────────────────┘     └──────────────────────────┘     └──────────────────────────┘
                                      │             │
               ┌──────────────────────┘             │                 ▲
               ▼         reads + writes, tenant-scoped                │
┌──── POSTGRES 16 · :5432 ─────┐        ┌──── REDIS 7 · :6379 ─────┐  │
│20 tables · forced RLS on 18  │        │    6 BullMQ queues       │  │ pin · fetch
│  append-only audit ledger    │───┐    └────────────│─────────────┘  │
│    the system of record      │   │                 ▼                │
└──────────────────────────────┘   │    ┌──── WORKER · no HTTP ────┐  │
                                   │    │ai-enrichment · ipfs-pin  │  │
                                   └───▶│blender · chain-license   │──┘
                                        │  xr-publish · notify     │      ┌──── EXTERNAL ────┐
                                        │    the only signer       │─────▶│Claude · Blender  │
                                        └──────────────────────────┘      └──────────────────┘
                                                     │
                                                     ▼ signs, simulated first
                                        ┌─── ANVIL EVM · :8545 ────┐
                                        │  AssetLicenseRegistry    │
                                        │ ERC-721 licence token    │
                                        └──────────────────────────┘
```

| Reading the picture |                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **One door in**     | nginx (80/443) is the only port published to the host. Everything else is on a private network                          |
| **One writer**      | Only the API writes domain state. It holds no signing key, so hacking it cannot mint licences                           |
| **One signer**      | Only the worker holds the transaction key, and it never serves HTTP                                                     |
| **One record**      | Only Postgres is the system of record: files never live there, only their addresses                                     |
| **One direction**   | Slow work (AI, IPFS, Blender, chain, mail) is always a queued job — a provider outage slows one asset, not the platform |

### 1.1 The four principles behind every choice below

```text
┌──────────────────────────────────────────────┬──────────────────────────────────────────────┐
│ 1  ONE WRITER PER BOUNDARY                   │ 2  ISOLATION BY THE DATABASE                 │
│                                              │                                              │
│                                              │                                              │
│  Only the API writes domain state.           │  Row-level security is FORCED on 18 tables.  │
│  Only the worker signs transactions.         │  The runtime role cannot read across tenants,│
│  Only Postgres holds the record.             │  even with a hand-written query.             │
│  Nothing becomes a second source of truth.   │  A leak needs Postgres itself to break.      │
└──────────────────────────────────────────────┴──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┬──────────────────────────────────────────────┐
│ 3  SLOW WORK NEVER BLOCKS A REQUEST          │ 4  TRUST IS VERIFIABLE                       │
│                                              │                                              │
│                                              │                                              │
│  AI, IPFS, Blender, chain and mail are queues│  Content is addressed by hash.               │
│  with documented retry policies.             │  Licences live on chain, verifiable.         │
│  A provider outage slows one asset,          │  Every change lands in an append-only        │
│  never the API.                              │  ledger that records chain receipts.         │
└──────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

---

## 2. The lifecycle, in one line

```text
  ┌─── draft ────┐        ┌─── pending ────┐        ┌─ approved ─┐        ┌─── published ────┐
  │              │submit ▶│                │approve▶│            │mint ─▶ │                  │
  └──────────────┘        └────────────────┘        └────────────┘        └──────────────────┘
                              │     │   │
             ┐────────────────┘     ┘───┘──────────┐──────────────────┐
             ▼                                     ▼                  ▼
  ┌─revision ┬───────────┐  ┌─needs_manual_review ─┬─┐      ┌─rejected┬────────────┐
  │  comment required    │  │ an assessor decides    │      │comment is required   │
  │resubmit -> pending   │  │AI confidence was low   │      │new version resubmit  │
  └──────────────────────┘  └────────────────────────┘      └──────────────────────┘
```

```text
  ┌─ THE RULES THAT MATTER ────────────────────────────────────────────────────────────────────┐
  │  · a rejection or a revision request MUST carry a comment; an approval does not have to    │
  │  · an assessor can never review their own upload                                              │
  │  · `published` is terminal: a takedown revokes the licence and delists the asset, but the    │
  │    asset's own history is never rewritten and the token is never burned                       │
  │  · a licence binds to a VERSION, so uploading a new version cannot change what was licensed   │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The numbers

```text
┌──────────────────────┬──────────────────────┬──────────────────────┬──────────────────────┐
│ RUNTIME              │ DATA MODEL           │ API SURFACE          │ VERIFICATION         │
│                      │                      │                      │                      │
│     10  containers   │     20  tables       │     69  operations   │    275  tests        │
│      4  profiles     │     18  forced RLS   │     63  paths        │    240 TS + 35 chain │
│      1  open port    │      3  DB roles     │     11  route modules│      0  lint warnings│
│         nginx 80/443 │     append-only audit│     OpenAPI 3        │     12  typecheck    │
└──────────────────────┴──────────────────────┴──────────────────────┴──────────────────────┘
┌──────────────────────┬──────────────────────┬──────────────────────┬──────────────────────┐
│ ASYNC PLATFORM       │ LICENCE CHAIN        │ CONTENT              │ ISOLATION            │
│                      │                      │                      │                      │
│      6  BullMQ queues│     ERC-721 registry │     IPFS by CID      │      3  DB roles     │
│     retry per queue  │     Solidity ^0.8.24 │     worker streams   │     forced RLS on 18 │
│     job rows in SQL  │     35  chain tests  │     cached at nginx  │     boot-time check  │
│     no slow request  │     takedown = a flag│   immutable by CID   │     fails closed     │
└──────────────────────┴──────────────────────┴──────────────────────┴──────────────────────┘
```

Where the 275 tests live, and what they prove:

```text
  SUITE                       TESTS
  ────────────────────────────────────────────────────────────────
  apps/api            ███████████████████████████████████████   91
  apps/worker         █████████████████████████                 58
  packages/db         ███████████████████████                   43
  packages/contracts  ██████████████████                        35
  packages/types      ███████████████                           28
  apps/web            ███████████                               20
  ────────────────────────────────────────────────────────────────
  total                                                275
```

| Credibility note                                                                    |                                                                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tests run against the **real stack**                                                | A real Postgres with real RLS policies, a real Redis, a real EVM chain. Isolation tested against a mock would prove nothing |
| Suites clean up after themselves                                                    | A full run starts and ends with the same workspace, user and published-asset counts                                         |
| Gates                                                                               | 12 typecheck tasks · 0 lint warnings · 8 build tasks                                                                        |
| Every number here was **read from the running system**, not estimated from the spec |                                                                                                                             |

---

## 4. What is built, and what is not

Solid bars are built and verified; shaded bars need a third-party account or a deployment target. The
distinction matters: a shaded row is never an unwritten adapter — the code, the processor and the
tests exist, and what is absent is something only an account or a production environment can supply.
Nothing in the lower group is presented as working.

```text
  CAPABILITY            WHAT IT DOES                                MATURITY    STATE
  ──────────────────────────────────────────────────────────────────────────────────────
  Authentication        password, Google SSO, SIWE, API keys        ██████████  built
  Authorisation         one RBAC matrix, re-resolved per request    ██████████  built
  Tenancy               forced row-level security, 18 tables        ██████████  built
  Audit                 append-only ledger, enforced by grant       ██████████  built
  Ingestion             streamed 200 MB upload, versioning          ██████████  built
  Storage               IPFS pinning behind a cached gateway        ██████████  built
  AI enrichment         Claude, plus an offline fallback            ██████████  built
  Review                queue, decisions, threaded comments         ██████████  built
  Licensing             ERC-721 mint, takedown, registry            ██████████  built
  XR publish            descriptor built and shipped as a job       ██████████  built
  Notifications         in-app, per user, read state                ██████████  built
  Blender conversion    processor, runner service, protocol         ██████████  built
  3rd-party importers   Sketchfab / Poly Pizza / Meshy adapters     ██████████  built
  Outbound webhooks     delivered by the notify processor           ██████████  built
  Public catalogue      cross-tenant projection, read anonymously   ██████████  built
  Avalanche C-Chain     portability proven; migration is config     ▒▒▒▒▒░░░░░  harden
  Email delivery        notifications are in-app only               ▒▒▒▒░░░░░░  designed
```

The three that moved out of the shaded group in the last pass — Blender conversion, the importers and
outbound webhooks — had all been marked "designed" for longer than they were actually undesigned. The
bars were not measuring missing code; they were measuring missing credentials.

---

## 5. How a model gets in

Upload is accepted by the API, then every slow step happens in the worker tier. Nothing in this path
blocks a request.

```text
  CREATOR          API         STAGING        REDIS          PIN          IPFS           AI
  ────────────────────────────────────────────────────────────────────────────────────────

       1  POST /assets (multipart, streamed)
     │──────────────▶
  2  validate extension + MIME + magic bytes
                      3  stream to .staging/<tenant>/<version>
                    │─────────────▶
  4  sha256, read the GLB JSON chunk, create Asset + Version (draft)
                      5  enqueue ipfs-pin + ai-enrichment
                    │───────────────────────────▶
       6  201 Created (asset id, job ids)
     ◀──────────────│
                                                  7  consume ipfs-pin
                                                │─────────────▶
                                                       8  add: streamed, one chunk in memory
                                                              │─────────────▶
                                                                9  CID
                                                              ◀─────────────│
  10  pinStatus = pinned, ipfsCid stored, staging deleted
                                                  11  consume ai-enrichment
                                                │─────────────────────────────────────────▶
                                                     12  fetch the model through the gateway
                                                                            ◀─────────────│
  13  classify + describe (Claude, or the offline enricher)
                      14  AISuggestion: tags, description, confidence
                    ◀─────────────────────────────────────────────────────────────────────│
  15  low confidence after a retry -> needsManualReview = true
       16  POST /assets/{id}/submit   ->   draft to pending
     │──────────────▶
  17  audit entry written, notify job enqueued
```

| Design choice                         | Why                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Streamed in chunks, never buffered    | A 200 MB upload never sits in memory; Postgres only ever stores the address (CID), not the file                             |
| Geometry is **measured**, not trusted | Polycount, vertices, materials and textures are read from the file itself, then compared against what the browser decodes   |
| AI is advisory only                   | A suggestion can flag an asset for humans, never approve it; the confidence is shown to the assessor                        |
| No external key is required           | Without an Anthropic key, a deterministic offline enricher runs and reports _low_ confidence instead of inventing certainty |

---

## 6. How a licence gets issued

The most consequential flow in the platform: an approved asset becomes a licensed, publicly verifiable
one. Ordering is deliberate.

```text
 ASSESSOR          API                      REDIS          WORKER           CHAIN    POSTGRES
  ────────────────────────────────────────────────────────────────────────────────────────

       1  POST /assets/{id}/publish
     │──────────────▶
  2  require asset:publish and status = approved
  3  sha256 the licence terms
  4  write the licence intent (beforeState) - the asset stays approved
                      5  enqueue chain-license
                    │─────────────────────────▶
       6  202 Accepted (job id)
     ◀──────────────│
                                                7  consume chain-license
                                              │───────────────▶
                                              8  read the version, pin the metadata document
                                                              │──────────────────────────▶
                                          9  simulate mintLicense, then send the transaction
                                                              │───────────────▶
                                                  10  receipt: tokenId, gasUsed, blockNumber
                                                              ◀───────────────│
                                   11  write the Licence row, promote the asset to published
                                                              │──────────────────────────▶
                                         12  audit entries with the tx hash and the gas used
                                                              │──────────────────────────▶
                                                13  enqueue xr-publish + notify
                                              ◀───────────────│
  14  chain unreachable after every retry -> job failed, asset stays approved
```

```text
  ┌─ WHY MINT BEFORE PUBLISH ──────────────────────────────────────────────────────────────────┐
  │                                                                                            │
  │   publish first  ─▶  a public asset with no licence  ─▶  broken public promise, invisible     │
  │                                                        to every screen, undetectable         │
  │                                                                                            │
  │   mint first     ─▶  if the chain is down the job fails and the asset simply stays           │
  │                      `approved`  ─▶  an operator retries, nothing false was ever public      │
  │                                                                                            │
  │   the invariant:  THERE IS NO PUBLISHED ASSET WITHOUT AN ON-CHAIN LICENCE                    │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Tenancy and trust, made of four walls

```text
┌─ ZONE 0 · UNTRUSTED — browser, API client, XR consumer ──────────────────────────────┐
│ ┌─ ZONE 1 · EDGE — nginx :80/:443 · TLS, rate limits, /ipfs cache ─────────────────┐ │
│ │ ┌─ ZONE 2 · APPLICATION — api :4000 (RBAC, tenancy) + worker (signs) ──────────┐ │ │
│ │ │ ┌─ ZONE 3 · DATA — postgres :5432 · redis :6379 · ipfs · anvil ────────────┐ │ │ │
│ │ │ │ anvil holds only licence identity, a terms hash and a CID.               │ │ │ │
│ │ │ │ The model file never reaches the chain, and no key leaves the worker.    │ │ │ │
│ │ │ │ A breach of one zone does not hand over the next: the API cannot sign,   │ │ │ │
│ │ │ │ and the runtime role cannot read across tenants.                         │ │ │ │
│ │ │ └──────────────────────────────────────────────────────────────────────────┘ │ │ │
│ │ └──────────────────────────────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Wall         | What it stops                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| The network  | Only nginx is reachable. There is no side door into the database, Redis, IPFS or the chain                                       |
| The process  | The API cannot sign a transaction, and the worker cannot serve a request                                                         |
| The database | Row-level security is forced on 18 tables; a query without tenant context **errors** rather than returning another tenant's rows |
| The grant    | The audit ledger has no `UPDATE` or `DELETE` privilege at all — history cannot be rewritten, even by an operator                 |

```text
  ROLE            USED BY                  CAN REACH                                  CANNOT REACH
  ─────────────────────────────────────────────────────────────────────────────────────────────────
  void_app        api + worker runtime     every table, but only through the          another tenant's rows,
                                           RLS policy for the active tenant            ever
  void_platform   narrow, audited paths    tenants · roles · users · user_roles ·      assets · licences · audit ·
                  (identity at login)      wallets · invites                            jobs · api keys · notifications
  schema owner    migrations + RLS apply   DDL only                                     never used to serve a request
```

---

## 8. The data model on one map

20 tables in four clusters. Two pointers carry the domain: an asset points at its current version, and
a **licence points at a version** — so a new upload can never change what was licensed.

```text
┌─IDENTITY ────────────────────────────────┐      ┌─ASSET CONTENT ───────────────────────────┐
│ tenants  (the unit of isolation)         │      │ assets  (current_version_id pointer)     │
│ users · user_roles · roles               │ 1 : n│ asset_versions  (cid, pin_status)        │
│ wallets · sessions                       │────▶▶│ ai_suggestions  (tags, confidence)       │
│ invites · api_keys                       │      │                                          │
└──────────────────────────────────────────┘      └──────────────────────────────────────────┘

                     ▼ 1 : n                                           ▼ licence -> version
┌─OPERATIONS ────────┬─────────────────────┐      ┌─REVIEW & LICENSING ┬─────────────────────┐
│ jobs  (queue, status, attempts)          │      │ review_decisions  (decision, comment)    │
│ notifications  (per user, read state)    │ 1 : n│ review_comments  (threaded)              │
│ audit_logs  (append-only by grant)       │      │ licenses  (token_id, tx_hash,            │
│ webhooks · tenant_settings               │      │   license_terms_hash, metadata_cid)      │
│                                          │      │                                          │
└──────────────────────────────────────────┘      └──────────────────────────────────────────┘

every tenant-owned table carries tenant_id · 18 tables carry a forced RLS policy
```

---

## 9. Who may do what (RBAC matrix)

Six platform roles, assigned **per tenant**: the same person can be a Creator in one workspace and an
Assessor in another. This table is transcribed from the single matrix the API enforces and the console
uses to hide buttons.

```text
            PERMISSION           SuperAdmin TenantAdmin   Creator     Assessor   Developer     Viewer
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
  tenant:manage                      ●           ·           ·           ·           ·           ·
  tenant:manage-users                ●           ●           ·           ·           ·           ·
  asset:upload-own                   ●           ●           ●           ·           ·           ·
  asset:delete-own-unpublished       ●           ●           ●           ·           ·           ·
  review:view-queue                  ●           ●           ·           ●           ·           ·
  review:decide                      ●           ●           ·           ●           ·           ·
  asset:publish (mints licence)      ●           ●           ·           ●           ·           ·
  asset:revoke-license               ●           ●           ·           ·           ·           ·
  apikey:manage                      ●           ●           ·           ·           ●           ·
  api:call                           ●           ●           ●           ●           ●           ●
  catalog:view                       ●           ●           ●           ●           ●           ●
  audit:view                         ●           ●           ·           ·           ·           ·
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
  37 grants across 72 cells · asset:revoke-license is the takedown path
  ● granted    · not granted
  SA SuperAdmin · TA TenantAdmin · CR Creator · AS Assessor · DV Developer · VW Viewer
  A Viewer's REST access is read-only (GET endpoints only); a Creator can never approve.
```

Two consequences worth stating: a Creator can never approve anything, and a Viewer cannot write
anything at all — not because the UI hides it, but because the API refuses it and the matrix is
checked on every request.

---

## 10. On-chain licensing, and why the chain is there at all

Three things are hard to prove with a database alone: that a licence was issued at a particular time,
that its terms have not changed since, and that the same licence is not being handed to two consumers
with different claims. A public registry answers all three without either party trusting the other.

```text
┌────── API PROCESS ───────┐       ┌─────── REDIS ────────┐       ┌───────── WORKER ─────────┐
│ no private key in env    │ ──▶   │ payload: ids, CID,   │ ──▶   │ PLATFORM_SIGNER_SEED     │
│ the API cannot sign      │       │ terms hash - no key  │       │ simulate, then send      │
└──────────────────────────┘       └──────────────────────┘       └──────────────────────────┘
                                                                                ▼

┌───── ANYONE WITH THE ABI + AN RPC ─────┐        ┌─────────────────────────────┬────────────┐
│ isLicenseValid(tokenId) · tokenURI     │ ◀─▶    │       LICENCE REGISTRY · ERC-721         │
└────────────────────────────────────────┘        │  terms hash · metadata CID · no burn     │
                                                  └──────────────────────────────────────────┘
```

| Contract surface (`AssetLicenseRegistry`)         |                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `mintLicense(assetId, cid, termsHash, recipient)` | Publisher-only. Records the terms hash + metadata CID                                                              |
| `revokeLicense(tokenId, reason)`                  | Marks it revoked — **the token is never burned**, because the fact it existed is what an auditor needs             |
| `isLicenseValid(tokenId)`                         | The question the marketplace and XR consumers actually ask                                                         |
| `tokenURI(tokenId)`                               | Resolves to the IPFS metadata document                                                                             |
| Idempotency                                       | Republishing a licensed asset returns `409 ALREADY_LICENSED` instead of minting a second token                     |
| Portability                                       | EVM-only, no vendor precompiles. Moving to Avalanche C-Chain is a chain-id and RPC change — **no contract change** |

---

## 11. Slow work is always a queue

Six BullMQ queues, each with a documented retry policy and a _named_ terminal behaviour — so "what
happens when it finally gives up?" always has an answer.

| Queue              | Attempts | Backoff              | When retries run out                                                  |
| ------------------ | -------- | -------------------- | --------------------------------------------------------------------- |
| `ai-enrichment`    | 2        | fixed 2 s            | One stricter retry, then the asset is flagged `needs_manual_review`   |
| `ipfs-pin`         | 3        | exponential from 2 s | Version marked failed — visible in the console, nothing was published |
| `blender-optimize` | 2        | exponential from 5 s | Job shows the failure; the original version is untouched              |
| `chain-license`    | 3        | exponential from 3 s | Asset stays `approved` — **never** silently published                 |
| `xr-publish`       | 3        | exponential from 3 s | Retried; licence validity is unaffected                               |
| `notify`           | 2        | fixed 1 s            | Best-effort; a lost notification never blocks a workflow              |

```text
  guarantee:  every job is mirrored into the `jobs` table, so job health is queryable in SQL.
              clearing Redis cannot corrupt application state or erase job history.
```

---

## 12. Where it all runs

```text
┌─ edge profile  ·  the only published ports ────────────────────────────────────────────────┐
│  nginx :80 :443                    TLS 1.2+ · HSTS · rate limits · cached /ipfs gateway  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ app profile  ·  run natively by pnpm dev, or in containers ───────────────────────────────┐
│  web :3000                         Next.js console; the browser only ever reaches nginx  │
│  api :4000                         Fastify REST API; OpenAPI at /api/v1/docs (dev only)  │
│  worker                            six BullMQ consumers; no HTTP port at all             │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ infra profile ────────────────────────────────────────────────────────────────────────────┐
│  postgres :5432                    volume pgdata  ·  20 tables · forced RLS · audit      │
│  redis :6379                       volume redisdata  ·  six queues, retry per queue      │
│  ipfs :5001 :8080                  volumes ipfsdata, ipfscache  ·  addressed by hash     │
│  anvil :8545                       volume contractsdata  ·  local EVM, chain id 31337    │
│  deploy-contracts                  one-shot: migrate → RLS → deploy → write address      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ blender profile  ·  opt-in, heavy image ──────────────────────────────────────────────────┐
│  blender-runner                    volume blenderjobs  ·  headless conversion, opt-in    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

The whole stack — console, API, workers, database, cache, IPFS node and blockchain — runs locally with
**no cloud dependency, no faucet and no paid RPC provider**. Ten containers, four profiles, one
published port. That is what makes it demonstrable on a laptop, and why nothing here needs a
credential anyone has to pay for.

---

## 13. Requirements → mechanism

| Requirement                                    | How the system meets it                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Uploads up to 200 MB without exhausting memory | Streamed to disk in chunks, then streamed to IPFS one chunk at a time                    |
| Repeat content reads must be fast              | Immutable content is cached at the edge — safe precisely because a CID is a hash         |
| No provider outage may block a request         | Six queues; nothing slow ever runs inside a request                                      |
| A chain outage must not corrupt state          | Promotion to `published` happens only after a mint receipt exists                        |
| Upload validation must go beyond the extension | Extension + MIME + magic bytes + a size ceiling                                          |
| Tenant isolation must be verifiable            | Forced RLS on 18 tables, a boot-time role assertion, and tests that try to cross tenants |
| Every action must be attributable              | A correlation id per request, and an audit ledger that carries it                        |
| Shared contracts must not drift                | One `packages/types` package imported by api, worker and console                         |
| Human review wins                              | Every role here is one person doing one job — the platform does not see your data        |
| Deployment must be reproducible                | Migrations + idempotent RLS apply + idempotent seed, all run by one command              |

---

## 14. Built, designed, and next

```text
┌──────────────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ BUILT AND VERIFIED TODAY     │ NEEDS A THIRD-PARTY ACCOUNT  │ PRODUCTION HARDENING         │
│                              │                              │                              │
│  • ingestion · IPFS · review │  · Blender conversion        │  · Avalanche C-Chain         │
│  • licensing on chain        │    (real mode: ~1 GB image)  │  · managed signer / HSM      │
│  • console · audit · alerts  │  · vendor search adapters    │  · redundant IPFS pinning    │
│  • RBAC · RLS · SSO · SIWE   │    (live API keys)           │  · worker autoscaling        │
│  • API keys for machines     │  · email delivery            │  · Playwright e2e in CI      │
│  • Blender conversion        │                              │                              │
│  • 3rd-party importers       │                              │                              │
│  • outbound webhooks         │                              │                              │
│  • public catalogue          │                              │                              │
└──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

The middle column was headed "designed · adapter pending" until the last pass, and that heading was
wrong in a way the column itself could not show: everything listed under it already *had* its adapter,
its processor and its tests. What it lacks is a vendor account and outbound network access. Calling
that "designed but not built" made finished work look unfinished, which is its own kind of inaccuracy.

```text
  ┌─ THE SHORT VERSION ────────────────────────────────────────────────────────────────────────┐
  │                                                                                            │
  │  BUILT AND DEMONSTRABLE TODAY                                                              │
  │    upload → content-addressed storage → AI tags → human review → on-chain licence →          │
  │    marketplace and XR descriptor, with RBAC, tenant isolation, SSO/SIWE and an audit ledger  │
  │                                                                                            │
  │  NEEDS A THIRD-PARTY ACCOUNT (code, queues and tests already exist)                          │
  │    Blender conversion in real mode · vendor search against live APIs · email delivery        │
  │                                                                                            │
  │  PRODUCTION HARDENING                                                                        │
  │    Avalanche C-Chain + managed signer · redundant IPFS pinning · worker autoscaling ·        │
  │    Playwright end-to-end suite as a CI gate                                                  │
  │                                                                                            │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 15. One-screen cheat sheet

```text
╔════════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                        ║
║    10 containers · 4 profiles · 1 published port      275 tests · 0 lint warnings      ║
║    20 tables · 18 under forced RLS · 3 DB roles       6 queues with documented retries ║
║    69 API operations · 63 paths · 13 modules         35 Solidity contract tests        ║
║    content stored by hash, cached at the edge        an ERC-721 licence per asset      ║
║                                                                                        ║
║    THE LOOP      upload → hash → tag → human review → licence → marketplace → XR       ║
║    THE PROMISE   no customer can see another customer's unreleased models              ║
║    THE PROOF     every change sits in an append-only ledger, beside its chain receipt  ║
║                                                                                        ║
╚════════════════════════════════════════════════════════════════════════════════════════╝
```

---

## 16. The questions a reviewer asks, answered

| Question                                | Answer                                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is it, in one line?                | A governed pipeline that turns raw 3D/XR files into licensed, publicly verifiable assets                                                                                                                                           |
| Why is a blockchain in a DAM platform?  | Because "who licensed this, when, on what terms, and has it changed?" is exactly what a database cannot prove to a third party. Only the licence identity, a terms hash and a metadata CID go on chain — the model file never does |
| What is the real product risk?          | A customer's unreleased product models leaking. That is why isolation is enforced by Postgres itself, not by application code, and why a test tries to cross tenants on every run                                                  |
| What happens when a dependency is down? | Nothing loud. AI falls back to a deterministic offline enricher, IPFS retries with backoff, and a chain outage leaves the asset `approved` rather than falsely published                                                           |
| Can a licence be taken back?            | Yes — revocation is a flag on chain, not a burn. The asset leaves the marketplace, the token stays, and the history of the original grant remains auditable                                                                        |
| How much of this is real?               | Everything in the "built and verified" column is demoable right now, end to end, from one `docker compose` stack. §14 lists what still needs a third-party account or a production target, and says which — nothing there is an unwritten adapter                                                                                        |
| How do we know the numbers are true?    | Every figure was read from the running system: 275 tests across six suites, 20 tables, 69 API operations, 6 queues, 18 RLS-protected tables                                                                                        |
| Who sees what?                          | Six roles, assigned per workspace. A Creator can never approve; a Viewer cannot write anything; an Assessor can never review their own upload (§9)                                                                                 |

---

## 17. Sharing and printing this

```text
  ┌─ THE PRACTICAL BITS ───────────────────────────────────────────────────────────────────────┐
  │                                                                                            │
  │  · this file is one self-contained Markdown document — paste it into Slack, Confluence,      │
  │    Notion, an email or a wiki and the diagrams survive, because every one of them is         │
  │    plain text inside a code block (no images, no JavaScript, no web fonts)                   │
  │                                                                                            │
  │  · for a PDF:  pnpm docs:pdf  →  docs/build/VOID-SPACE-architecture.pdf (A4, 39 pages)        │
  │    built from docs/architecture.md, which carries the same diagrams plus the full reasoning   │
  │                                                                                            │
  │  · the long-form document is docs/architecture.md: the same ground in depth, with the    │
  │    request pipeline, the RLS failure mode, the data-model decisions, the API surface, the    │
  │    full test breakdown, the traceability matrix and an infographic atlas                     │
  │                                                                                            │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
```

_VOID·SPACE — architecture summary. Every figure in this document was read from the running platform,
not estimated from the specification; the long-form version, with the reasoning behind each decision,
is `docs/architecture.md`._
