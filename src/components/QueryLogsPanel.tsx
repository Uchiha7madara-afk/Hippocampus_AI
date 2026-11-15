import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Lock, Search, Wrench } from 'lucide-react';
import { QueryLogItem, RbacRole } from '../types/app.ts';

interface QueryLogsPanelProps {
  logs: QueryLogItem[];
  loading: boolean;
  activeRole?: RbacRole;
}

export function QueryLogsPanel({
  logs,
  loading,
  activeRole = 'Admin',
}: QueryLogsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState<
    'all' | 'playground' | 'slack'
  >('all');
  const [selectedLog, setSelectedLog] = useState<QueryLogItem | null>(
    logs[0] ?? null
  );

  const filteredLogs = logs.filter((log) => {
    const isSlack = log.channel.toLowerCase().includes('slack');
    const matchesChannel =
      channelFilter === 'all' ||
      (channelFilter === 'slack' && isSlack) ||
      (channelFilter === 'playground' && !isSlack);

    const matchesSearch =
      !searchQuery.trim() ||
      log.query.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.userHandle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.answer.toLowerCase().includes(searchQuery.toLowerCase());

    return matchesChannel && matchesSearch;
  });

  const formatConfidenceText = (score: number) => {
    if (score >= 90) return `${score}% (High)`;
    if (score >= 75) return `${score}% (Moderate)`;
    return `${score}% (Low)`;
  };

  const formatMode = (mode?: string) => {
    if (mode === 'vector_only') return 'Vector';
    if (mode === 'bm25_lexical') return 'BM25';
    return 'Hybrid RRF';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-base font-semibold text-white">
            Query Telemetry &amp; Audit Logs ({filteredLogs.length} authorized
            for {activeRole})
          </h2>
          <p className="text-xs text-slate-400">
            Filtered by active RBAC clearance ({activeRole}). Logs referencing higher-tier runbooks are automatically redacted for lower roles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by user or query..."
              className="rounded-lg border border-slate-800 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1">
            {(['all', 'slack', 'playground'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setChannelFilter(filter)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  channelFilter === filter
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {filter === 'all'
                  ? 'All Channels'
                  : filter === 'slack'
                    ? 'Slack Events'
                    : 'Playground'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full min-w-[780px] text-left">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs font-medium text-slate-400">
                <th className="px-4 py-3">Engineer</th>
                <th className="px-4 py-3">RBAC Tier</th>
                <th className="px-4 py-3">Query</th>
                <th className="px-4 py-3">Mode / Tools</th>
                <th className="px-4 py-3">Cache / Tokens</th>
                <th className="px-4 py-3 text-right">Latency</th>
                <th className="px-4 py-3 text-right">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    Loading query logs from PostgreSQL...
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No query logs match the current filter or RBAC clearance.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => {
                  const isSelected = selectedLog?.id === log.id;
                  const toolCount = log.toolCalls?.length ?? 0;
                  const tier = log.requiredRole || 'Engineer';
                  return (
                    <tr
                      key={log.id}
                      onClick={() => setSelectedLog(log)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-emerald-500/10'
                          : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-emerald-400">
                        {log.userHandle}
                      </td>
                      <td
                        className={`px-4 py-3 font-mono ${
                          tier === 'Admin'
                            ? 'text-amber-400'
                            : tier === 'Manager'
                              ? 'text-sky-400'
                              : 'text-slate-300'
                        }`}
                      >
                        {tier}
                      </td>
                      <td className="max-w-xs px-4 py-3 text-white truncate">
                        {log.query}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300 tabular-nums">
                        {formatMode(log.searchMode)}
                        {toolCount > 0 ? ` · ${toolCount} tool(s)` : ''}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300 tabular-nums">
                        {log.cacheHit
                          ? 'Cache Hit · 0 tok'
                          : `LLM · ${log.totalTokens || 0} tok`}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300 tabular-nums">
                        {log.latencyMs}ms
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono tabular-nums ${
                          log.confidence >= 90
                            ? 'text-emerald-400'
                            : log.confidence >= 75
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }`}
                      >
                        {formatConfidenceText(log.confidence)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Right: Selected Query Answer Inspector */}
        <div className="lg:col-span-4 rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4 self-start">
          <h3 className="font-display text-sm font-semibold text-white">
            Query Resolution Inspector
          </h3>
          {selectedLog ? (
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
                <span>{selectedLog.userHandle}</span>
                <span aria-hidden="true">·</span>
                <span>{selectedLog.channel}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-slate-200">
                  {formatMode(selectedLog.searchMode)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-mono text-emerald-400">
                  <Lock className="h-3 w-3" />
                  {selectedLog.requiredRole || 'Engineer'}
                </span>
              </div>

              <div className="text-[11px] font-mono text-emerald-400 tabular-nums">
                {selectedLog.cacheHit
                  ? 'Served from L1/L2 Semantic Cache (0 tokens)'
                  : `Gemini Tokens: ${selectedLog.promptTokens} prompt + ${selectedLog.completionTokens} completion = ${selectedLog.totalTokens} total`}
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <p className="text-[11px] font-medium text-slate-400">
                  Engineer Prompt
                </p>
                <p className="mt-1 font-medium text-white">
                  {selectedLog.query}
                </p>
              </div>

              {selectedLog.toolCalls && selectedLog.toolCalls.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-slate-950 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
                    <Wrench className="h-3.5 w-3.5" />
                    <span>
                      Agentic Tool Invocations ({selectedLog.toolCalls.length})
                    </span>
                  </div>
                  {selectedLog.toolCalls.map((tc, index) => (
                    <div
                      key={`${tc.toolName}-${index}`}
                      className="border-t border-slate-800 pt-1.5 first:border-t-0 first:pt-0 text-[11px] space-y-1"
                    >
                      <p className="font-mono text-white">
                        {tc.toolName}({JSON.stringify(tc.args)}) · {tc.durationMs}ms
                      </p>
                      <pre className="overflow-x-auto rounded bg-slate-900 p-1.5 font-mono text-[10px] text-slate-400">
                        {JSON.stringify(tc.result, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
                <p className="text-[11px] font-medium text-emerald-400">
                  Synthesized Hippocampus Answer
                </p>
                <div className="prose prose-invert prose-xs max-w-none text-slate-200">
                  <ReactMarkdown>{selectedLog.answer}</ReactMarkdown>
                </div>
              </div>

              <div className="text-[11px] text-slate-400">
                <p className="font-medium text-slate-300">Cited Documents:</p>
                <p className="mt-0.5">
                  {selectedLog.sources && selectedLog.sources.length > 0
                    ? selectedLog.sources.join(' · ')
                    : 'None'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Select any query row on the left to inspect its full synthesized response, retrieval mode, and agentic tool executions.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
