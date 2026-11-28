# HIPPOCAMPUS AI — MISSION 001.7
# PRODUCTION ACCEPTANCE CHECKLIST (SINGLE-ORGANIZATION BASELINE)

**Audit Date:** 2026-11-28 (UTC)  
**Overall Verdict:** **`C. REQUIRE REMEDIATION`**  
**Multi-Tenant SaaS Gate:** **EXPLICITLY NO-GO** (Deferred to Mission 002)

> **Separation Principle:** Code acceptance and infrastructure acceptance are evaluated independently below. Passing a local code check **never** implies staging or production infrastructure acceptance. Every live environment control without authorized access is explicitly marked **`BLOCKED BY INFRASTRUCTURE`**.

---

## Summary Scorecard

| # | Acceptance Category | Scope | Status | Blocking Findings |
|---|---|---|---|---|
| 1 | Code Acceptance | Codebase | **FAIL** | `NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`, `NEW-006`, `NEW-007`, `NEW-008`, `NEW-010`, `NEW-011` |
| 2 | Authentication Acceptance | Codebase + Infra | **PASS (Code) / BLOCKED (Infra)** | Latent `getOrCreateUser` race (`NEW-009`); live Firebase IAM `BLOCKED BY INFRASTRUCTURE` |
| 3 | Authorization Acceptance | Codebase | **FAIL** | `NEW-001` (HIGH), `NEW-002` (HIGH), `NEW-003` (HIGH), `NEW-004` (HIGH) |
| 4 | OAuth Acceptance | Codebase + Infra | **PARTIAL (Code) / BLOCKED (Infra)** | `NEW-007` (missing callback CSP), `NEW-009` (key rotation `503`, state consumption ordering) |
| 5 | Webhook Acceptance | Codebase + Infra | **PASS (Code) / BLOCKED (Infra)** | Live secret injection & edge proxy hop count `BLOCKED BY INFRASTRUCTURE` |
| 6 | Database Acceptance | Codebase + Infra | **FAIL (Code) / BLOCKED (Infra)** | `NEW-005` (`TRUNCATE` bypass on `security_audit_logs`), `NEW-006` (non-transactional writes) |
| 7 | Migration Acceptance | Codebase + Infra | **PARTIAL (Code) / BLOCKED (Infra)** | CI runs `drizzle-kit push --force` instead of `drizzle-kit migrate` (`NEW-008`); live DB dry-run `BLOCKED BY INFRASTRUCTURE` |
| 8 | Secret Management | Codebase + Infra | **PARTIAL (Code) / BLOCKED (Infra)** | `NEW-009` (incomplete startup fail-fast), `NEW-010` (PG URI password unredacted in logs); live Secret Manager `BLOCKED BY INFRASTRUCTURE` |
| 9 | Logging and Monitoring | Codebase + Infra | **PARTIAL (Code) / BLOCKED (Infra)** | `NEW-010` (PG URI redaction), `NEW-011` (`ErrorBoundary` 401); live SIEM/alerting `BLOCKED BY INFRASTRUCTURE` |
| 10 | Backup and Recovery | Infrastructure | **`BLOCKED BY INFRASTRUCTURE`** | No access to Cloud SQL backups, PITR, or restore drill evidence |
| 11 | Staging Verification | Infrastructure | **`BLOCKED BY INFRASTRUCTURE`** | No staging deployment accessible; codebase fails Node 22 `"start"` boot (`NEW-008`) |
| 12 | Rollback Readiness | Infrastructure | **`BLOCKED BY INFRASTRUCTURE`** | No tested application or SQL rollback procedure in staging |
| 13 | Explicit Production Approval Requirements | Governance | **NOT MET (REJECTED)** | All P0/P1 code remediations + re-audit + staging infrastructure sign-off required |

---

