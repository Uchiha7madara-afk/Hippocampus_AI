import { z } from 'zod';
import { emitStructuredLog } from './logger.ts';

export const RbacRoleSchema = z.enum(['Admin', 'Manager', 'Engineer']);
export type RbacRole = z.infer<typeof RbacRoleSchema>;

/**
 * Mission 001: Hardened Runtime Environment Variable Schema enforced via Zod.
 * Least-privilege defaults: never defaults unauthenticated or new users to Admin.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  SQL_HOST: z.string().min(1).optional(),
  SQL_USER: z.string().min(1).optional(),
  SQL_DB_NAME: z.string().min(1).optional(),
  SQL_SSL_CA_PATH: z.string().min(1).optional(),
  CONNECTOR_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
  OAUTH_STATE_COOKIE_SECRET: z.string().min(32).optional(),
  HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK: z.enum(['true', 'false']).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  GITHUB_ALLOWED_REPOS: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().min(8).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  // Least-privilege default role for newly onboarded verified users ONLY (never unauthenticated)
  DEFAULT_RBAC_ROLE: z.enum(['Engineer']).default('Engineer'),
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  BOOTSTRAP_ADMIN_UIDS: z.string().optional(),
});

export type ValidatedEnv = z.infer<typeof EnvSchema>;

export interface EnvValidationCheck {
  key: string;
  status: 'valid' | 'fallback' | 'missing';
  description: string;
}

export interface EnvValidationReport {
  valid: boolean;
  checkedAt: string;
  environment: string;
  checks: EnvValidationCheck[];
  issues: string[];
}

let cachedEnvReport: EnvValidationReport | null = null;
let parsedEnvCache: ValidatedEnv | null = null;

function isPlaceholder(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('MY_') ||
    trimmed.startsWith('YOUR_') ||
    trimmed === 'placeholder'
  );
}

export function resetEnvCacheForTesting(): void {
  cachedEnvReport = null;
  parsedEnvCache = null;
}

export function hasExplicitDatabaseConfig(): boolean {
  if (!isPlaceholder(process.env.DATABASE_URL)) {
    return true;
  }
  const hasHost = !isPlaceholder(process.env.SQL_HOST);
  const hasUser = !isPlaceholder(process.env.SQL_USER);
  const hasPassword = !isPlaceholder(process.env.SQL_PASSWORD);
  const hasDbName = !isPlaceholder(process.env.SQL_DB_NAME);
  return hasHost && hasUser && hasPassword && hasDbName;
}

/**
 * Mission 001.6 (AUD-003, AUD-015): Fail-closed production startup configuration guard.
 * Refuses to boot in production if in-memory fallback is explicitly enabled or if
 * PostgreSQL credentials/connection settings are absent.
 */
export function assertSafeProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  if (process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK === 'true') {
    throw new Error(
      'FATAL SECURITY MISCONFIGURATION: HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK=true is forbidden in production.'
    );
  }
  if (!hasExplicitDatabaseConfig()) {
    throw new Error(
      'FATAL SECURITY MISCONFIGURATION: PostgreSQL configuration (DATABASE_URL or SQL_HOST/SQL_USER/SQL_PASSWORD/SQL_DB_NAME) is mandatory in production.'
    );
  }
}

/**
 * Explicit trusted proxy hop count for Express `trust proxy`.
 * Defaults to 0 (do not trust arbitrary X-Forwarded-* headers).
 */
export function getTrustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    return 0;
  }
  return parsed;
}

