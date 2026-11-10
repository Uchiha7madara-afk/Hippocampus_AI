import React, { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Database,
  MessageSquare,
  Plus,
  Terminal,
} from 'lucide-react';
import {
  AgentSettingItem,
  DashboardStats,
  IndexedDocument,
  QueryLogItem,
  WorkspaceTab,
} from '../types/app.ts';

interface DashboardPanelProps {
  stats: DashboardStats;
  recentDocuments: IndexedDocument[];
  recentLogs: QueryLogItem[];
  settings: AgentSettingItem[];
  onNavigateTab: (tab: WorkspaceTab) => void;
  onQuickIngest: (payload: {
    title: string;
    sourceType: 'file' | 'url' | 'slack';
    content: string;
  }) => Promise<void>;
  onToggleSetting: (key: string, enabled: boolean) => Promise<void>;
}

export function DashboardPanel({
  stats,
  recentDocuments,
  recentLogs,
  settings,
  onNavigateTab,
  onQuickIngest,
  onToggleSetting,
}: DashboardPanelProps) {
  const [quickTitle, setQuickTitle] = useState('');
  const [quickContent, setQuickContent] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestNotice, setIngestNotice] = useState<string | null>(null);

  const handleQuickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!quickTitle.trim()) {
      setQuickTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
    const text = await file.text();
    setQuickContent(text);
    e.target.value = '';
  };

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickTitle.trim() || !quickContent.trim() || ingesting) return;

    setIngesting(true);
    setIngestNotice(null);
    try {
      await onQuickIngest({
        title: quickTitle.trim(),
        sourceType: 'file',
        content: quickContent.trim(),
      });
      setQuickTitle('');
      setQuickContent('');
      setIngestNotice(
        'Document chunked, embedded via Gemini, and added to knowledge base.'
      );
    } catch (err: unknown) {
      setIngestNotice(
        err instanceof Error ? err.message : 'Failed to ingest document.'
      );
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* 4-Column Real Database KPI Row */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Indexed Knowledge Docs</span>
            <Database className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-white tabular-nums">
            {stats.totalDocuments}
          </p>
          <p className="text-xs text-slate-400">
            <span className="font-mono text-slate-200 tabular-nums">
              {stats.totalChunks}
            </span>{' '}
            embedded semantic chunks
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Onboarding Inquiries</span>
            <MessageSquare className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-white tabular-nums">
            {stats.totalQueries}
          </p>
          <p className="text-xs text-slate-400">
            Across Slack threads &amp; Playground
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Mean Mentor Confidence</span>
            <BookOpen className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
            {stats.avgConfidence}%
          </p>
          <p className="text-xs text-slate-400">
            Grounded similarity &amp; citation score
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Mean RAG Latency</span>
            <Terminal className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-white tabular-nums">
            {stats.avgLatencyMs}ms
          </p>
          <p className="text-xs text-slate-400">
            Vector retrieval + Gemini synthesis
          </p>
        </div>
      </section>

      {/* Main Split: Recent Inquiries & Quick Document Ingestion */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Recent Mentorship Inquiries */}
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/40 p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display text-base font-semibold text-white">
                  Recent Mentorship Inquiries
                </h2>
                <p className="text-xs text-slate-400">
                  Live queries resolved across Slack &amp; Playground
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('logs')}
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:text-emerald-300 cursor-pointer"
              >
                View All Telemetry
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="divide-y divide-slate-800/80">
              {recentLogs.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium text-white">
                      {item.query}
                    </p>
                    <p className="text-slate-400">
                      <span>{item.userHandle}</span>
                      <span className="mx-1.5" aria-hidden="true">
                        ·
                      </span>
                      <span>{item.channel}</span>
                      <span className="mx-1.5" aria-hidden="true">
                        ·
                      </span>
                      <span>
                        {item.sources[0] || 'No source matched'}
                      </span>
                    </p>
                  </div>
                  <div className="text-right font-mono tabular-nums shrink-0">
                    <p className="text-emerald-400">{item.confidence}%</p>
                    <p className="text-[11px] text-slate-400">
                      {item.latencyMs}ms
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 pt-4 border-t border-slate-800 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onNavigateTab('sources')}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-600 cursor-pointer"
            >
              <span>Knowledge Sources</span>
              <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('playground')}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-600 cursor-pointer"
            >
              <span>RAG Playground</span>
              <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('slack')}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:border-slate-600 cursor-pointer"
            >
              <span>Slack Simulator</span>
              <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Right: Quick Runbook Ingestion Form */}
        <form
          onSubmit={handleQuickSubmit}
          className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-4"
        >
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Quick Runbook Ingestion
            </h2>
            <p className="text-xs text-slate-400">
              Upload a <code>.md</code> / <code>.txt</code> file or paste documentation to chunk &amp; embed immediately.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Document Title
            </label>
            <input
              type="text"
              required
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              placeholder="e.g. Incident On-Call Escalation Policy"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Load from File (.md, .txt) or Paste Below
            </label>
            <input
              type="file"
              accept=".md,.markdown,.txt"
              onChange={handleQuickFile}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-white cursor-pointer"
            />
          </div>

          <div>
            <textarea
              rows={4}
              required
              value={quickContent}
              onChange={(e) => setQuickContent(e.target.value)}
              placeholder="Paste markdown documentation or onboarding steps here..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={ingesting}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            {ingesting
              ? 'Generating Vector Embeddings...'
              : 'Ingest & Embed Document'}
          </button>

          {ingestNotice && (
            <p className="text-xs text-emerald-400">{ingestNotice}</p>
          )}
        </form>
      </section>

      {/* Bottom Row: Indexed Sources Summary & Agent Guardrail Toggles */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-white">
              Recently Indexed Runbooks
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab('sources')}
              className="text-xs font-medium text-emerald-400 hover:underline cursor-pointer"
            >
              Manage all {stats.totalDocuments} sources
            </button>
          </div>
          <div className="divide-y divide-slate-800/80 text-xs">
            {recentDocuments.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 pr-3">
                  <p className="truncate font-medium text-white">{doc.title}</p>
                  <p className="text-slate-400">
                    {doc.sourceType.toUpperCase()} · {doc.chunkCount} chunks
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-emerald-400 shrink-0">
                  <Check className="h-3.5 w-3.5" />
                  {doc.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-6 rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Active Agent Guardrails
            </h2>
            <p className="text-xs text-slate-400">
              Persisted in PostgreSQL · Governs Slack and Playground behavior
            </p>
          </div>
          <div className="divide-y divide-slate-800/80">
            {settings.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="text-xs font-medium text-white">{s.label}</p>
                  <p className="text-[11px] text-slate-400 line-clamp-1">
                    {s.description}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={s.enabled}
                  onClick={() => onToggleSetting(s.key, !s.enabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    s.enabled ? 'bg-emerald-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      s.enabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
