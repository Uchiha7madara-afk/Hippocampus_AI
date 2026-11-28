import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  FileCode2,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommit,
  Lock,
  Play,
  RefreshCw,
  Webhook,
} from 'lucide-react';
import {
  ConnectorsOverviewPayload,
  GoogleDriveDocCandidate,
  RbacRole,
} from '../types/app.ts';

interface ConnectorsPanelProps {
  connectors: ConnectorsOverviewPayload | null;
  activeRole: RbacRole;
  googleAccessToken: string | null;
  onConnectGoogleWorkspace: () => Promise<string | null>;
  onRefreshAll: () => Promise<void>;
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onNavigateSources: () => void;
}

const SAMPLE_GOOGLE_DOC_TEMPLATES = [
  {
    id: 'gdoc-incident-postmortem',
    title: 'Q4 Production Incident Postmortem & Runbook',
    description:
      'Google Docs structural JSON with headings, bullet lists, and inline code for Redis/pgvector pool saturation recovery.',
    payload: {
      documentId: '1A2B3C_q4_incident_postmortem',
      title: 'Q4 Production Incident Postmortem & Runbook',
      sourceUrl:
        'https://docs.google.com/document/d/1A2B3C_q4_incident_postmortem/edit',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [
                {
                  textRun: {
                    content:
                      'Q4 Production Incident Postmortem: PgBouncer Connection Pool Exhaustion\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              elements: [
                {
                  textRun: {
                    content:
                      'During peak Slack event ingestion, database connections spiked to 98% utilization due to unpooled serverless workers opening direct TCP sessions.\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_2' },
              elements: [
                {
                  textRun: {
                    content: 'Immediate Mitigation & Recovery Steps\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'kix.list1', nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content:
                      'Route all Drizzle ORM connections through PgBouncer transaction pooling on port 6432.\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'kix.list1', nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content:
                      'Verify pool health using the ',
                  },
                },
                {
                  textRun: {
                    content: 'SHOW POOLS;',
                    textStyle: {
                      weightedFontFamily: { fontFamily: 'Roboto Mono' },
                    },
                  },
                },
                {
                  textRun: {
                    content:
                      ' admin command and ensure max_client_conn is set to 500.\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'kix.list1', nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content:
                      'Enable L1/L2 Semantic Vector Caching to absorb repeated onboarding questions before hitting Cloud SQL.\n',
                  },
                },
              ],
            },
          },
        ],
      },
    },
  },
  {
    id: 'gdoc-k8s-failover',
    title: 'Multi-Region Cloud SQL & GKE Failover Architecture',
    description:
      'Google Docs structural specification detailing RPO/RTO targets, read-replica promotion, and DNS cutover.',
    payload: {
      documentId: '1D4E5F_multi_region_failover',
      title: 'Multi-Region Cloud SQL & GKE Failover Architecture',
      sourceUrl:
        'https://docs.google.com/document/d/1D4E5F_multi_region_failover/edit',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [
                {
                  textRun: {
                    content:
                      'Multi-Region Cloud SQL & GKE Failover Specification\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
              elements: [
                {
                  textRun: {
                    content:
                      'Hippocampus maintains a High-Availability regional standby in us-east1 with cross-region read replicas in asia-east1 and europe-west1. Target RTO is under 180 seconds and RPO is zero for synchronous HA standby.\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_2' },
              elements: [
                {
                  textRun: {
                    content: 'Regional Failover Drill Checklist\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'kix.list2', nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content:
                      'Drain active webhook ingestion queues and place Slack Events gateway in queuing mode.\n',
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'kix.list2', nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content:
                      'Promote cross-region replica via gcloud sql instances promote-replica and rotate SQL_HOST endpoint.\n',
                  },
                },
              ],
            },
          },
        ],
      },
    },
  },
];

export function ConnectorsPanel({
  connectors,
  activeRole,
  googleAccessToken,
  onConnectGoogleWorkspace,
  onRefreshAll,
  authFetch,
  onNavigateSources,
}: ConnectorsPanelProps) {
  const canManageConnectors =
    activeRole === 'Admin' || activeRole === 'Manager';

  // Step 3: GitHub Repository Connector state
  const [repoFullName, setRepoFullName] = useState(
    'Uchiha7madara-afk/Hippocampus'
  );
  const [branch, setBranch] = useState('main');
  const [githubAccessTier, setGithubAccessTier] =
    useState<RbacRole>('Engineer');
  const [syncingGithub, setSyncingGithub] = useState(false);
  const [simulatingWebhook, setSimulatingWebhook] = useState(false);
  const [webhookBranchOption, setWebhookBranchOption] = useState<
    'refs/heads/main' | 'refs/heads/feat/experimental'
  >('refs/heads/main');

  // Step 4: Google Workspace Drive & Docs Connector state
  const [gdriveAccessTier, setGdriveAccessTier] =
    useState<RbacRole>('Engineer');
  const [driveFiles, setDriveFiles] = useState<GoogleDriveDocCandidate[]>([]);
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);
  const [importingDocId, setImportingDocId] = useState<string | null>(null);

  const [disconnectingGithub, setDisconnectingGithub] = useState(false);
  const oauthPopupRef = useRef<Window | null>(null);

  const [banner, setBanner] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Listen for GitHub OAuth popup postMessage completion (AUD-010: strict origin, popup source, and payload shape)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (!oauthPopupRef.current || event.source !== oauthPopupRef.current) {
        return;
      }
      const data = event.data;
      if (
        !data ||
        typeof data !== 'object' ||
        (data as { type?: unknown }).type !== 'GITHUB_OAUTH_SUCCESS'
      ) {
        return;
      }
      const rawUsername = (data as { username?: unknown }).username;
      if (
        typeof rawUsername !== 'string' ||
        !/^@[A-Za-z0-9._-]{1,64}$/.test(rawUsername)
      ) {
        return;
      }
      oauthPopupRef.current = null;
      setBanner({
        type: 'success',
        text: `GitHub OAuth session connected (${rawUsername}). Ready for repository ingestion.`,
      });
      onRefreshAll();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRefreshAll]);

  const fetchUserDriveFiles = useCallback(async () => {
    if (!googleAccessToken) return;
    setLoadingDriveFiles(true);
    try {
      const res = await authFetch('/api/connectors/gdrive/files');
      const data = await res.json();
      if (res.ok && Array.isArray(data.files)) {
        setDriveFiles(data.files);
      } else if (!res.ok) {
        setBanner({
          type: 'error',
          text: data.error || 'Could not list Google Drive files.',
        });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to fetch Google Drive files.',
      });
    } finally {
      setLoadingDriveFiles(false);
    }
  }, [authFetch, googleAccessToken]);

  useEffect(() => {
    if (googleAccessToken) {
      fetchUserDriveFiles();
    }
  }, [googleAccessToken, fetchUserDriveFiles]);

  const handleOpenGithubOAuthPopup = async () => {
    setBanner(null);
    try {
      const res = await authFetch('/api/connectors/github/auth-url');
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Failed to generate GitHub OAuth URL.');
      }

      const authWindow = window.open(
        data.url,
        'hippocampus_github_oauth',
        'width=600,height=700'
      );
      if (!authWindow) {
        oauthPopupRef.current = null;
        setBanner({
          type: 'error',
          text: 'Popup blocked by browser. Please allow popups for this site to complete GitHub OAuth.',
        });
      } else {
        oauthPopupRef.current = authWindow;
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to initiate GitHub OAuth flow.',
      });
    }
  };

  const handleDisconnectGithubOAuth = async () => {
    setDisconnectingGithub(true);
    setBanner(null);
    try {
      const res = await authFetch('/api/connectors/github/disconnect', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to disconnect GitHub OAuth.');
      }
      setBanner({
        type: 'info',
        text: 'Your personal GitHub OAuth connection has been revoked.',
      });
      await onRefreshAll();
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to disconnect GitHub OAuth.',
      });
    } finally {
      setDisconnectingGithub(false);
    }
  };

  const handleSyncGithubRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageConnectors) {
      setBanner({
        type: 'error',
        text: 'RBAC Policy: Only Manager or Admin roles can trigger GitHub repository ingestion.',
      });
      return;
    }

    setSyncingGithub(true);
    setBanner(null);
    try {
      const res = await authFetch('/api/connectors/github/sync', {
        method: 'POST',
        body: JSON.stringify({
          repoFullName: repoFullName.trim(),
          branch: branch.trim(),
          accessLevel: githubAccessTier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'GitHub repository sync failed.');
      }
      setBanner({
        type: 'success',
        text: `Synced ${data.filesProcessed} Markdown/TXT file(s) from ${data.repoFullName}@${data.branch} and upserted ${data.chunksUpserted} semantic vector chunks into PostgreSQL.`,
      });
      await onRefreshAll();
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to sync GitHub repository.',
      });
    } finally {
      setSyncingGithub(false);
    }
  };

  const handleSimulateGithubWebhook = async () => {
    setSimulatingWebhook(true);
    setBanner(null);
    try {
      const simulatedSha = Math.random().toString(16).slice(2, 9);
      const res = await authFetch('/api/dev/webhooks/github/simulate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: webhookBranchOption,
          after: simulatedSha,
          repository: {
            full_name: repoFullName.trim() || 'Uchiha7madara-afk/Hippocampus',
            html_url: `https://github.com/${repoFullName.trim() || 'Uchiha7madara-afk/Hippocampus'}`,
          },
          pusher: {
            name: 'elena-rostova',
          },
          commits: [
            {
              id: simulatedSha,
              message:
                'docs(runbook): update pgvector HNSW index tuning & hybrid RRF thresholds',
              added: [],
              modified: ['docs/HYBRID_RAG_PIPELINE.md'],
            },
          ],
          simulatedDocs: [
            {
              path: 'docs/HYBRID_RAG_PIPELINE.md',
              title: `${repoFullName.trim() || 'Uchiha7madara-afk/Hippocampus'} — docs/HYBRID_RAG_PIPELINE.md`,
              content: `# Hybrid RAG & Webhook Auto-Sync Runbook (Commit ${simulatedSha})\n\n## Automated GitHub Push Ingestion\nWhen commits land on \`refs/heads/main\`, Hippocampus receives the signed \`X-Hub-Signature-256\` webhook payload, extracts modified Markdown and TXT documentation, splits content into 900-character chunks with 140-character overlap, and generates fresh \`gemini-embedding-2-preview\` vectors.\n\n## Reciprocal Rank Fusion Tuning\nDense vector cosine similarity and Okapi BM25 lexical scores are fused with RRF constant k=60. Error codes such as ERR_PGVECTOR_DIM_MISMATCH receive an automatic +1.8 lexical boost.`,
            },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Webhook simulation failed.');
      }

      if (data.status === 'skipped_non_main_branch') {
        setBanner({
          type: 'info',
          text: `[Simulated Dry-Run] Webhook simulator verified event on ${data.ref} and skipped indexing (only refs/heads/main is indexed).`,
        });
      } else {
        setBanner({
          type: 'success',
          text: `[Simulated Dry-Run] Validated push payload (${data.commitSha}) on ${data.ref}: previewed ${data.chunksUpserted} vector chunk(s) without mutating production data.`,
        });
      }
      await onRefreshAll();
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to simulate GitHub push webhook.',
      });
    } finally {
      setSimulatingWebhook(false);
    }
  };

  const handleGoogleWorkspaceAuth = async () => {
    setBanner(null);
    const token = await onConnectGoogleWorkspace();
    if (token) {
      setBanner({
        type: 'success',
        text: 'Google Workspace OAuth authorized (drive.readonly & documents.readonly). Loading your Google Docs...',
      });
    }
  };

  const handleImportLiveDriveDoc = async (file: GoogleDriveDocCandidate) => {
    if (!canManageConnectors) {
      setBanner({
        type: 'error',
        text: 'RBAC Policy: Only Manager or Admin roles can import Google Drive documents.',
      });
      return;
    }

    setImportingDocId(file.id);
    setBanner(null);
    try {
      const res = await authFetch('/api/connectors/gdrive/import', {
        method: 'POST',
        body: JSON.stringify({
          fileId: file.id,
          mimeType: file.mimeType,
          accessLevel: gdriveAccessTier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to import Google Doc.');
      }
      setBanner({
        type: 'success',
        text: `Pulled "${data.document.title}" from Google Drive, converted to clean Markdown, and upserted ${data.document.chunksUpserted} semantic vector chunks.`,
      });
      await onRefreshAll();
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to import Google Drive document.',
      });
    } finally {
      setImportingDocId(null);
    }
  };

  const handleImportSampleGoogleDoc = async (
    template: (typeof SAMPLE_GOOGLE_DOC_TEMPLATES)[number]
  ) => {
    if (!canManageConnectors) {
      setBanner({
        type: 'error',
        text: 'RBAC Policy: Only Manager or Admin roles can import Google Docs into the vector database.',
      });
      return;
    }

    setImportingDocId(template.id);
    setBanner(null);
    try {
      const res = await authFetch('/api/connectors/gdrive/import', {
        method: 'POST',
        body: JSON.stringify({
          accessLevel: gdriveAccessTier,
          googleDocJson: template.payload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to convert and import Google Doc.');
      }
      setBanner({
        type: 'success',
        text: `Converted Google Doc "${data.document.title}" structural JSON to Markdown and upserted ${data.document.chunksUpserted} vector chunks.`,
      });
      await onRefreshAll();
    } catch (err) {
      setBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to import sample Google Doc.',
      });
    } finally {
      setImportingDocId(null);
    }
  };

  const syncLogs = connectors?.syncLogs || [];

  return (
    <div className="space-y-8">
      {/* Top RBAC & Pipeline Architecture Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-3 text-xs">
        <div className="flex items-center gap-2 text-slate-300">
          <Lock className="h-3.5 w-3.5 text-emerald-400" />
          <span>
            Active RBAC Clearance:{' '}
            <strong className="font-mono text-white">{activeRole}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-slate-400">
            {canManageConnectors
              ? 'Authorized to connect GitHub repositories, process webhooks, and import Google Workspace Docs'
              : 'Read-only connector audit view · Switch to Manager or Admin to trigger live ingestion'}
          </span>
        </div>

        <button
          type="button"
          onClick={onNavigateSources}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 cursor-pointer"
        >
          <span>View Indexed Knowledge Base</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-xl border px-4 py-3 text-xs ${
            banner.type === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : banner.type === 'info'
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Dual Connector Grid: Step 3 (GitHub) & Step 4 (Google Workspace) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Step 3: GitHub Repository OAuth & Webhook Connector */}
        <div className="lg:col-span-6 flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-6">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-white">
                  <FolderGit2 className="h-4 w-4 text-emerald-400" />
                </div>
                <div>
                  <h2 className="font-display text-base font-semibold text-white">
                    GitHub Repository &amp; Webhook Connector
                  </h2>
                  <p className="text-xs text-slate-400">
                    Step 3 · Live REST API ingestion &amp; <code>refs/heads/main</code> push webhook listener
                  </p>
                </div>
              </div>

              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  connectors?.githubSessionConnected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300'
                }`}
              >
                {connectors?.githubSessionConnected
                  ? `Connected (${connectors.githubConnectedUser || '@github'})`
                  : 'Public API + OAuth Ready'}
              </span>
            </div>

            {/* GitHub OAuth Popup Trigger */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-white">
                    GitHub OAuth 2.0 Handshake
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Connect via popup OAuth callback (<code>/auth/github/callback</code>) or pull directly from public/token repositories.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenGithubOAuthPopup}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:border-emerald-500/50 hover:text-emerald-300 cursor-pointer"
                  >
                    <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>
                      {connectors?.githubSessionConnected
                        ? 'Reconnect GitHub OAuth'
                        : 'Connect GitHub OAuth'}
                    </span>
                  </button>
                  {connectors?.githubSessionConnected && (
                    <button
                      type="button"
                      disabled={disconnectingGithub}
                      onClick={handleDisconnectGithubOAuth}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50 cursor-pointer"
                    >
                      {disconnectingGithub ? 'Revoking...' : 'Disconnect'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Repository Sync Form */}
            <form onSubmit={handleSyncGithubRepo} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                <div className="sm:col-span-6 space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Repository (owner/repo)
                  </label>
                  <input
                    type="text"
                    value={repoFullName}
                    onChange={(e) => setRepoFullName(e.target.value)}
                    placeholder="Uchiha7madara-afk/Hippocampus"
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-white focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-3 space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Branch
                  </label>
                  <div className="relative">
                    <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    <input
                      type="text"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      placeholder="main"
                      className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-8 pr-2.5 py-2 font-mono text-xs text-white focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="sm:col-span-3 space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    RBAC Tier
                  </label>
                  <select
                    value={githubAccessTier}
                    onChange={(e) =>
                      setGithubAccessTier(e.target.value as RbacRole)
                    }
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="Engineer">Engineer</option>
                    <option value="Manager">Manager</option>
                    {activeRole === 'Admin' && (
                      <option value="Admin">Admin</option>
                    )}
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={syncingGithub || !canManageConnectors}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${syncingGithub ? 'animate-spin' : ''}`}
                />
                <span>
                  {syncingGithub
                    ? 'Fetching Markdown & Generating Gemini Embeddings...'
                    : 'Sync Repository Docs Now (900c / 140c Overlap)'}
                </span>
              </button>
            </form>
          </div>

          {/* Interactive GitHub Webhook Simulator */}
          <div className="border-t border-slate-800/80 pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Webhook className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-xs font-semibold text-white">
                  Webhook Receiver (<code>POST /api/webhooks/github</code>)
                </span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                HMAC-SHA256 Verified
              </span>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={webhookBranchOption}
                onChange={(e) =>
                  setWebhookBranchOption(
                    e.target.value as
                      | 'refs/heads/main'
                      | 'refs/heads/feat/experimental'
                  )
                }
                aria-label="Webhook target ref"
                className="flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="refs/heads/main">
                  refs/heads/main (Auto-Chunk &amp; Upsert)
                </option>
                <option value="refs/heads/feat/experimental">
                  refs/heads/feat/experimental (Branch Filter Skip)
                </option>
              </select>

              <button
                type="button"
                disabled={simulatingWebhook}
                onClick={handleSimulateGithubWebhook}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3.5 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" />
                <span>
                  {simulatingWebhook
                    ? 'Dispatching Push...'
                    : 'Simulate Push Event'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Step 4: Google Workspace (Drive & Docs) Connector */}
        <div className="lg:col-span-6 flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-6">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-white">
                  <FileText className="h-4 w-4 text-emerald-400" />
                </div>
                <div>
                  <h2 className="font-display text-base font-semibold text-white">
                    Google Workspace Drive &amp; Docs Connector
                  </h2>
                  <p className="text-xs text-slate-400">
                    Step 4 · Google Docs structural JSON &rarr; Markdown converter &amp; vector indexer
                  </p>
                </div>
              </div>

              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  googleAccessToken
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300'
                }`}
              >
                {googleAccessToken ? 'OAuth Token Active' : 'Scopes Configured'}
              </span>
            </div>

            {/* Official Google Sign-In / Drive Scope Authorization */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-white">
                  Google Drive &amp; Docs Read-Only OAuth
                </p>
                <p className="font-mono text-[11px] text-slate-400">
                  drive.readonly · documents.readonly
                </p>
              </div>

              <button
                type="button"
                onClick={handleGoogleWorkspaceAuth}
                className="gsi-material-button inline-flex items-center gap-2.5 rounded-lg border border-slate-700 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 shadow-xs hover:bg-slate-100 cursor-pointer"
              >
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  className="h-4 w-4 shrink-0"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>
                  {googleAccessToken
                    ? 'Refresh Google Drive Access'
                    : 'Sign in with Google'}
                </span>
              </button>
            </div>

            {/* Target RBAC Tier Selector for Google Docs */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-slate-300">
                Target RBAC Classification for Imported Docs:
              </span>
              <select
                value={gdriveAccessTier}
                onChange={(e) =>
                  setGdriveAccessTier(e.target.value as RbacRole)
                }
                className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="Engineer">Engineer Tier</option>
                <option value="Manager">Manager Tier</option>
                {activeRole === 'Admin' && (
                  <option value="Admin">Admin Tier</option>
                )}
              </select>
            </div>

            {/* Live Google Drive File Browser (when authenticated) */}
            {googleAccessToken && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-400">
                    Your Live Google Drive Documents ({driveFiles.length})
                  </span>
                  <button
                    type="button"
                    onClick={fetchUserDriveFiles}
                    disabled={loadingDriveFiles}
                    className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                  >
                    {loadingDriveFiles ? 'Loading...' : 'Refresh List'}
                  </button>
                </div>

                {driveFiles.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    {loadingDriveFiles
                      ? 'Querying Google Drive API v3...'
                      : 'No Google Docs found in your Drive, or use the structural templates below.'}
                  </p>
                ) : (
                  <div className="max-h-36 overflow-y-auto divide-y divide-slate-800/70">
                    {driveFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center justify-between gap-2 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-white">
                            {file.name}
                          </p>
                          <p className="text-[10px] text-slate-400 font-mono">
                            {file.id.slice(0, 14)}...
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={
                            importingDocId === file.id || !canManageConnectors
                          }
                          onClick={() => handleImportLiveDriveDoc(file)}
                          className="rounded-md bg-emerald-500/20 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 shrink-0 cursor-pointer"
                        >
                          {importingDocId === file.id
                            ? 'Embedding...'
                            : 'Pull & Embed'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Google Docs Structural JSON -> Markdown Pipeline Templates */}
            <div className="space-y-2.5">
              <p className="text-xs font-semibold text-slate-300">
                Google Docs Structural JSON &rarr; Clean Markdown Pipeline
              </p>
              <div className="space-y-2">
                {SAMPLE_GOOGLE_DOC_TEMPLATES.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="flex flex-col justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 sm:flex-row sm:items-center"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <FileCode2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                        <span className="text-xs font-medium text-white">
                          {tpl.title}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        {tpl.description}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={
                        importingDocId === tpl.id || !canManageConnectors
                      }
                      onClick={() => handleImportSampleGoogleDoc(tpl)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>
                        {importingDocId === tpl.id
                          ? 'Converting & Embedding...'
                          : 'Convert & Upsert Doc'}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Connector Sync & Webhook Ingestion Audit Table */}
      <div className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              External Connector Sync &amp; Webhook Audit Log ({syncLogs.length})
            </h2>
            <p className="text-xs text-slate-400">
              Real-time PostgreSQL record of GitHub <code>refs/heads/main</code> push webhooks, repository syncs, and Google Docs structural conversions.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full min-w-[780px] text-left">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs font-medium text-slate-400">
                <th className="px-4 py-3">Connector</th>
                <th className="px-4 py-3">Target Repository / Google Doc</th>
                <th className="px-4 py-3">Trigger Event</th>
                <th className="px-4 py-3">Commit / Ref</th>
                <th className="px-4 py-3 text-right">Files</th>
                <th className="px-4 py-3 text-right">Chunks Upserted</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {syncLogs.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-slate-400"
                  >
                    No connector sync events recorded yet.
                  </td>
                </tr>
              ) : (
                syncLogs.map((log) => (
                  <tr
                    key={log.id}
                    className="transition-colors hover:bg-slate-800/30"
                  >
                    <td className="px-4 py-3 font-medium text-white">
                      <span className="inline-flex items-center gap-1.5">
                        {log.provider === 'github' ? (
                          <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 text-sky-400" />
                        )}
                        {log.provider === 'github'
                          ? 'GitHub'
                          : 'Google Workspace'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-200">
                        {log.target}{' '}
                        <span className="font-mono text-[11px] text-slate-400">
                          ({log.branchOrFolder})
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-md">
                        {log.details}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">
                      {log.triggerType}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">
                      {log.commitSha ? (
                        <span className="inline-flex items-center gap-1">
                          <GitCommit className="h-3 w-3 text-slate-500" />
                          {log.commitSha}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-200 tabular-nums">
                      {log.filesProcessed}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-400 tabular-nums">
                      +{log.chunksUpserted}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-mono ${
                          log.status === 'Synced'
                            ? 'text-emerald-400'
                            : log.status === 'Skipped'
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-400 tabular-nums">
                      {new Date(log.createdAt).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
