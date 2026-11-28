import type { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { RbacRole } from '../lib/env.ts';
import {
  getUserByUid,
  recordSecurityAuditEvent,
  type AppUserRecord,
} from '../db/queries.ts';
import type { TelemetryRequest } from '../lib/logger.ts';

export type Permission =
  | 'knowledge:read'
  | 'assistant:use'
  | 'sources:read'
  | 'sources:ingest'
  | 'sources:ingest:admin'
  | 'sources:delete'
  | 'onboarding:read'
  | 'onboarding:progress:self'
  | 'onboarding:manage'
  | 'connectors:read'
  | 'connectors:manage'
  | 'settings:read'
  | 'settings:manage'
  | 'cache:purge'
  | 'ratelimit:reset'
  | 'telemetry:read'
  | 'users:read'
  | 'users:role:update'
  | 'audit:read';

const ENGINEER_PERMISSIONS: Permission[] = [
  'knowledge:read',
  'assistant:use',
  'sources:read',
  'onboarding:read',
  'onboarding:progress:self',
  'connectors:read',
  'settings:read',
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...ENGINEER_PERMISSIONS,
  'sources:ingest',
  'onboarding:manage',
  'connectors:manage',
  'telemetry:read',
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  'sources:ingest:admin',
  'sources:delete',
  'settings:manage',
  'cache:purge',
  'ratelimit:reset',
  'users:read',
  'users:role:update',
  'audit:read',
];

export const ROLE_PERMISSIONS: Record<RbacRole, ReadonlySet<Permission>> = {
  Engineer: new Set(ENGINEER_PERMISSIONS),
  Manager: new Set(MANAGER_PERMISSIONS),
  Admin: new Set(ADMIN_PERMISSIONS),
};

export function roleHasPermission(role: RbacRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export interface VerifiedFirebaseIdentity {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export type TokenVerifierFn = (
  token: string,
  checkRevoked?: boolean
) => Promise<VerifiedFirebaseIdentity>;

export interface AuthRequest extends TelemetryRequest {
  user?: DecodedIdToken | VerifiedFirebaseIdentity;
  authUser?: AppUserRecord;
  rbacRole?: RbacRole;
}

export interface AuthMiddlewareOptions {
  verifyIdToken?: TokenVerifierFn;
  resolveUserByUid?: (uid: string) => Promise<AppUserRecord | null>;
}

const TOKEN_INVALID_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/user-disabled',
  'auth/user-not-found',
]);

const SERVICE_UNAVAILABLE_CODES = new Set([
  'auth/internal-error',
  'app/no-app',
  'app/invalid-credential',
  'auth/network-request-failed',
  'auth/service-unavailable',
]);

function extractErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return '';
}

function isServiceUnavailableError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (SERVICE_UNAVAILABLE_CODES.has(code)) {
    return true;
  }
  if (TOKEN_INVALID_CODES.has(code)) {
    return false;
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('service unavailable') ||
    msg.includes('could not load the default credentials') ||
    msg.includes('unable to detect a project id') ||
    msg.includes('metadata server')
  );
}

export function extractBearerToken(
  authHeader: string | undefined
): { token: string } | { error: string; reason: string } {
  if (!authHeader || typeof authHeader !== 'string') {
    return {
      error: 'Unauthorized: Missing Authorization header.',
      reason: 'missing_authorization_header',
    };
  }

  const trimmed = authHeader.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return {
      error: 'Unauthorized: Malformed Authorization header. Expected Bearer token.',
      reason: 'malformed_authorization_scheme',
    };
  }

  const token = parts[1];
  if (!token || token.length < 10 || /[\r\n\t]/.test(token)) {
    return {
      error: 'Unauthorized: Malformed Bearer token.',
      reason: 'malformed_bearer_token',
    };
  }

  return { token };
}

export async function resolveAuthenticatedUser(
  uid: string,
  resolver: (uid: string) => Promise<AppUserRecord | null> = getUserByUid
): Promise<AppUserRecord | null> {
  return resolver(uid);
}

