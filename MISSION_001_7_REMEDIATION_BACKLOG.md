# HIPPOCAMPUS AI — MISSION 001.7
# PRIORITIZED SECURITY REMEDIATION BACKLOG

**Audit Status:** Read-Only Backlog Specification (DO NOT IMPLEMENT during Mission 001.7; DO NOT start Mission 002 prior to completion and re-audit.)  
**Priority Tiers:**
- **P0 — Immediate Release Blockers (HIGH vulnerabilities + Production Startup Crash):** `NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`, `NEW-008`
- **P1 — Pre-Staging Hardening (MEDIUM vulnerabilities / Partial AUD-* remediations):** `NEW-005` (`AUD-014`), `NEW-006` (`AUD-003`), `NEW-007` (`AUD-010`)
- **P2 — Operational Resilience, Defense-in-Depth & Documentation Alignment:** `NEW-009` (`AUD-004`/`AUD-007`), `NEW-010` (`AUD-011`), `NEW-011` (`AUD-005` docs / client hygiene)

---

## P0-1 — `NEW-001`: Prevent Unauthorized Higher-Tier Document Overwrite & RBAC Downgrade in `upsertConnectorDocument`

- **Finding ID:** `NEW-001`
- **Severity:** **HIGH**
- **Affected Components:** `src/db/queries.ts:2327-2358` (`upsertConnectorDocument`), `src/app-server.ts:1683-1772` (`POST /api/connectors/gdrive/import`, `POST /api/connectors/github/sync`, webhook ingestion path)
- **Root Cause:** `upsertConnectorDocument()` looks up existing documents solely by `sourceUrl` and updates `title`, `content`, `accessLevel`, and chunks in place without verifying that the calling actor's role is authorized to modify or overwrite the existing document's current `accessLevel`.
- **Reproduction Steps:**
  1. Provision an `Admin` and a `Manager` in PostgreSQL 16.
  2. As `Admin`, ingest a document with `accessLevel: "Admin"` and `sourceUrl: "https://drive.google.com/file/d/exec-board-memo/view"`.
  3. Confirm an `Engineer` cannot view the document via `GET /api/documents`.
  4. As `Manager`, call `POST /api/connectors/gdrive/import` targeting the exact same `sourceUrl` with `accessLevel: "Engineer"`.
  5. Observe HTTP `200`, in-place overwrite of the Admin document, and immediate visibility to `Engineer`.
- **Required Remediation:**
  1. Pass `actorRole: RbacRole` (or trusted system context for verified webhooks) into `upsertConnectorDocument()`.
  2. When an existing document matches `sourceUrl`, verify `getRoleRank(actorRole) >= getRoleRank(existing.accessLevel)`. If not, throw a typed `AuthorizationError` mapped to HTTP `403` and write a `security_audit_logs` denial event.
  3. Prevent non-Admin automated syncs/webhooks from silently downgrading an `Admin`-classified document's `accessLevel` unless explicitly authorized.
- **Security Acceptance Criteria:**
  - `Manager` attempting to overwrite or downgrade an `Admin` document via Drive import or GitHub sync receives HTTP `403`, zero DB rows are mutated, and an audit denial event is recorded.
  - Same-tier or higher-tier authorized updates continue to work cleanly.
- **Regression Tests:**
  - Add PostgreSQL integration test in `tests/postgres-integration.test.ts` reproducing `ADV-014a` across both `/api/connectors/gdrive/import` and `/api/connectors/github/sync`, asserting HTTP `403`, preserved `accessLevel === 'Admin'`, preserved content, and zero Engineer visibility.
- **Dependencies:** Pairs cleanly with `NEW-006` (wrap `upsertConnectorDocument` in `db.transaction()` with `SELECT ... FOR UPDATE`).
- **Deployment Implications:** Backward-compatible code change; no schema migration required.

---

## P0-2 — `NEW-002`: Enforce User Ownership & Actor-Role Classification on Query Logs (`GET /api/logs`)