export function validateRuntimeEnv(): {
  env: ValidatedEnv;
  report: EnvValidationReport;
} {
  const rawDefaultRole = process.env.DEFAULT_RBAC_ROLE?.trim();
  const issues: string[] = [];

  if (rawDefaultRole && rawDefaultRole !== 'Engineer') {
    issues.push(
      `DEFAULT_RBAC_ROLE="${rawDefaultRole}" ignored: least-privilege policy enforces "Engineer" for new users.`
    );
  }

  const raw = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || '3000',
    APP_URL: isPlaceholder(process.env.APP_URL)
      ? undefined
      : process.env.APP_URL?.trim(),
    ALLOWED_ORIGINS: isPlaceholder(process.env.ALLOWED_ORIGINS)
      ? undefined
      : process.env.ALLOWED_ORIGINS?.trim(),
    TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS?.trim() || '0',
    FIREBASE_PROJECT_ID: isPlaceholder(process.env.FIREBASE_PROJECT_ID)
      ? undefined
      : process.env.FIREBASE_PROJECT_ID?.trim(),
    GEMINI_API_KEY: isPlaceholder(process.env.GEMINI_API_KEY)
      ? undefined
      : process.env.GEMINI_API_KEY,
    DATABASE_URL: isPlaceholder(process.env.DATABASE_URL)
      ? undefined
      : process.env.DATABASE_URL,
    SQL_HOST: isPlaceholder(process.env.SQL_HOST)
      ? undefined
      : process.env.SQL_HOST?.trim(),
    SQL_USER: isPlaceholder(process.env.SQL_USER)
      ? undefined
      : process.env.SQL_USER?.trim(),
    SQL_DB_NAME: isPlaceholder(process.env.SQL_DB_NAME)
      ? undefined
      : process.env.SQL_DB_NAME?.trim(),
    SQL_SSL_CA_PATH: isPlaceholder(process.env.SQL_SSL_CA_PATH)
      ? undefined
      : process.env.SQL_SSL_CA_PATH?.trim(),
    CONNECTOR_TOKEN_ENCRYPTION_KEY: isPlaceholder(
      process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY
    )
      ? undefined
      : process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY?.trim(),
    OAUTH_STATE_COOKIE_SECRET: isPlaceholder(
      process.env.OAUTH_STATE_COOKIE_SECRET
    )
      ? undefined
      : process.env.OAUTH_STATE_COOKIE_SECRET?.trim(),
    HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK:
      process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK === 'true' ||
      process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK === 'false'
        ? process.env.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK
        : undefined,
    GITHUB_WEBHOOK_SECRET: isPlaceholder(process.env.GITHUB_WEBHOOK_SECRET)
      ? undefined
      : process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_ALLOWED_REPOS: isPlaceholder(process.env.GITHUB_ALLOWED_REPOS)
      ? undefined
      : process.env.GITHUB_ALLOWED_REPOS?.trim(),
    SLACK_SIGNING_SECRET: isPlaceholder(process.env.SLACK_SIGNING_SECRET)
      ? undefined
      : process.env.SLACK_SIGNING_SECRET,
    UPSTASH_REDIS_REST_URL: isPlaceholder(process.env.UPSTASH_REDIS_REST_URL)
      ? undefined
      : process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: isPlaceholder(
      process.env.UPSTASH_REDIS_REST_TOKEN
    )
      ? undefined
      : process.env.UPSTASH_REDIS_REST_TOKEN,
    DEFAULT_RBAC_ROLE: 'Engineer' as const,
    BOOTSTRAP_ADMIN_EMAILS: isPlaceholder(process.env.BOOTSTRAP_ADMIN_EMAILS)
      ? undefined
      : process.env.BOOTSTRAP_ADMIN_EMAILS?.trim(),
    BOOTSTRAP_ADMIN_UIDS: isPlaceholder(process.env.BOOTSTRAP_ADMIN_UIDS)
      ? undefined
      : process.env.BOOTSTRAP_ADMIN_UIDS?.trim(),
  };

  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  const parsed: ValidatedEnv = result.success
    ? result.data
    : {
        NODE_ENV:
          process.env.NODE_ENV === 'production'
            ? 'production'
            : process.env.NODE_ENV === 'test'
              ? 'test'
              : 'development',
        PORT: 3000,
        TRUST_PROXY_HOPS: 0,
        DEFAULT_RBAC_ROLE: 'Engineer',
      };

  const isProd = parsed.NODE_ENV === 'production';
  const hasDatabaseConfig = hasExplicitDatabaseConfig();
  const hasGithubWebhookSecret = Boolean(parsed.GITHUB_WEBHOOK_SECRET);
  const hasAllowedOrigins = getAllowedOrigins(parsed).length > 0;

  if (isProd && !hasDatabaseConfig) {
    issues.push(
      'PostgreSQL configuration is missing in production: fail-closed persistence enforced.'
    );
  }
  if (isProd && !hasGithubWebhookSecret) {
    issues.push(
      'GITHUB_WEBHOOK_SECRET is missing in production: GitHub webhooks will fail closed.'
    );
  }
  if (isProd && !hasAllowedOrigins) {
    issues.push(
      'ALLOWED_ORIGINS / APP_URL is missing in production: cross-origin browser requests will be rejected.'
    );
  }
  if (isProd && parsed.HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK === 'true') {
    issues.push(
      'HIPPOCAMPUS_ALLOW_IN_MEMORY_FALLBACK=true is prohibited in production.'
    );
  }

  const checks: EnvValidationCheck[] = [
    {
      key: 'CLOUD_SQL_POSTGRES (SQL_HOST / DATABASE_URL)',
      status: hasDatabaseConfig ? 'valid' : 'missing',
      description: hasDatabaseConfig
        ? `Cloud SQL PostgreSQL + pgvector configured (${parsed.SQL_DB_NAME || 'connected'})`
        : 'PostgreSQL connection configuration missing',
    },
    {
      key: 'FIREBASE_AUTH_ADMIN',
      status: 'valid',
      description:
        'Mandatory server-side Firebase Admin ID token verification enabled (fail-closed)',
    },
    {
      key: 'DEFAULT_RBAC_ROLE',
      status: 'valid',
      description:
        'Least-privilege default enforced (Engineer for verified new users; no unauthenticated role)',
    },
    {
      key: 'GITHUB_WEBHOOK_SECRET',
      status: hasGithubWebhookSecret ? 'valid' : isProd ? 'missing' : 'fallback',
      description: hasGithubWebhookSecret
        ? 'GitHub HMAC-SHA256 webhook verification secret active'
        : 'Not set — POST /api/webhooks/github fails closed until configured',
    },
    {
      key: 'CORS_ALLOWED_ORIGINS',
      status: hasAllowedOrigins ? 'valid' : 'missing',
      description: hasAllowedOrigins
        ? `Explicit origin allowlist active (${getAllowedOrigins(parsed).length} origin(s))`
        : 'No allowed origins configured — cross-origin requests denied',
    },
    {
      key: 'GEMINI_API_KEY',
      status: parsed.GEMINI_API_KEY ? 'valid' : 'fallback',
      description: parsed.GEMINI_API_KEY
        ? 'Google GenAI SDK key verified'
        : 'Using deterministic local embedding & synthesis fallback',
    },
    {
      key: 'SLACK_SIGNING_SECRET',
      status: parsed.SLACK_SIGNING_SECRET
        ? 'valid'
        : isProd
          ? 'missing'
          : 'fallback',
      description: parsed.SLACK_SIGNING_SECRET
        ? 'Slack HMAC-SHA256 webhook verification secret active'
        : 'Not set — POST /api/slack/events fails closed until configured',
    },
    {
      key: 'UPSTASH_REDIS_REST_URL',
      status:
        parsed.UPSTASH_REDIS_REST_URL && parsed.UPSTASH_REDIS_REST_TOKEN
          ? 'valid'
          : 'fallback',
      description:
        parsed.UPSTASH_REDIS_REST_URL && parsed.UPSTASH_REDIS_REST_TOKEN
          ? 'Upstash Redis distributed rate-limiter connected'
          : 'Hybrid in-memory + PostgreSQL L1/L2 store active',
    },
  ];

  const report: EnvValidationReport = {
    valid: result.success && hasDatabaseConfig && (!isProd || hasAllowedOrigins),
    checkedAt: new Date().toISOString(),
    environment: parsed.NODE_ENV,
    checks,
    issues,
  };

  if (!cachedEnvReport) {
    emitStructuredLog({
      level: report.valid ? 'info' : 'warn',
      component: 'api',
      event: 'env.zod_validated',
      metadata: {
        valid: report.valid,
        environment: report.environment,
        issueCount: issues.length,
      },
      message: `Zod runtime environment validation complete (valid=${report.valid}, checks=${checks.length})`,
    });
  }

  cachedEnvReport = report;
  parsedEnvCache = parsed;
  return { env: parsed, report };
}

