import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app-server.ts';
import {
  getOrCreateUser,
  ingestDocument,
  resetSecurityFallbackStoresForTesting,
} from '../src/db/queries.ts';
import {
  assertSafeProductionConfig,
  resetEnvCacheForTesting,
} from '../src/lib/env.ts';
import {
  getObservabilityMetrics,
  recordAgentToolCall,
  recordCacheEvent,
  sanitizeRequestId,
} from '../src/lib/logger.ts';
import { resetRateLimitBuckets } from '../src/lib/resilience.ts';
import type { VerifiedFirebaseIdentity } from '../src/middleware/auth.ts';

function signGithubPayload(rawBody: string, secret: string): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(rawBody, 'utf8'))
    .digest('hex');
  return `sha256=${digest}`;
}

function signSlackPayload(
  rawBody: string,
  timestamp: string,
  secret: string
): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), Buffer.from(rawBody, 'utf8')]))
    .digest('hex');
  return `v0=${digest}`;
}

const VALID_TOKENS: Record<string, VerifiedFirebaseIdentity> = {
  'valid-admin-token-0001': {
    uid: 'uid-admin-1',
    email: 'admin@hippocampus.internal',
    email_verified: true,
    name: 'Principal Admin',
  },
  'valid-manager-token-0001': {
    uid: 'uid-manager-1',
    email: 'manager@hippocampus.internal',
    email_verified: true,
    name: 'Engineering Manager',
  },
  'valid-engineer-token-0001': {
    uid: 'uid-engineer-1',
    email: 'alex.chen@hippocampus.internal',
    email_verified: true,
    name: 'Alex Chen',
  },
  'valid-unknown-token-0001': {
    uid: 'uid-unknown-999',
    email: 'stranger@hippocampus.internal',
    email_verified: true,
    name: 'Unprovisioned User',
  },
  'valid-bootstrap-token-0001': {
    uid: 'uid-bootstrap-1',
    email: 'bootstrap.admin@hippocampus.internal',
    email_verified: true,
    name: 'Bootstrap Admin',
  },
  'valid-bootstrap-unverified-0001': {
    uid: 'uid-bootstrap-unverified',
    email: 'bootstrap.admin@hippocampus.internal',
    email_verified: false,
    name: 'Unverified Bootstrap Attacker',
  },
  'valid-alice-acme-0001': {
    uid: 'uid-alice-acme',
    email: 'alice@acme.internal',
    email_verified: true,
    name: 'Alice Acme',
  },
  'valid-alice-other-0001': {
    uid: 'uid-alice-other',
    email: 'alice@other.internal',
    email_verified: true,
    name: 'Alice Other',
  },
};

let simulateAuthOutage = false;
let githubFetchCount = 0;
let lastGithubSyncToken: string | undefined;
let oauthExchangeBehavior:
  | 'success'
  | 'xss_username'
  | 'token_http_error'
  | 'token_missing'
  | 'profile_http_error' = 'success';

async function mockVerifyIdToken(
  token: string
): Promise<VerifiedFirebaseIdentity> {
  if (simulateAuthOutage) {
    const err = new Error('Firebase Auth service unavailable') as Error & {
      code?: string;
    };
    err.code = 'auth/internal-error';
    throw err;
  }
  if (token === 'expired-firebase-token-0001') {
    const err = new Error('Token expired') as Error & { code?: string };
    err.code = 'auth/id-token-expired';
    throw err;
  }
  if (token === 'revoked-firebase-token-0001') {
    const err = new Error('Token revoked') as Error & { code?: string };
    err.code = 'auth/id-token-revoked';
    throw err;
  }
  const identity = VALID_TOKENS[token];
  if (!identity) {
    const err = new Error('Invalid Firebase ID token') as Error & {
      code?: string;
    };
    err.code = 'auth/invalid-id-token';
    throw err;
  }
  return identity;
}

