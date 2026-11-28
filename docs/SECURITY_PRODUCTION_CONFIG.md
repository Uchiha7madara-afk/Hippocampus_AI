# Hippocampus AI — Production Security Configuration & Operations Guide

## 1. Required Production Environment Variables

Configure all secrets exclusively in your cloud secret manager (e.g., Google Secret Manager / Cloud Run Secrets). Never commit real values into `.env`, `.env.example`, source code, or test fixtures.

| Variable | Required in Production | Purpose |
|---|---|---|
| `NODE_ENV` | **Yes** (`production`) | Disables dev-only simulator endpoints (`/api/dev/*`), enables static bundle serving, enforces fail-closed PostgreSQL persistence (`503`), strict CORS allowlist, and error redaction. |
| `PORT` | Optional (`3000`) | HTTP listen port (`0.0.0.0:$PORT`). |
| `APP_URL` | **Yes** | Canonical HTTPS URL of the deployed application (used for OAuth redirect URI and CORS allowlist). Required in production — `req.get('host')` is never trusted for OAuth redirects in production. |
| `ALLOWED_ORIGINS` | **Yes** | Comma-separated explicit browser origins allowed to call `/api/*` (e.g., `https://hippocampus.company.com`). Wildcards (`*`) and spoofed `Host`/`X-Forwarded-Proto` origins are strictly rejected in production. |
| `TRUST_PROXY_HOPS` | **Yes** (`1` on Cloud Run / single LB) | Exact count of trusted reverse proxies in front of Express (`app.set('trust proxy', N)`). Governs `req.ip` for rate limiting without blindly trusting spoofed `X-Forwarded-For` headers. |
| `FIREBASE_PROJECT_ID` | **Yes** | Firebase project ID for server-side ID token verification via Firebase Admin SDK. |
| `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON` | **Yes** (unless Cloud Run ADC IAM is bound) | Firebase Admin SDK credentials for verifying ID tokens and revocation state (`verifyIdToken(token, true)`). |
| `DATABASE_URL` or (`SQL_HOST`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`) | **Yes** | Cloud SQL PostgreSQL + `pgvector` credentials. **Production refuses to start without explicit DB config**, and any DB outage fails closed (`HTTP 503`) with zero silent in-memory fallback. |
| `SQL_SSL_CA_PATH` | Optional (TCP with private CA) | Path to PEM root CA certificate for verified TLS (`rejectUnauthorized: true`) when connecting over TCP to PostgreSQL outside Cloud SQL Auth Proxy Unix sockets. |
| `HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK` | Must be unset or `false` | Server **refuses to boot** if set to `true` when `NODE_ENV=production`. |
| `CONNECTOR_TOKEN_ENCRYPTION_KEY` | **Yes** (when using GitHub OAuth) | 32-byte hex/base64 key (`openssl rand -hex 32`) for AES-256-GCM authenticated encryption at rest of per-user OAuth access/refresh tokens and PKCE verifiers. |
| `OAUTH_STATE_COOKIE_SECRET` | **Yes** (or derived from encryption key) | High-entropy secret (`>= 32` chars) signing the `HttpOnly` OAuth browser-binding cookie (`hippocampus_gh_oauth_bind`). |
| `DEFAULT_RBAC_ROLE` | Optional (`Engineer`) | Enforced strictly as `Engineer` for newly onboarded verified users. Unauthenticated requests never receive a role. |
| `BOOTSTRAP_ADMIN_EMAILS` / `BOOTSTRAP_ADMIN_UIDS` | Initial provisioning only | Comma-separated verified emails or Firebase UIDs granted `Admin` ONLY on initial `/api/auth/sync` creation when `email_verified === true`. Never re-elevates existing/demoted users. Remove after initial setup. |
| `GITHUB_WEBHOOK_SECRET` | **Yes** (for GitHub webhooks) | Minimum 32-byte random secret used for mandatory `X-Hub-Signature-256` HMAC-SHA256 verification over exact raw request bytes. Missing secret fails closed (`503`). |
| `GITHUB_ALLOWED_REPOS` | Recommended | Comma-separated `owner/repo` allowlist permitted to trigger webhook ingestion. |
| `SLACK_SIGNING_SECRET` | **Yes** (for Slack Events API) | Slack app signing secret used for mandatory `X-Slack-Signature` HMAC-SHA256 verification over exact raw bytes with strict 10-digit timestamp (`±300s`). Missing secret fails closed (`503`). |
| `GEMINI_API_KEY` | Recommended | Server-side Google GenAI SDK key for embeddings and RAG synthesis. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional (for GitHub OAuth) | GitHub OAuth App credentials. Simulated handshake is strictly blocked in production. |

---

## 2. Database Transport Security (Cloud SQL vs. Direct TCP)

- **Cloud SQL Auth Proxy / Cloud Run Unix Socket (`/cloudsql/<project>:<region>:<instance>`)**: Transport encryption and identity verification are enforced automatically via IAM-authenticated mTLS by the Cloud SQL Auth Proxy.
- **Direct TCP PostgreSQL Connections in Production**: `src/db/index.ts` and `src/db/drizzle.config.ts` enforce verified TLS (`rejectUnauthorized: true`). If connecting to a managed PostgreSQL instance with a private CA, mount the CA bundle and set `SQL_SSL_CA_PATH=/etc/ssl/certs/cloudsql-ca.pem`. Hardcoded default passwords are completely removed.

---

## 3. Proxy & Ingress Topology (`TRUST_PROXY_HOPS`)

- **Cloud Run / GKE Ingress / Single Load Balancer**: Set `TRUST_PROXY_HOPS=1`. Express strips exactly 1 proxy hop when deriving `req.ip` and `req.protocol`.
- **Direct / Localhost (no reverse proxy)**: Set `TRUST_PROXY_HOPS=0`.
- **Multi-tier Proxy (CDN -> Cloud Load Balancer -> Cloud Run)**: Set `TRUST_PROXY_HOPS=2` (exact number of trusted proxies). Never enable blanket `trust proxy = true`, and never derive CORS origins from raw `Host` or `X-Forwarded-Proto` headers in production.

---

## 4. Initial Administrator Provisioning & Existing Admin Audit

Hippocampus never defaults unauthenticated callers or newly registered users to `Admin`.

1. Configure `BOOTSTRAP_ADMIN_EMAILS="security-lead@company.com"` (or `BOOTSTRAP_ADMIN_UIDS="<firebase-uid>"`) in Cloud Run Secrets for initial deployment.
2. Have the designated administrator sign in with Google/Firebase (must have `email_verified === true`) and trigger `POST /api/auth/sync`.
3. Verify the `user.provisioned` event in `GET /api/audit-logs` confirms `bootstrapAdmin: true` and `assignedRole: "Admin"`.
4. **Remove `BOOTSTRAP_ADMIN_EMAILS` / `BOOTSTRAP_ADMIN_UIDS`** on the next revision. Existing users (including any Admin later demoted via `PATCH /api/auth/role`) will NEVER re-elevate on subsequent `/api/auth/sync` calls.

### Mandatory Existing Admin Audit Query (Pre- and Post-Migration)
Before and after applying Mission 001.6 migrations in production, run this read-only audit query to verify every account holding `Admin` or `Manager` privileges:

```sql
SELECT uid, email, display_name, role, created_at, updated_at
FROM users
WHERE role IN ('Admin', 'Manager')
ORDER BY role ASC, created_at ASC;
```

Demote any unintended accounts via `PATCH /api/auth/role` (from an authorized Admin) so every role change is recorded in the append-only `security_audit_logs` table.

---

## 5. OAuth Encryption Key Provisioning & Rotation

1. **Generate keys**:
   ```bash
   openssl rand -hex 32   # -> CONNECTOR_TOKEN_ENCRYPTION_KEY
   openssl rand -hex 32   # -> OAUTH_STATE_COOKIE_SECRET
   ```
2. **Store in Secret Manager** and bind to the runtime environment. Never log or expose these keys.
3. **Key Rotation**:
   - Rotate `OAUTH_STATE_COOKIE_SECRET` during a low-traffic window (in-flight OAuth popups expire after 10 minutes and simply retry).
   - Rotate `CONNECTOR_TOKEN_ENCRYPTION_KEY` by running an offline re-encryption script against `user_connector_connections` (or revoking existing rows via `DELETE FROM user_connector_connections` and prompting users to click **Connect GitHub OAuth** again).

---

## 6. Append-Only Security Audit Log Enforcement

Migration `0001_mission001_6_security_remediation.sql` installs a database-level `BEFORE UPDATE OR DELETE` trigger (`trg_security_audit_logs_append_only`) that raises PostgreSQL `insufficient_privilege` (`SQLSTATE 42501`) on any attempt to modify or delete rows in `security_audit_logs`, and revokes `UPDATE, DELETE, TRUNCATE` privileges on `security_audit_logs` from `app_user` when that role exists.

- **Application runtime role (`app_user`)** should only hold `INSERT, SELECT` on `security_audit_logs` (plus sequence `USAGE`).
- **Maintenance/DBA retention archival** must be executed only under a separate audited DBA role after exporting sealed audit snapshots to immutable WORM storage (e.g., GCS Bucket Lock).

---

## 7. Secret Rotation & Emergency Access Revocation

### Webhook Secret Rotation (GitHub & Slack)
1. Generate a new 32-byte secret (`openssl rand -hex 32`) or regenerate in Slack App Management.
2. Update Secret Manager, deploy a new revision, and update the webhook configuration on GitHub/Slack.
3. Verify delivery via GitHub `ping` (with `X-GitHub-Delivery`) or Slack `url_verification`.

### Emergency User Revocation
1. **Demote Role**: An `Admin` calls `PATCH /api/auth/role` (`{ "targetUid": "<uid>", "role": "Engineer" }`).
2. **Revoke Tokens**: Call `adminAuth.revokeRefreshTokens(uid)` or disable the account in Firebase Auth. `verifyIdToken(token, true)` rejects revoked sessions immediately with `401 Unauthorized`.
3. **Revoke Connector Tokens**: Delete the user's rows in `user_connector_connections` (or have the user call `POST /api/connectors/github/disconnect`).

---

## 8. Database Migrations & Safe Rollback Strategy

### Forward Migration (Non-Destructive, Preserves Production Data)
Apply the incremental Drizzle migrations in order (`0000_mission001_security_hardening.sql`, `0001_mission001_6_security_remediation.sql`):

```bash
npx drizzle-kit check --config=src/db/drizzle.config.ts
npx drizzle-kit migrate --config=src/db/drizzle.config.ts
```

Migration `0001_mission001_6_security_remediation.sql`:
- Preserves all existing `users`, `documents`, `document_chunks`, `query_logs`, `onboarding_tracks`, `user_progress`, and `security_audit_logs` rows.
- Safely deduplicates any legacy `(user_handle, track_id)` rows before creating partial unique indexes for legacy (`user_uid IS NULL`) and UID-scoped (`user_uid IS NOT NULL`) progress records.
- Tags pre-existing `semantic_cache` rows as `cache_version = 1` so v2 role-isolated lookups never serve unpartitioned legacy cache entries.
- Creates `oauth_states` and `user_connector_connections` for distributed single-use OAuth states and per-user encrypted tokens.
- Installs the append-only `trg_security_audit_logs_append_only` trigger on `security_audit_logs`.

### Safe Rollback Procedure
**CRITICAL: Never drop `security_audit_logs` during rollback** — audit history must remain intact for compliance and forensics.

```sql
-- Roll back only additive Mission 001.6 OAuth tables if an emergency application revert is required.
DROP TABLE IF EXISTS oauth_states;
DROP TABLE IF EXISTS user_connector_connections;
-- Retain security_audit_logs, trg_security_audit_logs_append_only, users.role default ('Engineer'),
-- semantic_cache role-isolation columns, and user_progress.user_uid column so no production data is lost.
```