export function getEnvValidationReport(): EnvValidationReport {
  if (!cachedEnvReport) {
    return validateRuntimeEnv().report;
  }
  return cachedEnvReport;
}

export function getValidatedEnv(): ValidatedEnv {
  if (!parsedEnvCache) {
    return validateRuntimeEnv().env;
  }
  return parsedEnvCache;
}

/**
 * Explicit CORS allowlist.
 * - Production: ONLY origins declared in ALLOWED_ORIGINS and/or APP_URL. Never wildcard.
 * - Development/Test: Explicit local dev origins + ALLOWED_ORIGINS + APP_URL.
 */
export function getAllowedOrigins(envOverride?: Partial<ValidatedEnv>): string[] {
  const origins = new Set<string>();
  const nodeEnv = envOverride?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';

  const rawAllowed = envOverride?.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS;
  if (rawAllowed && !isPlaceholder(rawAllowed)) {
    for (const entry of rawAllowed.split(',')) {
      const cleaned = entry.trim().replace(/\/$/, '');
      try {
        const parsedUrl = new URL(cleaned);
        if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
          origins.add(parsedUrl.origin);
        }
      } catch {
        // Ignore malformed origins
      }
    }
  }

  const appUrl = envOverride?.APP_URL ?? process.env.APP_URL;
  if (appUrl && !isPlaceholder(appUrl)) {
    try {
      const parsedUrl = new URL(appUrl.trim());
      if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
        origins.add(parsedUrl.origin);
      }
    } catch {
      // Ignore malformed APP_URL
    }
  }

  if (nodeEnv !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }

  return Array.from(origins);
}