describe('Mission 001 — Enterprise Security Hardening Adversarial Suite', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  const originalEnv = { ...process.env };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_WEBHOOK_SECRET = 'test_github_webhook_secret_32bytes_min';
    process.env.SLACK_SIGNING_SECRET = 'test_slack_signing_secret_32bytes_min';
    process.env.BOOTSTRAP_ADMIN_EMAILS = 'bootstrap.admin@hippocampus.internal';
    process.env.ALLOWED_ORIGINS = 'https://console.hippocampus.example';
    delete process.env.GITHUB_ALLOWED_REPOS;
    resetEnvCacheForTesting();

    const app = createApp({
      authOptions: {
        verifyIdToken: mockVerifyIdToken,
      },
      githubWebhookFetcher: async (repoFullName, branch, token) => {
        githubFetchCount += 1;
        lastGithubSyncToken = token ?? undefined;
        return {
          commitSha: 'a1b2c3d',
          liveApiUsed: false,
          files: [
            {
              path: 'docs/SECURITY_RUNBOOK.md',
              title: `${repoFullName} — docs/SECURITY_RUNBOOK.md`,
              sourceUrl: `https://github.com/${repoFullName}/blob/${branch}/docs/SECURITY_RUNBOOK.md`,
              content:
                '# Security Runbook\nVerified webhook ingestion pipeline with HMAC-SHA256 raw body verification.',
              sha: 'a1b2c3d',
            },
          ],
        };
      },
      githubOAuthExchangeFetcher: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/login/oauth/access_token')) {
          if (oauthExchangeBehavior === 'token_http_error') {
            return new Response('Upstream error', { status: 500 });
          }
          if (oauthExchangeBehavior === 'token_missing') {
            return new Response(
              JSON.stringify({ error: 'bad_verification_code' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              access_token: 'gho_manager_private_oauth_token_99887766',
              token_type: 'bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('api.github.com/user')) {
          if (oauthExchangeBehavior === 'profile_http_error') {
            return new Response('Unauthorized', { status: 401 });
          }
          const login =
            oauthExchangeBehavior === 'xss_username'
              ? 'octo</script><script>alert(1)</script>'
              : 'octocat-manager';
          return new Response(JSON.stringify({ login }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
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
    process.env = originalEnv;
  });

  beforeEach(async () => {
    simulateAuthOutage = false;
    githubFetchCount = 0;
    lastGithubSyncToken = undefined;
    oauthExchangeBehavior = 'success';
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_WEBHOOK_SECRET = 'test_github_webhook_secret_32bytes_min';
    process.env.SLACK_SIGNING_SECRET = 'test_slack_signing_secret_32bytes_min';
    process.env.ALLOWED_ORIGINS = 'https://console.hippocampus.example';
    delete process.env.GITHUB_ALLOWED_REPOS;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.APP_URL;
    delete process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
    delete process.env.OAUTH_STATE_COOKIE_SECRET;
    delete process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK;
    resetEnvCacheForTesting();
    resetRateLimitBuckets();
    resetSecurityFallbackStoresForTesting();

    await getOrCreateUser(
      'uid-admin-1',
      'admin@hippocampus.internal',
      'Principal Admin',
      'Admin'
    );
    await getOrCreateUser(
      'uid-manager-1',
      'manager@hippocampus.internal',
      'Engineering Manager',
      'Manager'
    );
    await getOrCreateUser(
      'uid-engineer-1',
      'alex.chen@hippocampus.internal',
      'Alex Chen',
      'Engineer'
    );
  });

  // =========================================================================
  // 8.1 AUTHENTICATION TESTS
  // =========================================================================
  describe('8.1 Trusted Authentication & Fail-Closed Behavior', () => {
    it('rejects missing token with 401 on protected routes', async () => {
      const routes: Array<[string, string]> = [
        ['GET', '/api/overview'],
        ['GET', '/api/documents'],
        ['DELETE', '/api/documents/1'],
        ['PATCH', '/api/auth/role'],
        ['GET', '/api/audit-logs'],
        ['PATCH', '/api/settings/strict_citation_enforcement'],
        ['POST', '/api/chat'],
      ];

      for (const [method, path] of routes) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-hippocampus-role': 'Admin',
            'x-operator-identity': 'forged-admin',
          },
          body:
            method === 'GET' || method === 'DELETE'
              ? undefined
              : JSON.stringify({}),
        });
        assert.equal(
          res.status,
          401,
          `Expected 401 for unauthenticated ${method} ${path}, got ${res.status}`
        );
      }
    });

    it('rejects invalid token with 401', async () => {
      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Authorization: 'Bearer totally-invalid-token-value' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects expired token with 401', async () => {
      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Authorization: 'Bearer expired-firebase-token-0001' },
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /expired/i);
    });

    it('rejects revoked token with 401', async () => {
      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: { Authorization: 'Bearer revoked-firebase-token-0001' },
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /revoked/i);
    });

    it('rejects malformed Authorization headers with 401', async () => {
      const malformedHeaders = [
        'Basic dXNlcjpwYXNz',
        'Bearer',
        'Bearer short',
        'Bearer token with spaces',
        'raw-jwt-without-bearer-prefix',
      ];
      for (const header of malformedHeaders) {
        const res = await fetch(`${baseUrl}/api/documents`, {
          headers: { Authorization: header },
        });
        assert.equal(
          res.status,
          401,
          `Expected 401 for malformed Authorization="${header}", got ${res.status}`
        );
      }
    });

    it('valid Firebase token resolves the authoritative database user and ignores forged headers', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: {
          Authorization: 'Bearer valid-engineer-token-0001',
          'x-hippocampus-role': 'Admin',
          'x-operator-identity': 'root-admin',
        },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        user: { uid: string; role: string };
      };
      assert.equal(body.user.uid, 'uid-engineer-1');
      assert.equal(body.user.role, 'Engineer');
    });

    it('denies unprovisioned unknown Firebase user on protected routes (403) and onboards strictly as Engineer', async () => {
      // Unknown user cannot access privileged routes prior to onboarding
      const deniedRes = await fetch(`${baseUrl}/api/documents`, {
        headers: {
          Authorization: 'Bearer valid-unknown-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(deniedRes.status, 403);

      // Even if DEFAULT_RBAC_ROLE=Admin is set in env, new users MUST default to Engineer
      process.env.DEFAULT_RBAC_ROLE = 'Admin';
      resetEnvCacheForTesting();

      const syncRes = await fetch(`${baseUrl}/api/auth/sync`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-unknown-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(syncRes.status, 200);
      const syncBody = (await syncRes.json()) as {
        user: { uid: string; role: string };
      };
      assert.equal(syncBody.user.uid, 'uid-unknown-999');
      assert.equal(syncBody.user.role, 'Engineer');
    });

    it('provisions explicit BOOTSTRAP_ADMIN_EMAILS identity as Admin during controlled onboarding', async () => {
      const syncRes = await fetch(`${baseUrl}/api/auth/sync`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-bootstrap-token-0001',
        },
      });
      assert.equal(syncRes.status, 200);
      const syncBody = (await syncRes.json()) as {
        user: { uid: string; role: string };
      };
      assert.equal(syncBody.user.role, 'Admin');
    });

    it('fails closed with 503 when Firebase verification service is unavailable', async () => {
      simulateAuthOutage = true;
      const res = await fetch(`${baseUrl}/api/documents`, {
        headers: {
          Authorization: 'Bearer valid-admin-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(res.status, 503);
    });
  });

  // =========================================================================
  // 8.2 RBAC ADVERSARIAL TESTS
  // =========================================================================
  describe('8.2 RBAC Adversarial Escalation & Authorization Matrix', () => {
    it('denies unauthenticated caller requesting Admin routes (401)', async () => {
      const delRes = await fetch(`${baseUrl}/api/documents/1`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 401);

      const settingsRes = await fetch(
        `${baseUrl}/api/settings/strict_citation_enforcement`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        }
      );
      assert.equal(settingsRes.status, 401);
    });

    it('denies Engineer sending x-hippocampus-role: Admin on Admin endpoints (403)', async () => {
      const res = await fetch(`${baseUrl}/api/audit-logs`, {
        headers: {
          Authorization: 'Bearer valid-engineer-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(res.status, 403);
    });

    it('denies Manager sending x-hippocampus-role: Admin on Admin endpoints (403)', async () => {
      const delRes = await fetch(`${baseUrl}/api/documents/1`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-manager-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(delRes.status, 403);

      const settingsRes = await fetch(
        `${baseUrl}/api/settings/strict_citation_enforcement`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid-manager-token-0001',
            'x-hippocampus-role': 'Admin',
          },
          body: JSON.stringify({ enabled: false }),
        }
      );
      assert.equal(settingsRes.status, 403);
    });

    it('denies Engineer calling protected delete endpoint (403)', async () => {
      const res = await fetch(`${baseUrl}/api/documents/1`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-engineer-token-0001',
        },
      });
      assert.equal(res.status, 403);
    });

    it('denies Engineer attempting to change own role (403)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-engineer-token-0001',
          'x-hippocampus-role': 'Admin',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Admin',
        }),
      });
      assert.equal(res.status, 403);
    });

    it('denies Manager attempting to promote self to Admin (403)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-manager-token-0001',
          'x-hippocampus-role': 'Admin',
        },
        body: JSON.stringify({
          targetUid: 'uid-manager-1',
          role: 'Admin',
        }),
      });
      assert.equal(res.status, 403);
    });

    it('denies unauthenticated caller calling /api/auth/role (401)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-hippocampus-role': 'Admin',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Admin',
        }),
      });
      assert.equal(res.status, 401);
    });

    it('denies non-admin modifying another user role (403)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-manager-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Manager',
        }),
      });
      assert.equal(res.status, 403);
    });

    it('denies Admin attempting self-role modification (403)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-admin-1',
          role: 'Engineer',
        }),
      });
      assert.equal(res.status, 403);
    });

    it('allows Admin to perform an authorized role change on another user and persists it', async () => {
      const res = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Manager',
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { user: { role: string } };
      assert.equal(body.user.role, 'Manager');

      // Verify target user now resolves as Manager
      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: 'Bearer valid-engineer-token-0001' },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as { user: { role: string } };
      assert.equal(meBody.user.role, 'Manager');
    });

    it('enforces resource-level permissions: Engineer reads permitted docs, blocked from Admin docs and cross-user onboarding edits', async () => {
      const adminDocsRes = await fetch(`${baseUrl}/api/documents`, {
        headers: { Authorization: 'Bearer valid-admin-token-0001' },
      });
      assert.equal(adminDocsRes.status, 200);
      const adminDocs = (await adminDocsRes.json()) as {
        documents: Array<{ accessLevel: string }>;
      };

      const engDocsRes = await fetch(`${baseUrl}/api/documents`, {
        headers: {
          Authorization: 'Bearer valid-engineer-token-0001',
          'x-hippocampus-role': 'Admin',
        },
      });
      assert.equal(engDocsRes.status, 200);
      const engDocs = (await engDocsRes.json()) as {
        documents: Array<{ accessLevel: string }>;
      };

      assert.ok(engDocs.documents.length > 0);
      assert.ok(adminDocs.documents.length > engDocs.documents.length);
      assert.ok(
        engDocs.documents.every((d) => d.accessLevel === 'Engineer'),
        'Engineer must never receive Manager or Admin documents'
      );

      // Engineer cannot check off another user's onboarding milestone
      const crossUserProgress = await fetch(
        `${baseUrl}/api/onboarding/progress`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid-engineer-token-0001',
          },
          body: JSON.stringify({
            userHandle: '@sarah.kim',
            trackId: 1,
            completed: true,
          }),
        }
      );
      assert.equal(crossUserProgress.status, 403);

      // Engineer CAN update their own onboarding milestone
      const selfProgress = await fetch(`${baseUrl}/api/onboarding/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-engineer-token-0001',
        },
        body: JSON.stringify({
          userHandle: '@alex.chen',
          trackId: 1,
          completed: true,
        }),
      });
      assert.equal(selfProgress.status, 200);
    });
  });

  // =========================================================================
  // 8.3 WEBHOOK SECURITY TESTS
  // =========================================================================
  describe('8.3 GitHub Webhook HMAC Integrity & Simulator Isolation', () => {
    const samplePayload = JSON.stringify({
      ref: 'refs/heads/main',
      after: '9f8e7d6c5b4a',
      repository: {
        full_name: 'Uchiha7madara-afk/Hippocampus_AI',
        html_url: 'https://github.com/Uchiha7madara-afk/Hippocampus_AI',
      },
      commits: [{ id: '9f8e7d6c5b4a', message: 'docs: update security guide' }],
    });

    it('1. rejects missing signature with 401', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-missing-sig',
        },
        body: samplePayload,
      });
      assert.equal(res.status, 401);
    });

    it('2. rejects invalid signature with 401', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-invalid-sig',
          'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        },
        body: samplePayload,
      });
      assert.equal(res.status, 401);
    });

    it('3. rejects malformed signatures with 401', async () => {
      const malformed = [
        'sha1=deadbeef',
        'sha256=not-hex-characters',
        'sha256=abcd1234',
        'plain-text',
      ];
      for (const sig of malformed) {
        const res = await fetch(`${baseUrl}/api/webhooks/github`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-github-event': 'push',
            'x-hub-signature-256': sig,
          },
          body: samplePayload,
        });
        assert.equal(res.status, 401, `Expected 401 for malformed sig=${sig}`);
      }
    });

    it('4. rejects payload signed with incorrect secret (401)', async () => {
      const wrongSig = signGithubPayload(samplePayload, 'wrong_secret_value_123456');
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': wrongSig,
        },
        body: samplePayload,
      });
      assert.equal(res.status, 401);
    });

    it('5. accepts valid HMAC-SHA256 signature computed over exact non-canonical raw bytes', async () => {
      // Non-canonical whitespace proves raw Buffer verification rather than JSON.stringify(req.body)
      const nonCanonicalRaw = `{  "ref" : "refs/heads/main" ,  "after" : "1234abcd" , "repository" : { "full_name" : "Uchiha7madara-afk/Hippocampus_AI" }  }`;
      const validSig = signGithubPayload(
        nonCanonicalRaw,
        process.env.GITHUB_WEBHOOK_SECRET!
      );

      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-valid-raw-001',
          'x-hub-signature-256': validSig,
        },
        body: nonCanonicalRaw,
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; status: string };
      assert.equal(body.ok, true);
      assert.equal(body.status, 'webhook_processed');
      assert.equal(githubFetchCount, 1);
    });

    it('6. rejects modified body with original signature (401)', async () => {
      const originalSig = signGithubPayload(
        samplePayload,
        process.env.GITHUB_WEBHOOK_SECRET!
      );
      const tamperedPayload = samplePayload.replace('Hippocampus_AI', 'Attacker_Repo');
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': originalSig,
        },
        body: tamperedPayload,
      });
      assert.equal(res.status, 401);
    });

    it('7. fails closed (503) when GITHUB_WEBHOOK_SECRET is missing', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
        },
        body: samplePayload,
      });
      assert.equal(res.status, 503);
    });

    it('8. MANDATORY: x-hippocampus-simulator header CANNOT bypass webhook HMAC verification', async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hippocampus-simulator': 'true',
          'x-github-event': 'push',
        },
        body: samplePayload,
      });
      assert.equal(res.status, 401);
      assert.equal(githubFetchCount, 0);
    });

    it('9. rejects isolated dev simulator route in production environment (404)', async () => {
      process.env.NODE_ENV = 'production';
      const res = await fetch(`${baseUrl}/api/dev/webhooks/github/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
          'x-hippocampus-simulator': 'true',
        },
        body: samplePayload,
      });
      assert.equal(res.status, 404);

      const slackSimRes = await fetch(
        `${baseUrl}/api/dev/slack/events/simulate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid-admin-token-0001',
            'x-hippocampus-simulator': 'true',
          },
          body: JSON.stringify({ event: { type: 'app_mention', channel: '#eng' } }),
        }
      );
      assert.equal(slackSimRes.status, 404);
    });

    it('10. suppresses duplicate GitHub delivery IDs via persistent idempotency', async () => {
      const validSig = signGithubPayload(
        samplePayload,
        process.env.GITHUB_WEBHOOK_SECRET!
      );

      const first = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-replay-999',
          'x-hub-signature-256': validSig,
        },
        body: samplePayload,
      });
      assert.equal(first.status, 200);
      assert.equal(githubFetchCount, 1);

      const replay = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-replay-999',
          'x-hub-signature-256': validSig,
        },
        body: samplePayload,
      });
      assert.equal(replay.status, 200);
      const replayBody = (await replay.json()) as { status: string };
      assert.equal(replayBody.status, 'duplicate_delivery_ignored');
      assert.equal(
        githubFetchCount,
        1,
        'Duplicate delivery must not execute ingestion twice'
      );
    });

    it('11. enforces GITHUB_ALLOWED_REPOS allowlist when configured (403)', async () => {
      process.env.GITHUB_ALLOWED_REPOS = 'org/approved-repo-only';
      const validSig = signGithubPayload(
        samplePayload,
        process.env.GITHUB_WEBHOOK_SECRET!
      );

      const res = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'deliv-unapproved-repo',
          'x-hub-signature-256': validSig,
        },
        body: samplePayload,
      });
      assert.equal(res.status, 403);
    });
  });

  // =========================================================================
  // 8.4 AUDIT LOGGING & PROVENANCE TESTS
  // =========================================================================
  describe('8.4 Audit Logging, Provenance & Secret Redaction', () => {
    it('records verified actor UID on role changes and ignores forged identity headers', async () => {
      // Unauthorized attempt by Engineer with forged identity headers
      const denied = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-engineer-token-0001',
          'x-operator-identity': 'forged-ceo@attacker.com',
          'x-hippocampus-role': 'Admin',
        },
        body: JSON.stringify({
          targetUid: 'uid-manager-1',
          role: 'Engineer',
        }),
      });
      assert.equal(denied.status, 403);

      // Authorized change by Admin with forged header attempting to spoof actor
      const ok = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
          'x-operator-identity': 'spoofed-actor-uid',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Manager',
        }),
      });
      assert.equal(ok.status, 200);

      // Fetch audit logs as Admin
      const logsRes = await fetch(`${baseUrl}/api/audit-logs`, {
        headers: { Authorization: 'Bearer valid-admin-token-0001' },
      });
      assert.equal(logsRes.status, 200);
      const { auditLogs } = (await logsRes.json()) as {
        auditLogs: Array<{
          actorUid: string;
          actorRole: string;
          action: string;
          outcome: string;
          targetResource: string;
        }>;
      };

      const roleChangeEvent = auditLogs.find((e) => e.action === 'role.changed');
      assert.ok(roleChangeEvent, 'Expected role.changed audit event');
      assert.equal(roleChangeEvent.actorUid, 'uid-admin-1');
      assert.equal(roleChangeEvent.actorRole, 'Admin');
      assert.equal(roleChangeEvent.targetResource, 'user:uid-engineer-1');
      assert.equal(roleChangeEvent.outcome, 'success');

      const deniedEvent = auditLogs.find(
        (e) => e.action === 'authz.denied' && e.actorUid === 'uid-engineer-1'
      );
      assert.ok(deniedEvent, 'Expected authz.denied audit event for Engineer');
      assert.equal(deniedEvent.actorRole, 'Engineer');

      // Ensure NO Firebase tokens or webhook secrets appear anywhere in audit logs
      const serialized = JSON.stringify(auditLogs);
      assert.ok(!serialized.includes('valid-admin-token-0001'));
      assert.ok(!serialized.includes('valid-engineer-token-0001'));
      assert.ok(!serialized.includes('test_github_webhook_secret_32bytes_min'));
      assert.ok(!serialized.includes('spoofed-actor-uid'));
    });
  });

  // =========================================================================
  // 8.5 CORS & INPUT VALIDATION HARDENING TESTS
  // =========================================================================
  describe('8.5 Explicit Production CORS & Strict Input Validation', () => {
    it('enforces explicit CORS allowlist in production and rejects unknown origins with 403', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_ORIGINS = 'https://console.hippocampus.example';

      const disallowed = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://evil-attacker.example' },
      });
      assert.equal(disallowed.status, 403);
      assert.equal(disallowed.headers.get('access-control-allow-origin'), null);

      const allowed = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://console.hippocampus.example' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(
        allowed.headers.get('access-control-allow-origin'),
        'https://console.hippocampus.example'
      );
    });

    it('rejects malformed JSON, unexpected fields, and invalid enum values cleanly (400)', async () => {
      const malformedJson = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: '{"targetUid": "uid-engineer-1", broken json',
      });
      assert.equal(malformedJson.status, 400);

      const unexpectedField = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'Manager',
          unexpectedEscalationFlag: true,
        }),
      });
      assert.equal(unexpectedField.status, 400);

      const invalidEnum = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-engineer-1',
          role: 'SuperAdmin',
        }),
      });
      assert.equal(invalidEnum.status, 400);
    });
  });

  // =========================================================================
  // 8.6 MISSION 001.6 COMPREHENSIVE SECURITY REMEDIATION TESTS
  // =========================================================================
  describe('8.6 Mission 001.6 Remediation Suite (AUD-001 through AUD-015)', () => {
    it('AUD-001 & AUD-002: isolates semantic cache by role & searchMode and strips secret answers from telemetry', async () => {
      const canary = 'CANARY_ADMIN_VAULT_SECRET_9911';
      await ingestDocument({
        title: 'Admin Vault Break-Glass Procedure',
        sourceType: 'file',
        accessLevel: 'Admin',
        content: `Executive Break-Glass Vault Procedure. Secret rotation token reference: ${canary}. Strictly Admin-only.`,
        userId: 'uid-admin-1',
      });

      const query = 'What is the executive break-glass vault secret rotation procedure?';

      // 1. Admin populates semantic cache for hybrid_rrf
      const adminRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({ query, searchMode: 'hybrid_rrf' }),
      });
      assert.equal(adminRes.status, 200);
      const adminBody = (await adminRes.json()) as {
        answer: string;
        cacheHit: boolean;
        sources: string[];
      };
      assert.equal(adminBody.cacheHit, false);

      // 2. Engineer runs IDENTICAL query -> MUST NOT receive Admin cached answer or canary!
      const engRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-engineer-token-0001',
        },
        body: JSON.stringify({ query, searchMode: 'hybrid_rrf' }),
      });
      assert.equal(engRes.status, 200);
      const engBody = (await engRes.json()) as {
        answer: string;
        cacheHit: boolean;
        sources: string[];
        chunks: Array<{ accessLevel?: string }>;
      };
      assert.equal(
        engBody.cacheHit,
        false,
        'Engineer must NEVER hit an Admin semantic cache entry'
      );
      assert.ok(
        !engBody.answer.includes(canary),
        'Engineer response must NEVER leak Admin-classified content'
      );
      assert.ok(
        engBody.chunks.every((c) => c.accessLevel === 'Engineer'),
        'Engineer chunks must only contain Engineer-tier documents'
      );

      // 3. Same Admin with a different searchMode MUST NOT reuse hybrid_rrf entry
      const bm25Res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({ query, searchMode: 'sparse_bm25' }),
      });
      assert.equal(bm25Res.status, 200);
      const bm25Body = (await bm25Res.json()) as { cacheHit: boolean };
      assert.equal(
        bm25Body.cacheHit,
        false,
        'Different searchMode must not reuse hybrid_rrf semantic cache entry'
      );

      // 4. Same Engineer repeating Engineer query DOES hit Engineer-scoped cache
      const engRepeat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-engineer-token-0001',
        },
        body: JSON.stringify({ query, searchMode: 'hybrid_rrf' }),
      });
      assert.equal(engRepeat.status, 200);
      const engRepeatBody = (await engRepeat.json()) as {
        cacheHit: boolean;
        answer: string;
      };
      assert.equal(engRepeatBody.cacheHit, true);
      assert.ok(!engRepeatBody.answer.includes(canary));

      // 5. AUD-002: Manager telemetry sees ONLY aggregate non-Admin counts and entries: []
      const mgrTelRes = await fetch(`${baseUrl}/api/telemetry`, {
        headers: { Authorization: 'Bearer valid-manager-token-0001' },
      });
      assert.equal(mgrTelRes.status, 200);
      const mgrTel = (await mgrTelRes.json()) as {
        cacheSummary: { totalEntries: number; byRole: Record<string, number> };
        cacheEntries: unknown[];
      };
      assert.equal(mgrTel.cacheEntries.length, 0);
      assert.equal(mgrTel.cacheSummary.byRole.Admin, undefined);
      assert.ok(!JSON.stringify(mgrTel).includes(canary));
      assert.ok(!JSON.stringify(mgrTel).includes('Admin Vault Break-Glass'));

      // 6. AUD-002: Admin telemetry sees metadata-only cacheEntries (zero answer/queryText/sources)
      const adminTelRes = await fetch(`${baseUrl}/api/telemetry`, {
        headers: { Authorization: 'Bearer valid-admin-token-0001' },
      });
      assert.equal(adminTelRes.status, 200);
      const adminTel = (await adminTelRes.json()) as {
        cacheEntries: Array<Record<string, unknown>>;
      };
      assert.ok(adminTel.cacheEntries.length >= 2);
      for (const entry of adminTel.cacheEntries) {
        assert.equal(entry.answer, undefined);
        assert.equal(entry.queryText, undefined);
        assert.equal(entry.queryEmbedding, undefined);
        assert.equal(entry.sources, undefined);
        assert.equal(typeof entry.cacheKeyPrefix, 'string');
        assert.equal(typeof entry.requiredRole, 'string');
      }
      assert.ok(!JSON.stringify(adminTel).includes(canary));
    });

    it('AUD-004 & AUD-010: enforces per-user GitHub OAuth, browser-binding cookie, PKCE, single-use state, fail-closed exchange & script escaping', async () => {
      process.env.GITHUB_CLIENT_ID = 'gh_client_id_test';
      process.env.GITHUB_CLIENT_SECRET = 'gh_client_secret_test';
      process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
      process.env.OAUTH_STATE_COOKIE_SECRET = 'b'.repeat(64);
      process.env.APP_URL = baseUrl;

      // 1. Manager initiates OAuth -> receives PKCE S256 URL + HttpOnly binding cookie
      const initRes = await fetch(`${baseUrl}/api/connectors/github/auth-url`, {
        headers: { Authorization: 'Bearer valid-manager-token-0001' },
      });
      assert.equal(initRes.status, 200);
      const setCookie = initRes.headers.get('set-cookie') || '';
      assert.match(setCookie, /hippocampus_gh_oauth_bind=/);
      assert.match(setCookie, /HttpOnly/i);
      const bindingCookiePair = setCookie.split(';')[0];

      const initData = (await initRes.json()) as { url: string };
      const authUrl = new URL(initData.url);
      const state = authUrl.searchParams.get('state')!;
      assert.ok(state && state.length >= 32);
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(authUrl.searchParams.get('code_challenge'));

      // 2. Missing binding cookie -> rejected 403 (state NOT consumed yet!)
      const noCookieCb = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=${state}`
      );
      assert.equal(noCookieCb.status, 403);

      // 3. Mismatched binding cookie -> rejected 403
      const wrongCookieCb = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=${state}`,
        { headers: { Cookie: 'hippocampus_gh_oauth_bind=deadbeef.invalid' } }
      );
      assert.equal(wrongCookieCb.status, 403);

      // 4. Valid cookie + failing upstream token exchange -> fails closed 502 (NEVER @Uchiha7madara-afk)
      oauthExchangeBehavior = 'token_http_error';
      const failedCb = await fetch(
        `${baseUrl}/auth/github/callback?code=bad_code&state=${state}`,
        { headers: { Cookie: bindingCookiePair } }
      );
      assert.equal(failedCb.status, 502);
      const failedText = await failedCb.text();
      assert.ok(!failedText.includes('Uchiha7madara-afk'));

      // 5. Replaying already-consumed state -> rejected 400
      oauthExchangeBehavior = 'success';
      const replayCb = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=${state}`,
        { headers: { Cookie: bindingCookiePair } }
      );
      assert.equal(replayCb.status, 400);

      // 6. Successful OAuth flow with XSS-payload username -> safely escaped & saved ONLY for Manager
      const init2 = await fetch(`${baseUrl}/api/connectors/github/auth-url`, {
        headers: { Authorization: 'Bearer valid-manager-token-0001' },
      });
      const cookie2 = (init2.headers.get('set-cookie') || '').split(';')[0];
      const state2 = new URL(((await init2.json()) as { url: string }).url)
        .searchParams.get('state')!;

      oauthExchangeBehavior = 'xss_username';
      const okCb = await fetch(
        `${baseUrl}/auth/github/callback?code=good_code&state=${state2}`,
        { headers: { Cookie: cookie2 } }
      );
      assert.equal(okCb.status, 200);
      const html = await okCb.text();
      assert.ok(
        !html.includes('</script><script>alert(1)'),
        'Callback HTML/script must neutralize </script> sequences'
      );
      assert.ok(html.includes('\\u003c/script\\u003e'));

      // 7. Cross-user isolation: Manager sees connected, Admin sees disconnected & never gets Manager token
      const mgrConnRes = await fetch(`${baseUrl}/api/connectors`, {
        headers: { Authorization: 'Bearer valid-manager-token-0001' },
      });
      const mgrConn = (await mgrConnRes.json()) as {
        githubSessionConnected: boolean;
        githubConnectedUser: string | null;
      };
      assert.equal(mgrConn.githubSessionConnected, true);

      const adminConnRes = await fetch(`${baseUrl}/api/connectors`, {
        headers: { Authorization: 'Bearer valid-admin-token-0001' },
      });
      const adminConn = (await adminConnRes.json()) as {
        githubSessionConnected: boolean;
        githubConnectedUser: string | null;
      };
      assert.equal(adminConn.githubSessionConnected, false);
      assert.equal(adminConn.githubConnectedUser, null);

      // Admin sync must NOT use Manager's OAuth token
      const adminSync = await fetch(`${baseUrl}/api/connectors/github/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          repoFullName: 'org/test-repo',
          branch: 'main',
          accessLevel: 'Engineer',
        }),
      });
      assert.equal(adminSync.status, 200);
      assert.equal(lastGithubSyncToken, undefined);

      // Manager sync DOES use Manager's own decrypted OAuth token
      const mgrSync = await fetch(`${baseUrl}/api/connectors/github/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-manager-token-0001',
        },
        body: JSON.stringify({
          repoFullName: 'org/test-repo',
          branch: 'main',
          accessLevel: 'Engineer',
        }),
      });
      assert.equal(mgrSync.status, 200);
      assert.equal(
        lastGithubSyncToken,
        'gho_manager_private_oauth_token_99887766'
      );

      // Manager disconnects -> token revoked
      const disc = await fetch(`${baseUrl}/api/connectors/github/disconnect`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-manager-token-0001' },
      });
      assert.equal(disc.status, 200);
      const afterDisc = (await (
        await fetch(`${baseUrl}/api/connectors`, {
          headers: { Authorization: 'Bearer valid-manager-token-0001' },
        })
      ).json()) as { githubSessionConnected: boolean };
      assert.equal(afterDisc.githubSessionConnected, false);
    });

    it('AUD-007: requires email_verified=true for bootstrap admin and never re-elevates demoted admins on re-sync', async () => {
      // Unverified email cannot bootstrap Admin even if email matches BOOTSTRAP_ADMIN_EMAILS
      const unverifiedRes = await fetch(`${baseUrl}/api/auth/sync`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-bootstrap-unverified-0001',
        },
      });
      assert.equal(unverifiedRes.status, 200);
      const unverifiedBody = (await unverifiedRes.json()) as {
        user: { role: string };
      };
      assert.equal(unverifiedBody.user.role, 'Engineer');

      // Verified bootstrap email provisions Admin on initial creation
      const verifiedRes = await fetch(`${baseUrl}/api/auth/sync`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-bootstrap-token-0001' },
      });
      assert.equal(verifiedRes.status, 200);
      assert.equal(
        ((await verifiedRes.json()) as { user: { role: string } }).user.role,
        'Admin'
      );

      // Admin demotes bootstrap user to Engineer
      const demoteRes = await fetch(`${baseUrl}/api/auth/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin-token-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-bootstrap-1',
          role: 'Engineer',
        }),
      });
      assert.equal(demoteRes.status, 200);

      // Demoted user re-syncs while BOOTSTRAP_ADMIN_EMAILS is STILL set -> MUST stay Engineer!
      const resyncRes = await fetch(`${baseUrl}/api/auth/sync`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-bootstrap-token-0001' },
      });
      assert.equal(resyncRes.status, 200);
      const resyncBody = (await resyncRes.json()) as { user: { role: string } };
      assert.equal(
        resyncBody.user.role,
        'Engineer',
        'Demoted bootstrap admin must NEVER re-elevate on /api/auth/sync'
      );
    });

    it('AUD-008: rejects signed GitHub webhook missing or malformed X-GitHub-Delivery (400) and applies rate-limit headers', async () => {
      const body = JSON.stringify({
        ref: 'refs/heads/main',
        after: 'abcdef1234',
        repository: { full_name: 'org/repo-delivery-test' },
      });
      const sig = signGithubPayload(body, process.env.GITHUB_WEBHOOK_SECRET!);

      const missingDelivery = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-hub-signature-256': sig,
        },
        body,
      });
      assert.equal(missingDelivery.status, 400);
      assert.ok(missingDelivery.headers.get('x-ratelimit-limit'));

      const shortDelivery = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'bad',
          'x-hub-signature-256': sig,
        },
        body,
      });
      assert.equal(shortDelivery.status, 400);
    });

    it('AUD-009: hardens Slack HMAC timestamp/format validation, deduplicates by event_id only, and makes dev simulator non-mutating', async () => {
      const secret = process.env.SLACK_SIGNING_SECRET!;
      const nowSec = String(Math.floor(Date.now() / 1000));
      const payload = JSON.stringify({
        type: 'event_callback',
        event_id: 'Ev_FRESH_RETRY_TEST_01',
        event: {
          type: 'app_mention',
          channel: '#eng-onboarding',
          user: 'U12345',
          text: '<@U999> How do I set up SSO?',
        },
      });

      // Trailing garbage timestamp rejected (401)
      const badTs = `${nowSec}garbage`;
      const badTsRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': badTs,
          'x-slack-signature': signSlackPayload(payload, badTs, secret),
        },
        body: payload,
      });
      assert.equal(badTsRes.status, 401);

      // Future timestamp (>300s) rejected (401)
      const futureTs = String(Math.floor(Date.now() / 1000) + 600);
      const futureRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': futureTs,
          'x-slack-signature': signSlackPayload(payload, futureTs, secret),
        },
        body: payload,
      });
      assert.equal(futureRes.status, 401);

      // Fresh event_id WITH x-slack-retry-num: 1 MUST NOT be blindly suppressed
      const firstRetryRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': nowSec,
          'x-slack-signature': signSlackPayload(payload, nowSec, secret),
          'x-slack-retry-num': '1',
        },
        body: payload,
      });
      assert.equal(firstRetryRes.status, 200);
      const firstBody = (await firstRetryRes.json()) as { status: string };
      assert.equal(firstBody.status, 'accepted_async');

      // Duplicate same event_id IS suppressed
      const dupRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': nowSec,
          'x-slack-signature': signSlackPayload(payload, nowSec, secret),
        },
        body: payload,
      });
      assert.equal(dupRes.status, 200);
      const dupBody = (await dupRes.json()) as { status: string };
      assert.equal(dupBody.status, 'duplicate_retry_suppressed');

      // Invalid Slack payload schema rejected with 400
      const invalidPayload = JSON.stringify({ type: 'unknown_event_type' });
      const invalidSchemaRes = await fetch(`${baseUrl}/api/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': nowSec,
          'x-slack-signature': signSlackPayload(invalidPayload, nowSec, secret),
        },
        body: invalidPayload,
      });
      assert.equal(invalidSchemaRes.status, 400);

      // Dev simulator in NODE_ENV=development is strictly non-mutating dry-run
      process.env.NODE_ENV = 'development';
      const logsBefore = (
        (await (
          await fetch(`${baseUrl}/api/logs`, {
            headers: { Authorization: 'Bearer valid-admin-token-0001' },
          })
        ).json()) as { logs: unknown[] }
      ).logs.length;

      const simRes = await fetch(`${baseUrl}/api/dev/slack/events/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-manager-token-0001',
        },
        body: JSON.stringify({
          type: 'event_callback',
          event_id: 'Ev_DEV_DRYRUN_01',
          event: {
            type: 'member_joined_channel',
            channel: '#eng-onboarding',
            user: 'U_DRYRUN',
          },
        }),
      });
      assert.equal(simRes.status, 200);
      const simBody = (await simRes.json()) as { dryRun: boolean };
      assert.equal(simBody.dryRun, true);

      const logsAfter = (
        (await (
          await fetch(`${baseUrl}/api/logs`, {
            headers: { Authorization: 'Bearer valid-admin-token-0001' },
          })
        ).json()) as { logs: unknown[] }
      ).logs.length;
      assert.equal(
        logsAfter,
        logsBefore,
        'Dev Slack simulator must never mutate production query_logs'
      );
    });

    it('AUD-011: sanitizes X-Request-Id and redacts nested secrets, Slack/GitHub tokens, and query previews from telemetry logs', () => {
      const injectedId = sanitizeRequestId('req-123\r\n[FAKE AUDIT]');
      assert.ok(!injectedId.includes('\r'));
      assert.ok(!injectedId.includes('\n'));
      assert.notEqual(injectedId, 'req-123\r\n[FAKE AUDIT]');
      assert.equal(sanitizeRequestId('valid_req-01.abc'), 'valid_req-01.abc');

      const fakeSlackToken = 'xoxb-1234567890-secret-slack-token-xyz';
      const fakeGhToken = 'ghp_1234567890abcdefghijklmnopqrstuvwx';
      const fakeQuery = 'CONFIDENTIAL_SALARY_QUERY_TEXT_9988';

      recordAgentToolCall({
        toolName: 'check_deployment_status',
        args: {
          service: 'billing-api',
          accessToken: fakeGhToken,
          nested: { slackBotToken: fakeSlackToken },
        },
        durationMs: 12,
        requestId: 'req-audit-011',
      });

      recordCacheEvent(false, undefined, fakeQuery);

      const serialized = JSON.stringify(getObservabilityMetrics().recentLogs);
      assert.ok(!serialized.includes(fakeSlackToken));
      assert.ok(!serialized.includes(fakeGhToken));
      assert.ok(!serialized.includes(fakeQuery));
    });

    it('AUD-012: blocks production CORS bypass via spoofed Host and X-Forwarded-Proto headers', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOWED_ORIGINS = 'https://console.hippocampus.example';

      const spoofed = await fetch(`${baseUrl}/api/health`, {
        headers: {
          Origin: 'https://evil-attacker.example',
          Host: 'evil-attacker.example',
          'X-Forwarded-Proto': 'https',
        },
      });
      assert.equal(spoofed.status, 403);
      assert.equal(spoofed.headers.get('access-control-allow-origin'), null);
    });

    it('AUD-013: isolates onboarding progress by immutable userUid even for identical email local-parts and rejects cross-UID edits', async () => {
      await getOrCreateUser(
        'uid-alice-acme',
        'alice@acme.internal',
        'Alice Acme',
        'Engineer'
      );
      await getOrCreateUser(
        'uid-alice-other',
        'alice@other.internal',
        'Alice Other',
        'Engineer'
      );

      // Alice Acme toggles milestone 1
      const toggle1 = await fetch(`${baseUrl}/api/onboarding/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-alice-acme-0001',
        },
        body: JSON.stringify({
          userHandle: '@alice',
          trackId: 1,
          completed: true,
        }),
      });
      assert.equal(toggle1.status, 200);

      // Alice Other (same @alice local-part, different UID) MUST see empty cohort, NOT Alice Acme's progress or seeded Alex Chen!
      const otherGet = await fetch(`${baseUrl}/api/onboarding`, {
        headers: { Authorization: 'Bearer valid-alice-other-0001' },
      });
      assert.equal(otherGet.status, 200);
      const otherBody = (await otherGet.json()) as {
        activeUserUid: string;
        cohort: Array<{ userUid?: string; userHandle: string }>;
      };
      assert.equal(otherBody.activeUserUid, 'uid-alice-other');
      assert.equal(
        otherBody.cohort.length,
        0,
        'New Engineer with no progress must receive empty cohort, never another user'
      );

      // Alice Other attempting to modify Alice Acme via targetUid MUST fail with 403
      const crossUid = await fetch(`${baseUrl}/api/onboarding/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-alice-other-0001',
        },
        body: JSON.stringify({
          targetUid: 'uid-alice-acme',
          userHandle: '@alice',
          trackId: 1,
          completed: false,
        }),
      });
      assert.equal(crossUid.status, 403);
    });

    it('AUD-003: assertSafeProductionConfig fails fast when production lacks DB config or enables in-memory fallback', () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedFallback = process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK;
      const savedDbUrl = process.env.DATABASE_URL;
      const savedSqlHost = process.env.SQL_HOST;
      const savedSqlPass = process.env.SQL_PASSWORD;

      try {
        process.env.NODE_ENV = 'production';
        process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK = 'true';
        process.env.DATABASE_URL = 'postgresql://user:pass@10.0.0.5:5432/db';
        assert.throws(
          () => assertSafeProductionConfig(),
          /HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK/
        );

        delete process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK;
        delete process.env.DATABASE_URL;
        delete process.env.SQL_HOST;
        delete process.env.SQL_PASSWORD;
        assert.throws(
          () => assertSafeProductionConfig(),
          /PostgreSQL configuration .* is mandatory in production/
        );
      } finally {
        process.env.NODE_ENV = savedNodeEnv;
        if (savedFallback === undefined)
          delete process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK;
        else process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK = savedFallback;
        if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = savedDbUrl;
        if (savedSqlHost === undefined) delete process.env.SQL_HOST;
        else process.env.SQL_HOST = savedSqlHost;
        if (savedSqlPass === undefined) delete process.env.SQL_PASSWORD;
        else process.env.SQL_PASSWORD = savedSqlPass;
      }
    });
  });
});

