/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Database,
  LogIn,
  LogOut,
  MessageSquare,
  Slack,
  Terminal,
} from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import {
  AgentSettingItem,
  DashboardStats,
  IndexedDocument,
  OverviewPayload,
  QueryLogItem,
  RetrievedChunkPreview,
  WorkspaceTab,
} from './types/app.ts';
import { LandingView } from './components/LandingView.tsx';
import { DashboardPanel } from './components/DashboardPanel.tsx';
import { SourcesPanel } from './components/SourcesPanel.tsx';
import { PlaygroundPanel } from './components/PlaygroundPanel.tsx';
import { SlackSimulatorPanel } from './components/SlackSimulatorPanel.tsx';
import { QueryLogsPanel } from './components/QueryLogsPanel.tsx';

const NAV_ITEMS: {
  id: WorkspaceTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'dashboard', label: 'Overview Dashboard', icon: Activity },
  { id: 'sources', label: 'Knowledge Sources', icon: Database },
  { id: 'playground', label: 'RAG Playground', icon: Terminal },
  { id: 'slack', label: 'Slack Event Simulator', icon: Slack },
  { id: 'logs', label: 'Query Telemetry', icon: MessageSquare },
];

const TAB_TITLES: Record<WorkspaceTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Overview Dashboard',
    subtitle:
      'Monitor vector ingestion, RAG confidence scores, and Slack mentorship activity.',
  },
  sources: {
    title: 'Knowledge Sources',
    subtitle:
      'Upload Markdown & TXT runbooks, index internal URLs, and manage PostgreSQL vector chunks.',
  },
  playground: {
    title: 'RAG Knowledge Playground',
    subtitle:
      'Test how Hippocampus retrieves semantic chunks and cites sources before engineers ask in Slack.',
  },
  slack: {
    title: 'Slack Events API & Simulator',
    subtitle:
      'Simulate @Hippocampus channel mentions and new-hire join events or copy your Slack App Manifest.',
  },
  logs: {
    title: 'Query Telemetry & Audit Logs',
    subtitle:
      'Inspect historical inquiries, response latency, cited documents, and similarity confidence.',
  },
};

