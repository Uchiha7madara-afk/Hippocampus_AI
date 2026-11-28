import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { TelemetryPayload } from '../types/app.ts';

interface TelemetryDrawerProps {
  open: boolean;
  onClose: () => void;
  telemetry: TelemetryPayload | null;
  onRefresh: () => Promise<void>;
  onPurgeCache: () => Promise<void>;
  onResetRateLimit: () => Promise<void>;
}

export function TelemetryDrawer({
  open,
  onClose,
  telemetry,
  onRefresh,
  onPurgeCache,
  onResetRateLimit,
}: TelemetryDrawerProps) {
  const [componentFilter, setComponentFilter] = useState<string>('all');
  const [purging, setPurging] = useState(false);
  const [resettingRl, setResettingRl] = useState(false);

  if (!open) return null;

  const logs = (telemetry?.recentLogs || []).filter(
    (l) => componentFilter === 'all' || l.component === componentFilter
  );

  const handlePurge = async () => {
    setPurging(true);
    try {
      await onPurgeCache();
    } finally {
      setPurging(false);
    }
  };

  const handleResetRl = async () => {
    setResettingRl(true);
    try {
      await onResetRateLimit();
    } finally {
      setResettingRl(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs">
      <div className="flex h-full w-full max-w-3xl flex-col border-l border-slate-800 bg-[#090D16] text-slate-100">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Activity className="h-4 w-4 text-emerald-400" />
            <div>
              <h2 className="font-display text-base font-bold text-white">
                Observability, RBAC Security &amp; Pino Telemetry
              </h2>
              <p className="text-xs text-slate-400">
                Phases 1–3 Hardening · Zod Env Validation · RBAC Policy · Semantic Cache
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close telemetry drawer"
              className="rounded-lg border border-slate-800 bg-slate-900 p-1.5 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 3-Column Telemetry Summary */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-1.5">
              <p className="text-xs text-slate-400">Gemini Token &amp; Tool Usage</p>
              <p className="font-mono text-2xl font-bold text-white tabular-nums">
                {telemetry?.tokenTotals.totalTokens.toLocaleString() ?? 0}
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                Prompt: {telemetry?.tokenTotals.promptTokens ?? 0} · Out:{' '}
                {telemetry?.tokenTotals.completionTokens ?? 0} · Tools:{' '}
                {telemetry?.tokenTotals.agentToolCalls ?? 0}
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-1.5">
              <p className="text-xs text-slate-400">Semantic Cache Hit Ratio</p>
              <p className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
                {telemetry?.cacheHitRate ?? 0}%
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                {telemetry?.tokenTotals.cacheHits ?? 0} hits ·{' '}
                {telemetry?.tokenTotals.cacheMisses ?? 0} misses
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-1.5">
              <p className="text-xs text-slate-400">Rate Limit &amp; Slack Guard</p>
              <p className="font-mono text-2xl font-bold text-white tabular-nums">
                {telemetry?.rateLimit.chatRemaining ?? 25} /{' '}
                {telemetry?.rateLimit.chatLimit ?? 25}
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                Retries suppressed:{' '}
                {telemetry?.tokenTotals.slackRetriesDeduplicated ?? 0}
              </p>
            </div>
          </div>

          {/* Phase 3: RBAC Matrix & Zod Runtime Environment Validation */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <h3 className="font-display text-sm font-semibold text-white">
                  Phase 3 Security: Zod Runtime Validation &amp; RBAC Policy
                </h3>
              </div>
              {telemetry?.rbacPolicy && (
                <span className="font-mono text-xs text-emerald-400">
                  Active Role: {telemetry.rbacPolicy.activeRole} (Tiers:{' '}
                  {telemetry.rbacPolicy.allowedTiers.join(', ')})
                </span>
              )}
            </div>

            {telemetry?.envReport && (
              <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950">
                {telemetry.envReport.checks.map((chk) => (
                  <div
                    key={chk.key}
                    className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-mono font-semibold text-white">
                        {chk.key}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {chk.description}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 font-mono text-[11px] ${
                        chk.status === 'valid'
                          ? 'text-emerald-400'
                          : chk.status === 'fallback'
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {chk.status.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Semantic Cache & Rate Limiter Controls */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-white">
                  Semantic Vector Cache (
                  {telemetry?.cacheSummary?.totalEntries ??
                    telemetry?.cacheEntries.length ??
                    0}{' '}
                  active entries)
                </h3>
                <p className="text-xs text-slate-400">
                  Role-isolated cache metadata (answers, prompts, and source titles redacted from telemetry).
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={resettingRl}
                  onClick={handleResetRl}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {resettingRl ? 'Resetting...' : 'Reset Rate Limits'}
                </button>
                <button
                  type="button"
                  disabled={
                    purging || telemetry?.rbacPolicy?.activeRole === 'Engineer'
                  }
                  onClick={handlePurge}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {purging ? 'Purging...' : 'Purge Semantic Cache'}
                </button>
              </div>
            </div>

            {telemetry?.cacheSummary && (
              <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400">
                <span>Total hits: {telemetry.cacheSummary.totalHits}</span>
                {Object.entries(telemetry.cacheSummary.byRole).map(
                  ([tier, count]) => (
                    <span key={tier}>
                      · {tier}: {count}
                    </span>
                  )
                )}
              </div>
            )}

            {telemetry?.cacheEntries && telemetry.cacheEntries.length > 0 ? (
              <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950">
                {telemetry.cacheEntries.slice(0, 5).map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium text-white">
                        key:{entry.cacheKeyPrefix} · {entry.requiredRole} ·{' '}
                        {entry.searchMode}
                      </p>
                      <p className="truncate text-[11px] text-slate-400">
                        {entry.sourceCount} cited source(s) · confidence{' '}
                        {entry.confidence}%
                      </p>
                    </div>
                    <span className="font-mono text-emerald-400 tabular-nums shrink-0">
                      {entry.hitCount} hit(s)
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                {telemetry?.rbacPolicy?.activeRole === 'Manager'
                  ? 'Per-entry cache records are restricted to Admin role. Aggregate counts are displayed above.'
                  : 'No queries cached yet. Run a query in the RAG Playground to populate the role-scoped cache.'}
              </p>
            )}
          </div>

          {/* Structured Pino Log Stream */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-sm font-semibold text-white">
                Structured Pino Telemetry Stream ({logs.length} events)
              </h3>
              <div className="inline-flex flex-wrap rounded-lg border border-slate-800 bg-slate-900 p-1">
                {(
                  [
                    'all',
                    'api',
                    'gemini',
                    'tools',
                    'cache',
                    'slack',
                    'ratelimit',
                  ] as const
                ).map((comp) => (
                  <button
                    key={comp}
                    type="button"
                    onClick={() => setComponentFilter(comp)}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      componentFilter === comp
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {comp.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950 font-mono text-xs">
              {logs.map((log) => (
                <div key={log.id} className="px-4 py-3 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          log.level === 'error'
                            ? 'text-red-400 font-semibold'
                            : log.level === 'warn'
                              ? 'text-amber-400 font-semibold'
                              : 'text-emerald-400 font-semibold'
                        }
                      >
                        {log.level.toUpperCase()}
                      </span>
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-300">{log.component}</span>
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-400">{log.event}</span>
                      {log.requestId && (
                        <>
                          <span className="text-slate-500">·</span>
                          <span className="text-slate-500">
                            req:{log.requestId}
                          </span>
                        </>
                      )}
                    </div>
                    <span className="text-slate-500 tabular-nums">
                      {log.latencyMs !== undefined ? `${log.latencyMs}ms · ` : ''}
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-slate-200">{log.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