## 1. Code Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Zero unresolved Critical or High vulnerabilities | **FAIL** | 4 HIGH findings open (`NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`). |
| Existing security & PG integration tests pass | **PASS** | `npm run test:security` -> 52 passed, 0 failed. |
| Production build succeeds without source maps or leaked server secrets | **PASS** | `npm run build` -> `dist/` built cleanly; `maps: []`; zero server secrets in client JS. |
| Declared production `"start"` script boots cleanly on target Node runtime | **FAIL** | `node server.ts` crashes on Node `v22.23.5` (`ERR_IMPORT_ATTRIBUTE_MISSING` at `src/lib/firebase-admin.ts:3`, `NEW-008`). |
| Production `dependencies` free of dev/test tools & known vulnerable transitive packages | **FAIL** | `drizzle-kit` (carrying `esbuild@0.18.20` GHSA-67mh-4wv8-2f99), `@playwright/test`, `@electric-sql/pglite`, `vite` are in `dependencies` (`NEW-008`). |
| Strict TypeScript compilation (`"strict": true`) | **FAIL** | `tsconfig.json` enables `"strictNullChecks": true` only (`NEW-011`). |
| All Express 4 async routes handle rejections without crashing process | **FAIL** | `POST /api/ratelimit/reset` emits fatal `unhandledRejection: PersistenceError` on DB failure (`NEW-006`). |
| Security headers (`CSP`, `HSTS`, `X-Frame-Options`) emitted | **FAIL** | Missing globally and on `/auth/github/callback` (`NEW-007`). |
| Document `sourceUrl` rejects `javascript:` / unsafe URI schemes | **FAIL** | `POST /api/documents` persisted `javascript:alert(1)` with HTTP `201` (`NEW-010`). |

---

## 2. Authentication Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Firebase ID token verification enforces revocation (`checkRevoked: true`) | **PASS (Code)** | Verified in `src/middleware/auth.ts`. |
| Production rejects `ALLOW_DEV_AUTH_BYPASS=true` at startup | **PASS (Code)** | Verified in `src/lib/env.ts:91-105`. |
| Forged identity/role headers ignored on all protected routes | **PASS (Code)** | `ADV-013`: unauthenticated -> `401`, Engineer with forged headers -> `403`. |
| Admin bootstrap requires `email_verified === true` and is strictly one-time | **PASS (Code)** | Verified in `src/app-server.ts:469-498` (`AUD-007`). |
| First-login user creation safe under concurrent multi-connection PostgreSQL | **PARTIAL (Code)** | `getOrCreateUser()` uses non-atomic `SELECT`-then-`INSERT` without `ON CONFLICT` (`NEW-009`). |
| Production Firebase project auth providers, authorized domains, and IAM service account | **`BLOCKED BY INFRASTRUCTURE`** | Live Firebase Console / GCP IAM inaccessible. |

---

## 3. Authorization Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Role authority sourced exclusively from PostgreSQL `users.role` | **PASS (Code)** | Verified in `src/middleware/auth.ts` & `ADV-013`. |
| Semantic cache partitioned by role, search mode, and cache version (L1 + L2) | **PASS (Code)** | Verified in `ADV-001` (`AUD-001`), including live role demotion. |
| Cache telemetry strictly role-scoped and metadata-only | **PASS (Code)** | Verified in `ADV-002` (`AUD-002`). |
| Direct `/api/documents` CRUD enforces tier RBAC | **PASS (Code)** | Verified in `ADV-014b` (Admin doc hidden; `POST`/`DELETE` -> `403`). |
| RAG retrieval SQL enforces `access_level` tier filtering across all modes | **PASS (Code)** | Verified in `ADV-016` across `hybrid_rrf`, `dense_vector`, `sparse_bm25`. |
| Onboarding progress isolated strictly by `user_uid` | **PASS (Code)** | Verified in `ADV-011` (`AUD-013`). |
| Connector upsert prevents lower-privileged overwrite/downgrade of higher-tier documents | **FAIL (Code)** | **`NEW-001` (HIGH):** Manager overwrote & downgraded Admin doc via `sourceUrl` collision (`ADV-014a`). |
| Query history (`GET /api/logs`) enforces user ownership & actor-role classification | **FAIL (Code)** | **`NEW-002` (HIGH):** Engineer read both Admin's and peer Engineer's raw prompts/answers (`ADV-015`). |
| Manual GitHub sync enforces `GITHUB_ALLOWED_REPOS` and prevents shared PAT abuse | **FAIL (Code)** | **`NEW-004` (HIGH):** Manager synced unapproved repo via `POST /api/connectors/github/sync` (`ADV-018`). |
| Agent tool execution enforces per-tool RBAC, argument validation, and untrusted-data framing | **FAIL (Code)** | **`NEW-003` (HIGH):** Unconstrained LLM `functionCalls` execution + schema/executor mismatch (`ADV-016`, `ADV-017`). |

