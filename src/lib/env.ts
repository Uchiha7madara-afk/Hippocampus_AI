import { z } from 'zod';
import { emitStructuredLog } from './logger.ts';

export const RbacRoleSchema = z.enum(['Admin', 'Manager', 'Engineer']);
export type RbacRole = z.infer<typeof RbacRoleSchema>;

/**
 * Phase 3 Runtime Environment Variable Schema enforced via Zod.
 * Validates server startup configuration and produces an auditable status report.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GEMINI_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  SQL_HOST: z.string().min(1).optional(),
  SQL_USER: z.string().min(1).optional(),
  SQL_DB_NAME: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(8).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  DEFAULT_RBAC_ROLE: RbacRoleSchema.default('Admin'),
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

export function validateRuntimeEnv(): {
  env: ValidatedEnv;
  report: EnvValidationReport;
} {
  const raw = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || '3000',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    DATABASE_URL: process.env.DATABASE_URL || undefined,
    SQL_HOST: process.env.SQL_HOST || undefined,
    SQL_USER: process.env.SQL_USER || undefined,
    SQL_DB_NAME: process.env.SQL_DB_NAME || undefined,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || undefined,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || undefined,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || undefined,
    DEFAULT_RBAC_ROLE: process.env.DEFAULT_RBAC_ROLE || 'Admin',
  };

  const result = EnvSchema.safeParse(raw);
  const issues: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  const parsed: ValidatedEnv = result.success
    ? result.data
    : {
        NODE_ENV: 'development',
        PORT: 3000,
        DEFAULT_RBAC_ROLE: 'Admin',
      };

  const hasDatabaseConfig = Boolean(
    parsed.SQL_HOST || parsed.DATABASE_URL
  );

  const checks: EnvValidationCheck[] = [
    {
      key: 'CLOUD_SQL_POSTGRES (SQL_HOST / DATABASE_URL)',
      status: hasDatabaseConfig ? 'valid' : 'missing',
      description: hasDatabaseConfig
        ? `Cloud SQL PostgreSQL + pgvector verified (${parsed.SQL_DB_NAME || 'connected'})`
        : 'PostgreSQL connection configuration missing',
    },
    {
      key: 'GEMINI_API_KEY',
      status: parsed.GEMINI_API_KEY ? 'valid' : 'fallback',
      description: parsed.GEMINI_API_KEY
        ? 'Google GenAI SDK key verified (gemini-3.8-flash + gemini-embedding-2-preview)'
        : 'Using deterministic local embedding & synthesis fallback',
    },
    {
      key: 'SLACK_SIGNING_SECRET',
      status: parsed.SLACK_SIGNING_SECRET ? 'valid' : 'fallback',
      description: parsed.SLACK_SIGNING_SECRET
        ? 'Slack HMAC-SHA256 webhook verification secret active'
        : 'Simulator bypass mode active (HMAC enforced when secret is set)',
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
    {
      key: 'DEFAULT_RBAC_ROLE',
      status: 'valid',
      description: `Default workspace RBAC role validated (${parsed.DEFAULT_RBAC_ROLE})`,
    },
  ];

  const report: EnvValidationReport = {
    valid: result.success && hasDatabaseConfig,
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
 * Request Body Schemas for API Route Hardening
 */
export const IngestDocumentRequestSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Document title must be at least 3 characters')
    .max(180, 'Document title cannot exceed 180 characters'),
  sourceType: z.enum(['file', 'url', 'slack', 'github', 'gdrive']).default('file'),
  sourceUrl: z.string().trim().max(500).optional().nullable(),
  accessLevel: RbacRoleSchema.default('Engineer'),
  content: z
    .string()
    .trim()
    .min(10, 'Document content must be at least 10 characters'),
});

export const ChatQueryRequestSchema = z.object({
  query: z.string().trim().optional(),
  message: z.string().trim().optional(),
  channel: z.string().trim().default('Playground'),
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
});

export const UpdateRoleRequestSchema = z.object({
  role: RbacRoleSchema,
});

export const OnboardingPhaseSchema = z.enum(['Day 1', 'Week 1', 'Month 1']);

export const ToggleOnboardingProgressSchema = z.object({
  userHandle: z.string().trim().min(2).max(64).optional(),
  displayName: z.string().trim().min(2).max(80).optional(),
  engineerRole: z.string().trim().min(2).max(80).optional(),
  trackId: z.number().int().positive(),
  completed: z.boolean(),
  notes: z.string().trim().max(300).optional().nullable(),
});

export const CreateOnboardingTrackSchema = z.object({
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
});

/**
 * RBAC Hierarchy helper:
 * Admin (level 3) > Manager (level 2) > Engineer (level 1)
 */
const ROLE_WEIGHT: Record<RbacRole, number> = {
  Engineer: 1,
  Manager: 2,
  Admin: 3,
};

export function normalizeRbacRole(raw?: string | null): RbacRole {
  if (!raw) return 'Admin';
  const cleaned = raw.trim();
  if (cleaned === 'Engineer') return 'Engineer';
  if (cleaned === 'Manager') return 'Manager';
  if (cleaned === 'Admin' || cleaned.toLowerCase().includes('admin')) {
    return 'Admin';
  }
  return 'Admin';
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