- **Finding ID:** `NEW-002`
- **Severity:** **HIGH**
- **Affected Components:** `src/db/schema.ts` (`queryLogs`), `src/db/queries.ts:1828-1844` (`recordQueryLog`, `getRecentQueryLogs`), `src/app-server.ts:2203-2238, 2270-2283` (`POST /api/chat`, `GET /api/logs`), new SQL migration `drizzle/0002_*.sql`
- **Root Cause:** `query_logs` has no `user_uid` column and `getRecentQueryLogs(role)` filters only on `requiredRole` with zero user scoping; furthermore, `POST /api/chat` sets `requiredRole` strictly from `highestTier` of retrieved chunks rather than `max(actor.role, highestChunkTier)`.
- **Reproduction Steps:**
  1. Seed 5 `Engineer`-tier documents matching a shared keyword.
  2. As `Admin`, send `POST /api/chat` containing confidential text in `query` using `searchMode: "sparse_bm25"` (retrieving 4 `Engineer` chunks).
  3. As `Engineer 1`, send `POST /api/chat` with a private question.
  4. As `Engineer 2`, call `GET /api/logs`.
  5. Observe HTTP `200` returning both `@admin`'s confidential prompt/answer (`requiredRole: "Engineer"`) and `@eng1`'s private prompt/answer.
- **Required Remediation:**
  1. Add nullable `user_uid text` column + index on `query_logs` via migration `0002` (backfill existing legacy rows safely as `required_role = 'Admin'` or restrict legacy rows with `user_uid IS NULL` to `Admin` only).
  2. Store `req.authUser!.uid` in `query_logs.user_uid` on every chat/Slack query.
  3. Compute `requiredRole = maxRole(activeRole, highestChunkTier)` so an `Admin`'s prompt is always at least `'Admin'` and a `Manager`'s prompt is always at least `'Manager'`.
  4. Scope `getRecentQueryLogs({ uid, role })`: `Engineer` sees **only** rows where `user_uid = uid AND required_role = 'Engineer'`; `Manager` sees own rows (or explicitly documented policy: own rows only unless org audit review is enabled, never `Admin` rows); `Admin` sees org-wide logs within explicit audit policy.
- **Security Acceptance Criteria:**
  - `Engineer 2` never sees `Engineer 1`'s prompts/answers or any `Admin`/`Manager` prompt/answer regardless of retrieved chunk tier.
  - `Manager` never sees `Admin` prompts/answers even when Admin queried `Engineer`-tier docs.
  - Legacy pre-migration rows with `user_uid IS NULL` are not exposed to `Engineer` users.
- **Regression Tests:**
  - Add PostgreSQL integration test reproducing `ADV-015` (Admin->Engineer and Engineer1->Engineer2 isolation) plus legacy `user_uid IS NULL` row isolation.
- **Dependencies:** Requires migration `0002` and `drizzle-kit check` update.
- **Deployment Implications:** Zero-downtime additive column migration; verify staging UI `QueryLogsPanel.tsx` displays per-user history cleanly.

---

## P0-3 — `NEW-003`: Harden RAG Prompt Framing, Agent Tool RBAC/Validation & Fix Tool Schema Mismatch

- **Finding ID:** `NEW-003`
- **Severity:** **HIGH**
- **Affected Components:** `src/lib/ai.ts:27-33, 178-264, 677-733`, `src/app-server.ts:2070-2090`, `src/lib/env.ts:520-545`
- **Root Cause:** Retrieved document chunks are concatenated unframed into the LLM user prompt with no instruction hierarchy; LLM-returned `functionCalls` execute automatically with no per-tool RBAC, no Zod argument validation, no per-turn execution cap, and no confirmation gate for side-effecting tools; `ExecuteToolRequestSchema` declares `fetchGithubPullRequest` while `executeEnterpriseTool()` implements `inspectGithubPullRequest`.
- **Reproduction Steps:**
  1. Inspect `src/lib/ai.ts:27-33, 677-733`: raw chunk text injected into prompt; all `response.functionCalls` automatically invoke `executeEnterpriseTool(call.name, call.args)` without passing `activeRole` or validating `args`.
  2. As `Engineer`, call `POST /api/tools/execute` with `toolName: "pingOnCallEngineer"` -> HTTP `200`.
  3. Call `POST /api/tools/execute` with `toolName: "fetchGithubPullRequest"` -> `{"error":"Unknown tool: fetchGithubPullRequest"}`.
