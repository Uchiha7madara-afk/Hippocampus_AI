import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import {
  createAuthLayer,
  roleHasPermission,
  type AuthMiddlewareOptions,
  type AuthRequest,
} from './middleware/auth.ts';
import {
  PersistenceError,
  consumeOAuthStateAtomic,
  createOAuthState,
  createOnboardingTrack,
  deleteDocumentById,
  getAgentSettingsList,
  getConnectorSyncLogs,
  getDocumentsList,
  getOnboardingPayload,
  getOrCreateUser,
  getOverviewPayload,
  getRecentQueryLogs,
  getSecurityAuditLogs,
  getSemanticCacheTelemetry,
  getUserByUid,
  getUserConnectorConnection,
  ingestDocument,
  listUsers,
  lookupSemanticCache,
  purgeSemanticCache,
  recordConnectorSyncLog,
  recordQueryLog,
  recordSecurityAuditEvent,
  recordWebhookDeliveryIfNew,
  revokeUserConnectorConnection,
  searchKnowledgeChunks,
  splitIntoChunks,
  storeInSemanticCache,
  toggleOnboardingMilestone,
  updateAgentSettingByKey,
  updateUserRole,
  upsertConnectorDocument,
  upsertUserConnectorConnection,
} from './db/queries.ts';
import {
  convertGoogleDocToMarkdown,
  fetchGithubRepositoryDocs,
  type GoogleDocStructuralResponse,
  listGoogleDriveDocuments,
  pullGoogleDriveDocumentAsMarkdown,
  verifyGithubWebhookSignatureDetailed,
} from './lib/connectors.ts';
import { SCOPES as GOOGLE_WORKSPACE_SCOPES } from './lib/firebase.ts';
import { executeEnterpriseTool, synthesizeRagAnswer } from './lib/ai.ts';
import {
  buildWelcomeMessage,
  type SlackEventPayload,
  verifySlackRequest,
} from './lib/slack.ts';
import {
  emitStructuredLog,
  getObservabilityMetrics,
  recordSlackWebhookMetric,
  requestLoggerMiddleware,
  type TelemetryRequest,
} from './lib/logger.ts';
import {
  createRateLimitMiddleware,
  getRateLimitStatus,
  resetRateLimitBuckets,
} from './lib/resilience.ts';
import {
  ALLOWED_SETTING_KEYS,
  assertSafeProductionConfig,
  ChatQueryRequestSchema,
  ClientErrorTelemetrySchema,
  CreateOnboardingTrackSchema,
  DevGithubWebhookSimulateSchema,
  ExecuteToolRequestSchema,
  GdriveImportRequestSchema,
  getAllowedGithubRepos,
  getAllowedOrigins,
  getAllowedTiersForRole,
  getEnvValidationReport,
  getTrustedProxyHops,
  GithubSyncRequestSchema,
  GithubWebhookPayloadSchema,
  IngestDocumentRequestSchema,
  isBootstrapAdminIdentity,
  normalizeRbacRole,
  type RbacRole,
  SlackEventPayloadSchema,
  ToggleOnboardingProgressSchema,
  UpdateRoleRequestSchema,
  UpdateSettingRequestSchema,
  validateRuntimeEnv,
} from './lib/env.ts';
import {
  OAUTH_BINDING_COOKIE_NAME,
  buildClearOAuthBindingCookieHeader,
  buildOAuthBindingCookieHeader,
  generatePkcePair,
  generateRandomTokenHex,
  isTokenEncryptionConfigured,
  parseCookies,
  serializeJsonForScript,
  sha256Hex,
  signOAuthBindingCookie,
  timingSafeHashEquals,
  verifyOAuthBindingCookie,
} from './lib/oauth-crypto.ts';
import type { HybridSearchMode } from './types/app.ts';

export interface AppServerOptions {
  authOptions?: AuthMiddlewareOptions;
  githubWebhookFetcher?: typeof fetchGithubRepositoryDocs;
  githubOAuthExchangeFetcher?: typeof fetch;
}