/**
 * Explicit GitHub repository allowlist for webhook ingestion.
 */
export function getAllowedGithubRepos(): string[] {
  const raw = process.env.GITHUB_ALLOWED_REPOS;
  if (!raw || isPlaceholder(raw)) return [];
  return raw
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter((r) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(r));
}

/**
 * One-time bootstrap administrator matcher (trusted server-side env config only).
 */
export function isBootstrapAdminIdentity(params: {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
}): boolean {
  const rawUids = process.env.BOOTSTRAP_ADMIN_UIDS;
  if (rawUids && !isPlaceholder(rawUids)) {
    const allowedUids = rawUids
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (allowedUids.includes(params.uid)) {
      return true;
    }
  }

  const rawEmails = process.env.BOOTSTRAP_ADMIN_EMAILS;
  if (
    rawEmails &&
    !isPlaceholder(rawEmails) &&
    params.email &&
    params.emailVerified === true
  ) {
    const allowedEmails = rawEmails
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (allowedEmails.includes(params.email.trim().toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Request Body Schemas for API Route Hardening (.strict() rejects unexpected fields)
 */
export const IngestDocumentRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, 'Document title must be at least 3 characters')
      .max(180, 'Document title cannot exceed 180 characters'),
    sourceType: z
      .enum(['file', 'url', 'slack', 'github', 'gdrive'])
      .default('file'),
    sourceUrl: z.string().trim().max(500).optional().nullable(),
    accessLevel: RbacRoleSchema.default('Engineer'),
    content: z
      .string()
      .trim()
      .min(10, 'Document content must be at least 10 characters')
      .max(100_000, 'Document content exceeds 100,000 character limit'),
  })
  .strict();

export const ChatQueryRequestSchema = z
  .object({
    query: z.string().trim().max(4000).optional(),
    message: z.string().trim().max(4000).optional(),
    channel: z.string().trim().max(80).default('Playground'),
    bypassCache: z.boolean().optional().default(false),
    searchMode: z
      .enum([
        'hybrid_rrf',
        'sparse_bm25',
        'dense_vector',
        'linear_sum',
        'vector_only',
        'bm25_lexical',
      ])
      .optional()
      .default('hybrid_rrf'),
  })
  .strict();

export const UpdateRoleRequestSchema = z
  .object({
    targetUid: z
      .string()
      .trim()
      .min(3, 'targetUid must be at least 3 characters')
      .max(128, 'targetUid cannot exceed 128 characters')
      .regex(/^[A-Za-z0-9._:@-]+$/, 'targetUid contains invalid characters'),
    role: RbacRoleSchema,
  })
  .strict();

export const UpdateSettingRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const ALLOWED_SETTING_KEYS = new Set([
  'slack_auto_thread_reply',
  'proactive_member_onboarding',
  'strict_citation_enforcement',
  'auto_rechunk_on_update',
]);

export const ExecuteToolRequestSchema = z
  .object({
    toolName: z.enum([
      'fetchJiraTicket',
      'fetchGithubPullRequest',
      'pingOnCallEngineer',
      'checkServiceHealth',
    ]),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const GithubSyncRequestSchema = z
  .object({
    repoFullName: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        'Repository must be in owner/repo format'
      )
      .default('Uchiha7madara-afk/Hippocampus'),
    branch: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._/-]+$/, 'Branch contains invalid characters')
      .default('main'),
    accessLevel: RbacRoleSchema.default('Engineer'),
    githubToken: z.string().trim().max(255).optional(),
  })
  .strict();

