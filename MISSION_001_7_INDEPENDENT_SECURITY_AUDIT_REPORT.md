# HIPPOCAMPUS AI — MISSION 001.7
# INDEPENDENT SECURITY RE-AUDIT, ADVERSARIAL VERIFICATION & PRODUCTION ACCEPTANCE REPORT

**Audit Classification:** Independent Security Acceptance Re-Audit (Read-Only)  
**Target Application:** Hippocampus AI (`https://github.com/Uchiha7madara-afk/Hippocampus_AI`)  
**Scope:** Single-Organization Production Security Baseline (Multi-Tenant SaaS Explicitly OUT OF SCOPE / NO-GO Pending Mission 002)  
**Predecessors:** Mission 001 (Security Hardening), Mission 001.5 (Independent Audit), Mission 001.6 (Comprehensive Security Remediation)  
**Audit Date:** 2026-11-28 (UTC)  
**Overall Independent Audit Verdict:** **`C. REQUIRE REMEDIATION`**

---

## 1. Executive Summary

An independent, read-only principal application security re-audit (Mission 001.7) was conducted against the Hippocampus AI workspace to verify whether Mission 001.6 remediations eliminated findings **AUD-001 through AUD-015**, introduced regressions, or left newly exploitable security boundaries unaddressed. All existing test suites, schema integrity checks, production builds, dependency audits, and 22 bespoke adversarial tests (executed via disposable harnesses against real PostgreSQL 16 semantics via PGlite and an in-process production-configured Express server) were run independently without modifying any repository source file, migration, manifest, lockfile, or test.

### Key Findings Summary

- **Substantial Core Hardening Verified:** Eight of the fifteen original findings (**AUD-001, AUD-002, AUD-004, AUD-007, AUD-008, AUD-009, AUD-012, AUD-013**) are **VERIFIED FIXED** at the code level. Role-partitioned L1/L2 semantic caching, metadata-only role-scoped cache telemetry, user-bound encrypted GitHub OAuth with browser-binding cookies and atomic single-use state consumption, fail-closed webhook HMAC verification with atomic PostgreSQL replay deduplication, strict production CORS without `Host`/`X-Forwarded-Proto` bypass, and UID-scoped onboarding isolation with partial unique indexes all held up under adversarial testing.
- **Four Newly Discovered HIGH-Severity Vulnerabilities Independently Reproduced:**
  1. **`NEW-001` (HIGH):** `upsertConnectorDocument()` (`src/db/queries.ts:2327-2358`) matches existing documents solely by `sourceUrl` without verifying whether the caller's role permits modifying the existing document's `accessLevel`. A `Manager` can call `POST /api/connectors/gdrive/import` with the `sourceUrl` of an existing `Admin`-tier document and `accessLevel: "Engineer"`, overwriting and downgrading the `Admin` document in place so `Engineer` users can read it. **Reproduced against PostgreSQL 16 (HTTP 200).**
  2. **`NEW-002` (HIGH):** `GET /api/logs` (`src/app-server.ts:2270-2283`, `src/db/queries.ts:1828-1844`) enforces zero `userUid` ownership scoping and classifies each query log's `requiredRole` solely from the highest `accessLevel` of retrieved chunks (`src/app-server.ts:2203-2209`) rather than `max(actor.role, highestChunkTier)`. Consequently, any `Engineer` can read all peer Engineers' raw prompts and generated answers, **and** can read an `Admin`'s or `Manager`'s raw confidential prompt and answer whenever the privileged user's query retrieves only `Engineer`-tier chunks. **Reproduced against PostgreSQL 16 (HTTP 200).**
  3. **`NEW-003` (HIGH):** Indirect prompt injection via ingested documents (`src/lib/ai.ts:27-33, 677-733`) lacks untrusted-data framing or instruction hierarchy, concatenates raw chunk text directly into the LLM user prompt, and executes every LLM-returned `functionCalls` item automatically without per-tool RBAC, argument schema validation, or human confirmation. Additionally, a schema/executor mismatch exists between `fetchGithubPullRequest` (`src/lib/env.ts:529`) and `inspectGithubPullRequest` (`src/lib/ai.ts:202`).
  4. **`NEW-004` (HIGH):** `POST /api/connectors/github/sync` (`src/app-server.ts:1166-1220`) bypasses the `GITHUB_ALLOWED_REPOS` allowlist enforced on GitHub webhooks, allowing a `Manager` (or `Admin`) to ingest arbitrary private repositories accessible to the shared server `GITHUB_TOKEN` PAT when the user has not connected personal GitHub OAuth (`src/lib/connectors.ts:153-158`). **Reproduced (HTTP 200 sync of unapproved repository).**
- **Five Original Findings Partially Fixed & Report-vs-Code Discrepancies Confirmed:**
  - **`AUD-003` (PARTIALLY FIXED / `NEW-006` MEDIUM):** Nine tested endpoints correctly fail closed with HTTP `503` on production DB failure, **but** `POST /api/ratelimit/reset` (`src/app-server.ts:1914-1932`) omits `try/catch` in Express 4, causing an unhandled `PersistenceError` rejection that hangs the HTTP request and crashes Node 22. Multi-step document/chunk writes are also non-transactional.
  - **`AUD-010` (PARTIALLY FIXED / `NEW-007` MEDIUM):** HTML/script XSS escaping works, **but** `MISSION_001_6_REMEDIATION_REPORT.md` and `MISSION_001_6_SECURITY_TEST_MATRIX.md` falsely claim a strict `Content-Security-Policy` header is enforced on `/auth/github/callback`. Live inspection confirmed `Content-Security-Policy: null`, `Strict-Transport-Security: null`, and `X-Frame-Options: null` globally and on `/auth/github/callback`.
  - **`AUD-011` (PARTIALLY FIXED / `NEW-010` MEDIUM-LOW):** `sanitizeStringForLogs` (`src/lib/logger.ts:48-49`) does not redact embedded PostgreSQL URI passwords (`postgresql://user:pass@host`). `POST /api/documents` also accepts `javascript:` URIs in `sourceUrl` (HTTP `201`).
  - **`AUD-014` (PARTIALLY FIXED / `NEW-005` MEDIUM):** `UPDATE` and `DELETE` on `security_audit_logs` are blocked with SQLSTATE `42501`, **but** `TRUNCATE TABLE security_audit_logs` succeeds (`16 -> 0` rows) because the trigger lacks `BEFORE TRUNCATE FOR EACH STATEMENT` and `REVOKE` targets only a hardcoded `app_user` role.
  - **`AUD-015` (PARTIALLY FIXED / `NEW-008` MEDIUM):** `drizzle-kit@0.31.11` (carrying transitive `esbuild@0.18.20` GHSA-67mh-4wv8-2f99) is declared in **`dependencies`** (not `devDependencies`) alongside `@playwright/test`, `@electric-sql/pglite`, and `vite`, contradicting Mission 001.6's claim that it is dev-only. Furthermore, `package.json`'s `"start": "node server.ts"` crashes immediately under Node `v22.23.5` due to a missing JSON import attribute (`with { type: 'json' }`) at `src/lib/firebase-admin.ts:3`.
- **Infrastructure & Staging Acceptance:** No live staging or production Cloud SQL, Cloud Run/hosting, Firebase project, or Vercel environment was accessible during this audit. All live infrastructure, migration dry-run against production backups, secret manager, TLS/HSTS termination, monitoring, and rollback checks are strictly classified as **`BLOCKED BY INFRASTRUCTURE`**.

### Explicit Answers to the 10 Production Release Decision Questions

1. **Is the current codebase safe for a single-organization staging deployment?**  
   **NO (Not Yet).** While staging carries lower blast radius than production, the codebase currently fails to boot via its declared production `"start": "node server.ts"` script on Node 22 (`NEW-008`), crashes on unhandled `PersistenceError` in `POST /api/ratelimit/reset` (`NEW-006`), and contains four reproducible HIGH vulnerabilities (`NEW-001`–`NEW-004`). Remediate `NEW-001`–`NEW-008` before staging acceptance testing.
2. **Are all AUD-001–AUD-004 and AUD-006–AUD-014 findings independently verified as fixed?**  
   **NO.** Only **8** (`AUD-001, AUD-002, AUD-004, AUD-007, AUD-008, AUD-009, AUD-012, AUD-013`) are `VERIFIED FIXED`. Five (`AUD-003, AUD-006, AUD-010, AUD-011, AUD-014`) are `PARTIALLY FIXED` (with `AUD-006` additionally `BLOCKED BY INFRASTRUCTURE` for real staging/prod PostgreSQL).
3. **Is AUD-015 acceptable under the documented dependency risk?**  
   **NO.** The Mission 001.6 risk acceptance rested on the false premise that `drizzle-kit` (and its vulnerable `esbuild@0.18.20` dependency) resides in `devDependencies` and is excluded from production images. In fact, `drizzle-kit`, `@playwright/test`, `@electric-sql/pglite`, and `vite` are all listed in `dependencies` (`package.json:20-44`), and CI runs `npm install --no-audit` without any vulnerability gate.
4. **Were any new Critical or High vulnerabilities discovered?**  
   **YES — 4 HIGH vulnerabilities** (`NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`), plus **5 MEDIUM**, **1 MEDIUM-LOW**, and **1 LOW** documentation/consistency finding (`NEW-005` through `NEW-011`). Zero Critical vulnerabilities were found.