---

## 4. OAuth Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Cryptographic, single-use, expiring, atomically consumed PG state | **PASS (Code)** | Verified in `ADV-004` (`AUD-004`). |
| Browser-binding HMAC `HttpOnly; Secure` cookie enforced on callback | **PASS (Code)** | Verified in `ADV-005` (`noCookie=403`). |
| Per-user AES-256-GCM encrypted token storage & disconnect isolation | **PASS (Code)** | Verified in `ADV-006`. |
| Upstream OAuth token exchange timeout bounded | **PASS (Code)** | Verified in `ADV-005` (`timeout=502`). |
| Callback HTML/script XSS escaping + frontend `event.origin` & `event.source` validation | **PASS (Code)** | Verified in `ADV-020` and `src/components/ConnectorsPanel.tsx`. |
| Strict `Content-Security-Policy` header on `/auth/github/callback` | **FAIL (Code)** | `CSP=null` (`NEW-007`). |
| Graceful encryption key rotation without breaking `GET /api/connectors` | **FAIL (Code)** | Rotating `CONNECTOR_TOKEN_ENCRYPTION_KEY` triggers HTTP `503` (`NEW-009`, `ADV-006`). |
| GitHub OAuth App callback URL, client secret rotation & cross-browser CHIPS testing | **`BLOCKED BY INFRASTRUCTURE`** | Live GitHub OAuth App & staging domains inaccessible. |

---

## 5. Webhook Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| GitHub raw-body HMAC-SHA256 + `timingSafeEqual` + fail-closed missing secret | **PASS (Code)** | Verified in `ADV-007` (`AUD-008`). |
| GitHub mandatory `X-GitHub-Delivery` + atomic PG concurrent replay deduplication | **PASS (Code)** | `ADV-007`: 3 concurrent duplicates -> `1 processed, 2 ignored`. |
| GitHub webhook rate limit immune to spoofed `X-Forwarded-For` (`TRUST_PROXY_HOPS=0`) | **PASS (Code)** | `ADV-008`: req `#61` -> `429`. |
| Slack raw-body HMAC + strict `^\d{10}$` timestamp + `±300s` replay window + atomic `event_id` dedupe | **PASS (Code)** | `ADV-009`: all 5 malformed/stale timestamps -> `401`; 3 concurrent -> `1 accepted, 2 suppressed`. |
| Dev simulator routes disabled (`404`) and simulator bypass header rejected in production | **PASS (Code)** | `ADV-007`, `ADV-022`: simulator routes `404`, bypass header `401`. |
| Live GitHub/Slack webhook signing secrets & reverse-proxy hop alignment | **`BLOCKED BY INFRASTRUCTURE`** | Live ingress/load balancer and webhook providers inaccessible. |

---