- **Required Remediation:**
  1. Add strict untrusted-data framing in `SYSTEM_PROMPT` and wrap retrieved document chunks in explicit data delimiters (`<untrusted_knowledge_chunk ...>...</untrusted_knowledge_chunk>`), explicitly instructing the model never to follow instructions or trigger side-effecting tools solely from retrieved document content.
  2. Define a declarative Tool Policy Registry mapping every tool to: (a) required RBAC permission/role (e.g., restrict `pingOnCallEngineer` to `Manager`/`Admin` or require explicit user confirmation), (b) strict Zod argument schema, (c) `sideEffecting: boolean` flag (never auto-execute side-effecting tools from LLM output without explicit user confirmation), and (d) max tool calls per turn (e.g., `<= 2`).
  3. Reconcile `fetchGithubPullRequest` vs `inspectGithubPullRequest` across `src/lib/env.ts`, `src/lib/ai.ts`, and frontend components.
  4. Record security audit events for every tool invocation (including denied attempts) with actor `uid` and validated tool name.
- **Security Acceptance Criteria:**
  - Poisoned document chunks containing prompt-injection instructions cannot trigger side-effecting tools or tools outside the caller's RBAC tier.
  - Malformed tool arguments returned by LLM or HTTP caller are rejected by Zod before tool execution.
  - Every tool in `ExecuteToolRequestSchema` maps 1:1 to a registered executor with matching name and schema.
- **Regression Tests:**
  - Add unit + integration tests covering: Engineer denied side-effecting tool (`403`), LLM returning unauthorized or malformed tool call rejected safely, tool-call count cap enforced, and every schema-declared tool resolving cleanly.
- **Dependencies:** None.
- **Deployment Implications:** Verify UI tool-execution panel handles confirmation/permission errors gracefully.

---

## P0-4 — `NEW-004`: Enforce `GITHUB_ALLOWED_REPOS` Allowlist & Eliminate Unauthorized Shared PAT Exposure in Manual GitHub Sync

- **Finding ID:** `NEW-004`
- **Severity:** **HIGH**
- **Affected Components:** `src/app-server.ts:1166-1220` (`POST /api/connectors/github/sync`), `src/lib/connectors.ts:153-158` (`fetchGithubRepositoryDocs`), `src/lib/env.ts` (`isAllowedGithubRepo`)
- **Root Cause:** `POST /api/connectors/github/sync` does not check `GITHUB_ALLOWED_REPOS` and falls back to the shared server `GITHUB_TOKEN` PAT when the authenticated user has no personal GitHub OAuth token. `fetchGithubRepositoryDocs()` also interpolates `node.path` directly into `raw.githubusercontent.com` URLs with a Bearer header without path-traversal validation or redirect protection.
- **Reproduction Steps:**
  1. Set `GITHUB_ALLOWED_REPOS="org/strictly-approved-only"`.
  2. As an authenticated `Manager` without a personal GitHub OAuth connection, send `POST /api/connectors/github/sync` for `owner: "private-org"`, `repo: "unapproved-secret-repo"`.
  3. Observe HTTP `200` and sync execution for the unapproved repository.
