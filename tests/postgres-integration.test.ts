import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema.ts';
import { setDbInstanceForTesting } from '../src/db/index.ts';
import {
  consumeOAuthStateAtomic,
  createOAuthState,
  getOnboardingPayload,
  getOrCreateUser,
  getSemanticCacheTelemetry,
  getUserByUid,
  getUserConnectorConnection,
  lookupSemanticCache,
  recordSecurityAuditEvent,
  recordWebhookDeliveryIfNew,
  resetSecurityFallbackStoresForTesting,
  storeInSemanticCache,
  toggleOnboardingMilestone,
  upsertUserConnectorConnection,
} from '../src/db/queries.ts';
import { createApp } from '../src/app-server.ts';
import { resetEnvCacheForTesting } from '../src/lib/env.ts';
import { sha256Hex } from '../src/lib/oauth-crypto.ts';
import { resetRateLimitBuckets } from '../src/lib/resilience.ts';
import type { VerifiedFirebaseIdentity } from '../src/middleware/auth.ts';

const MIGRATION_0000 = fs.readFileSync(
  path.resolve(process.cwd(), 'drizzle/0000_mission001_security_hardening.sql'),
  'utf8'
);
const MIGRATION_0001 = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'drizzle/0001_mission001_6_security_remediation.sql'
  ),
  'utf8'
);

async function applySqlMigration(pg: PGlite, sqlText: string): Promise<void> {
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await pg.exec(stmt);
  }
}

function signGithubPayload(rawBody: string, secret: string): string {
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex')}`;
}

function signSlackPayload(
  rawBody: string,
  timestamp: string,
  secret: string
): string {
  return `v0=${crypto
    .createHmac('sha256', secret)
    .update(
      Buffer.concat([
        Buffer.from(`v0:${timestamp}:`, 'utf8'),
        Buffer.from(rawBody, 'utf8'),
      ])
    )
    .digest('hex')}`;
}