/**
 * Factory producing centralized authentication and RBAC middleware.
 * Default token verifier uses Firebase Admin SDK (`adminAuth.verifyIdToken(token, true)`).
 */
export function createAuthLayer(options: AuthMiddlewareOptions = {}) {
  const verifyToken: TokenVerifierFn =
    options.verifyIdToken ??
    ((token: string, checkRevoked = true) =>
      adminAuth.verifyIdToken(token, checkRevoked));
  const lookupUser = options.resolveUserByUid ?? getUserByUid;

  const safeRecordAudit = async (
    params: Parameters<typeof recordSecurityAuditEvent>[0]
  ): Promise<boolean> => {
    try {
      await recordSecurityAuditEvent(params);
      return true;
    } catch {
      return false;
    }
  };

  const verifyBearerIdentity = async (
    req: AuthRequest,
    res: Response
  ): Promise<VerifiedFirebaseIdentity | null> => {
    const extracted = extractBearerToken(req.headers.authorization);
    if ('error' in extracted) {
      await safeRecordAudit({
        actorUid: 'unauthenticated',
        actorRole: 'None',
        action: 'auth.failed',
        targetResource: `${req.method} ${req.path}`,
        outcome: 'denied',
        requestId: req.requestId,
        metadata: { reason: extracted.reason },
      });
      res.status(401).json({ error: extracted.error });
      return null;
    }

    try {
      const decoded = await verifyToken(extracted.token, true);
      if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid.trim()) {
        await safeRecordAudit({
          actorUid: 'unauthenticated',
          actorRole: 'None',
          action: 'auth.failed',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'denied',
          requestId: req.requestId,
          metadata: { reason: 'missing_uid_claim' },
        });
        res.status(401).json({ error: 'Unauthorized: Invalid Firebase identity token.' });
        return null;
      }
      req.user = decoded;
      return decoded;
    } catch (error) {
      const code = extractErrorCode(error);
      if (isServiceUnavailableError(error)) {
        await safeRecordAudit({
          actorUid: 'unauthenticated',
          actorRole: 'None',
          action: 'auth.service_unavailable',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'failure',
          requestId: req.requestId,
          metadata: { code: code || 'service_unavailable' },
        });
        res.status(503).json({
          error:
            'Authentication service temporarily unavailable. Access denied (fail-closed).',
        });
        return null;
      }

      const reason =
        code === 'auth/id-token-expired'
          ? 'token_expired'
          : code === 'auth/id-token-revoked'
            ? 'token_revoked'
            : 'invalid_token';

      await safeRecordAudit({
        actorUid: 'unauthenticated',
        actorRole: 'None',
        action: 'auth.failed',
        targetResource: `${req.method} ${req.path}`,
        outcome: 'denied',
        requestId: req.requestId,
        metadata: { reason, code: code || 'invalid' },
      });

      res.status(401).json({
        error:
          reason === 'token_expired'
            ? 'Unauthorized: Firebase ID token has expired.'
            : reason === 'token_revoked'
              ? 'Unauthorized: Firebase ID token has been revoked.'
              : 'Unauthorized: Invalid Firebase ID token.',
      });
      return null;
    }
  };

  /**
   * Verifies Firebase ID token only (used exclusively for controlled onboarding /api/auth/sync).
   */
  const requireFirebaseIdentity = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    const identity = await verifyBearerIdentity(req, res);
    if (!identity) return;
    next();
  };

  /**
   * Full fail-closed authentication:
   * 1. Verifies Firebase Bearer token via Firebase Admin SDK.
   * 2. Resolves authoritative application user + RBAC role from trusted server storage.
   * 3. Completely ignores client-supplied role/identity headers.
   */
  const requireAuthentication = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    const identity = await verifyBearerIdentity(req, res);
    if (!identity) return;

    try {
      const appUser = await resolveAuthenticatedUser(identity.uid, lookupUser);
      if (!appUser) {
        await safeRecordAudit({
          actorUid: identity.uid,
          actorEmail: identity.email ?? null,
          actorRole: 'None',
          action: 'auth.unknown_user',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'denied',
          requestId: req.requestId,
          metadata: { reason: 'user_not_provisioned' },
        });
        return res.status(403).json({
          error:
            'Forbidden: Account is not provisioned in Hippocampus. Complete sign-in onboarding via POST /api/auth/sync.',
        });
      }

      req.authUser = appUser;
      req.rbacRole = appUser.role;
      next();
    } catch {
      await safeRecordAudit({
        actorUid: identity.uid,
        actorEmail: identity.email ?? null,
        actorRole: 'None',
        action: 'auth.role_store_unavailable',
        targetResource: `${req.method} ${req.path}`,
        outcome: 'failure',
        requestId: req.requestId,
      });
      return res.status(503).json({
        error:
          'Authorization store temporarily unavailable. Access denied (fail-closed).',
      });
    }
  };

  const requireRole = (...allowedRoles: RbacRole[]) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.authUser) {
        return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      }
      if (!allowedRoles.includes(req.authUser.role)) {
        const audited = await safeRecordAudit({
          actorUid: req.authUser.uid,
          actorEmail: req.authUser.email,
          actorRole: req.authUser.role,
          action: 'authz.denied',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'denied',
          requestId: req.requestId,
          metadata: {
            requiredRoles: allowedRoles,
            actualRole: req.authUser.role,
          },
        });
        if (!audited && process.env.NODE_ENV === 'production') {
          return res.status(503).json({
            error:
              'Audit persistence temporarily unavailable. Access denied (fail-closed).',
          });
        }
        return res.status(403).json({
          error: `Forbidden: This operation requires one of [${allowedRoles.join(', ')}] privileges.`,
        });
      }
      next();
    };
  };

  const requirePermission = (permission: Permission) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.authUser) {
        return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      }
      if (!roleHasPermission(req.authUser.role, permission)) {
        const audited = await safeRecordAudit({
          actorUid: req.authUser.uid,
          actorEmail: req.authUser.email,
          actorRole: req.authUser.role,
          action: 'authz.denied',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'denied',
          requestId: req.requestId,
          metadata: {
            requiredPermission: permission,
            actualRole: req.authUser.role,
          },
        });
        if (!audited && process.env.NODE_ENV === 'production') {
          return res.status(503).json({
            error:
              'Audit persistence temporarily unavailable. Access denied (fail-closed).',
          });
        }
        return res.status(403).json({
          error: `Forbidden: Missing required permission "${permission}" for role ${req.authUser.role}.`,
        });
      }
      next();
    };
  };

  const authorizeResourceAccess = (
    checker: (
      req: AuthRequest
    ) => Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string }
  ) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.authUser) {
        return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      }
      const decision = await checker(req);
      if (!decision.allowed) {
        const audited = await safeRecordAudit({
          actorUid: req.authUser.uid,
          actorEmail: req.authUser.email,
          actorRole: req.authUser.role,
          action: 'authz.resource_denied',
          targetResource: `${req.method} ${req.path}`,
          outcome: 'denied',
          requestId: req.requestId,
          metadata: { reason: decision.reason || 'resource_policy_denied' },
        });
        if (!audited && process.env.NODE_ENV === 'production') {
          return res.status(503).json({
            error:
              'Audit persistence temporarily unavailable. Access denied (fail-closed).',
          });
        }
        return res.status(403).json({
          error: decision.reason || 'Forbidden: Access to this resource is denied.',
        });
      }
      next();
    };
  };

  return {
    requireFirebaseIdentity,
    requireAuthentication,
    requireRole,
    requirePermission,
    authorizeResourceAccess,
  };
}

const defaultAuthLayer = createAuthLayer();

export const requireFirebaseIdentity = defaultAuthLayer.requireFirebaseIdentity;
export const requireAuthentication = defaultAuthLayer.requireAuthentication;
export const requireAuth = defaultAuthLayer.requireAuthentication;
export const requireRole = defaultAuthLayer.requireRole;
export const requirePermission = defaultAuthLayer.requirePermission;
export const authorizeResourceAccess = defaultAuthLayer.authorizeResourceAccess;
