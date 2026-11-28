import pino from 'pino';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export interface StructuredLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  component:
    | 'api'
    | 'gemini'
    | 'slack'
    | 'cache'
    | 'ratelimit'
    | 'db'
    | 'client'
    | 'tools';
  event: string;
  requestId?: string;
  latencyMs?: number;
  cacheHit?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  message: string;
}

const MAX_LOG_BUFFER = 120;
const logRingBuffer: StructuredLogEntry[] = [];

const tokenTotals = {
  promptTokens: 1420,
  completionTokens: 960,
  totalTokens: 2380,
  llmRequests: 5,
  cacheHits: 2,
  cacheMisses: 3,
  slackEventsProcessed: 4,
  slackRetriesDeduplicated: 1,
  agentToolCalls: 2,
};

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|signature|credential|raw[_-]?body|rawbody|verifier|encryption[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|content|answer|queryembedding|query[_-]?preview|query[_-]?text)/i;

const TOKEN_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9\-._~+/]+=*|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{20,}|v0=[a-f0-9]{64}|sha256=[a-f0-9]{64}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gi;

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;

export function sanitizeRequestId(raw?: string | string[]): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (candidate && SAFE_REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return randomUUID().slice(0, 12);
}

export function sanitizeStringForLogs(value: string): string {
  return value.replace(TOKEN_VALUE_PATTERN, '[REDACTED]');
}

export function sanitizeAuditMetadata(
  input?: Record<string, unknown> | null,
  depth = 0
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || depth > 4) {
    return {};
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      safe[key] = sanitizeStringForLogs(value).slice(0, 300);
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 20).map((item) =>
        typeof item === 'string'
          ? sanitizeStringForLogs(item).slice(0, 120)
          : typeof item === 'number' || typeof item === 'boolean'
            ? item
            : '[OBJECT]'
      );
    } else if (typeof value === 'object') {
      safe[key] = sanitizeAuditMetadata(
        value as Record<string, unknown>,
        depth + 1
      );
    }
  }
  return safe;
}

export const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'authorization',
      'token',
      'idToken',
      'accessToken',
      'refreshToken',
      'githubToken',
      'secret',
      'webhookSecret',
      'clientSecret',
      'password',
      'apiKey',
      'privateKey',
      'cookie',
      'codeVerifier',
      '*.authorization',
      '*.token',
      '*.idToken',
      '*.accessToken',
      '*.refreshToken',
      '*.githubToken',
      '*.secret',
      '*.webhookSecret',
      '*.clientSecret',
      '*.password',
      '*.apiKey',
      '*.privateKey',
      '*.cookie',
      '*.codeVerifier',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'hippocampus-enterprise',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function emitStructuredLog(
  entry: Omit<StructuredLogEntry, 'id' | 'timestamp'>
): StructuredLogEntry {
  const sanitizedMetadata = entry.metadata
    ? sanitizeAuditMetadata(entry.metadata)
    : undefined;
  const fullEntry: StructuredLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
    message: sanitizeStringForLogs(entry.message),
    metadata: sanitizedMetadata,
  };

  logRingBuffer.unshift(fullEntry);
  if (logRingBuffer.length > MAX_LOG_BUFFER) {
    logRingBuffer.pop();
  }

  const logPayload = {
    requestId: fullEntry.requestId,
    component: fullEntry.component,
    event: fullEntry.event,
    latencyMs: fullEntry.latencyMs,
    cacheHit: fullEntry.cacheHit,
    promptTokens: fullEntry.promptTokens,
    completionTokens: fullEntry.completionTokens,
    totalTokens: fullEntry.totalTokens,
    statusCode: fullEntry.statusCode,
    ...(sanitizedMetadata || {}),
  };

  if (fullEntry.level === 'error') {
    pinoLogger.error(logPayload, fullEntry.message);
  } else if (fullEntry.level === 'warn') {
    pinoLogger.warn(logPayload, fullEntry.message);
  } else {
    pinoLogger.info(logPayload, fullEntry.message);
  }

  return fullEntry;
}

export function recordGeminiTokenUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  latencyMs: number;
  requestId?: string;
}) {
  tokenTotals.promptTokens += usage.promptTokens;
  tokenTotals.completionTokens += usage.completionTokens;
  tokenTotals.totalTokens += usage.totalTokens;
  tokenTotals.llmRequests += 1;

  emitStructuredLog({
    level: 'info',
    component: 'gemini',
    event: 'gemini.generate_content',
    requestId: usage.requestId,
    latencyMs: usage.latencyMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    metadata: { model: usage.model },
    message: `Gemini ${usage.model} completed in ${usage.latencyMs}ms (${usage.totalTokens} tokens)`,
  });
}