describe('Mission 001.6 — Real PostgreSQL 16 Integration, Migration & Fail-Closed Suite', () => {
  const originalEnv = { ...process.env };

  after(() => {
    setDbInstanceForTesting(null);
    process.env = originalEnv;
  });

  // =========================================================================
  // 1. REAL POSTGRESQL MIGRATION TESTS (CLEAN + POPULATED + DUPLICATES + IDEMPOTENT)
  // =========================================================================
  describe('1. Non-Destructive Incremental Migrations on PostgreSQL 16', () => {
    it('executes 0000 + 0001 cleanly on an empty PostgreSQL 16 database and is idempotent on re-run', async () => {
      const pg = new PGlite();
      try {
        await applySqlMigration(pg, MIGRATION_0000);
        await applySqlMigration(pg, MIGRATION_0001);
        // Re-running 0001 must succeed cleanly (idempotent DDL)
        await applySqlMigration(pg, MIGRATION_0001);

        const tablesRes = await pg.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`
        );
        const tables = tablesRes.rows.map((r) => r.tablename);
        assert.ok(tables.includes('oauth_states'));
        assert.ok(tables.includes('user_connector_connections'));
        assert.ok(tables.includes('security_audit_logs'));
        assert.ok(tables.includes('semantic_cache'));
        assert.ok(tables.includes('user_progress'));

        const defaultRoleRes = await pg.query<{ column_default: string }>(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role';`
        );
        assert.match(defaultRoleRes.rows[0].column_default, /'Engineer'/);
      } finally {
        await pg.close();
      }
    });

    it('preserves existing production data, deduplicates legacy user_progress rows, and isolates legacy semantic_cache v1 rows', async () => {
      const pg = new PGlite();
      const pgliteDb = drizzle(pg, { schema });
      try {
        // Apply pre-001.6 schema (0000) and populate realistic pre-existing production data
        await applySqlMigration(pg, MIGRATION_0000);

        await pg.exec(`
          INSERT INTO users (uid, email, display_name, role) VALUES
            ('uid-prod-admin', 'founder@acme.com', 'Founder Admin', 'Admin'),
            ('uid-prod-eng', 'dev@acme.com', 'Senior Dev', 'Engineer');

          INSERT INTO documents (title, source_type, access_level, chunk_count, content_preview) VALUES
            ('Legacy Production Runbook', 'file', 'Admin', 1, 'Critical production data that must be preserved.');

          INSERT INTO document_chunks (document_id, chunk_index, content, embedding) VALUES
            (1, 0, 'Critical production chunk content', '[0.1, 0.2, 0.3]'::jsonb);

          INSERT INTO onboarding_tracks (phase, title, description, category, target_role, estimated_minutes, sort_order) VALUES
            ('Day 1', 'SSO Setup', 'Configure SSO', 'Security', 'Engineer', 20, 1);

          -- Duplicate legacy (user_handle, track_id) rows prior to Mission 001.6
          INSERT INTO user_progress (user_handle, display_name, engineer_role, track_id, completed, updated_at) VALUES
            ('@legacy.hire', 'Legacy Hire', 'Backend', 1, false, NOW() - INTERVAL '2 days'),
            ('@legacy.hire', 'Legacy Hire', 'Backend', 1, true, NOW() - INTERVAL '1 hour');

          INSERT INTO semantic_cache (query_text, query_embedding, answer, sources, confidence, hit_count) VALUES
            ('legacy unpartitioned query', '[0.5, 0.5]'::jsonb, 'LEGACY_ADMIN_ANSWER_NEVER_SERVE', '["Admin Doc"]'::jsonb, 99, 5);

          INSERT INTO security_audit_logs (actor_uid, actor_role, action, target_resource, outcome) VALUES
            ('uid-prod-admin', 'Admin', 'role.changed', 'user:uid-prod-eng', 'success');
        `);

        // Apply Mission 001.6 incremental migration
        await applySqlMigration(pg, MIGRATION_0001);

        // 1. Existing Admin, documents, chunks, and audit logs are 100% preserved
        const users = await pg.query<{ uid: string; role: string }>(
          `SELECT uid, role FROM users ORDER BY uid;`
        );
        assert.equal(users.rows.length, 2);
        assert.equal(
          users.rows.find((u) => u.uid === 'uid-prod-admin')?.role,
          'Admin'
        );

        const docs = await pg.query<{ title: string }>(
          `SELECT title FROM documents;`
        );
        assert.equal(docs.rows[0].title, 'Legacy Production Runbook');

        const audits = await pg.query<{ action: string }>(
          `SELECT action FROM security_audit_logs;`
        );
        assert.equal(audits.rows.length, 1);

        // 2. Duplicate legacy user_progress rows safely deduplicated keeping newest (completed = true)
        const progressRows = await pg.query<{
          user_handle: string;
          completed: boolean;
        }>(`SELECT user_handle, completed FROM user_progress;`);
        assert.equal(progressRows.rows.length, 1);
        assert.equal(progressRows.rows[0].completed, true);

        // 3. Legacy semantic_cache row tagged cache_version = 1 and NEVER served to v2 lookup
        const legacyCache = await pg.query<{
          cache_version: number;
          required_role: string;
        }>(`SELECT cache_version, required_role FROM semantic_cache;`);
        assert.equal(legacyCache.rows[0].cache_version, 1);

        setDbInstanceForTesting(pgliteDb as unknown as Parameters<typeof setDbInstanceForTesting>[0]);
        resetSecurityFallbackStoresForTesting();
        const lookup = await lookupSemanticCache(
          'legacy unpartitioned query',
          'Admin',
          'hybrid_rrf'
        );
        assert.equal(
          lookup.hit,
          false,
          'Legacy cache_version=1 rows must NEVER be returned to v2 lookups'
        );
      } finally {
        setDbInstanceForTesting(null);
        await pg.close();
      }
    });
  });

  // =========================================================================
  // 2. REAL POSTGRESQL SECURITY INVARIANTS (TRIGGER, CACHE L2, ATOMIC OAUTH, WEBHOOKS, UID ISOLATION)
  // =========================================================================
  describe('2. Real PostgreSQL 16 Data-Plane Security Invariants', () => {
    let pg: PGlite;

    before(async () => {
      process.env.NODE_ENV = 'test';
      process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
      pg = new PGlite();
      await applySqlMigration(pg, MIGRATION_0000);
      await applySqlMigration(pg, MIGRATION_0001);
      setDbInstanceForTesting(
        drizzle(pg, { schema }) as unknown as Parameters<typeof setDbInstanceForTesting>[0]
      );
    });

    after(async () => {
      setDbInstanceForTesting(null);
      await pg.close();
    });

    beforeEach(() => {
      resetSecurityFallbackStoresForTesting();
    });

    it('AUD-014: enforces DB-level append-only trigger on security_audit_logs (rejects UPDATE & DELETE with SQLSTATE 42501)', async () => {
      const inserted = await recordSecurityAuditEvent({
        actorUid: 'uid-pg-admin',
        actorEmail: 'pgadmin@acme.com',
        actorRole: 'Admin',
        action: 'role.changed',
        targetResource: 'user:uid-target',
        outcome: 'success',
        requestId: 'req-pg-audit-1',
        metadata: { previousRole: 'Engineer', newRole: 'Manager' },
      });
      assert.ok(inserted.id > 0);

      // Direct SQL UPDATE must fail with 42501 (insufficient_privilege)
      await assert.rejects(
        () =>
          pg.query(
            `UPDATE security_audit_logs SET action = 'tampered' WHERE id = $1;`,
            [inserted.id]
          ),
        (err: { code?: string; message?: string }) =>
          err.code === '42501' || /append-only/i.test(err.message || '')
      );

      // Direct SQL DELETE must fail with 42501 (insufficient_privilege)
      await assert.rejects(
        () =>
          pg.query(`DELETE FROM security_audit_logs WHERE id = $1;`, [
            inserted.id,
          ]),
        (err: { code?: string; message?: string }) =>
          err.code === '42501' || /append-only/i.test(err.message || '')
      );

      // Row remains completely intact
      const check = await pg.query<{ action: string }>(
        `SELECT action FROM security_audit_logs WHERE id = $1;`,
        [inserted.id]
      );
      assert.equal(check.rows[0].action, 'role.changed');
    });

    it('AUD-001 & AUD-002: enforces L2 PostgreSQL semantic cache isolation by role and searchMode', async () => {
      const query = 'Explain internal executive disaster recovery KMS keys';
      const secretAnswer = 'ADMIN_ONLY_KMS_ANSWER_7744';

      await storeInSemanticCache({
        query,
        role: 'Admin',
        searchMode: 'hybrid_rrf',
        answer: secretAnswer,
        sources: ['Admin KMS Spec'],
        confidence: 97,
      });

      // Clear L1 memory cache so lookups MUST execute SQL against PostgreSQL L2
      resetSecurityFallbackStoresForTesting();

      // Engineer lookup against PostgreSQL L2 -> MISS
      const engHit = await lookupSemanticCache(query, 'Engineer', 'hybrid_rrf');
      assert.equal(engHit.hit, false);

      // Manager lookup against PostgreSQL L2 -> MISS
      const mgrHit = await lookupSemanticCache(query, 'Manager', 'hybrid_rrf');
      assert.equal(mgrHit.hit, false);

      // Admin lookup with different searchMode -> MISS
      const wrongModeHit = await lookupSemanticCache(
        query,
        'Admin',
        'sparse_bm25'
      );
      assert.equal(wrongModeHit.hit, false);

      // Admin lookup with matching role & searchMode -> HIT from PostgreSQL L2
      const adminHit = await lookupSemanticCache(query, 'Admin', 'hybrid_rrf');
      assert.equal(adminHit.hit, true);
      assert.equal(adminHit.answer, secretAnswer);

      // Telemetry check against PostgreSQL L2
      const mgrTelemetry = await getSemanticCacheTelemetry('Manager');
      assert.equal(mgrTelemetry.entries.length, 0);
      assert.equal(mgrTelemetry.summary.byRole.Admin, undefined);

      const adminTelemetry = await getSemanticCacheTelemetry('Admin');
      assert.ok(adminTelemetry.entries.length >= 1);
      assert.ok(!JSON.stringify(adminTelemetry).includes(secretAnswer));
    });

    it('AUD-004: guarantees atomic single-use OAuth state consumption under concurrency and AES-256-GCM token encryption at rest', async () => {
      const rawState = 'concurrent_state_token_value_1234567890';
      const stateHash = sha256Hex(rawState);

      await createOAuthState({
        stateHash,
        provider: 'github',
        actorUid: 'uid-mgr-pg',
        actorRole: 'Manager',
        bindingHash: sha256Hex('nonce-xyz'),
        codeVerifier: 'pkce-secret-verifier-abcdef',
        targetOrigin: 'https://console.acme.com',
        redirectUri: 'https://console.acme.com/auth/github/callback',
        expiresAt: new Date(Date.now() + 600_000),
      });

      // Concurrent callback race against real PostgreSQL UPDATE ... WHERE consumed_at IS NULL RETURNING *
      const [r1, r2] = await Promise.all([
        consumeOAuthStateAtomic(stateHash),
        consumeOAuthStateAtomic(stateHash),
      ]);
      const successes = [r1, r2].filter((r) => r !== null);
      assert.equal(
        successes.length,
        1,
        'Exactly ONE concurrent callback may consume a single-use OAuth state'
      );
      assert.equal(successes[0]!.codeVerifier, 'pkce-secret-verifier-abcdef');

      // Store per-user OAuth token and verify ciphertext in PostgreSQL (never plaintext!)
      const plaintextToken = 'gho_super_secret_token_do_not_store_plain_42';
      await upsertUserConnectorConnection({
        userUid: 'uid-mgr-pg',
        provider: 'github',
        externalUsername: '@mgr-octocat',
        accessToken: plaintextToken,
      });

      const rawDbRow = await pg.query<{ encrypted_access_token: string }>(
        `SELECT encrypted_access_token FROM user_connector_connections WHERE user_uid = 'uid-mgr-pg' AND provider = 'github';`
      );
      assert.equal(rawDbRow.rows.length, 1);
      assert.ok(rawDbRow.rows[0].encrypted_access_token.startsWith('v1.'));
      assert.ok(
        !rawDbRow.rows[0].encrypted_access_token.includes(plaintextToken),
        'OAuth token must be encrypted at rest in PostgreSQL'
      );

      // Owner decrypts cleanly; another user gets null
      const ownConn = await getUserConnectorConnection('uid-mgr-pg', 'github');
      assert.equal(ownConn?.accessToken, plaintextToken);
      const otherConn = await getUserConnectorConnection(
        'uid-other-pg',
        'github'
      );
      assert.equal(otherConn, null);
    });

    it('AUD-008 & AUD-009: guarantees atomic concurrent webhook delivery deduplication in PostgreSQL', async () => {
      const [first, second] = await Promise.all([
        recordWebhookDeliveryIfNew({
          provider: 'github',
          deliveryId: 'concurrent-deliv-uuid-001',
          eventType: 'push',
        }),
        recordWebhookDeliveryIfNew({
          provider: 'github',
          deliveryId: 'concurrent-deliv-uuid-001',
          eventType: 'push',
        }),
      ]);
      const newCount = [first, second].filter((r) => r.isNew).length;
      assert.equal(
        newCount,
        1,
        'Exactly ONE concurrent webhook delivery with identical deliveryId may be treated as new'
      );
    });

    it('AUD-013: isolates user_progress by user_uid in PostgreSQL with zero unique-index collision for identical email local-parts', async () => {
      await toggleOnboardingMilestone({
        userUid: 'uid-alice-pg-1',
        userHandle: '@alice',
        displayName: 'Alice One',
        trackId: 1,
        completed: true,
      });

      // Second user with identical @alice handle and same trackId=1 must NOT collide!
      await toggleOnboardingMilestone({
        userUid: 'uid-alice-pg-2',
        userHandle: '@alice',
        displayName: 'Alice Two',
        trackId: 1,
        completed: false,
      });

      const p1 = await getOnboardingPayload({
        userUid: 'uid-alice-pg-1',
        userHandle: '@alice',
        role: 'Engineer',
      });
      const p2 = await getOnboardingPayload({
        userUid: 'uid-alice-pg-2',
        userHandle: '@alice',
        role: 'Engineer',
      });

      assert.equal(p1.cohort.length, 1);
      assert.equal(p1.cohort[0].userUid, 'uid-alice-pg-1');
      assert.equal(p1.cohort[0].progressByTrackId[1]?.completed, true);

      assert.equal(p2.cohort.length, 1);
      assert.equal(p2.cohort[0].userUid, 'uid-alice-pg-2');
      assert.equal(p2.cohort[0].progressByTrackId[1]?.completed, false);

      // Brand-new Engineer with no progress rows sees empty cohort (never another user)
      const p3 = await getOnboardingPayload({
        userUid: 'uid-brand-new-pg',
        userHandle: '@newbie',
        role: 'Engineer',
      });
      assert.equal(p3.cohort.length, 0);
    });

    it('persists authoritative user roles in PostgreSQL and reads them back cleanly', async () => {
      await getOrCreateUser('uid-pg-user-1', 'u1@acme.com', 'User One', 'Engineer');
      const fetched = await getUserByUid('uid-pg-user-1');
      assert.equal(fetched?.role, 'Engineer');
    });
  });

  // =========================================================================
  // 3. PRODUCTION FAIL-CLOSED PERSISTENCE OUTAGE SUITE (AUD-003)
  // =========================================================================
  describe('3. AUD-003 Production Database Failure Fail-Closed Enforcement (HTTP 503)', () => {
    let baseUrl = '';
    let server: ReturnType<ReturnType<typeof createApp>['listen']>;

    const TOKENS: Record<string, VerifiedFirebaseIdentity> = {
      'prod-admin-tok-0001': {
        uid: 'uid-prod-admin',
        email: 'admin@prod.example',
        email_verified: true,
        name: 'Prod Admin',
      },
      'prod-eng-tok-0001': {
        uid: 'uid-prod-eng',
        email: 'eng@prod.example',
        email_verified: true,
        name: 'Prod Engineer',
      },
    };

    // A DB client where every Drizzle query rejects with ECONNREFUSED
    const failingDbStub = new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
          };
        },
      }
    );

    before(async () => {
      process.env.NODE_ENV = 'test';
      setDbInstanceForTesting(failingDbStub as never);

      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://app_user:secret@10.0.0.5:5432/hippocampus';
      process.env.APP_URL = 'https://hippocampus.prod.example';
      process.env.ALLOWED_ORIGINS = 'https://hippocampus.prod.example';
      process.env.GITHUB_WEBHOOK_SECRET = 'prod_github_webhook_secret_32bytes_min';
      process.env.SLACK_SIGNING_SECRET = 'prod_slack_signing_secret_32bytes_min';
      process.env.GITHUB_CLIENT_ID = 'prod_gh_client';
      process.env.GITHUB_CLIENT_SECRET = 'prod_gh_secret';
      process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);
      process.env.OAUTH_STATE_COOKIE_SECRET = 'e'.repeat(64);
      delete process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK;
      resetEnvCacheForTesting();
      resetRateLimitBuckets();

      const app = createApp({
        authOptions: {
          verifyIdToken: async (token) => {
            const id = TOKENS[token];
            if (!id) throw new Error('invalid token');
            return id;
          },
          // Resolve user directly for testing route-level DB failures AFTER auth
          resolveUserByUid: async (uid) => {
            if (uid === 'uid-prod-admin') {
              return {
                id: 1,
                uid,
                email: 'admin@prod.example',
                displayName: 'Prod Admin',
                role: 'Admin',
                createdAt: new Date(),
              };
            }
            if (uid === 'uid-prod-eng') {
              return {
                id: 2,
                uid,
                email: 'eng@prod.example',
                displayName: 'Prod Engineer',
                role: 'Engineer',
                createdAt: new Date(),
              };
            }
            return null;
          },
        },
      });

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setDbInstanceForTesting(null);
      process.env = { ...originalEnv };
      resetEnvCacheForTesting();
    });

    it('returns HTTP 503 (never silent 200/201) across mutations, reads, webhooks, OAuth, and audit writes when PostgreSQL is unavailable in production', async () => {
      // 1. Document ingestion fails closed 503
      const ingestRes = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer prod-admin-tok-0001',
        },
        body: JSON.stringify({
          title: 'Test Doc',
          sourceType: 'file',
          accessLevel: 'Engineer',
          content: 'Must fail closed when DB is down in production.',
        }),
      });
      assert.equal(ingestRes.status, 503);

      // 2. Document deletion fails closed 503
      const delRes = await fetch(`${baseUrl}/api/documents/1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer prod-admin-tok-0001' },
      });
      assert.equal(delRes.status, 503);

      // 3. Settings update fails closed 503
      const settingsRes = await fetch(
        `${baseUrl}/api/settings/strict_citation_enforcement`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer prod-admin-tok-0001',
          },
          body: JSON.stringify({ enabled: false }),
        }
      );
      assert.equal(settingsRes.status, 503);

      // 4. Onboarding mutation fails closed 503
      const progRes = await fetch(`${baseUrl}/api/onboarding/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer prod-admin-tok-0001',
        },
        body: JSON.stringify({ trackId: 1, completed: true }),
      });
      assert.equal(progRes.status, 503);

      // 5. GitHub OAuth initiation fails closed 503 (cannot persist state)
      const oauthRes = await fetch(`${baseUrl}/api/connectors/github/auth-url`, {
        headers: { Authorization: 'Bearer prod-admin-tok-0001' },
      });
      assert.equal(oauthRes.status, 503);

      // 6. Audit logs read fails closed 503
      const auditRes = await fetch(`${baseUrl}/api/audit-logs`, {
        headers: { Authorization: 'Bearer prod-admin-tok-0001' },
      });
      assert.equal(auditRes.status, 503);

      // 7. Signed GitHub webhook fails closed 503 when idempotency DB is down
      const ghBody = JSON.stringify({
        ref: 'refs/heads/main',
        after: 'abcdef1234',
        repository: { full_name: 'org/prod-repo' },
      });
      const ghRes = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'prod-deliv-outage-001',
          'x-hub-signature-256': signGithubPayload(
            ghBody,
            process.env.GITHUB_WEBHOOK_SECRET!
          ),
        },
        body: ghBody,
      });
      assert.equal(ghRes.status, 503);

      // 8. Signed Slack webhook fails closed 503 when idempotency DB is down
      const nowSec = String(Math.floor(Date.now() / 1000));
      const slackBody = JSON.stringify({
        type: 'event_callback',
        event_id: 'Ev_PROD_OUTAGE_01',
        event: {
          type: 'app_mention',
          channel: '#eng',
          user: 'U1',
          text: '<@U2> help',
        },
      });
      const slackRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': nowSec,
          'x-slack-signature': signSlackPayload(
            slackBody,
            nowSec,
            process.env.SLACK_SIGNING_SECRET!
          ),
        },
        body: slackBody,
      });
      assert.equal(slackRes.status, 503);

      // 9. Denied RBAC check fails closed 503 when audit log cannot be persisted in production
      const deniedAuditOutage = await fetch(`${baseUrl}/api/audit-logs`, {
        headers: { Authorization: 'Bearer prod-eng-tok-0001' },
      });
      assert.equal(deniedAuditOutage.status, 503);
    });
  });
});