function HippocampusShell() {
  const { user, signInWithGoogle, logout, authFetch, authError } = useAuth();

  const [mode, setMode] = useState<'landing' | 'workspace'>('landing');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('dashboard');

  const [stats, setStats] = useState<DashboardStats>({
    totalDocuments: 7,
    totalChunks: 9,
    totalQueries: 5,
    avgConfidence: 94.8,
    avgLatencyMs: 862,
  });
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [logs, setLogs] = useState<QueryLogItem[]>([]);
  const [settings, setSettings] = useState<AgentSettingItem[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  const refreshWorkspaceData = useCallback(async () => {
    setApiError(null);
    try {
      const [overviewRes, docsRes, logsRes] = await Promise.all([
        authFetch('/api/overview'),
        authFetch('/api/documents'),
        authFetch('/api/logs'),
      ]);

      if (overviewRes.ok) {
        const overviewData = (await overviewRes.json()) as OverviewPayload;
        setStats(overviewData.stats);
        setSettings(overviewData.settings);
      }

      if (docsRes.ok) {
        const docsData = (await docsRes.json()) as {
          documents: IndexedDocument[];
        };
        setDocuments(docsData.documents);
      }

      if (logsRes.ok) {
        const logsData = (await logsRes.json()) as { logs: QueryLogItem[] };
        setLogs(logsData.logs);
      }
    } catch (err: unknown) {
      setApiError(
        err instanceof Error
          ? err.message
          : 'Unable to load workspace telemetry.'
      );
    } finally {
      setLoadingData(false);
    }
  }, [authFetch]);

  useEffect(() => {
    refreshWorkspaceData();
  }, [refreshWorkspaceData]);

  const handleEnterWorkspace = (initialTab: WorkspaceTab = 'dashboard') => {
    setActiveTab(initialTab);
    setMode('workspace');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleIngestDocument = async (payload: {
    title: string;
    sourceType: 'file' | 'url' | 'slack';
    sourceUrl?: string;
    content: string;
  }) => {
    const res = await authFetch('/api/documents', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to ingest document.');
    }
    await refreshWorkspaceData();
  };

  const handleDeleteDocument = async (id: number) => {
    const res = await authFetch(`/api/documents/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete document.');
    }
    await refreshWorkspaceData();
  };

  const handleSendPlaygroundQuery = async (
    query: string
  ): Promise<{
    answer: string;
    sources: string[];
    confidence: number;
    latencyMs: number;
    chunks: RetrievedChunkPreview[];
  }> => {
    const res = await authFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ query, channel: 'Playground' }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'RAG query failed.');
    }
    await refreshWorkspaceData();
    return data;
  };

  const handleTriggerSlackEvent = async (payload: {
    type: 'app_mention' | 'member_joined_channel';
    channel: string;
    user: string;
    text?: string;
  }) => {
    const res = await authFetch('/api/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hippocampus-simulator': 'true',
      },
      body: JSON.stringify({
        type: 'event_callback',
        event: payload,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Slack event dispatch failed.');
    }
    await refreshWorkspaceData();
    return {
      reply: data.reply as string,
      sources: (data.sources || []) as string[],
      confidence: (data.confidence || 95) as number,
      latencyMs: (data.latencyMs || 420) as number,
    };
  };

  const handleToggleSetting = async (key: string, enabled: boolean) => {
    setSettings((prev) =>
      prev.map((s) => (s.key === key ? { ...s, enabled } : s))
    );
    const res = await authFetch(`/api/settings/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      await refreshWorkspaceData();
    }
  };

  if (mode === 'landing') {
    return (
      <LandingView
        onEnterWorkspace={handleEnterWorkspace}
        settings={settings}
        onToggleSetting={handleToggleSetting}
      />
    );
  }

  const currentHeader = TAB_TITLES[activeTab];

  return (
    <div className="flex min-h-screen bg-[#090D16] text-slate-100">
      {/* Workspace Sidebar (260px desktop width) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-800 bg-[#0B101B] lg:flex">
        <div className="flex h-16 items-center justify-between border-b border-slate-800 px-5">
          <button
            type="button"
            onClick={() => setMode('landing')}
            className="font-display text-lg font-bold tracking-tight text-white cursor-pointer"
          >
            Hippocampus
          </button>
          <button
            type="button"
            onClick={() => setMode('landing')}
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white cursor-pointer"
          >
            <ArrowLeft className="h-3 w-3" />
            Site
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-400 font-semibold'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>

        {/* Account & Google Sign-In Footer */}
        <div className="border-t border-slate-800 p-4 space-y-3">
          {user ? (
            <div className="space-y-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-white">
                  {user.displayName || 'Workspace Engineer'}
                </p>
                <p className="truncate text-[11px] text-slate-400">
                  {user.email}
                </p>
              </div>
              <button
                type="button"
                onClick={logout}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-white cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-400">
                Sign in with Google to link ingested runbooks to your engineer profile.
              </p>
              <button
                type="button"
                onClick={signInWithGoogle}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-slate-200 cursor-pointer"
              >
                <LogIn className="h-3.5 w-3.5" />
                Sign In with Google
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col lg:pl-64">
        {/* Top Workspace Header Following SaaS Top Bar Contract */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-800 bg-[#090D16]/90 px-6 backdrop-blur-md">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <button
              type="button"
              onClick={() => setMode('landing')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Hippocampus
            </button>
            <span aria-hidden="true">/</span>
            <span>Console</span>
            <span aria-hidden="true">/</span>
            <span className="font-medium text-white">
              {currentHeader.title}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Mobile Tab Selector */}
            <select
              value={activeTab}
              onChange={(e) => setActiveTab(e.target.value as WorkspaceTab)}
              aria-label="Select workspace view"
              className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white lg:hidden"
            >
              {NAV_ITEMS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>

            {activeTab !== 'sources' ? (
              <button
                type="button"
                onClick={() => setActiveTab('sources')}
                className="rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Ingest Document
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('playground')}
                className="rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Test in Playground
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8 space-y-6">
          <div className="space-y-1">
            <h1 className="font-display text-2xl font-bold tracking-tight text-white">
              {currentHeader.title}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              {currentHeader.subtitle}
            </p>
          </div>

          {(apiError || authError) && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
              {apiError || authError}
            </div>
          )}

          {activeTab === 'dashboard' && (
            <DashboardPanel
              stats={stats}
              recentDocuments={documents.slice(0, 6)}
              recentLogs={logs.slice(0, 8)}
              settings={settings}
              onNavigateTab={setActiveTab}
              onQuickIngest={handleIngestDocument}
              onToggleSetting={handleToggleSetting}
            />
          )}

          {activeTab === 'sources' && (
            <SourcesPanel
              documents={documents}
              loading={loadingData}
              onIngestDocument={handleIngestDocument}
              onDeleteDocument={handleDeleteDocument}
            />
          )}

          {activeTab === 'playground' && (
            <PlaygroundPanel onSendQuery={handleSendPlaygroundQuery} />
          )}

          {activeTab === 'slack' && (
            <SlackSimulatorPanel
              onTriggerSlackEvent={handleTriggerSlackEvent}
            />
          )}

          {activeTab === 'logs' && (
            <QueryLogsPanel logs={logs} loading={loadingData} />
          )}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <HippocampusShell />
    </AuthProvider>
  );
}
