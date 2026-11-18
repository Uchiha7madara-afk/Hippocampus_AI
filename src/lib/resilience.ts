import type { Response, NextFunction } from 'express';
import { emitStructuredLog, type TelemetryRequest } from './logger.ts';

interface RateBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, RateBucket>();
const slackProcessedEventIds = new Map<string, number>();

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  scope: string;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  chat: { windowMs: 60_000, maxRequests: 25, scope: 'rag_chat' },
  documents: { windowMs: 60_000, maxRequests: 15, scope: 'doc_ingest' },
  slack: { windowMs: 60_000, maxRequests: 40, scope: 'slack_webhook' },
};

let lastRateLimitSnapshot = {
  backend: process.env.UPSTASH_REDIS_REST_URL
    ? 'Upstash Redis REST + Memory L1'
    : 'Hybrid Memory L1 + PostgreSQL L2',
  windowSeconds: 60,
  chatLimit: DEFAULT_LIMITS.chat.maxRequests,
  chatRemaining: DEFAULT_LIMITS.chat.maxRequests,
  resetEpochSeconds: Math.floor((Date.now() + 60_000) / 1000),
  throttledRequests: 0,
};

async function checkUpstashRateLimit(
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<{ allowed: boolean; remaining: number; resetEpoch: number } | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const windowSec = Math.ceil(windowMs / 1000);
    const redisKey = `hippocampus:rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(redisKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!incrRes.ok) return null;
    const data = (await incrRes.json()) as { result?: number };
    const count = Number(data.result || 1);
    if (count === 1) {
      await fetch(
        `${url}/expire/${encodeURIComponent(redisKey)}/${windowSec}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    }
    const remaining = Math.max(0, maxRequests - count);
    const resetEpoch = Math.floor((Date.now() + windowMs) / 1000);
    return {
      allowed: count <= maxRequests,
      remaining,
      resetEpoch,
    };
  } catch {
    return null;
  }
}

export function checkSlidingWindowLimit(
  clientKey: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetEpoch: number } {
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const bucketKey = `${config.scope}:${clientKey}`;
  const bucket = memoryBuckets.get(bucketKey) || { timestamps: [] };

  bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

  if (bucket.timestamps.length >= config.maxRequests) {
    const oldest = bucket.timestamps[0] || now;
    const resetEpoch = Math.ceil((oldest + config.windowMs) / 1000);
    lastRateLimitSnapshot.throttledRequests += 1;
    memoryBuckets.set(bucketKey, bucket);
    return {
      allowed: false,
      remaining: 0,
      resetEpoch,
    };
  }

  bucket.timestamps.push(now);
  memoryBuckets.set(bucketKey, bucket);

  const remaining = Math.max(0, config.maxRequests - bucket.timestamps.length);
  const resetEpoch = Math.ceil((now + config.windowMs) / 1000);

  if (config.scope === 'rag_chat') {
    lastRateLimitSnapshot = {
      ...lastRateLimitSnapshot,
      chatRemaining: remaining,
      resetEpochSeconds: resetEpoch,
    };
  }

  return {
    allowed: true,
    remaining,
    resetEpoch,
  };
}

export function createRateLimitMiddleware(
  scopeKey: 'chat' | 'documents' | 'slack'
) {
  const config = DEFAULT_LIMITS[scopeKey];

  return async (req: TelemetryRequest, res: Response, next: NextFunction) => {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'workspace-client';

    const upstashResult = await checkUpstashRateLimit(
      `${ config.scope }:${ clientIp }`,
      config.windowMs,
      config.maxRequests
    );

    const result =
      upstashResult || checkSlidingWindowLimit(clientIp, config);

    res.setHeader('X-RateLimit-Limit', String(config.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(result.resetEpoch));
    res.setHeader('X-RateLimit-Backend', lastRateLimitSnapshot.backend);

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        result.resetEpoch - Math.floor(Date.now() / 1000)
      );
      emitStructuredLog({
        level: 'warn',
        component: 'ratelimit',
        event: 'ratelimit.exceeded',
        requestId: req.requestId,
        statusCode: 429,
        metadata: {
          scope: config.scope,
          limit: config.maxRequests,
          retryAfterSeconds,
        },
        message: `Rate limit exceeded on ${config.scope} (${config.maxRequests} req / ${config.windowMs / 1000}s)`,
      });

      return res.status(429).json({
        error: `Rate limit exceeded (${config.maxRequests} requests per minute). Please retry in ${retryAfterSeconds}s.`,
        retryAfterSeconds,
        scope: config.scope,
      });
    }

    next();
  };
}

export function resetRateLimitBuckets() {
  memoryBuckets.clear();
  lastRateLimitSnapshot.chatRemaining = DEFAULT_LIMITS.chat.maxRequests;
  emitStructuredLog({
    level: 'info',
    component: 'ratelimit',
    event: 'ratelimit.reset',
    message: 'All sliding-window rate limit buckets reset by administrator',
  });
}

export function getRateLimitStatus() {
  return { ...lastRateLimitSnapshot };
}

/**
 * Deduplicates Slack webhook retries (x-slack-retry-num or duplicate event_id within 10 minutes)
 * so Slack timeout retries never trigger duplicate Gemini RAG threads.
 */
export function isDuplicateSlackEvent(
  eventId?: string,
  retryNumHeader?: string | null
): boolean {
  const now = Date.now();
  for (const [id, ts] of slackProcessedEventIds.entries()) {
    if (now - ts > 10 * 60_000) {
      slackProcessedEventIds.delete(id);
    }
  }

  if (retryNumHeader && parseInt(retryNumHeader, 10) > 0) {
    return true;
  }

  if (eventId) {
    if (slackProcessedEventIds.has(eventId)) {
      return true;
    }
    slackProcessedEventIds.set(eventId, now);
  }

  return false;
}