- **Required Remediation:**
  1. Enforce `GITHUB_ALLOWED_REPOS` on `POST /api/connectors/github/sync` (fail closed in production when `GITHUB_ALLOWED_REPOS` is empty or does not match `owner/repo`, returning HTTP `403` and logging an audit event).
  2. Never allow non-Admin callers to fall back to the shared server `GITHUB_TOKEN` PAT; require the caller's own encrypted GitHub OAuth connection (and even for `Admin`, enforce `GITHUB_ALLOWED_REPOS`).
  3. In `fetchGithubRepositoryDocs()`, validate `owner`, `repo`, `branch`, and `node.path` strictly (reject `..`, leading `/`, backslashes, URL-encoded traversal, or control chars), encode path segments cleanly, and set `redirect: 'error'` when sending `Authorization` headers to prevent cross-host token leakage.
- **Security Acceptance Criteria:**
  - Syncing any repository not in `GITHUB_ALLOWED_REPOS` returns HTTP `403`.
  - `Manager` without a personal GitHub OAuth connection cannot consume `process.env.GITHUB_TOKEN` (returns HTTP `403` / `400` prompting OAuth connection).
  - Malicious tree `node.path` values containing `../` are skipped/rejected before outbound fetch.
- **Regression Tests:**
  - Add tests reproducing `ADV-018` (unapproved repo -> `403`, Manager shared-PAT fallback blocked, path traversal in GitHub tree response rejected).
- **Dependencies:** None.
- **Deployment Implications:** Production operators must populate `GITHUB_ALLOWED_REPOS` in environment configuration (`docs/SECURITY_PRODUCTION_CONFIG.md`).

---

## P0-5 — `NEW-008`: Fix Node 22 Production Startup Crash, Reclassify `dependencies`, and Harden CI Gates (`AUD-006` / `AUD-015`)

- **Finding ID:** `NEW-008` (also resolves residual gaps in `AUD-006` and `AUD-015`)
- **Severity:** **MEDIUM** (Release-blocking operational + supply-chain defect)
- **Affected Components:** `src/lib/firebase-admin.ts:3`, `package.json:7, 20-44`, `.github/workflows/ci.yml:27, 87`
- **Root Cause:**
  1. `src/lib/firebase-admin.ts:3` statically imports `firebase-applet-config.json` without `with { type: 'json' }`, causing `"start": "node server.ts"` to crash immediately on Node `v22.23.5` (`ERR_IMPORT_ATTRIBUTE_MISSING`).
  2. `drizzle-kit` (carrying vulnerable `esbuild@0.18.20` GHSA-67mh-4wv8-2f99), `@playwright/test`, `@electric-sql/pglite`, `@types/pg`, `vite`, `@vitejs/plugin-react`, and `@tailwindcss/vite` are declared in `dependencies` rather than `devDependencies`, shipping dev/test tooling and a known vulnerable package into production installs.
  3. `.github/workflows/ci.yml` runs `npm install --no-audit` (skipping vulnerability checks) and `npx drizzle-kit push --force` (never testing versioned SQL migrations in CI).
- **Reproduction Steps:**
  1. Run `node -e "import('./src/app-server.ts')"` on Node `v22.23.5` -> crashes with `ERR_IMPORT_ATTRIBUTE_MISSING`.
  2. Inspect `package.json:20-44` and run `bun audit` -> `drizzle-kit` (`esbuild@0.18.20`) is in production `dependencies`.
  3. Inspect `.github/workflows/ci.yml:27, 87` -> `--no-audit` and `drizzle-kit push --force`.
- **Required Remediation:**
  1. Replace the bare JSON import in `src/lib/firebase-admin.ts:3` with `fs.readFileSync` + `JSON.parse` (or `with { type: 'json' }` if targeting Node 22+ ESM) AND verify `node server.ts` boots cleanly end-to-end in production mode (or compile server TypeScript to `dist-server/` and run `"start": "node dist-server/server.js"`).
  2. Move `drizzle-kit`, `@playwright/test`, `@electric-sql/pglite`, `@types/pg`, `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` from `dependencies` to `devDependencies` (verifying `server.ts` dynamically imports `vite` only in `NODE_ENV !== 'production'`).
  3. Update `.github/workflows/ci.yml` to: (a) run `npm audit --omit=dev --audit-level=moderate` (blocking on production advisories), (b) execute versioned SQL migrations (`drizzle-kit migrate` against a fresh PostgreSQL service container) rather than `drizzle-kit push --force`, and (c) include a production server smoke-boot test under `NODE_ENV=production`.