export const GithubWebhookPayloadSchema = z.object({
  zen: z.string().optional(),
  hook_id: z.number().optional(),
  ref: z.string().trim().max(200).optional(),
  after: z.string().trim().max(64).optional(),
  repository: z
    .object({
      full_name: z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
          'Invalid repository.full_name format'
        ),
      html_url: z.string().url().optional(),
    })
    .optional(),
  pusher: z
    .object({
      name: z.string().trim().max(120).optional(),
    })
    .optional(),
  commits: z
    .array(
      z.object({
        id: z.string().trim().max(64).optional(),
        message: z.string().max(1000).optional(),
        added: z.array(z.string().max(300)).optional(),
        modified: z.array(z.string().max(300)).optional(),
      })
    )
    .max(50)
    .optional(),
});

export const DevGithubWebhookSimulateSchema = z
  .object({
    ref: z.string().trim().min(1).max(200).default('refs/heads/main'),
    after: z.string().trim().max(64).optional(),
    repository: z.object({
      full_name: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      html_url: z.string().url().optional(),
    }),
    pusher: z.object({ name: z.string().trim().max(120).optional() }).optional(),
    commits: z
      .array(
        z.object({
          id: z.string().trim().max(64).optional(),
          message: z.string().max(1000).optional(),
          added: z.array(z.string().max(300)).optional(),
          modified: z.array(z.string().max(300)).optional(),
        })
      )
      .max(20)
      .optional(),
    simulatedDocs: z
      .array(
        z.object({
          path: z.string().trim().min(1).max(300),
          title: z.string().trim().min(3).max(180),
          content: z.string().trim().min(10).max(50_000),
        })
      )
      .max(10)
      .optional(),
  })
  .strict();