5. **Is the migration safe for the actual production database?**  
   **LOCALLY VERIFIED / PRODUCTION BLOCKED BY INFRASTRUCTURE.** Migrations `0000` and `0001` executed cleanly, idempotently, and without data loss across five synthetic PGlite PG16 states (empty, populated, duplicate legacy `user_progress`, legacy v1 `semantic_cache`, and partial state). However, safety on the actual production PostgreSQL database cannot be certified because (a) no production schema dump/staging clone was accessible (`BLOCKED BY INFRASTRUCTURE`), (b) CI runs `drizzle-kit push --force` rather than `drizzle-kit migrate`, and (c) `0001` lacks `BEFORE TRUNCATE` protection and hardcodes `app_user`.
6. **Has the staging infrastructure been independently verified?**  
   **NO (`BLOCKED BY INFRASTRUCTURE`).** No staging environment, Cloud SQL instance, Firebase project IAM, Vercel config, or secret manager was accessible to this audit.
7. **Is the application safe for a single-organization production deployment?**  
   **NO.** Blocked by four HIGH vulnerabilities (`NEW-001`–`NEW-004`), production startup crash (`NEW-008`), unhandled Express 4 rejection crash (`NEW-006`), missing security headers (`NEW-007`), audit log `TRUNCATE` bypass (`NEW-005`), and unverified staging/production infrastructure (`BLOCKED BY INFRASTRUCTURE`).
8. **Is it safe for multi-tenant SaaS?**  
   **NO (Explicitly NO-GO pending Mission 002).** Single-organization global data model remains in place (`AUD-005` intentionally deferred to Mission 002).
9. **What exact actions remain before production authorization?**  
   (1) Remediate all P0/P1 findings (`NEW-001` through `NEW-008`) and add regression tests for each; (2) Remediate P2 operational/redaction/documentation gaps (`NEW-009` through `NEW-011`); (3) Fix `"start"` runtime compatibility and move dev/test/build tools to `devDependencies` with CI audit + `drizzle-kit migrate` gates; (4) Execute a fresh independent verification pass on remediated code; (5) Complete all staging and production infrastructure checks (`MISSION_001_7_PRODUCTION_ACCEPTANCE_CHECKLIST.md` Sections 8–13) against authorized staging/production environments including real Cloud SQL backup, migration dry-run, and rollback rehearsal.
10. **What is the final independent audit verdict?**  
    **`C. REQUIRE REMEDIATION`** (Single-Organization Baseline: Rejected pending remediation & staging/infrastructure verification; Multi-Tenant SaaS: **NO-GO** pending Mission 002).

---

## 2. Audit Scope