- **Security Acceptance Criteria:**
  - `npm audit --omit=dev` (and production-only `bun audit`) reports **0** moderate/high/critical vulnerabilities.
  - Production `"start"` command boots cleanly under Node `v22.23.5` with `NODE_ENV=production` and serves `/api/health`.
  - CI fails if any versioned SQL migration fails on clean PostgreSQL or if any production dependency carries a moderate+ advisory.
- **Regression Tests:**
  - CI smoke test booting production server + running `drizzle-kit migrate` on fresh PostgreSQL + running `npm audit --omit=dev`.
- **Dependencies:** Regenerate lockfile cleanly after moving packages to `devDependencies`.
- **Deployment Implications:** Smaller, cleaner production container/runtime image; fixes immediate production boot failure.

---

## P1-1 — `NEW-005`: Block `TRUNCATE TABLE` on `security_audit_logs` & Enforce Role-Agnostic Immutability (`AUD-014`)

- **Finding ID:** `NEW-005` (completes `AUD-014`)
- **Severity:** **MEDIUM**
- **Affected Components:** `drizzle/0001_mission001_6_security_remediation.sql:170-199`, new migration `drizzle/0002_*.sql`, `docs/SECURITY_PRODUCTION_CONFIG.md`
- **Root Cause:** `trg_security_audit_logs_append_only` only fires `BEFORE UPDATE OR DELETE FOR EACH ROW`, which PostgreSQL bypasses on `TRUNCATE TABLE`. The `REVOKE` block only targets a hardcoded role named `app_user`.
- **Reproduction Steps:**
  1. Apply `drizzle/0000` + `drizzle/0001` to PostgreSQL 16 and insert audit log rows.
  2. Execute `TRUNCATE TABLE security_audit_logs;`.
  3. Observe command succeeds and row count drops from `16` to `0`.
- **Required Remediation:**
  1. In migration `0002`, add a statement-level trigger:
     `CREATE TRIGGER trg_security_audit_logs_no_truncate BEFORE TRUNCATE ON security_audit_logs FOR EACH STATEMENT EXECUTE FUNCTION prevent_security_audit_log_mutation();`
  2. `REVOKE UPDATE, DELETE, TRUNCATE ON security_audit_logs FROM PUBLIC;` and document in `docs/SECURITY_PRODUCTION_CONFIG.md` that the production Cloud SQL runtime role must be a non-superuser, non-table-owner role granted only `SELECT, INSERT` on `security_audit_logs`.
- **Security Acceptance Criteria:**
  - `UPDATE`, `DELETE`, **and `TRUNCATE TABLE security_audit_logs`** all fail with SQLSTATE `42501` even for the connecting role.
- **Regression Tests:**
  - Extend `tests/postgres-integration.test.ts` audit-log immutability test to assert `TRUNCATE TABLE security_audit_logs` rejects with `42501` and preserves all rows.
- **Dependencies:** Migration `0002`.
- **Deployment Implications:** Zero-downtime DDL trigger addition; requires staging DB role verification.

---

## P1-2 — `NEW-006`: Catch Async Rejections in All Express 4 Routes (`POST /api/ratelimit/reset`) & Wrap Multi-Step Writes in Transactions (`AUD-003`)