export const GdriveImportRequestSchema = z
  .object({
    fileId: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/, 'Invalid Google Drive fileId')
      .optional(),
    mimeType: z.string().trim().max(160).optional(),
    accessLevel: RbacRoleSchema.default('Engineer'),
    googleDocJson: z
      .object({
        documentId: z.string().max(200).optional(),
        title: z.string().max(180).optional(),
        sourceUrl: z.string().url().max(500).optional(),
        body: z
          .object({
            content: z.array(z.record(z.string(), z.unknown())).max(1000),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();

export const ClientErrorTelemetrySchema = z
  .object({
    message: z.string().trim().min(1).max(500),
    componentStack: z.string().max(1000).optional(),
  })
  .strict();

export const OnboardingPhaseSchema = z.enum(['Day 1', 'Week 1', 'Month 1']);

export const SlackMentionEventSchema = z.object({
  type: z.enum(['app_mention', 'message', 'member_joined_channel']),
  user: z.string().trim().min(1).max(128),
  text: z.string().max(4000).optional(),
  ts: z.string().trim().max(64).optional(),
  thread_ts: z.string().trim().max(64).optional(),
  channel: z.string().trim().min(1).max(128),
  event_ts: z.string().trim().max(64).optional(),
  bot_id: z.string().trim().max(128).optional(),
});

export const SlackEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url_verification'),
    challenge: z.string().trim().min(1).max(500),
    token: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('event_callback'),
    token: z.string().max(200).optional(),
    team_id: z.string().max(128).optional(),
    api_app_id: z.string().max(128).optional(),
    event_id: z.string().trim().min(1).max(128).optional(),
    event_time: z.number().int().positive().optional(),
    event: SlackMentionEventSchema,
  }),
]);

export const ToggleOnboardingProgressSchema = z
  .object({
    targetUid: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .regex(/^[A-Za-z0-9._:@-]+$/, 'Invalid targetUid format')
      .optional(),
    userHandle: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^@?[A-Za-z0-9._-]+$/, 'Invalid userHandle format')
      .optional(),
    displayName: z.string().trim().min(2).max(80).optional(),
    engineerRole: z.string().trim().min(2).max(80).optional(),
    trackId: z.number().int().positive(),
    completed: z.boolean(),
    notes: z.string().trim().max(300).optional().nullable(),
  })
  .strict();

export const CreateOnboardingTrackSchema = z
  .object({
    phase: OnboardingPhaseSchema,
    title: z
      .string()
      .trim()
      .min(4, 'Milestone title must be at least 4 characters')
      .max(140),
    description: z
      .string()
      .trim()
      .min(10, 'Milestone description must be at least 10 characters')
      .max(500),
    category: z.string().trim().min(2).max(50).default('Environment'),
    targetRole: RbacRoleSchema.default('Engineer'),
    linkedDocTitle: z.string().trim().max(180).optional().nullable(),
    verificationPrompt: z.string().trim().max(300).optional().nullable(),
    estimatedMinutes: z.coerce.number().int().min(5).max(240).default(25),
  })
  .strict();

/**
 * RBAC Hierarchy helper:
 * Admin (level 3) > Manager (level 2) > Engineer (level 1)
 */
const ROLE_WEIGHT: Record<RbacRole, number> = {
  Engineer: 1,
  Manager: 2,
  Admin: 3,
};

/**
 * Strict parser: returns null if not an exact valid RbacRole.
 */
export function parseStrictRbacRole(raw?: string | null): RbacRole | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (cleaned === 'Engineer' || cleaned === 'Manager' || cleaned === 'Admin') {
    return cleaned;
  }
  return null;
}

/**
 * Least-privilege normalizer: NEVER defaults to Admin.
 */
export function normalizeRbacRole(raw?: string | null): RbacRole {
  return parseStrictRbacRole(raw) ?? 'Engineer';
}

export function canAccessTier(
  userRole: RbacRole,
  resourceTier?: string | null
): boolean {
  const normalizedResource = normalizeRbacRole(resourceTier || 'Engineer');
  return ROLE_WEIGHT[userRole] >= ROLE_WEIGHT[normalizedResource];
}

export function getAllowedTiersForRole(userRole: RbacRole): RbacRole[] {
  if (userRole === 'Admin') return ['Engineer', 'Manager', 'Admin'];
  if (userRole === 'Manager') return ['Engineer', 'Manager'];
  return ['Engineer'];
}