interface RawBodyRequest extends AuthRequest {
  rawBody?: string;
  rawBodyBuffer?: Buffer;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPersistenceFailure(error: unknown): boolean {
  return (
    error instanceof PersistenceError ||
    Boolean((error as { isPersistenceError?: boolean } | null)?.isPersistenceError)
  );
}

function sendSafeServerError(
  req: TelemetryRequest,
  res: Response,
  fallbackMessage: string,
  error: unknown
) {
  const persistenceDown = isPersistenceFailure(error);
  const statusCode = persistenceDown ? 503 : 500;

  emitStructuredLog({
    level: 'error',
    component: persistenceDown ? 'db' : 'api',
    event: persistenceDown ? 'db.persistence_unavailable' : 'api.internal_error',
    requestId: req.requestId,
    statusCode,
    metadata: {
      route: `${req.method} ${req.path}`,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    },
    message:
      error instanceof Error
        ? `${fallbackMessage}: ${error.message}`
        : fallbackMessage,
  });

  if (persistenceDown) {
    return res.status(503).json({
      error: 'Persistence service temporarily unavailable.',
      requestId: req.requestId,
    });
  }

  // Never expose stack traces, SQL errors, or internal details in production
  const isProd = process.env.NODE_ENV === 'production';
  return res.status(500).json({
    error: isProd ? 'An internal server error occurred.' : fallbackMessage,
    requestId: req.requestId,
  });
}

const GITHUB_DELIVERY_ID_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

export function createApp(options: AppServerOptions = {}): Express {
  validateRuntimeEnv();
  assertSafeProductionConfig();

  const app = express();
  // Explicit trusted proxy hop count (AUD-012) — never blanket `true`
  app.set('trust proxy', getTrustedProxyHops());

  const authLayer = createAuthLayer(options.authOptions);
  const {
    requireFirebaseIdentity,
    requireAuthentication,
    requirePermission,
  } = authLayer;

  const fetchRepoDocs =
    options.githubWebhookFetcher ?? fetchGithubRepositoryDocs;
  const oauthExchangeFetch = options.githubOAuthExchangeFetcher ?? fetch;

  // Isolated development-only Slack simulator dedupe cache (never touches production DB)
  const devSimulatedSlackEventIds = new Set<string>();

  // Security headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()'
    );
    next();
  });

  // Explicit CORS policy (AUD-012):
  // - Never wildcard on authenticated routes; fail-closed on disallowed origins.
  // - Never trust raw X-Forwarded-Proto or Host headers in production.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const originHeader = req.headers.origin;
    if (!originHeader) {
      return next();
    }

    const normalizedOrigin = originHeader.trim().replace(/\/$/, '');
    const allowedOrigins = getAllowedOrigins();
    const isProd = process.env.NODE_ENV === 'production';

    let isAllowed = allowedOrigins.includes(normalizedOrigin);

    if (!isAllowed && !isProd) {
      // In development/test only, allow exact same-origin browser requests using Express's trust-proxy-governed req.protocol
      const host = req.get('host');
      const proto = req.protocol || 'http';
      const sameOrigin = host ? `${proto}://${host}` : null;
      isAllowed = sameOrigin !== null && normalizedOrigin === sameOrigin;
    }

    res.setHeader('Vary', 'Origin');

    if (!isAllowed) {
      return res.status(403).json({
        error: 'CORS policy: Request origin is not allowed.',
      });
    }

    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Google-Access-Token, X-Request-Id'
    );
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  });

  // Preserve exact raw bytes for cryptographic webhook HMAC-SHA256 verification
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: RawBodyRequest, _res, buf) => {
        req.rawBodyBuffer = Buffer.from(buf);
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  // Catch malformed JSON bodies cleanly without leaking parser internals
  app.use(
    (
      err: Error & { status?: number; type?: string },
      req: TelemetryRequest,
      res: Response,
      next: NextFunction
    ) => {
      if (err instanceof SyntaxError && err.status === 400) {
        return res.status(400).json({
          error: 'Malformed JSON request body.',
          requestId: req.requestId,
        });
      }
      if (err.type === 'entity.too.large') {
        return res.status(413).json({
          error: 'Request payload exceeds maximum allowed size (1MB).',
          requestId: req.requestId,
        });
      }
      return next(err);
    }
  );

  app.use(requestLoggerMiddleware);

  // =========================================================================
  // PUBLIC HEALTH CHECK (non-sensitive)
  // =========================================================================
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'hippocampus-enterprise',
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // AUTHENTICATION & AUTHORITATIVE RBAC ROLE MANAGEMENT
  // =========================================================================

  /**
   * Controlled onboarding / user synchronization endpoint.
   * Requires verified Firebase ID token. Provisions new users with least-privilege
   * 'Engineer' role unless explicitly listed in server-side BOOTSTRAP_ADMIN_EMAILS/UIDS.
   */
  app.post(
    '/api/auth/sync',
    requireFirebaseIdentity,
    async (req: AuthRequest, res: Response) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const verifiedUid = req.user.uid;
        const verifiedEmail =
          req.user.email || `${verifiedUid}@users.hippocampus.internal`;
        const verifiedName = req.user.name || null;
        const emailVerified = req.user.email_verified;

        const existing = await getUserByUid(verifiedUid);
        // AUD-007: Bootstrap admin evaluation applies ONLY on initial user provisioning (!existing).
        // Existing users (including demoted admins) NEVER re-elevate on /api/auth/sync.
        const isBootstrap = !existing
          ? isBootstrapAdminIdentity({
              uid: verifiedUid,
              email: req.user.email,
              emailVerified,
            })
          : false;

        const assignedRole: RbacRole | undefined = existing
          ? undefined
          : isBootstrap
            ? 'Admin'
            : 'Engineer';

        const { user, created } = await getOrCreateUser(
          verifiedUid,
          verifiedEmail,
          verifiedName,
          assignedRole
        );

        if (created) {
          await recordSecurityAuditEvent({
            actorUid: verifiedUid,
            actorEmail: verifiedEmail,
            actorRole: user.role,
            action: 'user.provisioned',
            targetResource: `user:${verifiedUid}`,
            outcome: 'success',
            requestId: req.requestId,
            metadata: {
              assignedRole: user.role,
              bootstrapAdmin: isBootstrap,
              created,
            },
          });
        }

        res.json({
          user,
          allowedTiers: getAllowedTiersForRole(user.role),
        });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to sync user account', error);
      }
    }
  );

  app.get(
    '/api/auth/me',
    requireAuthentication,
    (req: AuthRequest, res: Response) => {
      const authUser = req.authUser!;
      res.json({
        user: authUser,
        allowedTiers: getAllowedTiersForRole(authUser.role),
      });
    }
  );

  app.get(
    '/api/auth/users',
    requireAuthentication,
    requirePermission('users:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const allUsers = await listUsers();
        res.json({ users: allUsers });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to list users', error);
      }
    }
  );

  /**
   * Mission 001 Objective B (3.4): Admin-only role mutation with self-modification guard
   * and immutable security audit logging.
   */
  app.patch(
    '/api/auth/role',
    requireAuthentication,
    requirePermission('users:role:update'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const parsed = UpdateRoleRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'role.change_denied',
            targetResource: 'user:invalid',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: {
              reason: 'validation_failed',
              issue: parsed.error.issues[0]?.message,
            },
          });
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid role update payload. Both targetUid and valid role are required.',
          });
        }

        const { targetUid, role: nextRole } = parsed.data;

        // Prevent self-role modification
        if (targetUid === actor.uid) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'role.change_denied',
            targetResource: `user:${targetUid}`,
            outcome: 'denied',
            requestId: req.requestId,
            metadata: {
              reason: 'self_role_modification_forbidden',
              requestedRole: nextRole,
            },
          });
          return res.status(403).json({
            error:
              'Forbidden: Administrators cannot modify their own role directly.',
          });
        }

        const targetUser = await getUserByUid(targetUid);
        if (!targetUser) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'role.change_denied',
            targetResource: `user:${targetUid}`,
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'target_user_not_found' },
          });
          return res.status(404).json({
            error: 'Target user not found.',
          });
        }

        const previousRole = targetUser.role;
        const updated = await updateUserRole(targetUid, nextRole);
        if (!updated) {
          return res.status(404).json({ error: 'Target user not found.' });
        }

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'role.changed',
          targetResource: `user:${targetUid}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: {
            targetUid,
            previousRole,
            newRole: nextRole,
          },
        });

        res.json({
          user: updated,
          role: updated.role,
          allowedTiers: getAllowedTiersForRole(updated.role),
        });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to update user role', error);
      }
    }
  );

  // =========================================================================
  // INTERACTIVE ONBOARDING CHECKLISTS & COHORT APIS
  // =========================================================================
  app.get(
    '/api/onboarding',
    requireAuthentication,
    requirePermission('onboarding:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const activeUserHandle = `@${actor.email.split('@')[0]}`;
        const payload = await getOnboardingPayload({
          userUid: actor.uid,
          userHandle: activeUserHandle,
          role: actor.role,
        });
        res.json(payload);
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to load onboarding tracks',
          error
        );
      }
    }
  );

  app.post(
    '/api/onboarding/progress',
    requireAuthentication,
    requirePermission('onboarding:progress:self'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const callerHandle = `@${actor.email.split('@')[0]}`;

        const parsed = ToggleOnboardingProgressSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid onboarding progress payload.',
          });
        }

        const rawTarget = parsed.data.userHandle || callerHandle;
        const targetHandle = rawTarget.startsWith('@')
          ? rawTarget
          : `@${rawTarget}`;
        const canManageCohort = roleHasPermission(
          actor.role,
          'onboarding:manage'
        );

        // AUD-013: Resource-owner RBAC enforcement by immutable userUid & handle
        if (!canManageCohort) {
          const uidMismatch =
            Boolean(parsed.data.targetUid) &&
            parsed.data.targetUid !== actor.uid;
          const handleMismatch =
            targetHandle.toLowerCase() !== callerHandle.toLowerCase();

          if (uidMismatch || handleMismatch) {
            await recordSecurityAuditEvent({
              actorUid: actor.uid,
              actorEmail: actor.email,
              actorRole: actor.role,
              action: 'authz.resource_denied',
              targetResource: `onboarding_progress:${parsed.data.targetUid || targetHandle}`,
              outcome: 'denied',
              requestId: req.requestId,
              metadata: {
                reason: 'engineer_cross_user_progress_denied',
                callerUid: actor.uid,
                callerHandle,
                targetUid: parsed.data.targetUid,
                targetHandle,
              },
            });
            return res.status(403).json({
              error: `RBAC Forbidden: Engineer role can only update their own milestones (${callerHandle}).`,
            });
          }
        }

        const resolvedUserUid = !canManageCohort
          ? actor.uid
          : parsed.data.targetUid ??
            (targetHandle.toLowerCase() === callerHandle.toLowerCase()
              ? actor.uid
              : null);

        const updated = await toggleOnboardingMilestone({
          userUid: resolvedUserUid,
          userHandle: targetHandle,
          displayName: parsed.data.displayName || actor.displayName || undefined,
          engineerRole: parsed.data.engineerRole,
          trackId: parsed.data.trackId,
          completed: parsed.data.completed,
          assignedBy: callerHandle,
          notes: parsed.data.notes,
        });

        res.json({ progress: updated });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to update onboarding milestone',
          error
        );
      }
    }
  );

  app.post(
    '/api/onboarding/tracks',
    requireAuthentication,
    requirePermission('onboarding:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const parsed = CreateOnboardingTrackSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid onboarding milestone payload.',
          });
        }

        const created = await createOnboardingTrack(parsed.data);
        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'onboarding.track_created',
          targetResource: `onboarding_track:${created.id}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { phase: created.phase, targetRole: created.targetRole },
        });
        res.status(201).json({ track: created });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to create onboarding milestone',
          error
        );
      }
    }
  );

  // =========================================================================
  // EXTERNAL CONNECTORS (GITHUB & GOOGLE WORKSPACE)
  // =========================================================================
  app.get(
    '/api/connectors',
    requireAuthentication,
    requirePermission('connectors:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const [syncLogs, userGithubConn] = await Promise.all([
          getConnectorSyncLogs(),
          getUserConnectorConnection(actor.uid, 'github'),
        ]);
        res.json({
          githubOAuthConfigured: Boolean(
            process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ),
          githubSessionConnected: Boolean(userGithubConn),
          githubConnectedUser: userGithubConn?.externalUsername ?? null,
          googleWorkspaceScopes: GOOGLE_WORKSPACE_SCOPES,
          devSimulatorEnabled: process.env.NODE_ENV === 'development',
          syncLogs,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to load external connectors state',
          error
        );
      }
    }
  );

  app.post(
    '/api/connectors/github/disconnect',
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const result = await revokeUserConnectorConnection(actor.uid, 'github');
        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'connector.github_oauth_disconnected',
          targetResource: `connector:github:${actor.uid}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { revoked: result.revoked },
        });
        return res.json({ disconnected: true, revoked: result.revoked });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to disconnect GitHub OAuth connection',
          error
        );
      }
    }
  );

  app.get(
    '/api/connectors/github/auth-url',
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const isProd = process.env.NODE_ENV === 'production';
        const clientId = process.env.GITHUB_CLIENT_ID?.trim();
        const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
        const configuredAppUrl = process.env.APP_URL?.trim();

        if (isProd) {
          if (!configuredAppUrl || configuredAppUrl.startsWith('MY_')) {
            return res.status(503).json({
              error:
                'GitHub OAuth requires explicit APP_URL in production.',
            });
          }
          if (!clientId || !clientSecret) {
            return res.status(503).json({
              error:
                'GitHub OAuth is not configured in production (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing).',
            });
          }
          if (!isTokenEncryptionConfigured()) {
            return res.status(503).json({
              error:
                'GitHub OAuth token encryption is not configured in production (CONNECTOR_TOKEN_ENCRYPTION_KEY missing).',
            });
          }
        }

        const baseUrl = (
          configuredAppUrl && !configuredAppUrl.startsWith('MY_')
            ? configuredAppUrl
            : `${req.protocol}://${req.get('host')}`
        ).replace(/\/$/, '');

        let targetOrigin: string;
        try {
          targetOrigin = new URL(baseUrl).origin;
        } catch {
          return res.status(500).json({
            error: 'Invalid server APP_URL configuration.',
          });
        }

        const redirectUri = `${baseUrl}/auth/github/callback`;
        const rawState = generateRandomTokenHex(32);
        const stateHash = sha256Hex(rawState);
        const bindingNonce = generateRandomTokenHex(32);
        const bindingHash = sha256Hex(bindingNonce);
        const pkce = generatePkcePair();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await createOAuthState({
          stateHash,
          provider: 'github',
          actorUid: actor.uid,
          actorRole: actor.role,
          bindingHash,
          codeVerifier: pkce.codeVerifier,
          targetOrigin,
          redirectUri,
          expiresAt,
        });

        const signedBindingCookie = signOAuthBindingCookie(bindingNonce);
        res.setHeader(
          'Set-Cookie',
          buildOAuthBindingCookieHeader(signedBindingCookie, {
            isSecureContext: targetOrigin.startsWith('https://'),
            maxAgeSeconds: 600,
          })
        );

        if (!clientId) {
          return res.json({
            configured: false,
            redirectUri,
            url: `${redirectUri}?code=simulated_github_oauth_code&state=${encodeURIComponent(rawState)}&mode=handshake`,
          });
        }

        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'repo read:user',
          state: rawState,
          code_challenge: pkce.codeChallenge,
          code_challenge_method: pkce.codeChallengeMethod,
        });

        return res.json({
          configured: true,
          redirectUri,
          url: `https://github.com/login/oauth/authorize?${params.toString()}`,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to initiate GitHub OAuth flow',
          error
        );
      }
    }
  );

  app.get(
    ['/auth/github/callback', '/auth/github/callback/'],
    async (req: TelemetryRequest, res: Response) => {
      try {
        const code =
          typeof req.query.code === 'string' ? req.query.code.trim() : '';
        const state =
          typeof req.query.state === 'string' ? req.query.state.trim() : '';
        const clientId = process.env.GITHUB_CLIENT_ID?.trim();
        const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
        const isProd = process.env.NODE_ENV === 'production';

        if (!code || !state) {
          return res
            .status(400)
            .send('Missing GitHub OAuth code or state parameter.');
        }

        // AUD-004: Verify HttpOnly signed browser-binding cookie before consuming state
        const cookies = parseCookies(req.headers.cookie);
        const verifiedCookie = verifyOAuthBindingCookie(
          cookies[OAUTH_BINDING_COOKIE_NAME]
        );
        if (!verifiedCookie.valid) {
          await recordSecurityAuditEvent({
            actorUid: 'oauth:github',
            actorRole: 'System',
            action: 'connector.github_oauth_binding_missing',
            targetResource: 'GET /auth/github/callback',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'missing_or_invalid_binding_cookie' },
          });
          return res
            .status(403)
            .send(
              'OAuth browser-binding cookie missing or invalid. Please initiate GitHub OAuth from the Hippocampus console.'
            );
        }

        // Atomic single-use state consumption in PostgreSQL (safe across concurrent requests/replicas)
        const stateRecord = await consumeOAuthStateAtomic(sha256Hex(state));
        if (!stateRecord) {
          return res
            .status(400)
            .send('Invalid, expired, or already-used GitHub OAuth state.');
        }

        // Clear one-time binding cookie regardless of downstream outcome
        res.setHeader(
          'Set-Cookie',
          buildClearOAuthBindingCookieHeader({
            isSecureContext: stateRecord.targetOrigin.startsWith('https://'),
          })
        );

        // Verify browser-binding nonce matches the initiating authenticated session
        if (
          !timingSafeHashEquals(
            verifiedCookie.bindingHash,
            stateRecord.bindingHash
          )
        ) {
          await recordSecurityAuditEvent({
            actorUid: stateRecord.actorUid,
            actorRole: stateRecord.actorRole,
            action: 'connector.github_oauth_binding_mismatch',
            targetResource: 'GET /auth/github/callback',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'csrf_binding_hash_mismatch' },
          });
          return res
            .status(403)
            .send('GitHub OAuth session binding mismatch. Request rejected.');
        }

        if (
          isProd &&
          (!clientId ||
            !clientSecret ||
            code === 'simulated_github_oauth_code')
        ) {
          return res
            .status(403)
            .send('Simulated GitHub OAuth is disabled in production.');
        }

        let accessToken = '';
        let connectedUser = '';

        if (!isProd && !clientId && code === 'simulated_github_oauth_code') {
          accessToken = 'dev_simulated_github_oauth_token';
          connectedUser = '@dev-github-user';
        } else {
          if (!clientId || !clientSecret) {
            return res
              .status(503)
              .send('GitHub OAuth client credentials are not configured.');
          }

          let tokenRes: globalThis.Response;
          try {
            tokenRes = await oauthExchangeFetch(
              'https://github.com/login/oauth/access_token',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                body: JSON.stringify({
                  client_id: clientId,
                  client_secret: clientSecret,
                  code,
                  redirect_uri: stateRecord.redirectUri,
                  code_verifier: stateRecord.codeVerifier,
                }),
              }
            );
          } catch (err) {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                stage: 'token_exchange_network',
                errorType: err instanceof Error ? err.name : 'UnknownError',
              },
            });
            return res
              .status(502)
              .send(
                'GitHub OAuth token exchange failed. Please retry authentication.'
              );
          }

          if (!tokenRes.ok) {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                stage: 'token_exchange_http',
                httpStatus: tokenRes.status,
              },
            });
            return res
              .status(502)
              .send(
                'GitHub OAuth token exchange was rejected. Please retry authentication.'
              );
          }

          const tokenData = (await tokenRes.json()) as {
            access_token?: string;
            error?: string;
          };
          if (!tokenData.access_token) {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                stage: 'token_missing',
                oauthError: tokenData.error || 'missing_access_token',
              },
            });
            return res
              .status(502)
              .send(
                'GitHub OAuth did not return an access token. Please retry authentication.'
              );
          }

          accessToken = tokenData.access_token;

          let userRes: globalThis.Response;
          try {
            userRes = await oauthExchangeFetch('https://api.github.com/user', {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Hippocampus-Enterprise-Agent',
              },
            });
          } catch (err) {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                stage: 'user_profile_network',
                errorType: err instanceof Error ? err.name : 'UnknownError',
              },
            });
            return res
              .status(502)
              .send(
                'Failed to verify GitHub user identity. Connection was not saved.'
              );
          }

          if (!userRes.ok) {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                stage: 'user_profile_http',
                httpStatus: userRes.status,
              },
            });
            return res
              .status(502)
              .send(
                'GitHub identity verification failed. Connection was not saved.'
              );
          }

          const userJson = (await userRes.json()) as { login?: string };
          if (!userJson.login || typeof userJson.login !== 'string') {
            await recordSecurityAuditEvent({
              actorUid: stateRecord.actorUid,
              actorRole: stateRecord.actorRole,
              action: 'connector.github_oauth_failed',
              targetResource: 'connector:github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: { stage: 'user_profile_missing_login' },
            });
            return res
              .status(502)
              .send(
                'GitHub profile response did not contain a valid username. Connection was not saved.'
              );
          }

          connectedUser = `@${userJson.login.replace(/^@+/, '')}`;
        }

        // Persist per-user AES-256-GCM encrypted GitHub connection in PostgreSQL
        await upsertUserConnectorConnection({
          userUid: stateRecord.actorUid,
          provider: 'github',
          externalUsername: connectedUser,
          accessToken,
        });

        await recordSecurityAuditEvent({
          actorUid: stateRecord.actorUid,
          actorRole: stateRecord.actorRole,
          action: 'connector.github_oauth_connected',
          targetResource: `connector:github:${stateRecord.actorUid}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { username: connectedUser },
        });

        const safeUserHtml = escapeHtml(connectedUser);
        const safeUserScript = serializeJsonForScript(connectedUser);
        const safeOriginScript = serializeJsonForScript(
          stateRecord.targetOrigin
        );

        res.setHeader('Cache-Control', 'no-store');
        return res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>GitHub OAuth Connected — Hippocampus</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #090D16; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { border: 1px solid #1e293b; background: #0f172a; border-radius: 12px; padding: 24px 32px; text-align: center; max-width: 380px; }
      .badge { color: #34d399; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
      p { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="badge">GitHub Connected (${safeUserHtml})</div>
      <p>Authentication successful. This popup window will close automatically.</p>
    </div>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'GITHUB_OAUTH_SUCCESS', username: ${safeUserScript} }, ${safeOriginScript});
        setTimeout(() => window.close(), 350);
      }
    </script>
  </body>
</html>`);
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to complete GitHub OAuth callback',
          error
        );
      }
    }
  );

  app.post(
    '/api/connectors/github/sync',
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const parsed = GithubSyncRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message || 'Invalid GitHub sync payload.',
          });
        }

        const {
          repoFullName: cleanRepo,
          branch: cleanBranch,
          accessLevel: targetTier,
          githubToken,
        } = parsed.data;

        if (
          targetTier === 'Admin' &&
          !roleHasPermission(actor.role, 'sources:ingest:admin')
        ) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'authz.denied',
            targetResource: `connector:github:${cleanRepo}`,
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'admin_tier_ingest_forbidden' },
          });
          return res.status(403).json({
            error:
              'RBAC Forbidden: Only Admin can ingest Admin-classified GitHub docs.',
          });
        }

        // AUD-004: Strictly fetch ONLY the authenticated actor's own GitHub OAuth connection
        const userConn = await getUserConnectorConnection(actor.uid, 'github');
        const tokenToUse =
          githubToken?.trim() ||
          userConn?.accessToken ||
          process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
          undefined;

        const {
          files: fetchedFiles,
          commitSha: repoCommitSha,
          liveApiUsed,
        } = await fetchRepoDocs(cleanRepo, cleanBranch, tokenToUse);

        let totalChunksUpserted = 0;
        const upsertedDocs: Array<{
          documentId: number;
          title: string;
          chunksUpserted: number;
          action: 'updated' | 'inserted';
        }> = [];

        for (const file of fetchedFiles) {
          const result = await upsertConnectorDocument({
            title: file.title,
            sourceType: 'github',
            sourceUrl: file.sourceUrl,
            accessLevel: targetTier,
            content: file.content,
            userId: actor.uid,
            metadata: {
              repoFullName: cleanRepo,
              branch: cleanBranch,
              path: file.path,
              sha: file.sha || repoCommitSha,
              liveApiUsed,
            },
          });
          totalChunksUpserted += result.chunksUpserted;
          upsertedDocs.push(result);
        }

        const syncLog = await recordConnectorSyncLog({
          provider: 'github',
          target: cleanRepo,
          branchOrFolder: `refs/heads/${cleanBranch}`,
          triggerType: 'manual_sync',
          status: 'Synced',
          filesProcessed: fetchedFiles.length,
          chunksUpserted: totalChunksUpserted,
          commitSha: (fetchedFiles[0]?.sha || repoCommitSha || 'HEAD').slice(
            0,
            7
          ),
          details: `Synced ${fetchedFiles.length} Markdown/TXT file(s) from ${cleanRepo}@${cleanBranch} and upserted ${totalChunksUpserted} vector chunks.`,
        });

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'connector.github_synced',
          targetResource: `connector:github:${cleanRepo}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: {
            branch: cleanBranch,
            accessLevel: targetTier,
            filesProcessed: fetchedFiles.length,
            chunksUpserted: totalChunksUpserted,
          },
        });

        res.json({
          synced: true,
          repoFullName: cleanRepo,
          branch: cleanBranch,
          filesProcessed: fetchedFiles.length,
          chunksUpserted: totalChunksUpserted,
          documents: upsertedDocs,
          syncLog,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to sync GitHub repository',
          error
        );
      }
    }
  );

  // =========================================================================
  // MISSION 001 OBJECTIVE C: PRODUCTION GITHUB WEBHOOK (MANDATORY HMAC-SHA256)
  // Zero simulator bypasses. Verifies exact raw bytes with crypto.timingSafeEqual.
  // =========================================================================
  app.post(
    '/api/webhooks/github',
    createRateLimitMiddleware('github'),
    async (req: RawBodyRequest, res: Response) => {
      try {
        const signature = req.headers['x-hub-signature-256'] as
          | string
          | undefined;
        const githubEvent = (
          (req.headers['x-github-event'] as string | undefined) || ''
        )
          .trim()
          .toLowerCase();
        const deliveryId = (
          (req.headers['x-github-delivery'] as string | undefined) || ''
        ).trim();

        // Mandatory HMAC-SHA256 verification over exact raw request bytes (never re-serialized JSON!)
        const verification = verifyGithubWebhookSignatureDetailed(
          signature,
          req.rawBodyBuffer
        );

        if (!verification.valid) {
          if (verification.reason === 'missing_secret') {
            await recordSecurityAuditEvent({
              actorUid: 'webhook:github',
              actorRole: 'System',
              action: 'webhook.config_missing',
              targetResource: 'POST /api/webhooks/github',
              outcome: 'failure',
              requestId: req.requestId,
              metadata: {
                reason: 'missing_github_webhook_secret',
                deliveryId: deliveryId || undefined,
              },
            });
            return res.status(503).json({
              error:
                'GitHub webhook verification is not configured on this server.',
            });
          }

          await recordSecurityAuditEvent({
            actorUid: 'webhook:github',
            actorRole: 'System',
            action: 'webhook.signature_failed',
            targetResource: 'POST /api/webhooks/github',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: {
              reason: verification.reason,
              event: githubEvent || 'missing',
              deliveryId: deliveryId || undefined,
              simulatorHeaderPresent: Boolean(
                req.headers['x-hippocampus-simulator']
              ),
            },
          });

          return res.status(401).json({
            error: 'Invalid or missing GitHub webhook X-Hub-Signature-256.',
          });
        }

        // Validate GitHub event type
        if (!githubEvent || !['push', 'ping'].includes(githubEvent)) {
          return res.status(400).json({
            error: `Unsupported or missing X-GitHub-Event header: "${githubEvent || 'none'}".`,
          });
        }

        // AUD-008: Mandatory X-GitHub-Delivery header for replay protection (fail closed)
        if (!deliveryId || !GITHUB_DELIVERY_ID_REGEX.test(deliveryId)) {
          await recordSecurityAuditEvent({
            actorUid: 'webhook:github',
            actorRole: 'System',
            action: 'webhook.missing_delivery_id',
            targetResource: 'POST /api/webhooks/github',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { event: githubEvent },
          });
          return res.status(400).json({
            error:
              'Missing or malformed X-GitHub-Delivery header required for replay protection.',
          });
        }

        // Validate payload schema (production webhook does NOT accept simulatedDocs)
        const parsed = GithubWebhookPayloadSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid GitHub webhook payload.',
          });
        }

        const payload = parsed.data;

        if (githubEvent === 'ping') {
          return res.status(200).json({
            ok: true,
            status: 'pong',
            deliveryId,
          });
        }

        const repoFullName = payload.repository?.full_name;
        if (!repoFullName) {
          return res.status(400).json({
            error: 'GitHub push payload must include repository.full_name.',
          });
        }

        // Repository allowlist check when GITHUB_ALLOWED_REPOS is configured
        const allowedRepos = getAllowedGithubRepos();
        if (
          allowedRepos.length > 0 &&
          !allowedRepos.includes(repoFullName.toLowerCase())
        ) {
          await recordSecurityAuditEvent({
            actorUid: 'webhook:github',
            actorRole: 'System',
            action: 'webhook.repo_not_allowed',
            targetResource: `github:${repoFullName}`,
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { repoFullName, deliveryId },
          });
          return res.status(403).json({
            error: `Repository "${repoFullName}" is not in GITHUB_ALLOWED_REPOS.`,
          });
        }

        // Persistent delivery replay protection / idempotency via mandatory X-GitHub-Delivery
        const { isNew } = await recordWebhookDeliveryIfNew({
          provider: 'github',
          deliveryId,
          eventType: githubEvent,
        });
        if (!isNew) {
          await recordSecurityAuditEvent({
            actorUid: 'webhook:github',
            actorRole: 'System',
            action: 'webhook.duplicate_suppressed',
            targetResource: `github:${repoFullName}`,
            outcome: 'success',
            requestId: req.requestId,
            metadata: { deliveryId },
          });
          return res.status(200).json({
            ok: true,
            status: 'duplicate_delivery_ignored',
            deliveryId,
          });
        }

        const ref = payload.ref || 'refs/heads/main';
        const commitSha = (
          payload.after ||
          payload.commits?.[0]?.id ||
          'HEAD'
        ).slice(0, 7);

        if (ref !== 'refs/heads/main' && ref !== 'refs/heads/master') {
          const skippedLog = await recordConnectorSyncLog({
            provider: 'github',
            target: repoFullName,
            branchOrFolder: ref,
            triggerType: 'webhook_push',
            status: 'Skipped',
            filesProcessed: 0,
            chunksUpserted: 0,
            commitSha,
            details: `Ignored push event on non-default branch ${ref} (listener only indexes refs/heads/main).`,
          });
          return res.status(200).json({
            ok: true,
            status: 'skipped_non_main_branch',
            ref,
            syncLog: skippedLog,
          });
        }

        // Background webhook uses dedicated server service token only — never another user's OAuth token
        const fetched = await fetchRepoDocs(
          repoFullName,
          'main',
          process.env.GITHUB_PERSONAL_ACCESS_TOKEN || undefined
        );

        let totalChunksUpserted = 0;
        const upsertedDocs: Array<{
          documentId: number;
          title: string;
          chunksUpserted: number;
          action: 'updated' | 'inserted';
        }> = [];

        for (const doc of fetched.files) {
          const upserted = await upsertConnectorDocument({
            title: doc.title,
            sourceType: 'github',
            sourceUrl: doc.sourceUrl,
            accessLevel: 'Engineer',
            content: doc.content,
            metadata: {
              repoFullName,
              ref,
              commitSha,
              path: doc.path,
              deliveryId: deliveryId || undefined,
            },
          });
          totalChunksUpserted += upserted.chunksUpserted;
          upsertedDocs.push(upserted);
        }

        const syncLog = await recordConnectorSyncLog({
          provider: 'github',
          target: repoFullName,
          branchOrFolder: ref,
          triggerType: 'webhook_push',
          status: 'Synced',
          filesProcessed: fetched.files.length,
          chunksUpserted: totalChunksUpserted,
          commitSha,
          details: `Verified HMAC webhook push (${commitSha}) on ${ref}: re-chunked & embedded ${fetched.files.length} Markdown file(s) (${totalChunksUpserted} chunks).`,
        });

        await recordSecurityAuditEvent({
          actorUid: 'webhook:github',
          actorRole: 'System',
          action: 'webhook.github_processed',
          targetResource: `github:${repoFullName}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: {
            ref,
            commitSha,
            deliveryId: deliveryId || undefined,
            filesProcessed: fetched.files.length,
            chunksUpserted: totalChunksUpserted,
          },
        });

        return res.status(200).json({
          ok: true,
          status: 'webhook_processed',
          repoFullName,
          ref,
          commitSha,
          deliveryId: deliveryId || undefined,
          filesProcessed: fetched.files.length,
          chunksUpserted: totalChunksUpserted,
          documents: upsertedDocs,
          syncLog,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to process GitHub push webhook',
          error
        );
      }
    }
  );

  /**
   * Isolated Development-Only GitHub Webhook Simulator.
   * Disabled completely when NODE_ENV !== 'development'.
   * Requires verified Manager/Admin auth and performs a non-contaminating dry-run preview.
   */
  app.post(
    '/api/dev/webhooks/github/simulate',
    (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV !== 'development') {
        return res.status(404).json({
          error: 'Development webhook simulator is not available in this environment.',
        });
      }
      return next();
    },
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const parsed = DevGithubWebhookSimulateSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid simulated GitHub webhook payload.',
          });
        }

        const payload = parsed.data;
        const ref = payload.ref;
        const repoFullName = payload.repository.full_name;
        const commitSha = (
          payload.after ||
          payload.commits?.[0]?.id ||
          'sim0001'
        ).slice(0, 7);

        if (ref !== 'refs/heads/main' && ref !== 'refs/heads/master') {
          return res.status(200).json({
            ok: true,
            simulated: true,
            dryRun: true,
            status: 'skipped_non_main_branch',
            ref,
            repoFullName,
            commitSha,
          });
        }

        const docs = payload.simulatedDocs || [];
        let previewChunks = 0;
        for (const doc of docs) {
          previewChunks += splitIntoChunks(doc.content).length;
        }

        return res.status(200).json({
          ok: true,
          simulated: true,
          dryRun: true,
          status: 'webhook_simulated',
          repoFullName,
          ref,
          commitSha,
          filesProcessed: docs.length,
          chunksUpserted: previewChunks,
          note: 'Development dry-run simulation complete. Production knowledge tables were not mutated.',
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to run development GitHub webhook simulation',
          error
        );
      }
    }
  );

  app.get(
    '/api/connectors/gdrive/files',
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const googleAccessToken = req.headers['x-google-access-token'] as
          | string
          | undefined;
        if (!googleAccessToken) {
          return res.status(401).json({
            error:
              'Google Workspace OAuth access token required. Click "Sign in with Google" to authorize Google Drive & Docs read access.',
          });
        }

        const files = await listGoogleDriveDocuments(googleAccessToken);
        res.json({ files });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to list Google Drive documents',
          error
        );
      }
    }
  );

  app.post(
    '/api/connectors/gdrive/import',
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const parsed = GdriveImportRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid Google Drive import payload.',
          });
        }

        const googleAccessToken = req.headers['x-google-access-token'] as
          | string
          | undefined;

        const { fileId, mimeType, accessLevel, googleDocJson } = parsed.data;
        const targetTier = normalizeRbacRole(accessLevel);

        if (
          targetTier === 'Admin' &&
          !roleHasPermission(actor.role, 'sources:ingest:admin')
        ) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'authz.denied',
            targetResource: `connector:gdrive:${fileId || 'structural_doc'}`,
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'admin_tier_ingest_forbidden' },
          });
          return res.status(403).json({
            error:
              'RBAC Forbidden: Only Admin can ingest Admin-classified Google Drive documents.',
          });
        }

        let docTitle = '';
        let markdownContent = '';
        let webViewLink = '';

        if (googleDocJson && googleDocJson.body?.content) {
          docTitle =
            googleDocJson.title || 'Google Workspace Engineering Specification';
          markdownContent = convertGoogleDocToMarkdown(
            googleDocJson as GoogleDocStructuralResponse
          );
          webViewLink =
            googleDocJson.sourceUrl ||
            `https://docs.google.com/document/d/${googleDocJson.documentId || 'gdoc-spec'}/edit`;
        } else if (fileId) {
          if (!googleAccessToken) {
            return res.status(401).json({
              error:
                'Google Workspace access token missing. Please authenticate with Google Drive & Docs first.',
            });
          }
          const pulled = await pullGoogleDriveDocumentAsMarkdown(
            fileId,
            googleAccessToken,
            mimeType
          );
          docTitle = pulled.title;
          markdownContent = pulled.markdown;
          webViewLink = pulled.sourceUrl;
        } else {
          return res.status(400).json({
            error:
              'Provide either a Google Drive fileId or a Google Docs structural payload to import.',
          });
        }

        const upserted = await upsertConnectorDocument({
          title: docTitle,
          sourceType: 'gdrive',
          sourceUrl: webViewLink,
          accessLevel: targetTier,
          content: markdownContent,
          userId: actor.uid,
          metadata: {
            provider: 'google_workspace',
            fileId: fileId || googleDocJson?.documentId || 'structural_doc',
          },
        });

        const syncLog = await recordConnectorSyncLog({
          provider: 'gdrive',
          target: docTitle,
          branchOrFolder: 'Google Workspace Drive',
          triggerType: 'drive_import',
          status: 'Synced',
          filesProcessed: 1,
          chunksUpserted: upserted.chunksUpserted,
          commitSha: null,
          details: `Converted Google Doc "${docTitle}" to clean Markdown (${markdownContent.length} chars) and upserted ${upserted.chunksUpserted} semantic vector chunks.`,
        });

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'connector.gdrive_imported',
          targetResource: `document:${upserted.documentId}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: {
            accessLevel: targetTier,
            chunksUpserted: upserted.chunksUpserted,
          },
        });

        res.json({
          imported: true,
          document: upserted,
          markdownPreview: markdownContent.slice(0, 500),
          syncLog,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to import Google Drive document',
          error
        );
      }
    }
  );

  // =========================================================================
  // KNOWLEDGE, OVERVIEW, TELEMETRY & AUDIT LOGS
  // =========================================================================
  app.get(
    '/api/overview',
    requireAuthentication,
    requirePermission('knowledge:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const data = await getOverviewPayload(actor.role);
        res.json(data);
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to load overview', error);
      }
    }
  );

  app.get(
    '/api/telemetry',
    requireAuthentication,
    requirePermission('telemetry:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const role = actor.role;
        const metrics = getObservabilityMetrics();
        const rateLimit = getRateLimitStatus();
        // AUD-002: Role-scoped, metadata-only cache telemetry (never exposes raw answers/embeddings/titles)
        const { summary: cacheSummary, entries: cacheEntries } =
          await getSemanticCacheTelemetry(role);
        const envReport = getEnvValidationReport();
        res.json({
          ...metrics,
          rateLimit,
          cacheSummary,
          cacheEntries,
          envReport,
          rbacPolicy: {
            activeRole: role,
            allowedTiers: getAllowedTiersForRole(role),
            canIngest: roleHasPermission(role, 'sources:ingest'),
            canDeleteDocuments: roleHasPermission(role, 'sources:delete'),
            canMutateSettings: roleHasPermission(role, 'settings:manage'),
          },
        });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to fetch telemetry', error);
      }
    }
  );

  app.get(
    '/api/audit-logs',
    requireAuthentication,
    requirePermission('audit:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const limitParam = Number(req.query.limit || 100);
        const safeLimit = Number.isFinite(limitParam) ? limitParam : 100;
        const auditLogs = await getSecurityAuditLogs(safeLimit);
        res.json({ auditLogs });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to fetch security audit logs',
          error
        );
      }
    }
  );

  app.delete(
    '/api/cache',
    requireAuthentication,
    requirePermission('cache:purge'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const result = await purgeSemanticCache();
        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'cache.purged',
          targetResource: 'semantic_cache:global',
          outcome: 'success',
          requestId: req.requestId,
        });
        res.json(result);
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to purge cache', error);
      }
    }
  );

  app.post(
    '/api/ratelimit/reset',
    requireAuthentication,
    requirePermission('ratelimit:reset'),
    async (req: AuthRequest, res: Response) => {
      const actor = req.authUser!;
      resetRateLimitBuckets();
      await recordSecurityAuditEvent({
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: 'ratelimit.reset',
        targetResource: 'ratelimit:global',
        outcome: 'success',
        requestId: req.requestId,
      });
      res.json({ reset: true, rateLimit: getRateLimitStatus() });
    }
  );

  app.post(
    '/api/telemetry/client-error',
    requireAuthentication,
    (req: AuthRequest, res: Response) => {
      const parsed = ClientErrorTelemetrySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid telemetry payload.' });
      }
      emitStructuredLog({
        level: 'error',
        component: 'client',
        event: 'react.error_boundary',
        requestId: req.requestId,
        metadata: {
          actorUid: req.authUser?.uid,
          componentStack: parsed.data.componentStack?.slice(0, 300),
        },
        message: `Client Error Boundary caught exception: ${parsed.data.message}`,
      });
      res.json({ recorded: true });
    }
  );

  app.get(
    '/api/documents',
    requireAuthentication,
    requirePermission('sources:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const role = req.authUser!.role;
        const docs = await getDocumentsList(role);
        res.json({ documents: docs, activeRole: role });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to fetch documents', error);
      }
    }
  );

  app.post(
    '/api/documents',
    createRateLimitMiddleware('documents'),
    requireAuthentication,
    requirePermission('sources:ingest'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const parsed = IngestDocumentRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Invalid document ingestion payload.',
          });
        }

        const { title, sourceType, sourceUrl, accessLevel, content } =
          parsed.data;

        if (
          accessLevel === 'Admin' &&
          !roleHasPermission(actor.role, 'sources:ingest:admin')
        ) {
          await recordSecurityAuditEvent({
            actorUid: actor.uid,
            actorEmail: actor.email,
            actorRole: actor.role,
            action: 'authz.denied',
            targetResource: 'documents:admin_tier',
            outcome: 'denied',
            requestId: req.requestId,
            metadata: { reason: 'admin_tier_ingest_forbidden' },
          });
          return res.status(403).json({
            error:
              'RBAC Forbidden: Only Admin can ingest Admin-classified documents.',
          });
        }

        const created = await ingestDocument({
          title,
          sourceType,
          sourceUrl: sourceUrl || null,
          accessLevel,
          content,
          userId: actor.uid,
        });

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'document.ingested',
          targetResource: `document:${created.id}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { sourceType, accessLevel },
        });

        res.status(201).json({ document: created });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to ingest document', error);
      }
    }
  );

  app.delete(
    '/api/documents/:id',
    requireAuthentication,
    requirePermission('sources:delete'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const docId = Number(req.params.id);
        if (!Number.isInteger(docId) || docId <= 0) {
          return res.status(400).json({ error: 'Invalid document ID.' });
        }
        const result = await deleteDocumentById(docId);

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'document.deleted',
          targetResource: `document:${docId}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { documentId: docId },
        });

        res.json(result);
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to delete document', error);
      }
    }
  );

  app.post(
    '/api/tools/execute',
    requireAuthentication,
    requirePermission('assistant:use'),
    (req: AuthRequest, res: Response) => {
      const parsed = ExecuteToolRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message || 'Invalid tool execution payload.',
        });
      }
      const invocation = executeEnterpriseTool(
        parsed.data.toolName,
        parsed.data.args,
        req.requestId
      );
      res.json({ invocation });
    }
  );

  app.post(
    '/api/chat',
    createRateLimitMiddleware('chat'),
    requireAuthentication,
    requirePermission('assistant:use'),
    async (req: AuthRequest, res: Response) => {
      const startTime = Date.now();
      try {
        const actor = req.authUser!;
        const parsed = ChatQueryRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message || 'Invalid chat query payload.',
          });
        }

        const { message, query, channel, bypassCache, searchMode } =
          parsed.data;
        const promptText = (query || message || '').trim();
        if (!promptText) {
          return res.status(400).json({ error: 'Query cannot be empty.' });
        }

        const activeSearchMode: HybridSearchMode = searchMode || 'hybrid_rrf';
        const activeRole: RbacRole = actor.role;
        const userHandle = `@${actor.email.split('@')[0]}`;

        if (!bypassCache) {
          const cached = await lookupSemanticCache(
            promptText,
            activeRole,
            activeSearchMode
          );
          if (cached.hit && cached.answer) {
            const latencyMs = Math.max(8, Date.now() - startTime);
            const chunks = await searchKnowledgeChunks(
              promptText,
              4,
              activeSearchMode,
              activeRole
            );

            const highestTier: RbacRole = chunks.some(
              (c) => c.accessLevel === 'Admin'
            )
              ? 'Admin'
              : chunks.some((c) => c.accessLevel === 'Manager')
                ? 'Manager'
                : 'Engineer';

            await recordQueryLog({
              userHandle,
              channel: channel || 'Playground',
              query: promptText,
              answer: cached.answer,
              sources: cached.sources || [],
              confidence: cached.confidence || 95,
              latencyMs,
              resolved:
                (cached.sources?.length ?? 0) > 0 ||
                (cached.toolCalls?.length ?? 0) > 0,
              cacheHit: true,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              searchMode: activeSearchMode,
              requiredRole: highestTier,
              toolCalls: cached.toolCalls || [],
            });

            return res.json({
              answer: cached.answer,
              sources: cached.sources || [],
              confidence: cached.confidence || 95,
              latencyMs,
              cacheHit: true,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              searchMode: activeSearchMode,
              activeRole,
              toolCalls: cached.toolCalls || [],
              chunks: chunks.map((c) => ({
                documentTitle: c.documentTitle,
                sourceType: c.sourceType,
                accessLevel: c.accessLevel,
                similarity: Number((c.similarity * 100).toFixed(1)),
                vectorScore: Number((c.vectorScore * 100).toFixed(1)),
                bm25Score: Number((c.bm25Score * 100).toFixed(1)),
                rrfScore: Number((c.rrfScore * 100).toFixed(1)),
                matchedTerms: c.matchedTerms,
                excerpt: c.content.slice(0, 220),
              })),
            });
          }
        }

        const chunks = await searchKnowledgeChunks(
          promptText,
          4,
          activeSearchMode,
          activeRole
        );

        const ragResult = await synthesizeRagAnswer(
          promptText,
          chunks,
          req.requestId
        );
        const latencyMs = Math.max(120, Date.now() - startTime);

        const highestTier: RbacRole = chunks.some(
          (c) => c.accessLevel === 'Admin'
        )
          ? 'Admin'
          : chunks.some((c) => c.accessLevel === 'Manager')
            ? 'Manager'
            : 'Engineer';

        await storeInSemanticCache({
          query: promptText,
          role: activeRole,
          searchMode: activeSearchMode,
          answer: ragResult.answer,
          sources: ragResult.sources,
          confidence: ragResult.confidence,
          toolCalls: ragResult.toolCalls,
        });

        await recordQueryLog({
          userHandle,
          channel: channel || 'Playground',
          query: promptText,
          answer: ragResult.answer,
          sources: ragResult.sources,
          confidence: ragResult.confidence,
          latencyMs,
          resolved:
            ragResult.sources.length > 0 || ragResult.toolCalls.length > 0,
          cacheHit: false,
          promptTokens: ragResult.promptTokens,
          completionTokens: ragResult.completionTokens,
          totalTokens: ragResult.totalTokens,
          searchMode: activeSearchMode,
          requiredRole: highestTier,
          toolCalls: ragResult.toolCalls,
        });

        res.json({
          answer: ragResult.answer,
          sources: ragResult.sources,
          confidence: ragResult.confidence,
          latencyMs,
          cacheHit: false,
          promptTokens: ragResult.promptTokens,
          completionTokens: ragResult.completionTokens,
          totalTokens: ragResult.totalTokens,
          searchMode: activeSearchMode,
          activeRole,
          toolCalls: ragResult.toolCalls,
          chunks: chunks.map((c) => ({
            documentTitle: c.documentTitle,
            sourceType: c.sourceType,
            accessLevel: c.accessLevel,
            similarity: Number((c.similarity * 100).toFixed(1)),
            vectorScore: Number((c.vectorScore * 100).toFixed(1)),
            bm25Score: Number((c.bm25Score * 100).toFixed(1)),
            rrfScore: Number((c.rrfScore * 100).toFixed(1)),
            matchedTerms: c.matchedTerms,
            excerpt: c.content.slice(0, 220),
          })),
        });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'RAG pipeline failed', error);
      }
    }
  );

  app.get(
    '/api/logs',
    requireAuthentication,
    requirePermission('knowledge:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const role = req.authUser!.role;
        const logs = await getRecentQueryLogs(role);
        res.json({ logs, activeRole: role });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to fetch query logs', error);
      }
    }
  );

  app.get(
    '/api/settings',
    requireAuthentication,
    requirePermission('settings:read'),
    async (req: AuthRequest, res: Response) => {
      try {
        const settings = await getAgentSettingsList();
        res.json({ settings });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to fetch settings', error);
      }
    }
  );

  app.patch(
    '/api/settings/:key',
    requireAuthentication,
    requirePermission('settings:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const actor = req.authUser!;
        const { key } = req.params;
        if (!ALLOWED_SETTING_KEYS.has(key)) {
          return res.status(400).json({
            error: `Unknown setting key "${key}".`,
          });
        }

        const parsed = UpdateSettingRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error:
              parsed.error.issues[0]?.message ||
              'Boolean enabled state is required.',
          });
        }

        const updated = await updateAgentSettingByKey(key, parsed.data.enabled);

        await recordSecurityAuditEvent({
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: 'settings.updated',
          targetResource: `setting:${key}`,
          outcome: 'success',
          requestId: req.requestId,
          metadata: { key, enabled: parsed.data.enabled },
        });

        res.json({ setting: updated });
      } catch (error: unknown) {
        return sendSafeServerError(req, res, 'Failed to update setting', error);
      }
    }
  );

  // =========================================================================
  // SLACK WEBHOOK (STRICT HMAC-SHA256, LEAST-PRIVILEGE SEARCH, NO HEADER BYPASS)
  // =========================================================================
  async function processSlackEventTask(
    event: SlackEventPayload['event'],
    requestId?: string
  ) {
    const startTime = Date.now();
    if (event.type === 'member_joined_channel') {
      const welcome = buildWelcomeMessage(event.channel || '#eng-onboarding');
      const latencyMs = Math.max(12, Date.now() - startTime);
      await recordQueryLog({
        userHandle: event.user || '@new.hire',
        channel: `Slack ${event.channel || '#eng-onboarding'}`,
        query: '[Event: member_joined_channel] Proactive onboarding greeting',
        answer: welcome,
        sources: ['Engineering Onboarding & SSO Setup Guide'],
        confidence: 99,
        latencyMs,
        resolved: true,
        cacheHit: true,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        searchMode: 'hybrid_rrf',
        requiredRole: 'Engineer',
        toolCalls: [],
      });
      return {
        eventType: 'member_joined_channel' as const,
        channel: event.channel || '#eng-onboarding',
        reply: welcome,
        sources: ['Engineering Onboarding & SSO Setup Guide'],
        confidence: 99,
        latencyMs,
        cacheHit: true,
        totalTokens: 0,
        toolCalls: [],
      };
    }

    const cleanQuestion = (event.text || '')
      .replace(/<@[A-Z0-9]+>|@Hippocampus/gi, '')
      .trim();

    if (!cleanQuestion) {
      return {
        eventType: 'app_mention' as const,
        channel: event.channel || '#eng-onboarding',
        reply:
          "Hi! Mention me with a question like `@Hippocampus How do I configure SSO?` and I'll search our engineering docs.",
        sources: [],
        confidence: 100,
        latencyMs: 15,
        cacheHit: true,
        totalTokens: 0,
        toolCalls: [],
      };
    }

    // Least-privilege: Slack channel mentions only search Engineer-tier docs (never Admin secrets)
    const slackRole: RbacRole = 'Engineer';

    const cached = await lookupSemanticCache(
      cleanQuestion,
      slackRole,
      'hybrid_rrf'
    );
    if (cached.hit && cached.answer) {
      const latencyMs = Math.max(10, Date.now() - startTime);
      await recordQueryLog({
        userHandle: event.user || '@slack.engineer',
        channel: `Slack ${event.channel || '#eng-onboarding'}`,
        query: cleanQuestion,
        answer: cached.answer,
        sources: cached.sources || [],
        confidence: cached.confidence || 95,
        latencyMs,
        resolved:
          (cached.sources?.length ?? 0) > 0 ||
          (cached.toolCalls?.length ?? 0) > 0,
        cacheHit: true,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        searchMode: 'hybrid_rrf',
        requiredRole: slackRole,
        toolCalls: cached.toolCalls || [],
      });
      return {
        eventType: 'app_mention' as const,
        channel: event.channel || '#eng-onboarding',
        reply: cached.answer,
        sources: cached.sources || [],
        confidence: cached.confidence || 95,
        latencyMs,
        cacheHit: true,
        totalTokens: 0,
        toolCalls: cached.toolCalls || [],
      };
    }

    const chunks = await searchKnowledgeChunks(
      cleanQuestion,
      4,
      'hybrid_rrf',
      slackRole
    );
    const ragResult = await synthesizeRagAnswer(
      cleanQuestion,
      chunks,
      requestId
    );
    const latencyMs = Math.max(140, Date.now() - startTime);

    await storeInSemanticCache({
      query: cleanQuestion,
      role: slackRole,
      searchMode: 'hybrid_rrf',
      answer: ragResult.answer,
      sources: ragResult.sources,
      confidence: ragResult.confidence,
      toolCalls: ragResult.toolCalls,
    });

    await recordQueryLog({
      userHandle: event.user || '@slack.engineer',
      channel: `Slack ${event.channel || '#eng-onboarding'}`,
      query: cleanQuestion,
      answer: ragResult.answer,
      sources: ragResult.sources,
      confidence: ragResult.confidence,
      latencyMs,
      resolved: ragResult.sources.length > 0 || ragResult.toolCalls.length > 0,
      cacheHit: false,
      promptTokens: ragResult.promptTokens,
      completionTokens: ragResult.completionTokens,
      totalTokens: ragResult.totalTokens,
      searchMode: 'hybrid_rrf',
      requiredRole: slackRole,
      toolCalls: ragResult.toolCalls,
    });

    return {
      eventType: 'app_mention' as const,
      channel: event.channel || '#eng-onboarding',
      reply: ragResult.answer,
      sources: ragResult.sources,
      confidence: ragResult.confidence,
      latencyMs,
      cacheHit: false,
      totalTokens: ragResult.totalTokens,
      toolCalls: ragResult.toolCalls,
    };
  }

  app.post(
    '/api/slack/events',
    createRateLimitMiddleware('slack'),
    async (req: RawBodyRequest, res: Response) => {
      const webhookReceivedAt = Date.now();
      try {
        const secret = process.env.SLACK_SIGNING_SECRET?.trim();
        if (!secret) {
          await recordSecurityAuditEvent({
            actorUid: 'webhook:slack',
            actorRole: 'System',
            action: 'webhook.config_missing',
            targetResource: 'POST /api/slack/events',
            outcome: 'failure',
            requestId: req.requestId,
            metadata: { reason: 'missing_slack_signing_secret' },
          });
          return res.status(503).json({
            error: 'Slack webhook signing secret is not configured.',
          });
        }

        const signature = req.headers['x-slack-signature'] as
          | string
          | undefined;
        const timestamp = req.headers['x-slack-request-timestamp'] as
          | string
          | undefined;

        if (!req.rawBodyBuffer || req.rawBodyBuffer.length === 0) {
          return res
            .status(401)
            .json({ error: 'Invalid Slack HMAC-SHA256 signature' });
        }

        // AUD-009: Verify exact raw incoming request bytes with strict 10-digit timestamp and v0=<64hex>
        const isValid = verifySlackRequest(
          signature,
          timestamp,
          req.rawBodyBuffer,
          secret
        );
        if (!isValid) {
          await recordSecurityAuditEvent({
            actorUid: 'webhook:slack',
            actorRole: 'System',
            action: 'webhook.signature_failed',
            targetResource: 'POST /api/slack/events',
            outcome: 'denied',
            requestId: req.requestId,
          });
          return res
            .status(401)
            .json({ error: 'Invalid Slack HMAC-SHA256 signature' });
        }

        const parsedPayload = SlackEventPayloadSchema.safeParse(req.body);
        if (!parsedPayload.success) {
          return res.status(400).json({
            error:
              parsedPayload.error.issues[0]?.message ||
              'Invalid Slack webhook payload.',
          });
        }

        const payload = parsedPayload.data;
        if (payload.type === 'url_verification') {
          if (!payload.challenge) {
            return res
              .status(400)
              .json({ error: 'Missing Slack url_verification challenge.' });
          }
          return res.status(200).json({ challenge: payload.challenge });
        }

        const event = payload.event;
        if (!event) {
          return res.status(200).json({ ok: true, skipped: 'missing_event' });
        }

        if (!payload.event_id) {
          return res.status(400).json({
            error: 'Missing Slack event_id required for idempotency.',
          });
        }

        // AUD-009: Deduplicate strictly by event_id via PostgreSQL (never blindly on X-Slack-Retry-Num)
        const { isNew } = await recordWebhookDeliveryIfNew({
          provider: 'slack',
          deliveryId: payload.event_id,
          eventType: event.type,
        });

        const ackLatencyMs = Math.max(2, Date.now() - webhookReceivedAt);

        if (!isNew) {
          recordSlackWebhookMetric({
            deduplicatedRetry: true,
            eventType: event.type,
            ackLatencyMs,
            channel: event.channel,
          });
          return res.status(200).json({
            ok: true,
            status: 'duplicate_retry_suppressed',
            ackLatencyMs,
          });
        }

        recordSlackWebhookMetric({
          deduplicatedRetry: false,
          eventType: event.type,
          ackLatencyMs,
          channel: event.channel,
        });

        res.status(200).json({
          ok: true,
          status: 'accepted_async',
          ackLatencyMs,
        });

        setImmediate(() => {
          processSlackEventTask(event, req.requestId).catch((err) => {
            emitStructuredLog({
              level: 'error',
              component: 'slack',
              event: 'slack.async_worker_error',
              requestId: req.requestId,
              message: `Async Slack worker error: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        });
        return;
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Slack webhook processing error',
          error
        );
      }
    }
  );

  /**
   * Isolated Development-Only Slack Event Simulator (Non-Mutating Dry-Run).
   * Disabled completely when NODE_ENV !== 'development'.
   * Never mutates query_logs, semantic_cache, or webhook_deliveries.
   */
  app.post(
    '/api/dev/slack/events/simulate',
    (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV !== 'development') {
        return res.status(404).json({
          error:
            'Development Slack simulator is not available in this environment.',
        });
      }
      return next();
    },
    requireAuthentication,
    requirePermission('connectors:manage'),
    async (req: AuthRequest, res: Response) => {
      const start = Date.now();
      try {
        const parsedPayload = SlackEventPayloadSchema.safeParse(req.body);
        if (
          !parsedPayload.success ||
          parsedPayload.data.type !== 'event_callback'
        ) {
          return res.status(400).json({
            error:
              (!parsedPayload.success &&
                parsedPayload.error.issues[0]?.message) ||
              'Missing or invalid Slack event_callback payload.',
          });
        }

        const payload = parsedPayload.data;
        const event = payload.event;
        const ackLatencyMs = Math.max(2, Date.now() - start);

        const eventId = payload.event_id?.trim();
        if (eventId && devSimulatedSlackEventIds.has(eventId)) {
          return res.status(200).json({
            ok: true,
            simulated: true,
            dryRun: true,
            status: 'duplicate_retry_suppressed',
            ackLatencyMs,
            reply:
              '[Simulated Dry-Run Idempotency Guard] Duplicate Slack event_id detected and suppressed without mutating production tables.',
            sources: [],
            confidence: 100,
            latencyMs: ackLatencyMs,
            cacheHit: false,
            totalTokens: 0,
            toolCalls: [],
          });
        }
        if (eventId) {
          devSimulatedSlackEventIds.add(eventId);
          if (devSimulatedSlackEventIds.size > 200) {
            const first = devSimulatedSlackEventIds.values().next().value;
            if (first) devSimulatedSlackEventIds.delete(first);
          }
        }

        if (event.type === 'member_joined_channel') {
          const welcome = buildWelcomeMessage(
            event.channel || '#eng-onboarding'
          );
          return res.status(200).json({
            ok: true,
            simulated: true,
            dryRun: true,
            status: 'accepted_async_simulated',
            ackLatencyMs,
            eventType: 'member_joined_channel',
            channel: event.channel || '#eng-onboarding',
            reply: welcome,
            sources: ['Engineering Onboarding & SSO Setup Guide'],
            confidence: 99,
            latencyMs: Math.max(8, Date.now() - start),
            cacheHit: false,
            totalTokens: 0,
            toolCalls: [],
          });
        }

        const cleanQuestion = (event.text || '')
          .replace(/<@[A-Z0-9]+>|@Hippocampus/gi, '')
          .trim();

        if (!cleanQuestion) {
          return res.status(200).json({
            ok: true,
            simulated: true,
            dryRun: true,
            status: 'accepted_async_simulated',
            ackLatencyMs,
            eventType: 'app_mention',
            channel: event.channel || '#eng-onboarding',
            reply:
              "Hi! Mention me with a question like `@Hippocampus How do I configure SSO?` and I'll search our engineering docs.",
            sources: [],
            confidence: 100,
            latencyMs: Math.max(8, Date.now() - start),
            cacheHit: false,
            totalTokens: 0,
            toolCalls: [],
          });
        }

        // Read-only Engineer-tier RAG dry-run (zero DB/cache writes)
        const chunks = await searchKnowledgeChunks(
          cleanQuestion,
          4,
          'hybrid_rrf',
          'Engineer'
        );
        const ragResult = await synthesizeRagAnswer(
          cleanQuestion,
          chunks,
          req.requestId
        );

        return res.status(200).json({
          ok: true,
          simulated: true,
          dryRun: true,
          status: 'accepted_async_simulated',
          ackLatencyMs,
          eventType: 'app_mention',
          channel: event.channel || '#eng-onboarding',
          reply: ragResult.answer,
          sources: ragResult.sources,
          confidence: ragResult.confidence,
          latencyMs: Math.max(25, Date.now() - start),
          cacheHit: false,
          totalTokens: ragResult.totalTokens,
          toolCalls: ragResult.toolCalls,
        });
      } catch (error: unknown) {
        return sendSafeServerError(
          req,
          res,
          'Failed to simulate Slack event',
          error
        );
      }
    }
  );

  // Global safe error handler
  app.use(
    (
      err: Error,
      req: TelemetryRequest,
      res: Response,
      _next: NextFunction
    ) => {
      return sendSafeServerError(
        req,
        res,
        'An unexpected server error occurred.',
        err
      );
    }
  );

  return app;
}