- **Finding ID:** `NEW-006` (completes `AUD-003`)
- **Severity:** **MEDIUM**
- **Affected Components:** `src/app-server.ts:1914-1932` (`POST /api/ratelimit/reset`) and all `async` Express 4 handlers, `src/middleware/auth.ts:420-453`, `src/db/queries.ts:1322-1361, 2336-2407`
- **Root Cause:** Express 4 does not catch rejected promises returned by `async` route handlers. `POST /api/ratelimit/reset` lacks `try/catch` around `await recordSecurityAuditEvent()`, causing a hung HTTP request and fatal `unhandledRejection: PersistenceError` on DB outage. Multi-step document/chunk mutations execute outside `db.transaction()`.
- **Reproduction Steps:**
  1. Start app in `NODE_ENV=production` pointing to a closed PostgreSQL port (`ECONNREFUSED`).
  2. Call `POST /api/ratelimit/reset` as Admin.
  3. Observe request hangs until timeout (`AbortError`) and Node emits `unhandledRejection: PersistenceError`.
- **Required Remediation:**
  1. Wrap `POST /api/ratelimit/reset` in `try/catch` returning `sendSafeServerError()` (`503` on `PersistenceError`), AND introduce a shared `asyncHandler()` wrapper across all async Express 4 routes (or upgrade to Express 5 with a global error handler that handles `PersistenceError -> 503`).
  2. Wrap `ingestDocument()` and `upsertConnectorDocument()` (document insert/update + old chunk delete + new chunk insert) in `db.transaction()`.
- **Security Acceptance Criteria:**
  - Under production DB outage (`ECONNREFUSED`), **every** API route including `POST /api/ratelimit/reset` returns HTTP `503` promptly with zero `unhandledRejection` events.
  - Mid-write failures during document ingestion leave zero orphaned documents or partial chunk sets.
- **Regression Tests:**
  - Add `POST /api/ratelimit/reset` to the production DB-outage test suite in `tests/security.test.ts` with a process `unhandledRejection` failure detector; add transactional rollback test for `ingestDocument`.
- **Dependencies:** None.
- **Deployment Implications:** Eliminates production crash vector during transient Cloud SQL failovers.

---

## P1-3 — `NEW-007`: Enforce Security Headers (`CSP`, `HSTS`, `X-Frame-Options`) Globally and on `/auth/github/callback` (`AUD-010`)

- **Finding ID:** `NEW-007` (completes `AUD-010`)
- **Severity:** **MEDIUM**
- **Affected Components:** `src/app-server.ts:209-217, 1130-1154`
- **Root Cause:** Express header middleware omits `Content-Security-Policy`, `Strict-Transport-Security`, and `X-Frame-Options`; `/auth/github/callback` emits zero CSP header despite Mission 001.6 reports claiming strict callback CSP was implemented.
- **Reproduction Steps:**
  1. Request `/auth/github/callback` and `/api/health` in production mode.
  2. Inspect response headers -> `content-security-policy: null`, `strict-transport-security: null`, `x-frame-options: null`.