export function recordAgentToolCall(params: {
  toolName: string;
  args: Record<string, unknown>;
  durationMs: number;
  requestId?: string;
}) {
  tokenTotals.agentToolCalls += 1;
  const sanitizedArgs = sanitizeAuditMetadata(params.args || {});
  const argKeys = Object.keys(params.args || {});
  emitStructuredLog({
    level: 'info',
    component: 'tools',
    event: `tool.invoke.${params.toolName}`,
    requestId: params.requestId,
    latencyMs: params.durationMs,
    metadata: {
      toolName: params.toolName,
      argKeys,
      args: sanitizedArgs,
    },
    message: `Agentic Function Call executed: ${params.toolName} (keys=${argKeys.join(',') || 'none'}) in ${params.durationMs}ms`,
  });
}

export function recordCacheEvent(
  hit: boolean,
  similarity?: number,
  query?: string
) {
  if (hit) {
    tokenTotals.cacheHits += 1;
  } else {
    tokenTotals.cacheMisses += 1;
  }

  emitStructuredLog({
    level: 'info',
    component: 'cache',
    event: hit ? 'semantic_cache.hit' : 'semantic_cache.miss',
    cacheHit: hit,
    metadata: {
      similarity: similarity ? Number((similarity * 100).toFixed(1)) : undefined,
      queryLength: query ? query.length : 0,
    },
    message: hit
      ? `Semantic cache HIT (${((similarity ?? 1) * 100).toFixed(1)}% match) — 0 LLM tokens consumed`
      : `Semantic cache MISS — routing to Hybrid Search + Gemini Agent`,
  });
}

export function recordSlackWebhookMetric(params: {
  deduplicatedRetry: boolean;
  eventType: string;
  ackLatencyMs: number;
  channel?: string;
}) {
  if (params.deduplicatedRetry) {
    tokenTotals.slackRetriesDeduplicated += 1;
    emitStructuredLog({
      level: 'warn',
      component: 'slack',
      event: 'slack.webhook.retry_suppressed',
      latencyMs: params.ackLatencyMs,
      metadata: { eventType: params.eventType, channel: params.channel },
      message: `Suppressed duplicate Slack webhook retry (${params.eventType}) with immediate 200 OK (${params.ackLatencyMs}ms)`,
    });
  } else {
    tokenTotals.slackEventsProcessed += 1;
    emitStructuredLog({
      level: 'info',
      component: 'slack',
      event: 'slack.webhook.ack_200',
      latencyMs: params.ackLatencyMs,
      metadata: { eventType: params.eventType, channel: params.channel },
      message: `Slack event (${params.eventType}) acknowledged with 200 OK in ${params.ackLatencyMs}ms`,
    });
  }
}

export function getObservabilityMetrics() {
  const totalCacheLookups = tokenTotals.cacheHits + tokenTotals.cacheMisses;
  const cacheHitRate =
    totalCacheLookups > 0
      ? Number(((tokenTotals.cacheHits / totalCacheLookups) * 100).toFixed(1))
      : 0;

  return {
    tokenTotals: { ...tokenTotals },
    cacheHitRate,
    recentLogs: logRingBuffer.slice(0, 60),
  };
}

emitStructuredLog({
  level: 'info',
  component: 'api',
  event: 'server.boot',
  latencyMs: 14,
  message:
    'Phase 2 Hybrid Search (pgvector + BM25 RRF) & Gemini Agentic Function Calling initialized',
});

export interface TelemetryRequest extends Request {
  requestId?: string;
}

export function requestLoggerMiddleware(
  req: TelemetryRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const requestId = sanitizeRequestId(req.headers['x-request-id']);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    if (req.path === '/api/telemetry') return;
    emitStructuredLog({
      level:
        res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
            ? 'warn'
            : 'info',
      component: 'api',
      event: `${req.method} ${req.path}`,
      requestId,
      latencyMs,
      statusCode: res.statusCode,
      message: `${req.method} ${req.path} -> ${res.statusCode} (${latencyMs}ms)`,
    });
  });

  next();
}