### In Scope
- Complete static source code review of all backend routes (`src/app-server.ts`, `server.ts`), authentication and RBAC middleware (`src/middleware/auth.ts`, `src/lib/firebase-admin.ts`), environment and Zod validation (`src/lib/env.ts`), OAuth cryptography and token encryption (`src/lib/oauth-crypto.ts`), RAG/LLM/agent tool orchestration (`src/lib/ai.ts`), external connectors and webhooks (`src/lib/connectors.ts`, `src/lib/slack.ts`), resilience and structured logging (`src/lib/resilience.ts`, `src/lib/logger.ts`), PostgreSQL schema/queries/migrations (`src/db/schema.ts`, `src/db/index.ts`, `src/db/queries.ts`, `src/db/drizzle.config.ts`, `drizzle/*.sql`, `drizzle/meta/*`), frontend authentication/components (`src/App.tsx`, `src/context/AuthContext.tsx`, `src/components/*`), build/CI/test suites (`package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `tests/*`, `e2e/*`), and security documentation (`docs/SECURITY_PRODUCTION_CONFIG.md`, `MISSION_001_6_*.md`).
- Independent execution of existing security tests, PostgreSQL integration tests, Playwright E2E tests, Drizzle migration consistency checks, TypeScript checks, production Vite bundle build, and dependency audit.
- Independent adversarial dynamic testing against local PostgreSQL 16 (PGlite) + production-mode Express server via temporary disposable harnesses outside the repository (`/tmp/`, deleted immediately after each run).

### Out of Scope / Unavailable
- Live staging or production infrastructure (Cloud SQL, Cloud Run/compute host, Vercel frontend host, Firebase Auth console, Secret Manager, WAF/CDN, production log sinks, backup/restore drills): **`BLOCKED BY INFRASTRUCTURE`**.
- Multi-tenant SaaS tenant isolation (`AUD-005`): Explicitly out of scope for Mission 001.7 and remains **NO-GO** pending Mission 002.
- Any modification of repository source code, migrations, manifests, lockfiles, CI configuration, or existing test files (strictly prohibited by read-only mandate).

---

## 3. Repository Integrity

| Integrity Dimension | Independent Observation | Verification Status |
|---|---|---|
| Git Metadata (`.git/`) | `.git` directory is absent in `/app/applet` (`git status` -> `fatal: not a git repository`). Commit hash, branch name, and git commit history could not be independently verified from local git objects. | **NOT AVAILABLE (Workspace Snapshot Only)** |
| Source Code Mutability | Zero repository files were modified during this audit; SHA-256 checksums of all migrations, snapshots, `package.json`, and `bun.lock` were verified unchanged before and after testing. | **VERIFIED READ-ONLY** |
| Secrets Committed in Repo | `.env` not committed; `.env.example` contains placeholders only. `firebase-applet-config.json` contains standard client-side public Firebase web app configuration (not a private service-account key). No private keys, GitHub tokens, Slack secrets, or DB passwords found in tracked files. | **VERIFIED CLEAN** |
| Deliverable Integrity vs Claims | Multiple material discrepancies found between `MISSION_001_6_REMEDIATION_REPORT.md` / `MISSION_001_6_SECURITY_TEST_MATRIX.md` and actual code (false callback CSP claim, false `devDependencies` claim for `drizzle-kit`, false TypeScript `strict: true` claim, missing `AUD-005` single-org constraint in `docs/SECURITY_PRODUCTION_CONFIG.md`). | **DISCREPANCIES IDENTIFIED** |

### Cryptographic Checksums (SHA-256) of Critical Artifacts

| Artifact Path | SHA-256 Digest |
|---|---|
| `drizzle/0000_mission001_security_hardening.sql` | `b96790a53ad00e5a4391e031cde3b91b5804c0ca4aee14eef77eee1466f8b0c1` |
| `drizzle/0001_mission001_6_security_remediation.sql` | `4a8d61c2f7807df4c3cf19a2621959806f729e482c06081ad6298ead78979a31` |
| `drizzle/meta/0000_snapshot.json` | `f5e0efd4ffe042a933f5ecc047e9739df17c81e306977f55ad70d95b1bf4b289` |
| `drizzle/meta/0001_snapshot.json` | `4c0f76aba7908d90d8114b90992b341f207f84ad499262e947a0538d67f28f9a` |
| `drizzle/meta/_journal.json` | `f82eb53c513d58050e2373591e176c52d4a085f3c4c7d095c2bf9cfb4f03dea0` |
| `package.json` | `9cf970ec80b3d19bc4b9d781b2f80c07f5f6ef30e20a7703f44f8a37a8da4d27` |
| `bun.lock` | `dd98a7765fc2155ab91867ceb3a59c857e95814a1b04674a4caaf413891bb31e` |

---

## 4. Methodology

The audit followed a six-phase evidence-driven methodology:
1. **Phase Zero — Baseline & Integrity Capture:** Captured tool versions, SHA-256 digests, and executed all existing verification commands (`npm run test:security`, `npx playwright test`, `npx drizzle-kit check`, `npx tsc --noEmit`, `npm run build`, `bun audit`, and Node 22 production startup test).
2. **Phase One — Claim-by-Claim AUD-001–AUD-015 Verification:** Independently inspected every referenced file and line range in `MISSION_001_6_REMEDIATION_REPORT.md` without assuming accuracy, cross-checking every claim against runtime code and SQL DDL.
3. **Phase Two — Full Attack Surface & Architectural Audit:** Mapped all 31 Express API routes in `src/app-server.ts`, verified middleware order, RBAC matrix, data-plane queries in `src/db/queries.ts`, RAG retrieval/prompt construction/tool calling in `src/lib/ai.ts`, connector ingestion in `src/lib/connectors.ts`, frontend sinks, and built Vite bundle contents.
4. **Phase Three — Deployment, Supply Chain & Migration Review:** Audited `package.json`, `bun.lock`, `.github/workflows/ci.yml`, `tsconfig.json`, `server.ts`, `src/db/index.ts`, `src/lib/env.ts`, and `docs/SECURITY_PRODUCTION_CONFIG.md`.
5. **Phase Four — Independent Adversarial Execution:** Executed 22 targeted adversarial test scenarios (`ADV-001`–`ADV-022`) using disposable harnesses in `/tmp/` against real PostgreSQL 16 (PGlite) with migrations `0000` + `0001` applied and `createApp()` operating under `NODE_ENV=production` and `ALLOW_DEV_AUTH_BYPASS=false`.
6. **Phase Five & Six — Test Quality Audit & Acceptance Classification:** Audited `tests/security.test.ts` (1,652 lines), `tests/postgres-integration.test.ts` (673 lines), and `e2e/hippocampus.spec.ts` (101 lines) for false positives, mock-only coverage, and uncovered branches; assigned independent verdicts using the strict Mission 001.7 rubric.

---

## 5. Environment and Tool Versions

| Tool / Component | Verified Version | Notes |
|---|---|---|
| Operating System | Linux (x86_64 container) | Workspace `/app/applet` |
| Node.js | `v22.23.5` | Direct `node server.ts` fails on JSON import attribute |
| npm | `10.9.9` | Used for `npm run test:security`, `npm run build` |
| Bun | `1.4.4` | Used for `bun audit` against `bun.lock` |
| Vite | `6.4.6` | Production build verified (`dist/`) |
| PGlite (`@electric-sql/pglite`) | `0.6.1` | Embedded PostgreSQL 16 WASM engine for PG integration tests |
| Drizzle Kit (`drizzle-kit`) | `0.31.11` | Listed in `dependencies` (misclassified); pulls `esbuild@0.18.20` |
| Drizzle ORM (`drizzle-orm`) | `0.45.1` | PostgreSQL query builder |
| Express (`express`) | `4.21.2` | Express 4 does **not** catch rejected async route handler promises |
| Playwright (`@playwright/test`) | `1.59.1` | Listed in `dependencies` (misclassified) |

---

## 6. Test Execution Results

| Command | Exit Code | Independent Observed Result | Critical Audit Notes |
|---|---|---|---|
| `npm run test:security` | `0` | **52 passed, 0 failed, 0 skipped** (11 suites, 38.05s) | Covers `tests/security.test.ts` + `tests/postgres-integration.test.ts`. Does not cover `NEW-001`–`NEW-010`. |
| `npx playwright test --reporter=list` | `0` | **4 passed, 0 failed** (11.0s) | Runs against dev server with dev auth bypass; does **not** exercise production Firebase Auth or production CORS. |
| `npx drizzle-kit check --config=src/db/drizzle.config.ts` | `0` | `Everything's fine` | Snapshots `0000` and `0001` align with `src/db/schema.ts`. |
| `npx tsc --noEmit` | `0` | 0 TypeScript errors | `tsconfig.json` has `"strictNullChecks": true` only — **not** `"strict": true`. |
| `npm run build` (`vite build`) | `0` | Built in 20.85s (`dist/index.html` 1.61 kB, CSS 43.06 kB, JS 1,031.54 kB) | Zero `.map` source maps emitted (`maps: []`). Zero server secrets found in `dist/assets/index-*.js`. |
| `bun audit` | `1` | **1 moderate vulnerability**: `esbuild@0.18.20` (`<=0.24.2`, GHSA-67mh-4wv8-2f99) via `drizzle-kit > esbuild` | **Active in `dependencies`** (not `devDependencies`), contradicting Mission 001.6 report. |
| `node -e "import('./src/app-server.ts')"` (Production Start Check) | **`1` (FAIL)** | `TypeError [ERR_IMPORT_ATTRIBUTE_MISSING]: Module "file:///app/applet/firebase-applet-config.json" needs an import attribute of "type: json"` (`src/lib/firebase-admin.ts:3`) | **`package.json` `"start": "node server.ts"` crashes immediately on Node `v22.23.5`.** |

---

## 7. AUD-001–AUD-015 Verification Matrix

| Finding ID | Summary | Mission 001.6 Claim | Independent Verdict | Evidence & Residual Gaps |
|---|---|---|---|---|
| **AUD-001** | Cross-role semantic cache data leakage | Fixed | **VERIFIED FIXED** | L2 SQL filters `role`, `search_mode`, `cache_version=2`; L1 keys partitioned by `${role}::${searchMode}`; `ADV-001` verified Admin-cached response yields `MISS` for Engineer, Manager, different `searchMode`, legacy v1 row, and immediately after live Admin->Engineer demotion. |
| **AUD-002** | Cross-role telemetry & cache payload leakage | Fixed | **VERIFIED FIXED** | `GET /api/cache/telemetry` requires `telemetry:read` (Engineer -> `403`); Manager sees only Engineer/Manager role buckets (zero Admin entries); Admin receives metadata-only entries (zero `answer`, `queryText`, `queryEmbedding`, `sources`). Verified in `ADV-002`. |
| **AUD-003** | Production in-memory fallback masking DB failures | Fixed | **PARTIALLY FIXED** | `handlePersistenceFailure()` throws `PersistenceError` in production and 9 tested endpoints return HTTP `503`. **HOWEVER**, `POST /api/ratelimit/reset` (`src/app-server.ts:1914-1932`) lacks `try/catch` in Express 4 -> reproduced fatal `unhandledRejection: PersistenceError` + hung request (`NEW-006`). Also non-transactional doc/chunk writes and incomplete `assertSafeProductionConfig()` (`NEW-009`). |
| **AUD-004** | GitHub OAuth session binding, replay & token storage | Fixed | **VERIFIED FIXED** | Cryptographic state, HMAC browser-binding cookie, atomic PG state consumption, AES-256-GCM per-user encrypted tokens, 10s exchange timeout, and cross-user disconnect isolation all verified (`ADV-004`/`005`/`006`). Residual operational defect logged separately as `NEW-009` (key rotation causes HTTP `503` on `GET /api/connectors`). |
| **AUD-005** | Multi-tenant organization isolation | Deferred to Mission 002 | **NOT FIXED** | Intentionally deferred to Mission 002; single-org global workspace remains. Report discrepancy (`NEW-011`): `docs/SECURITY_PRODUCTION_CONFIG.md` does not actually document the single-org deployment restriction despite Mission 001.6 claiming it does. |
| **AUD-006** | PostgreSQL production persistence, TLS & migrations | Fixed | **PARTIALLY FIXED / BLOCKED BY INFRASTRUCTURE** | Local migrations `0000`+`0001` pass `drizzle-kit check` and 5 synthetic PG16 scenarios (`ADV-021`); TLS `rejectUnauthorized: true` and password removal verified in `src/db/index.ts`. **Gaps:** CI uses `drizzle-kit push --force` instead of `drizzle-kit migrate` (`NEW-008`), and live staging/prod PostgreSQL & Cloud SQL migration/backups are **`BLOCKED BY INFRASTRUCTURE`**. |
| **AUD-007** | Admin bootstrap email verification & race safety | Fixed | **VERIFIED FIXED** | `email_verified === true` enforced on bootstrap (`src/app-server.ts:469-498`) and bootstrap is one-time only when user count is 0. Note latent multi-connection `23505` check-then-insert race in `getOrCreateUser()` (`src/db/queries.ts:236-271`, tracked in `NEW-009`). |
| **AUD-008** | GitHub webhook HMAC, replay & rate limiting | Fixed | **VERIFIED FIXED** | Raw `Buffer` HMAC-SHA256 with `timingSafeEqual`, mandatory `X-GitHub-Delivery`, atomic PG insert-first deduplication under concurrency (`1 processed / 2 ignored`), 60/min rate limit immune to spoofed `X-Forwarded-For` under `TRUST_PROXY_HOPS=0`, simulator header rejected, dev simulator `404` in prod (`ADV-007`/`008`). |
| **AUD-009** | Slack webhook signature, replay & timestamp validation | Fixed | **VERIFIED FIXED** | Raw `Buffer` HMAC-SHA256, strict `^\d{10}$` timestamp regex + `±300s` replay window, strict Zod payload validation, atomic PG `event_id` deduplication under concurrency (`1 accepted / 2 suppressed`), isolated dev simulator `404` in prod (`ADV-009`). |
| **AUD-010** | OAuth callback XSS, `postMessage` & CSP | Fixed | **PARTIALLY FIXED** | `serializeJsonForScript()` safely escapes `</script>`, `U+2028`, `U+2029`; `ConnectorsPanel.tsx` validates `event.origin` and `event.source === popupRef.current`. **HOWEVER**, Mission 001.6 falsely claimed a strict callback CSP header is enforced — runtime inspection confirmed `Content-Security-Policy: null`, `Strict-Transport-Security: null`, `X-Frame-Options: null` (`NEW-007`). |
| **AUD-011** | Log injection & secret redaction | Fixed | **PARTIALLY FIXED** | `X-Request-Id` CRLF sanitization blocks log forging and API keys/Bearer tokens/query keys are scrubbed. **HOWEVER**, `sanitizeStringForLogs` & `sanitizeAuditMetadata` fail to redact embedded PostgreSQL URI passwords (`postgresql://user:pass@host`) (`NEW-010`). |
| **AUD-012** | Production CORS spoofing & `trust proxy` | Fixed | **VERIFIED FIXED** | Production CORS uses explicit `ALLOWED_ORIGINS` only (no `Host`/`X-Forwarded-Proto` derivation); `null`, wrong-scheme, wrong-port, and suffix-spoofed origins rejected `403`; `trust proxy` uses integer `TRUST_PROXY_HOPS` (`ADV-010`). |
| **AUD-013** | Onboarding cross-user UID isolation | Fixed | **VERIFIED FIXED** | `user_progress` uses `user_uid` + partial unique index; identical email local-parts (`@engineer`) remain isolated under concurrency; cross-UID HTTP updates return `403` (`ADV-011`). |
| **AUD-014** | Append-only `security_audit_logs` enforcement | Fixed | **PARTIALLY FIXED** | `UPDATE` and `DELETE` fail with SQLSTATE `42501`. **HOWEVER**, `TRUNCATE TABLE security_audit_logs` succeeded and wiped all 16 audit rows (`16 -> 0`) because `trg_security_audit_logs_append_only` omits `BEFORE TRUNCATE FOR EACH STATEMENT` and `REVOKE` hardcodes role `app_user` (`NEW-005`). |
| **AUD-015** | Dependency vulnerabilities (`esbuild` / `@grpc/grpc-js`) | Risk Accepted (Dev-only) | **PARTIALLY FIXED** | `@grpc/grpc-js` resolved, **but** `drizzle-kit@0.31.11` (`esbuild@0.18.20`, GHSA-67mh-4wv8-2f99) is in **`dependencies`** rather than `devDependencies`, invalidating the "dev-only / excluded from production" risk-acceptance rationale (`NEW-008`). |

---

## 8. New Vulnerabilities

### `NEW-001` — HIGH — Unauthorized Admin Document Overwrite & RBAC Downgrade via Connector `sourceUrl` Collision
- **Verdict:** `NEW FINDING` (Independently Reproduced on PostgreSQL 16)
- **Affected Components:** `src/db/queries.ts:2327-2358` (`upsertConnectorDocument`), `src/app-server.ts:1683-1772` (`POST /api/connectors/gdrive/import`, `POST /api/connectors/github/sync`, webhook sync path)
- **Root Cause:** `POST /api/connectors/gdrive/import` authorizes the caller for `connectors:manage` (granted to `Manager` and `Admin`) and checks that the *requested* `accessLevel` does not exceed the caller's role (`Manager` may specify `Engineer` or `Manager`). However, `upsertConnectorDocument()` searches for an existing document solely by `eq(documents.sourceUrl, doc.sourceUrl)` and overwrites `title`, `content`, `accessLevel`, and `chunks` in place **without checking the existing document's `accessLevel` against the caller's role**.
- **Reproduction & Evidence (`ADV-014`):** Admin ingested an `Admin`-tier document (`id=9`, `sourceUrl: "https://drive.google.com/file/d/exec-board-memo/view"`, invisible to `Engineer`). Manager called `POST /api/connectors/gdrive/import` with the same `sourceUrl` and `accessLevel: "Engineer"`. Server returned **HTTP `200`**, overwrote document `id=9` in place, downgraded its `accessLevel` to `Engineer`, and made it immediately visible to `Engineer` (`engVisibleBefore=false -> engVisibleAfter=true`).
- **Impact:** Any `Manager` can destroy, poison, or downgrade `Admin`-classified documents (and corrupt RAG answers grounded in them) simply by matching or guessing a `sourceUrl`.

### `NEW-002` — HIGH — Cross-User & Cross-Role Query/Answer Leakage in `GET /api/logs`
- **Verdict:** `NEW FINDING` (Independently Reproduced on PostgreSQL 16)
- **Affected Components:** `src/app-server.ts:2203-2209, 2221-2238, 2270-2283`, `src/db/queries.ts:1828-1844` (`getRecentQueryLogs`)
- **Root Cause:** (1) `query_logs` stores no `user_uid` column and `getRecentQueryLogs(role)` filters solely on `inArray(queryLogs.requiredRole, allowedTiers)` with zero user-ownership scoping; (2) `POST /api/chat` sets `requiredRole` strictly from `highestTier` of the retrieved chunks (`src/app-server.ts:2203-2209`) rather than `max(activeRole, highestChunkTier)`.
- **Reproduction & Evidence (`ADV-015`):** With 5 `Engineer`-tier documents in the workspace, `Admin` (`@admin`) submitted a `POST /api/chat` prompt containing `confidential-M-and-A-layoff-plan-Q4` (`searchMode: "sparse_bm25"`), and `Engineer 1` (`@eng1`) submitted a prompt containing `eng1-private-hr-question-XYZ`. Both returned HTTP `200`; Admin's top 4 chunks were all `Engineer`-tier, so `requiredRole` was stored as `'Engineer'`. When `Engineer 2` called `GET /api/logs` (HTTP `200`), the response returned **both** `@admin`'s raw confidential prompt + answer (`eng2SeesAdminPrompt: true`, `eng2SeesAdminRequiredRole: "Engineer"`) **and** `@eng1`'s private prompt + answer (`eng2SeesEng1Prompt: true`).
- **Impact:** Persistent, systemic horizontal disclosure of all Engineers' prompts/answers to every other Engineer, plus vertical disclosure of confidential `Admin`/`Manager` prompts (e.g., M&A, HR, security incident queries) to every `Engineer` whenever retrieved context consists of `Engineer`-tier documents.

### `NEW-003` — HIGH — Indirect Prompt Injection Leading to Unconstrained Agent Tool Execution & Tool Schema Mismatch
- **Verdict:** `NEW FINDING` (Independently Verified via Static & Runtime Inspection)
- **Affected Components:** `src/lib/ai.ts:27-33, 178-264, 677-733`, `src/app-server.ts:2070-2090`, `src/lib/env.ts:529`
- **Root Cause:**
  1. `SYSTEM_PROMPT` (`src/lib/ai.ts:27-33`) has zero untrusted-data framing or instruction hierarchy warning the model that retrieved document chunks are untrusted data.
  2. Retrieved chunks are concatenated raw into `userPrompt` (`src/lib/ai.ts:677-685`).
  3. `synthesizeRagAnswer()` (`src/lib/ai.ts:706-733`) iterates over every `response.functionCalls` returned by Gemini and executes `executeEnterpriseTool(call.name, call.args)` **without** checking the authenticated user's role, validating tool arguments against Zod schemas, constraining tool-call count, or requiring user confirmation for side-effecting tools (e.g., `pingOnCallEngineer`).
  4. `POST /api/tools/execute` (`src/app-server.ts:2070-2090`) permits any `Engineer` (`assistant:use`) to invoke all catalog tools, and `ExecuteToolRequestSchema` (`src/lib/env.ts:529`) validates `fetchGithubPullRequest` while `executeEnterpriseTool()` (`src/lib/ai.ts:202`) implements `inspectGithubPullRequest` — verified via `ADV-017` returning `{"error":"Unknown tool: fetchGithubPullRequest"}`.
- **Impact:** Although current tool implementations are catalog-simulated, any poisoned document (e.g., via GitHub PR/issue or Drive import) can hijack Gemini tool invocations under a privileged user's session. As soon as real PagerDuty/Slack/GitHub actions are wired into these executors, this becomes immediate remote unauthorized action execution.

### `NEW-004` — HIGH — `POST /api/connectors/github/sync` Bypasses `GITHUB_ALLOWED_REPOS` Allowlist & Uses Shared Server PAT
- **Verdict:** `NEW FINDING` (Independently Reproduced)
- **Affected Components:** `src/app-server.ts:1166-1220`, `src/lib/connectors.ts:153-158`
- **Root Cause:** Unlike the GitHub webhook handler, `POST /api/connectors/github/sync` never enforces `GITHUB_ALLOWED_REPOS`. If the authenticated `Manager` has no personal GitHub OAuth connection, the route silently falls back to `process.env.GITHUB_TOKEN` (the shared organization/server PAT). Additionally, `fetchGithubRepositoryDocs()` interpolates `node.path` into `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${node.path}` while attaching the `Authorization: Bearer` header without validating against path traversal (`..`) or redirect host changes.
- **Reproduction & Evidence (`ADV-018`):** With `GITHUB_ALLOWED_REPOS="org/strictly-approved-only"`, an authenticated `Manager` sent `POST /api/connectors/github/sync` targeting `private-org/unapproved-secret-repo`. Server returned **HTTP `200`** and invoked repository ingestion for the unapproved repository.
- **Impact:** Complete bypass of repository allowlisting; any `Manager` can exfiltrate/ingest any private repository reachable by the server's `GITHUB_TOKEN` into the knowledge base (even at `Engineer` tier).

### `NEW-005` — MEDIUM — Audit Log Append-Only Enforcement Bypassed by `TRUNCATE TABLE` & Hardcoded Role Name
- **Verdict:** `NEW FINDING` (Independently Reproduced on PostgreSQL 16; degrades `AUD-014` to `PARTIALLY FIXED`)
- **Affected Components:** `drizzle/0001_mission001_6_security_remediation.sql:170-199`
- **Root Cause:** `trg_security_audit_logs_append_only` is registered as `BEFORE UPDATE OR DELETE ON security_audit_logs FOR EACH ROW`. In PostgreSQL, row-level `DELETE` triggers do **not** fire on `TRUNCATE`. Furthermore, the `REVOKE UPDATE, DELETE, TRUNCATE` block only executes if a role literally named `app_user` exists; any deployment connecting as `postgres`, `hippocampus_app`, or a Cloud SQL IAM user retains `TRUNCATE` privileges.
- **Reproduction & Evidence (`ADV-012`):** On PGlite PG16 with `0000`+`0001` applied, `UPDATE` and `DELETE` failed with SQLSTATE `42501`, **but** `TRUNCATE TABLE security_audit_logs` succeeded and wiped all rows (`16 -> 0`).

### `NEW-006` — MEDIUM — Uncaught Async Rejection in Express 4 Route `POST /api/ratelimit/reset` Crashes Node 22 & Non-Transactional Multi-Step Writes
- **Verdict:** `NEW FINDING` (Independently Reproduced; degrades `AUD-003` to `PARTIALLY FIXED`)
- **Affected Components:** `src/app-server.ts:1914-1932`, `src/middleware/auth.ts:420-453`, `src/db/queries.ts:1322-1361, 2336-2407`
- **Root Cause:** Express 4 does not catch rejected promises thrown by `async` handlers. `POST /api/ratelimit/reset` awaits `recordSecurityAuditEvent()` without a `try/catch` block. Under a production DB outage, `recordSecurityAuditEvent()` throws `PersistenceError` asynchronously, leaving the HTTP response hung indefinitely and emitting a process-terminating `unhandledRejection` in Node 22. Additionally, `ingestDocument()` and `upsertConnectorDocument()` execute document insert, chunk deletion, chunk insert, and cache invalidation outside a database transaction (`db.transaction()`), risking orphaned/partial document states on mid-write failure.
- **Reproduction & Evidence (`ADV-003`):** Against a closed local PostgreSQL port (`ECONNREFUSED`) in production mode, `POST /api/chat`, `GET /api/documents`, and `GET /api/overview` returned HTTP `503`, while `POST /api/ratelimit/reset` timed out (`AbortError`) and emitted `unhandledRejection: PersistenceError`.

### `NEW-007` — MEDIUM — Missing Security Headers (`CSP`, `HSTS`, `X-Frame-Options`) Globally and on `/auth/github/callback` (Contradicting Mission 001.6 Report)
- **Verdict:** `NEW FINDING` (Independently Reproduced; degrades `AUD-010` to `PARTIALLY FIXED`)
- **Affected Components:** `src/app-server.ts:209-217, 1130-1154`, `MISSION_001_6_REMEDIATION_REPORT.md`, `MISSION_001_6_SECURITY_TEST_MATRIX.md`
- **Root Cause:** Global header middleware sets only `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`. Neither the global middleware nor `renderOAuthCallbackHtml()` sets `Content-Security-Policy`, `Strict-Transport-Security`, or `X-Frame-Options` (or `frame-ancestors`). Mission 001.6 reports falsely claimed strict callback CSP enforcement.
- **Reproduction & Evidence (`ADV-020`):** HTTP response headers from `/auth/github/callback` returned `content-security-policy: null`, `strict-transport-security: null`, and `x-frame-options: null`.

### `NEW-008` — MEDIUM — Production Dependency Misclassification, Node 22 Start Script Crash, and CI Migration/Audit Gaps
- **Verdict:** `NEW FINDING` (Independently Reproduced; degrades `AUD-006` and `AUD-015` to `PARTIALLY FIXED`)
- **Affected Components:** `package.json:7, 20-44`, `src/lib/firebase-admin.ts:3`, `.github/workflows/ci.yml:27, 87`
- **Root Cause:**
  1. `package.json` defines `"start": "node server.ts"`, but `src/lib/firebase-admin.ts:3` uses `import firebaseConfig from '../../firebase-applet-config.json';` without `with { type: 'json' }`. Running on Node `v22.23.5` crashes immediately (`ERR_IMPORT_ATTRIBUTE_MISSING`).
  2. `drizzle-kit` (pulling vulnerable `esbuild@0.18.20` GHSA-67mh-4wv8-2f99), `@playwright/test`, `@electric-sql/pglite`, `@types/pg`, `vite`, `@vitejs/plugin-react`, and `@tailwindcss/vite` are all declared in `dependencies` instead of `devDependencies`.
  3. `.github/workflows/ci.yml` runs `npm install --no-audit` (no vulnerability gate) and runs `npx drizzle-kit push --force` instead of `drizzle-kit migrate` (never testing the versioned SQL migration files in CI).

### `NEW-009` — MEDIUM — Operational Security Gaps: Incomplete Production Startup Assertions, OAuth Key Rotation `503` Outage, & User Provisioning Race
- **Verdict:** `NEW FINDING` (Key rotation outage independently reproduced)
- **Affected Components:** `src/lib/env.ts:91-105`, `src/db/queries.ts:236-271, 2971-2988`, `src/lib/oauth-crypto.ts:266-269`, `src/app-server.ts:891`
- **Root Cause:**
  1. `assertSafeProductionConfig()` checks only `ALLOW_DEV_AUTH_BYPASS` and `TRUST_PROXY_HOPS`; it does **not** fail fast at startup if `ALLOWED_ORIGINS`, `APP_URL`, `DATABASE_URL`, `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_COOKIE_SECRET`, `GITHUB_WEBHOOK_SECRET`, or `SLACK_SIGNING_SECRET` are missing or weak.
  2. **Reproduced (`ADV-006`):** Rotating `CONNECTOR_TOKEN_ENCRYPTION_KEY` causes `decryptSecret()` inside `getUserOAuthConnection()` (`src/db/queries.ts:2971-2988`) to throw inside the DB `try/catch`, which invokes `handlePersistenceFailure()` and turns `GET /api/connectors` into HTTP `503` instead of gracefully prompting re-authentication or supporting multi-key versioned decryption (`keyId` ring).
  3. `getOrCreateUser()` (`src/db/queries.ts:236-271`) performs a non-atomic `SELECT`-then-`INSERT` without `ON CONFLICT (uid) DO NOTHING`, creating a latent `23505` race under concurrent multi-connection PostgreSQL first logins.
  4. `renderOAuthCallbackHtml()` / `/auth/github/callback` consumes OAuth state atomically at `src/app-server.ts:891` **before** verifying cookie-to-state binding when a valid cookie from a different session is present (minor DoS vector against an in-flight OAuth flow if state is leaked).
  5. `SameSite=None; Secure; HttpOnly; Partitioned` (`src/lib/oauth-crypto.ts:266-269`) relies on CHIPS support for third-party iframe/popup contexts; browsers lacking CHIPS or blocking third-party cookies may drop the binding cookie.

### `NEW-010` — MEDIUM-LOW — Embedded PostgreSQL URI Passwords Unredacted in Logs & Unsafe `javascript:` Scheme Accepted in `sourceUrl`
- **Verdict:** `NEW FINDING` (Independently Reproduced; degrades `AUD-011` to `PARTIALLY FIXED`)
- **Affected Components:** `src/lib/logger.ts:48-49`, `src/lib/env.ts:470`
- **Root Cause & Evidence:**
  1. `ADV-019`: `sanitizeStringForLogs("Connection failed: postgresql://app_user:SuperSecretPgPass9988@db.internal:5432/hippocampus")` and `sanitizeAuditMetadata({ err: ... })` both returned the plaintext password unredacted (`dbPassLeakedInString: true`, `dbPassLeakedInMeta: true`).
  2. `ADV-018`: `IngestDocumentRequestSchema` (`src/lib/env.ts:470`) validates `sourceUrl` as `z.string().trim().max(500)` with no URL scheme allowlist (`http:`/`https:`). `POST /api/documents` with `sourceUrl: "javascript:alert(1)"` returned **HTTP `201`** and persisted the unsafe URI. (Frontend currently renders `sourceUrl` in text/sanitized contexts, preventing immediate stored XSS, but storing `javascript:` URIs creates a latent stored-XSS hazard for any future `<a href>` rendering.)

### `NEW-011` — LOW (Documentation / Consistency) — Report-vs-Code Discrepancies & Minor Client Bugs
- **Verdict:** `NEW FINDING`
- **Affected Components:** `docs/SECURITY_PRODUCTION_CONFIG.md`, `tsconfig.json`, `src/components/ErrorBoundary.tsx:35`, `src/components/OnboardingPanel.tsx:662`
- **Findings:**
  1. `docs/SECURITY_PRODUCTION_CONFIG.md` never states the single-organization deployment constraint (`AUD-005`) despite Mission 001.6 claiming it was documented there.
  2. `tsconfig.json` does not set `"strict": true` (only `"strictNullChecks": true`), contradicting Mission 001.6's claim of "TypeScript strict typecheck".
  3. `src/components/ErrorBoundary.tsx:35` `POST`s client crashes to `/api/telemetry/client-error` without an `Authorization` header (always failing `401` in production), and `/api/telemetry/client-error` lacks a dedicated rate limiter.
  4. `src/components/OnboardingPanel.tsx:662` still contains UI text referencing the removed client-side role switcher.

---

## 9. Authentication and RBAC Review

### Authentication Controls
- **Firebase ID Token Verification (`src/middleware/auth.ts:186-260`):** Calls `adminAuth.verifyIdToken(token, true)` (revocation checks enabled). Rejects missing/malformed headers and tokens shorter than 10 characters or containing control chars (`401`). Fails closed (`401`/`503`) on Firebase Admin errors.
- **Dev Bypass Removal in Production (`src/lib/env.ts:91-105`, `src/middleware/auth.ts`):** `ALLOW_DEV_AUTH_BYPASS=true` is rejected at startup in production. Unauthenticated requests with forged headers (`X-User-Role`, `X-Role`, `X-Demo-Role`, `X-User-Uid`, `X-Forwarded-User`, `X-Auth-User`) all returned `401` (`ADV-013`).
- **Admin Bootstrap (`src/app-server.ts:469-498`):** Requires `email_verified === true` and zero existing users; verified one-time only.
- **Role Authority:** Database `users.role` is queried on every authenticated request (`resolveAuthenticatedUser`); client-supplied role claims and forged headers are ignored (`ADV-013`: Engineer with forged Admin headers received `403` on `/api/auth/users`, `/api/audit-logs`, and self-role escalation `PATCH /api/auth/role`).

### Route Authorization Matrix & Gaps
All 31 routes in `src/app-server.ts` were mapped and audited:
- **Strong Controls Verified:** `/api/auth/users`, `/api/auth/role`, `/api/audit-logs`, `/api/settings`, `/api/ratelimit/reset`, `/api/cache/telemetry`, `/api/documents` (`GET`/`POST`/`DELETE`), `/api/onboarding/progress` (`PATCH`).
- **Confirmed Authorization Defects:**
  1. `POST /api/connectors/gdrive/import` & `POST /api/connectors/github/sync` (`NEW-001`): Data-plane `upsertConnectorDocument()` fails to verify the caller's role against an existing document's `accessLevel` on `sourceUrl` match.
  2. `GET /api/logs` (`NEW-002`): Missing `userUid` ownership enforcement and miscomputed `requiredRole` leak both peer Engineer and privileged Admin/Manager queries/answers to Engineers.
  3. `POST /api/connectors/github/sync` (`NEW-004`): Missing `GITHUB_ALLOWED_REPOS` check and shared server PAT fallback allow unauthorized private repo ingestion.
  4. `POST /api/tools/execute` (`NEW-003`): Grants `Engineer` access to all tools including `pingOnCallEngineer` without per-tool authorization.

---

## 10. OAuth Review

- **State Generation & Persistence (`src/lib/oauth-crypto.ts`, `src/db/queries.ts`):** 256-bit CSPRNG state persisted in PostgreSQL `oauth_states` with 10-minute expiration, `user_uid` binding, and single-use atomic `DELETE ... RETURNING` consumption (`consumeOAuthStateAtomic`).
- **Browser Binding:** HMAC-SHA256 signed `HttpOnly; Secure; SameSite=None; Partitioned` cookie binds the initiating browser session to the OAuth state (`ADV-005`: callback without binding cookie rejected `403`).
- **Token Storage:** Per-user GitHub OAuth access tokens encrypted at rest via AES-256-GCM (`CONNECTOR_TOKEN_ENCRYPTION_KEY`) in `user_oauth_connections`, scoped by `user_uid` (`ADV-006`: cross-user disconnect isolated).
- **External Exchange Timeout:** `AbortSignal.timeout(10_000)` verified (`ADV-005`: timeout returns `502`).
- **Callback Escaping & Frontend Receiver:** `serializeJsonForScript()` safely escapes `</script>`, `<`, `>`, `&`, `U+2028`, `U+2029`. `ConnectorsPanel.tsx` validates `event.origin` and `event.source === popupRef.current`.
- **Residual Gaps Identified:**
  - Missing `Content-Security-Policy` header on `/auth/github/callback` (`NEW-007`).
  - Key rotation of `CONNECTOR_TOKEN_ENCRYPTION_KEY` triggers HTTP `503` on `GET /api/connectors` (`NEW-009`).
  - PKCE (`code_challenge`/`code_verifier`) is **not** implemented for GitHub OAuth (documented residual defense-in-depth risk; acceptable only because client secret exchange happens server-side over HTTPS, though PKCE is recommended).
  - State consumed before cookie-binding verification if an attacker supplies a different valid session's cookie (`NEW-009`).

---

## 11. Webhook Review

- **GitHub Webhook (`POST /api/webhooks/github`):**
  - Raw `Buffer` captured via Express `verify` hook (`req.rawBody`).
  - HMAC-SHA256 verified with `crypto.timingSafeEqual` on equal-length digests; missing `GITHUB_WEBHOOK_SECRET` fails closed (`503`).
  - `X-GitHub-Delivery` header required and regex-validated (`^[A-Za-z0-9._:-]{8,128}$`).
  - Concurrency-safe deduplication via PostgreSQL `PRIMARY KEY` insert-first on `processed_webhook_deliveries` (`ADV-007`: 3 concurrent identical deliveries -> 1 processed, 2 ignored).
  - Rate limiting (60/min) verified under `TRUST_PROXY_HOPS=0`: spoofed `X-Forwarded-For` did not bypass limit; request #61 returned `429` (`ADV-008`).
  - `X-Webhook-Simulator` header cannot bypass production HMAC; `/api/webhooks/github/simulate` returns `404` in production (`ADV-022`).
- **Slack Events Webhook (`POST /api/slack/events`):**
  - Raw `Buffer` HMAC-SHA256 (`v0:<ts>:<rawBody>`) with `timingSafeEqual`; missing `SLACK_SIGNING_SECRET` fails closed (`503`).
  - Timestamp validated against strict `^\d{10}$` regex and `±300s` replay window (`ADV-009`: short/long/non-numeric/expired/future timestamps all returned `401`).
  - Strict Zod validation of Slack Events envelope.
  - Concurrency-safe `event_id` deduplication via PostgreSQL `PRIMARY KEY` on `processed_slack_events` (`ADV-009`: 3 concurrent identical events -> 1 accepted, 2 suppressed).
  - `/api/slack/events/simulate` returns `404` in production (`ADV-022`).

---

## 12. PostgreSQL and Migration Review

- **Schema & Drizzle Alignment:** `npx drizzle-kit check --config=src/db/drizzle.config.ts` exited `0` (`Everything's fine`).
- **TLS & Connection Hardening (`src/db/index.ts`):** Production removes hardcoded/default credentials and enforces TLS with `rejectUnauthorized: true`.
- **Synthetic Migration Testing (`ADV-021`, PGlite PG16):** Verified migrations `0000` and `0001` across 5 states:
  1. Empty fresh database -> **PASS**.
  2. Populated pre-migration database -> **PASS** (existing rows preserved).
  3. Duplicate legacy `user_progress` rows -> **PASS** (deduplicated cleanly before partial unique index creation).
  4. Legacy `cache_version=1` `semantic_cache` rows -> **PASS** (quarantined and excluded from v2 lookups).
  5. Partially migrated + idempotent re-run -> **PASS**.
- **Identified PostgreSQL & Migration Defects:**
  1. **Audit-log `TRUNCATE` bypass (`NEW-005`):** Migration `0001` does not create a `BEFORE TRUNCATE FOR EACH STATEMENT` trigger, and `REVOKE` only affects hardcoded `app_user`.
  2. **Non-transactional document writes (`NEW-006`):** `ingestDocument()` and `upsertConnectorDocument()` do not wrap document + chunk + cache operations in `db.transaction()`.
  3. **CI skips SQL migrations (`NEW-008`):** `.github/workflows/ci.yml:87` executes `npx drizzle-kit push --force` instead of running versioned SQL migrations via `drizzle-kit migrate`.
  4. **Check-then-insert user race (`NEW-009`):** `getOrCreateUser()` lacks `ON CONFLICT (uid) DO NOTHING`.
  5. **Production DB & Rollback:** No access to real staging/prod PostgreSQL, Cloud SQL IAM roles, backups, or PITR (`BLOCKED BY INFRASTRUCTURE`).

---

## 13. RAG and Document Security Review

- **Retrieval-Plane RBAC (`ADV-016`):** Across all three retrieval modes (`hybrid_rrf`, `dense_vector`, `sparse_bm25`), `searchKnowledgeChunks()` enforced `inArray(documents.accessLevel, allowedTiers)` inside SQL. Zero `Admin` or `Manager` chunks leaked into `Engineer` retrieval results.
- **Direct Document CRUD (`ADV-014b`):** `GET /api/documents` hides `Admin` documents from `Engineer`; `POST /api/documents` with `accessLevel: 'Admin'` by `Engineer` returned `403`; `DELETE /api/documents/:id` of an `Admin` document by `Engineer` returned `403`.
- **Critical Gaps Found:**
  1. **Connector `sourceUrl` Overwrite/Downgrade (`NEW-001` — HIGH):** `upsertConnectorDocument()` allows a `Manager` to overwrite and downgrade an `Admin` document in place.
  2. **Query Log Disclosure (`NEW-002` — HIGH):** `GET /api/logs` leaks both cross-Engineer and `Admin -> Engineer` raw prompts and answers.
  3. **Unsafe `sourceUrl` Scheme (`NEW-010` — MEDIUM-LOW):** `POST /api/documents` accepts `javascript:alert(1)` (HTTP `201`).
  4. **Prompt Injection Framing (`NEW-003` — HIGH):** Raw document chunks are injected directly into the LLM prompt without untrusted-content delimiters or instruction hierarchy.

---

## 14. Agent and Tool Security Review

- **Architecture (`src/lib/ai.ts:178-264, 706-733`, `src/app-server.ts:2070-2090`):**
  - Gemini function calling is invoked during `synthesizeRagAnswer()` with tool declarations (`pingOnCallEngineer`, `queryServiceHealth`, `inspectGithubPullRequest`, `searchIncidentHistory`).
  - **Defects (`NEW-003` — HIGH):**
    1. LLM-triggered tool calls execute automatically with **zero per-tool RBAC**, **zero Zod argument validation**, **zero rate/count cap**, and **zero human-in-the-loop confirmation** for side-effecting operations.
    2. Direct endpoint `POST /api/tools/execute` grants any `Engineer` permission to invoke `pingOnCallEngineer`.
    3. Schema mismatch: `ExecuteToolRequestSchema` (`src/lib/env.ts:529`) expects `fetchGithubPullRequest`, while `executeEnterpriseTool()` (`src/lib/ai.ts:202`) expects `inspectGithubPullRequest`, causing `POST /api/tools/execute` with `fetchGithubPullRequest` to return `{"error":"Unknown tool: fetchGithubPullRequest"}` (`ADV-017`).

---

## 15. Frontend Security Review

- **XSS & DOM Sinks:** Global scan across `src/` found zero uses of `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `eval`, or `new Function`. React's default JSX escaping is used consistently.
- **Storage & Token Handling:** Firebase Auth SDK manages session tokens; no custom secret or OAuth token is stored in `localStorage`/`sessionStorage`.
- **Production Bundle Inspection (`dist/assets/index-CYlh_siE.js`):** Zero source maps (`maps: []`); zero server-side secrets (`GITHUB_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`, `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `GEMINI_API_KEY`, private keys) appear in client assets. Only standard public Firebase web config is bundled.
- **`postMessage` Receiver (`src/components/ConnectorsPanel.tsx`):** Properly checks `event.origin` against expected backend/app origin and validates `event.source === popupRef.current` and message payload schema.
- **Frontend Gaps:**
  - Global response headers lack `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options` (`NEW-007`).
  - `ErrorBoundary.tsx:35` calls authenticated `/api/telemetry/client-error` without an `Authorization` header (`NEW-011`).
  - `OnboardingPanel.tsx:662` still contains copy referencing the removed client-side role switcher (`NEW-011`).

---

## 16. Infrastructure and Deployment Review

| Area | Code-Level Inspection | Live Infrastructure Verification |
|---|---|---|
| Production Start Command | **FAIL (`NEW-008`):** `package.json` `"start": "node server.ts"` crashes on Node `v22.23.5` at `src/lib/firebase-admin.ts:3` (`ERR_IMPORT_ATTRIBUTE_MISSING`). | `BLOCKED BY INFRASTRUCTURE` |
| Production Dependencies | **FAIL (`NEW-008`):** `drizzle-kit` (vulnerable `esbuild@0.18.20`), `@playwright/test`, `@electric-sql/pglite`, `vite` are in `dependencies`. | `BLOCKED BY INFRASTRUCTURE` |
| Startup Config Validation | **PARTIAL (`NEW-009`):** `assertSafeProductionConfig()` does not fail fast on missing `ALLOWED_ORIGINS`, `APP_URL`, `DATABASE_URL`, webhook secrets, or encryption keys. | `BLOCKED BY INFRASTRUCTURE` |
| CI/CD Pipeline (`.github/workflows/ci.yml`) | **FAIL (`NEW-008`):** Uses `npm install --no-audit` (no vulnerability gate) and `drizzle-kit push --force` (skips SQL migrations). | `BLOCKED BY INFRASTRUCTURE` |
| Security Headers / TLS / HSTS | **FAIL (`NEW-007`):** No `CSP`, `HSTS`, or `X-Frame-Options` emitted by Express. | `BLOCKED BY INFRASTRUCTURE` |
| Cloud SQL / Firebase IAM / Vercel / Secret Manager / Backups / Rollback | No deployment manifests (`vercel.json`, `Dockerfile`, Terraform, Cloud Run YAML) present in workspace; live environments inaccessible. | `BLOCKED BY INFRASTRUCTURE` |

---

## 17. Test Quality Assessment

### Inspection of Existing Suites (`tests/security.test.ts` — 1,652 lines; `tests/postgres-integration.test.ts` — 673 lines; `e2e/hippocampus.spec.ts` — 101 lines)
- **Strengths:**
  - `tests/postgres-integration.test.ts` uses real PostgreSQL 16 (PGlite) with migrations `0000`+`0001`, testing real SQL constraints, unique indexes, concurrent webhook/Slack replays, L2 semantic cache SQL filtering, role demotion, and `UPDATE`/`DELETE` trigger enforcement.
  - `tests/security.test.ts` exercises real Express middleware (`createAuthLayer`, `createApp`) with negative assertions verifying absence of sensitive fields.
- **Material Coverage Blind Spots & Weaknesses:**
  1. **No Connector Cross-Tier Overwrite Test (`NEW-001`):** Zero tests verify that `Manager` cannot overwrite an existing `Admin` doc via matching `sourceUrl`.
  2. **No `GET /api/logs` Cross-User / Admin->Engineer Privacy Test (`NEW-002`):** Existing tests only checked telemetry/cache leakage, never `GET /api/logs` when an Admin query retrieves Engineer-tier chunks or between two Engineers.
  3. **No Prompt Injection or Tool RBAC Tests (`NEW-003`):** Zero tests validate untrusted chunk handling, LLM function-call RBAC, or `POST /api/tools/execute` schema alignment (`fetchGithubPullRequest` bug went completely undetected).
  4. **No `GITHUB_ALLOWED_REPOS` Enforcement Test on Manual Sync (`NEW-004`):** Only webhook sync tested repo allowlists.
  5. **Audit-Log Test Omitted `TRUNCATE` (`NEW-005`):** Tested `UPDATE` and `DELETE` only, missing `TRUNCATE TABLE`.
  6. **DB Outage Test Omitted `POST /api/ratelimit/reset` (`NEW-006`):** Missed the uncaught Express 4 async rejection.
  7. **Callback Header Test Never Asserted `Content-Security-Policy` (`NEW-007`):** Despite the report claiming strict CSP was tested and enforced, no assertion checked `res.headers.get('content-security-policy')`.
  8. **Log Sanitizer Test Omitted PostgreSQL Connection Strings (`NEW-010`).**
  9. **Playwright E2E (`e2e/hippocampus.spec.ts`):** Runs solely against dev server with dev auth bypass; provides **zero** production authentication, CORS, or RBAC E2E assurance.
  10. **No Production Boot Test (`NEW-008`):** Neither tests nor CI execute `node server.ts`, leaving the Node 22 JSON import attribute startup crash undetected.

### Finding-to-Test Traceability Summary
- **Covered & Verified by Existing Tests:** `AUD-001`, `AUD-002`, `AUD-004` (core), `AUD-007`, `AUD-008`, `AUD-009`, `AUD-012`, `AUD-013`.
- **Partially Covered (Critical Branches Missed):** `AUD-003` (`ratelimit/reset`), `AUD-006` (`drizzle-kit migrate` in CI), `AUD-010` (`CSP` header), `AUD-011` (PG URI passwords), `AUD-014` (`TRUNCATE`), `AUD-015` (prod dependency classification).
- **Completely Uncovered by Existing Tests:** `NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`, `NEW-008` (Node 22 boot), `NEW-009` (key rotation 503).

---

## 18. Risk Register

| Risk ID | Severity | Likelihood | Impact | Status | Owner |
|---|---|---|---|---|---|
| `NEW-001` | **HIGH** | High | Admin document overwrite & RBAC downgrade via `sourceUrl` collision | Open (Reproduced) | Backend / DB |
| `NEW-002` | **HIGH** | High | Cross-Engineer & Admin->Engineer raw prompt/answer disclosure in `/api/logs` | Open (Reproduced) | Backend / DB |
| `NEW-003` | **HIGH** | Medium-High | Indirect prompt injection -> unconstrained tool invocation + schema mismatch | Open (Verified) | AI / Backend |
| `NEW-004` | **HIGH** | High | `GITHUB_ALLOWED_REPOS` bypass + shared server PAT abuse on manual GitHub sync | Open (Reproduced) | Backend / Connectors |
| `NEW-005` | **MEDIUM** | Medium | Audit log table erasure via `TRUNCATE TABLE` + hardcoded `app_user` revoke | Open (Reproduced) | Database / Security |
| `NEW-006` | **MEDIUM** | Medium | Process crash/hang via uncaught rejection in `/api/ratelimit/reset` + non-transactional writes | Open (Reproduced) | Backend / Reliability |
| `NEW-007` | **MEDIUM** | High | Missing `CSP`, `HSTS`, `X-Frame-Options` headers (false report claim) | Open (Reproduced) | Backend / Security |
| `NEW-008` | **MEDIUM** | High | Node 22 `"start"` crash + dev/vulnerable pkgs in `dependencies` + CI gaps | Open (Reproduced) | DevOps / Platform |
| `NEW-009` | **MEDIUM** | Medium | Key rotation `503` outage, incomplete prod startup assertions, user creation race | Open (Reproduced) | Backend / Platform |
| `NEW-010` | **MEDIUM-LOW** | Medium | PG URI password unredacted in logs + `javascript:` accepted in `sourceUrl` | Open (Reproduced) | Backend / Security |
| `NEW-011` | **LOW** | Low | Documentation/report discrepancies, unauthenticated `ErrorBoundary` telemetry | Open (Verified) | Docs / Frontend |
| `AUD-005` | **HIGH (SaaS)** | N/A (Single-Org) | Multi-tenant isolation absent (explicitly deferred to Mission 002) | Deferred (NO-GO SaaS) | Architecture (M002) |
| `INFRA-001` | **HIGH (Release)** | Unknown | Live staging/production DB, IAM, TLS, secrets, backups, rollback unverified | `BLOCKED BY INFRASTRUCTURE` | SRE / Platform |

---

## 19. Production Readiness Assessment

Code acceptance and infrastructure acceptance are strictly separated:

- **Code Acceptance (Single-Organization Baseline):** **FAIL (`REQUIRE REMEDIATION`).** Four independently reproduced HIGH vulnerabilities (`NEW-001`–`NEW-004`), a Node 22 production startup crash (`NEW-008`), an Express 4 unhandled-rejection DoS/crash path (`NEW-006`), an audit-log `TRUNCATE` bypass (`NEW-005`), missing security headers (`NEW-007`), and production dependency misclassification (`NEW-008`) block even staging acceptance.
- **Infrastructure & Operational Acceptance (Staging & Production):** **`BLOCKED BY INFRASTRUCTURE`.** Cloud SQL provisioning/IAM, migration execution against production-like data, backup/PITR/rollback rehearsal, Secret Manager injection, TLS/HSTS edge termination, WAF/rate-limit alignment, and monitoring/alerting have not been verified in any live environment.
- **Multi-Tenant SaaS Readiness:** **NO-GO** (out of scope until Mission 002).

---

## 20. Final Verdict

**Overall Independent Audit Verdict: `C. REQUIRE REMEDIATION`**

Under Mission 001.7 acceptance rules, **Option A (Accepted)** and **Option B (Conditional Acceptance — Staging Only)** are disqualified because:
1. Four newly discovered **HIGH** security vulnerabilities (`NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`) were independently reproduced or verified.
2. Five previously claimed Mission 001.6 remediations (`AUD-003`, `AUD-006`, `AUD-010`, `AUD-011`, `AUD-014`, plus `AUD-015`) remain **PARTIALLY FIXED** with reproducible failures and report-vs-code discrepancies.
3. The application's declared production startup script (`"start": "node server.ts"`) crashes on Node `v22.23.5`.
4. All live staging and production infrastructure checks remain **`BLOCKED BY INFRASTRUCTURE`**.

---

## 21. Remediation Recommendations

Execute remediation in strict priority order (detailed specifications in `MISSION_001_7_REMEDIATION_BACKLOG.md`; do not start Mission 002 until remediated and re-audited):

1. **Priority 0 (Immediate Release Blockers):**
   - **`NEW-001`:** Enforce caller-role vs existing-document `accessLevel` authorization inside `upsertConnectorDocument()` (and reject downgrade/overwrite with `403`).
   - **`NEW-002`:** Add `user_uid` to `query_logs`, enforce per-user ownership scoping for non-Admin callers (or strict `user_uid = caller.uid` for Engineers), and compute `requiredRole = max(actor.role, highestChunkTier)`.
   - **`NEW-003`:** Implement untrusted-data framing in `SYSTEM_PROMPT`/context wrapper, add per-tool RBAC + Zod argument validation + invocation cap + confirmation gate for side-effecting tools, and reconcile `fetchGithubPullRequest` / `inspectGithubPullRequest`.
   - **`NEW-004`:** Enforce `GITHUB_ALLOWED_REPOS` on `POST /api/connectors/github/sync`, prohibit Manager fallback to shared `GITHUB_TOKEN` (require user OAuth token or explicit Admin-approved allowlisted repo), and validate `node.path` against traversal before attaching auth headers.
   - **`NEW-008` (Startup & Supply Chain):** Fix Node 22 JSON import attribute (`with { type: 'json' }` or `fs.readFileSync`) so `node server.ts` boots cleanly; move `drizzle-kit`, `@playwright/test`, `@electric-sql/pglite`, `@types/pg`, `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` to `devDependencies`; add `drizzle-kit migrate` and dependency audit gates to CI.
2. **Priority 1 (Pre-Staging Hardening):**
   - **`NEW-005`:** Add `BEFORE TRUNCATE ON security_audit_logs FOR EACH STATEMENT` trigger in migration `0002` and document least-privilege DB role setup (no `SUPERUSER`/table-owner runtime role).
   - **`NEW-006`:** Wrap `POST /api/ratelimit/reset` (and all async Express 4 routes) in `try/catch` / centralized async error wrapper, and wrap multi-step document/chunk writes in `db.transaction()`.
   - **`NEW-007`:** Emit strict `Content-Security-Policy` (globally and on `/auth/github/callback`), `Strict-Transport-Security` (in production), and `X-Frame-Options: DENY` / `frame-ancestors 'none'`.
3. **Priority 2 (Operational Hardening & Hygiene):**
   - **`NEW-009`:** Expand `assertSafeProductionConfig()` to fail fast on all mandatory production env vars; add versioned encryption key ring / graceful decrypt-failure handling (re-auth prompt instead of `503`); make `getOrCreateUser()` atomic via `ON CONFLICT (uid) DO NOTHING`; check binding cookie before consuming OAuth state.
   - **`NEW-010`:** Add PostgreSQL/URL credential redaction regex (`(postgres(?:ql)?|https?|redis):\/\/[^:\s/@]+:[^@\s/]+@`) in `src/lib/logger.ts`; restrict `sourceUrl` to `http:`/`https:` schemes in `IngestDocumentRequestSchema`.
   - **`NEW-011`:** Document the single-org constraint (`AUD-005`) in `docs/SECURITY_PRODUCTION_CONFIG.md`; enable `"strict": true` in `tsconfig.json`; attach Firebase Bearer token (or make intentional anonymous rate-limited error beacon) in `ErrorBoundary.tsx`; clean up stale role-switcher text in `OnboardingPanel.tsx`.

---

## 22. Evidence Appendix

All evidence below was collected independently during Mission 001.7 without modifying any repository file:

- **EVID-01 (Baseline Suites):** `npm run test:security` -> `52 passed, 0 failed` (38.05s); `npx playwright test` -> `4 passed, 0 failed` (11.0s); `npx drizzle-kit check` -> `Everything's fine`; `npx tsc --noEmit` -> exit `0`; `npm run build` -> `dist/assets/index-CYlh_siE.js` (1,031.54 kB, `maps: []`, zero server secrets).
- **EVID-02 (Dependency Audit & Manifest):** `bun audit` -> `1 moderate` (`esbuild@0.18.20` GHSA-67mh-4wv8-2f99 via `drizzle-kit`); `package.json:20-44` confirms `drizzle-kit`, `@playwright/test`, `@electric-sql/pglite`, `vite` reside in `dependencies`.
- **EVID-03 (Node 22 Startup Failure):** `node -e "import('./src/app-server.ts')"` under Node `v22.23.5` -> `ERR_IMPORT_ATTRIBUTE_MISSING` at `src/lib/firebase-admin.ts:3`.
- **EVID-04 (`NEW-001` Reproduction):** `ADV-014` on PGlite PG16: Admin doc `id=9` (`accessLevel: 'Admin'`, `engVisibleBefore: false`) overwritten by Manager `POST /api/connectors/gdrive/import` (`HTTP 200`) -> `engVisibleAfter: true`, `newAccessLevel: 'Engineer'`.
- **EVID-05 (`NEW-002` Reproduction):** `ADV-015` on PGlite PG16: Admin `POST /api/chat` (`HTTP 200`, chunks `["Engineer","Engineer","Engineer","Engineer"]`) + Eng1 `POST /api/chat` (`HTTP 200`) -> Eng2 `GET /api/logs` (`HTTP 200`) returned `eng2SeesAdminPrompt: true` (`userHandle: "@admin"`, `requiredRole: "Engineer"`) and `eng2SeesEng1Prompt: true` (`userHandle: "@eng1"`).
- **EVID-06 (`NEW-004` & `NEW-010` Reproduction):** `ADV-018`: With `GITHUB_ALLOWED_REPOS=org/strictly-approved-only`, Manager `POST /api/connectors/github/sync` for `private-org/unapproved-secret-repo` -> `HTTP 200`; `POST /api/documents` with `sourceUrl: "javascript:alert(1)"` -> `HTTP 201`.
- **EVID-07 (`NEW-005` Reproduction):** `ADV-012` on PGlite PG16: `UPDATE` -> `42501`, `DELETE` -> `42501`, `TRUNCATE TABLE security_audit_logs` -> succeeded (`rows 16 -> 0`).
- **EVID-08 (`NEW-006` Reproduction):** `ADV-003`: Under `ECONNREFUSED` in prod mode, `POST /api/chat`=`503`, `GET /api/documents`=`503`, `GET /api/overview`=`503`, `POST /api/ratelimit/reset` -> hung (`AbortError`) + `unhandledRejection: PersistenceError`.
- **EVID-09 (`NEW-007` Reproduction):** `ADV-020`: `/auth/github/callback` headers -> `CSP=null`, `HSTS=null`, `XFO=null`.
- **EVID-10 (`NEW-009` Key Rotation Reproduction):** `ADV-006`: After rotating `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `GET /api/connectors` returned `HTTP 503`.
- **EVID-11 (`NEW-010` Log Redaction Reproduction):** `ADV-019`: `sanitizeStringForLogs` & `sanitizeAuditMetadata` left PostgreSQL URI password plaintext (`dbPassLeakedInString: true`, `dbPassLeakedInMeta: true`).
- **EVID-12 (Passed Controls Evidence):** `ADV-001` (cache isolation), `ADV-002` (telemetry scoping), `ADV-004`/`005` (OAuth binding/replay/timeout), `ADV-007`/`008` (GitHub HMAC/concurrency/rate-limit), `ADV-009` (Slack timestamp/replay), `ADV-010` (CORS `403` on spoofed origins), `ADV-011` (onboarding UID isolation), `ADV-013` (forged headers `401`/`403`), `ADV-014b` (direct doc IDOR `403`), `ADV-016` (RAG SQL RBAC across all 3 modes), `ADV-021` (5 synthetic PG16 migration states), `ADV-022` (dev simulator routes `404` in prod).