- **Required Remediation:**
  1. On `/auth/github/callback`, emit strict nonce- or SHA-256 hash-based `Content-Security-Policy: default-src 'none'; script-src 'nonce-<csprng>'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` plus `Cache-Control: no-store`.
  2. Globally set `X-Frame-Options: DENY` (or explicit `Content-Security-Policy: frame-ancestors 'none'` where iframe embedding is not used), `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `NODE_ENV === 'production'`, and a production-appropriate SPA `Content-Security-Policy` allowing only Firebase Auth/API origins.
- **Security Acceptance Criteria:**
  - `/auth/github/callback` returns strict nonce/hash `Content-Security-Policy`, `Cache-Control: no-store`, `X-Frame-Options: DENY`, and `Strict-Transport-Security` (in production).
  - Global responses emit `Content-Security-Policy`, `X-Frame-Options`, and production `Strict-Transport-Security`.
- **Regression Tests:**
  - Add explicit HTTP header assertions on `/auth/github/callback` and `/api/health` in `tests/security.test.ts`.
- **Dependencies:** Verify SPA CSP allowlist covers Firebase Auth popup/token domains in staging.
- **Deployment Implications:** Test in staging browser to ensure zero legitimate Firebase Auth or Vite asset CSP violations.

---

## P2-1 — `NEW-009`: Complete Production Fail-Fast Assertions, Support Graceful OAuth Key Rotation, & Harden Atomic User Provisioning

- **Finding ID:** `NEW-009` (hardens `AUD-003`, `AUD-004`, `AUD-007`)
- **Severity:** **MEDIUM**
- **Affected Components:** `src/lib/env.ts:91-105`, `src/lib/oauth-crypto.ts:266-269`, `src/db/queries.ts:236-271, 2971-2988`, `src/app-server.ts:891`
- **Root Cause:**
  1. `assertSafeProductionConfig()` does not fail fast on missing/weak `ALLOWED_ORIGINS`, `APP_URL`, `DATABASE_URL`, `CONNECTOR_TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_COOKIE_SECRET`, `GITHUB_WEBHOOK_SECRET`, or `SLACK_SIGNING_SECRET`.
  2. Rotating `CONNECTOR_TOKEN_ENCRYPTION_KEY` triggers `decryptSecret()` error inside `getUserOAuthConnection()`'s DB `try/catch`, returning HTTP `503` on `GET /api/connectors`.
  3. `getOrCreateUser()` uses non-atomic `SELECT`-then-`INSERT` without `ON CONFLICT (uid) DO NOTHING`.
  4. `/auth/github/callback` consumes OAuth state before verifying the browser-binding cookie on valid-cookie mismatch.
- **Reproduction Steps:**
  1. Store an encrypted GitHub OAuth connection under Key A; restart/swap `CONNECTOR_TOKEN_ENCRYPTION_KEY` to Key B; call `GET /api/connectors` -> HTTP `503`.
  2. Boot `createApp()` in `NODE_ENV=production` with empty `ALLOWED_ORIGINS` / `CONNECTOR_TOKEN_ENCRYPTION_KEY` -> server boots without fail-fast error.
- **Required Remediation:**
  1. Expand `assertSafeProductionConfig()` to throw at startup in `NODE_ENV=production` if any mandatory production variable is missing or fails entropy/format checks.
  2. Support optional `CONNECTOR_TOKEN_ENCRYPTION_KEY_PREVIOUS` (or versioned key ring) for seamless key rotation, and catch `TokenDecryptionError` **separately** from DB errors so undecryptable tokens mark the connector as `needsReconnect: true` rather than returning HTTP `503`.
  3. Update `getOrCreateUser()` to use `INSERT ... ON CONFLICT (uid) DO NOTHING` followed by `SELECT`.
  4. Verify browser-binding cookie matches the persisted state's `user_uid`/nonce hash before consuming the state row (or validate cookie HMAC first).
  5. Document CHIPS / third-party cookie behavior for `SameSite=None; Partitioned` across browsers, and optionally add PKCE (`code_challenge`/`code_verifier`) for GitHub OAuth defense-in-depth.
- **Security Acceptance Criteria:**
  - Server refuses to boot in `NODE_ENV=production` when any mandatory secret/origin is missing.
  - Rotating `CONNECTOR_TOKEN_ENCRYPTION_KEY` returns HTTP `200` on `GET /api/connectors` with `connected: false, reconnectRequired: true` (or decrypts via previous key during rotation window).
  - Concurrent first-time `/api/auth/sync` under multi-connection PostgreSQL succeeds without `23505` errors.
- **Regression Tests:**
  - Add startup config fail-fast unit tests, key-rotation test in `tests/security.test.ts`, and concurrent `getOrCreateUser` PG test.
- **Dependencies:** None.
- **Deployment Implications:** Update staging/production env var checklists before deploying fail-fast startup assertions.

---

## P2-2 — `NEW-010`: Redact Embedded Database URI Passwords in Logs & Restrict `sourceUrl` to `http:`/`https:` Schemes (`AUD-011`)

- **Finding ID:** `NEW-010` (completes `AUD-011`)
- **Severity:** **MEDIUM-LOW**
- **Affected Components:** `src/lib/logger.ts:48-49`, `src/lib/env.ts:470`
- **Root Cause:** `sanitizeStringForLogs()` lacks a pattern matching credentialed URIs (`postgresql://user:pass@host`); `IngestDocumentRequestSchema` allows arbitrary strings including `javascript:alert(1)` in `sourceUrl`.
- **Reproduction Steps:**
  1. Call `sanitizeStringForLogs("postgresql://app_user:SuperSecretPgPass9988@db.internal:5432/hippocampus")` -> password returned in plaintext.
  2. Send `POST /api/documents` with `sourceUrl: "javascript:alert(1)"` -> HTTP `201`.