## 6. Database Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Production TLS enforces certificate verification (`rejectUnauthorized: true`) & no hardcoded passwords | **PASS (Code)** | Verified in `src/db/index.ts`. |
| Production DB failures fail closed (`503`) with zero silent in-memory fallback | **PARTIAL (Code)** | 9 endpoints return `503`, **but** `POST /api/ratelimit/reset` crashes/hangs (`NEW-006`). |
| Multi-step document/chunk mutations wrapped in ACID transactions | **FAIL (Code)** | `ingestDocument()` & `upsertConnectorDocument()` are non-transactional (`NEW-006`). |
| `security_audit_logs` immutable against `UPDATE`, `DELETE`, **and `TRUNCATE`** | **FAIL (Code)** | `UPDATE`/`DELETE` blocked (`42501`), **but `TRUNCATE TABLE` wiped 16 rows (`16 -> 0`)** (`NEW-005`). |
| Least-privilege Cloud SQL runtime role (non-owner, non-superuser, no `TRUNCATE`) | **`BLOCKED BY INFRASTRUCTURE`** | Live Cloud SQL roles & grants inaccessible. |
| Network isolation (private IP / Cloud SQL Auth Proxy) & connection pooling limits | **`BLOCKED BY INFRASTRUCTURE`** | Live GCP/VPC configuration inaccessible. |

---

## 7. Migration Acceptance

| Control | Status | Verification Evidence |
|---|---|---|
| Drizzle schema & migration snapshot integrity (`drizzle-kit check`) | **PASS (Code)** | `npx drizzle-kit check` -> `Everything's fine`. |
| Migrations `0000` + `0001` verified across 5 synthetic PG16 states & idempotent re-run | **PASS (Local PG16)** | Verified in `ADV-021`. |
| CI verifies versioned SQL migrations (`drizzle-kit migrate`), not schema push | **FAIL (CI Config)** | `.github/workflows/ci.yml:87` runs `npx drizzle-kit push --force` (`NEW-008`). |
| Staging dry-run against anonymized production schema snapshot | **`BLOCKED BY INFRASTRUCTURE`** | No staging DB or production schema dump available. |
| Forward-fix & rollback migration script tested on real PostgreSQL | **`BLOCKED BY INFRASTRUCTURE`** | No staging PostgreSQL environment available. |

---

## 8. Secret Management

| Control | Status | Verification Evidence |
|---|---|---|
| No private secrets committed to repository or bundled into client `dist/` | **PASS (Code)** | Verified across workspace & `dist/assets/index-CYlh_siE.js`. |
| Production startup fails fast when mandatory secrets/config vars are missing | **FAIL (Code)** | `assertSafeProductionConfig()` does not enforce `ALLOWED_ORIGINS`, `APP_URL`, `DATABASE_URL`, encryption/cookie/webhook secrets (`NEW-009`). |
| Secret Manager / KMS integration, IAM least privilege & rotation runbook verified | **`BLOCKED BY INFRASTRUCTURE`** | Live GCP Secret Manager / hosting env injection inaccessible. |

---

## 9. Logging and Monitoring

| Control | Status | Verification Evidence |
|---|---|---|
| `X-Request-Id` CRLF log injection neutralized | **PASS (Code)** | Verified in `ADV-019` (`AUD-011`). |
| All secret formats (including embedded PostgreSQL URI passwords) redacted in logs & audit metadata | **FAIL (Code)** | Plaintext PostgreSQL URI passwords leak through `sanitizeStringForLogs` & `sanitizeAuditMetadata` (`NEW-010`). |
| Client error telemetry endpoint properly authenticated and rate-limited | **FAIL (Code)** | `ErrorBoundary.tsx:35` omits `Authorization` header; route lacks rate limiter (`NEW-011`). |
| Centralized log sink, tamper-evident audit export, alerting on 503/401/403 spikes & webhook failures | **`BLOCKED BY INFRASTRUCTURE`** | Live observability stack inaccessible. |

---

## 10. Backup and Recovery

| Control | Status | Verification Evidence |
|---|---|---|
| Automated daily Cloud SQL backups & Point-in-Time Recovery (PITR) enabled | **`BLOCKED BY INFRASTRUCTURE`** | No Cloud SQL instance access. |
| Documented RPO/RTO targets and tested restore drill into isolated database | **`BLOCKED BY INFRASTRUCTURE`** | No restore drill artifacts or live access. |
| Encrypted backup retention & KMS key separation | **`BLOCKED BY INFRASTRUCTURE`** | No GCP KMS/backup access. |

---

## 11. Staging Verification

| Control | Status | Verification Evidence |
|---|---|---|
| Live staging deployment running production build (`NODE_ENV=production`) | **`BLOCKED BY INFRASTRUCTURE`** | No staging URL/environment accessible (and `"start"` currently crashes on Node 22). |
| E2E Playwright suite executed against staging with real Firebase Auth & CORS (no dev bypass) | **`BLOCKED BY INFRASTRUCTURE`** | Current `e2e/hippocampus.spec.ts` runs against dev server with dev bypass only. |
| Real GitHub OAuth popup flow & webhook delivery tested against staging HTTPS domain | **`BLOCKED BY INFRASTRUCTURE`** | No staging domain or webhook endpoint accessible. |

---

## 12. Rollback Readiness

| Control | Status | Verification Evidence |
|---|---|---|
| Immutable versioned release artifacts & one-command application rollback | **`BLOCKED BY INFRASTRUCTURE`** | No deployment pipeline or container registry accessible. |
| Verified pre-migration DB snapshot + rollback/forward-fix procedure tested in staging | **`BLOCKED BY INFRASTRUCTURE`** | No staging DB or snapshot procedure accessible. |
| Key-rotation rollback / dual-key decryption window verified | **FAIL (Code) / BLOCKED (Infra)** | Single-key decrypt fails with HTTP `503` on rotation (`NEW-009`). |

---

## 13. Explicit Production Approval Requirements (Mandatory Release Gates)

Production deployment of Hippocampus AI (Single-Organization Baseline) is **NOT AUTHORIZED** until **all** gates below are completed and independently signed off:

1. **Gate 1 — P0/P1 Code Remediation:** Resolve `NEW-001`, `NEW-002`, `NEW-003`, `NEW-004`, `NEW-005`, `NEW-006`, `NEW-007`, and `NEW-008` in full, with passing automated PostgreSQL + Express regression tests for every finding.
2. **Gate 2 — P2 Operational & Redaction Remediation:** Resolve `NEW-009`, `NEW-010`, and `NEW-011` (startup fail-fast checks, versioned/graceful OAuth key rotation, atomic `getOrCreateUser`, PostgreSQL URI password redaction, `sourceUrl` scheme allowlist, strict TS, accurate single-org documentation).
3. **Gate 3 — Supply Chain & CI Hardening:** Move dev/test/build tools (`drizzle-kit`, `@playwright/test`, `@electric-sql/pglite`, `vite`, `@types/pg`) to `devDependencies`; verify `node server.ts` boots cleanly on Node 22; add blocking `drizzle-kit migrate` and dependency audit gates to `.github/workflows/ci.yml`.
4. **Gate 4 — Independent Code Re-Audit:** Conduct a follow-up independent read-only verification pass confirming zero Critical/High findings remain and all report claims match actual code.
5. **Gate 5 — Authorized Staging & Infrastructure Sign-Off:** Deploy to a production-mirror staging environment with real Cloud SQL (least-privilege non-owner runtime DB role), real Firebase Auth (zero dev bypass), real Secret Manager, TLS/HSTS/CSP headers verified externally, live GitHub/Slack webhooks, tested PITR restore & rollback rehearsal, and staging E2E verification.
6. **Gate 6 — Multi-Tenant Restriction Acknowledgment:** Explicit written operational sign-off restricting deployment to a **single organization** until Mission 002 (`AUD-005`) is completed and independently audited.