- **Required Remediation:**
  1. Add URI password redaction regex in `src/lib/logger.ts` (`/\b((?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|https?):\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi` -> `$1[REDACTED]$3`).
  2. Refine `IngestDocumentRequestSchema.sourceUrl` to parse via `new URL()` and allow only `http:` and `https:` protocols (when non-empty).
- **Security Acceptance Criteria:**
  - Embedded passwords in PostgreSQL/HTTP/Redis URIs are always replaced with `[REDACTED]` in strings and nested audit metadata.
  - `javascript:`, `data:`, and `vbscript:` schemes in `sourceUrl` are rejected with HTTP `400`.
- **Regression Tests:**
  - Add log redaction tests for PostgreSQL/Redis/HTTPS credentialed URIs and `POST /api/documents` scheme rejection tests (`javascript:`, `data:`).
- **Dependencies:** None.
- **Deployment Implications:** Backward-compatible; verify existing seeded/connector `sourceUrl` values use `http:`/`https:` or `null`.

---

## P2-3 — `NEW-011`: Align Documentation, TypeScript Strictness & Client Telemetry Hygiene

- **Finding ID:** `NEW-011`
- **Severity:** **LOW**
- **Affected Components:** `docs/SECURITY_PRODUCTION_CONFIG.md`, `tsconfig.json`, `src/components/ErrorBoundary.tsx:35`, `src/app-server.ts` (`/api/telemetry/client-error`), `src/components/OnboardingPanel.tsx:662`
- **Root Cause:** Minor documentation and code discrepancies surfaced during independent verification.
- **Reproduction Steps:**
  1. Search `docs/SECURITY_PRODUCTION_CONFIG.md` for `single-organization` or `AUD-005` -> absent.
  2. Inspect `tsconfig.json` -> `"strict": true` absent.
  3. Inspect `src/components/ErrorBoundary.tsx:35` -> `fetch('/api/telemetry/client-error', ...)` omits `Authorization: Bearer` header.
  4. Inspect `src/components/OnboardingPanel.tsx:662` -> references removed client role switcher.
- **Required Remediation:**
  1. Add an explicit "Single-Organization Deployment Constraint (AUD-005 / Multi-Tenant NO-GO Until Mission 002)" section to `docs/SECURITY_PRODUCTION_CONFIG.md`.
  2. Enable `"strict": true` in `tsconfig.json` and resolve any resulting type findings.
  3. Attach Firebase Bearer token in `ErrorBoundary.tsx` (when user is signed in) and add a dedicated per-IP rate limiter on `POST /api/telemetry/client-error`.
  4. Update stale role-switcher text in `src/components/OnboardingPanel.tsx:662`.
- **Security Acceptance Criteria:**
  - Documentation accurately reflects deployment constraints and security posture.
  - `npx tsc --noEmit` passes with `"strict": true`.
  - `/api/telemetry/client-error` enforces rate limiting and receives authenticated reports from signed-in clients.
- **Regression Tests:**
  - Add rate-limit test for `/api/telemetry/client-error` and verify `npx tsc --noEmit` with `"strict": true` in CI.
- **Dependencies:** None.
- **Deployment Implications:** Low-risk hygiene improvements.
