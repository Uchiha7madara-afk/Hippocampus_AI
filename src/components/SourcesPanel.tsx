import React, { useCallback, useState } from 'react';
import {
  FileText,
  Globe,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { IndexedDocument, RbacRole } from '../types/app.ts';

interface SourcesPanelProps {
  documents: IndexedDocument[];
  loading: boolean;
  activeRole: RbacRole;
  onIngestDocument: (payload: {
    title: string;
    sourceType: 'file' | 'url' | 'slack';
    sourceUrl?: string;
    accessLevel?: RbacRole;
    content: string;
  }) => Promise<void>;
  onDeleteDocument: (id: number) => Promise<void>;
}

export function SourcesPanel({
  documents,
  loading,
  activeRole,
  onIngestDocument,
  onDeleteDocument,
}: SourcesPanelProps) {
  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<'file' | 'url' | 'slack'>('file');
  const [accessLevel, setAccessLevel] = useState<RbacRole>('Engineer');
  const [sourceUrl, setSourceUrl] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [filterType, setFilterType] = useState<
    'all' | 'file' | 'url' | 'slack' | 'github' | 'gdrive'
  >('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedDocId, setExpandedDocId] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const canIngest = activeRole === 'Admin' || activeRole === 'Manager';
  const canDelete = activeRole === 'Admin';

  const handleFileRead = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const inferredTitle = file.name.replace(/\.[^/.]+$/, '');
        if (!title.trim()) {
          setTitle(inferredTitle);
        }
        setSourceType('file');
        setSourceUrl(`file://${file.name}`);
        setContent(text);
        setFeedback({
          type: 'success',
          text: `Loaded "${file.name}" (${text.length.toLocaleString()} chars). Click "Chunk & Index Document" to generate embeddings.`,
        });
      } catch {
        setFeedback({
          type: 'error',
          text: 'Could not read file text. Please upload a .md, .txt, or .html file.',
        });
      }
    },
    [title]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) {
        await handleFileRead(file);
      }
    },
    [handleFileRead]
  );

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await handleFileRead(file);
    }
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canIngest) {
      setFeedback({
        type: 'error',
        text: 'RBAC Policy: Engineer role has read-only access. Switch to Manager or Admin to ingest documents.',
      });
      return;
    }
    if (!title.trim() || !content.trim()) {
      setFeedback({
        type: 'error',
        text: 'Both Document Title and Content are required.',
      });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      await onIngestDocument({
        title: title.trim(),
        sourceType,
        sourceUrl: sourceUrl.trim() || undefined,
        accessLevel,
        content: content.trim(),
      });
      setTitle('');
      setSourceUrl('');
      setContent('');
      setFeedback({
        type: 'success',
        text: `Document indexed under [${accessLevel}] RBAC tier and stored in PostgreSQL.`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to ingest document into knowledge base.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteClick = async (docId: number) => {
    setFeedback(null);
    try {
      await onDeleteDocument(docId);
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to delete document.',
      });
    }
  };

  const filteredDocs = documents.filter((doc) => {
    const matchesType = filterType === 'all' || doc.sourceType === filterType;
    const matchesSearch =
      !searchTerm.trim() ||
      doc.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      doc.contentPreview.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesType && matchesSearch;
  });

  const formatSourceLabel = (type: string) => {
    if (type === 'github') return 'GitHub Repo';
    if (type === 'gdrive') return 'Google Drive';
    if (type === 'url') return 'URL Crawl';
    if (type === 'slack') return 'Slack Thread';
    return 'File Upload';
  };

  return (
    <div className="space-y-8">
      {/* RBAC Visibility Notice */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-3 text-xs">
        <div className="flex items-center gap-2 text-slate-300">
          <Lock className="h-3.5 w-3.5 text-emerald-400" />
          <span>
            Active RBAC Clearance:{' '}
            <strong className="font-mono text-white">{activeRole}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-slate-400">
            {activeRole === 'Admin'
              ? 'Full visibility (Engineer, Manager & Admin tiers) + Ingestion & Deletion privileges'
              : activeRole === 'Manager'
                ? 'Manager visibility (Engineer & Manager tiers) + Ingestion privileges (Admin docs hidden)'
                : 'Engineer visibility (Engineer tier only) · Read-only source access'}
          </span>
        </div>
      </div>

      {/* Ingestion Form & Drag-and-Drop Zone */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="space-y-2">
            <h2 className="font-display text-base font-semibold text-white">
              Upload Runbook File
            </h2>
            <p className="text-xs leading-relaxed text-slate-400">
              Drag and drop Markdown (<code>.md</code>), Plain Text (<code>.txt</code>), or HTML documentation files to populate the ingestion editor automatically.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={handleDrop}
            className={`relative my-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              isDragging
                ? 'border-emerald-400 bg-emerald-500/10'
                : 'border-slate-700 hover:border-slate-500 bg-slate-950/60'
            }`}
          >
            <UploadCloud className="mb-3 h-7 w-7 text-emerald-400" />
            <p className="text-xs font-medium text-white">
              Drop .md, .txt, or .html runbook here, or click to browse
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Automatically chunks text into 900-character segments with 140-char overlap
            </p>
            <input
              type="file"
              accept=".md,.markdown,.txt,.html,.json"
              onChange={handleFileInput}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </div>

          <div className="text-xs text-slate-400">
            <span>Embedding Model: gemini-embedding-2</span>
            <span className="mx-2" aria-hidden="true">
              ·
            </span>
            <span>Storage: PostgreSQL + RBAC Policy</span>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-white">
              Ingest New Knowledge Source
            </h2>
            {/* Segmented Source Type Selector */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1">
              {(['file', 'url', 'slack'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSourceType(type)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    sourceType === type
                      ? 'bg-emerald-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {type === 'file'
                    ? 'File / Runbook'
                    : type === 'url'
                      ? 'Internal URL'
                      : 'Slack Channel'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Document Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. K8s Incident Rollback"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Source Reference (Optional)
              </label>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder={
                  sourceType === 'url'
                    ? 'https://docs.internal/k8s'
                    : sourceType === 'slack'
                      ? 'slack://#eng-incidents'
                      : 'docs://ops/k8s.md'
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1">
                RBAC Classification Tier
              </label>
              <div className="inline-flex w-full rounded-lg border border-slate-700 bg-slate-950 p-1">
                {(['Engineer', 'Manager', 'Admin'] as const).map((tier) => {
                  const disabledTier =
                    tier === 'Admin' && activeRole !== 'Admin';
                  return (
                    <button
                      key={tier}
                      type="button"
                      disabled={disabledTier}
                      onClick={() => setAccessLevel(tier)}
                      className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 ${
                        accessLevel === tier
                          ? 'bg-slate-800 text-emerald-400 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {tier}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Documentation Content (Markdown or Plain Text)
            </label>
            <textarea
              rows={5}
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste engineering onboarding steps, CLI commands, SAML configuration, or architecture runbooks here..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none font-mono"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {feedback ? (
              <p
                className={`text-xs ${
                  feedback.type === 'success'
                    ? 'text-emerald-400'
                    : 'text-red-400'
                }`}
              >
                {feedback.text}
              </p>
            ) : (
              <span className="text-xs text-slate-400">
                {canIngest
                  ? 'Chunks are immediately searchable by roles authorized for the selected classification tier.'
                  : 'Read-only mode active for Engineer role. Switch to Manager or Admin in the top header to ingest.'}
              </span>
            )}

            <button
              type="submit"
              disabled={submitting || !canIngest}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              {submitting
                ? 'Embedding & Indexing...'
                : 'Chunk & Index Document'}
            </button>
          </div>
        </form>
      </div>

      {/* Indexed Knowledge Base Table */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Authorized Knowledge Base ({filteredDocs.length} sources visible to{' '}
              {activeRole})
            </h2>
            <p className="text-xs text-slate-400">
              Click any document row to inspect its indexed content excerpt and RBAC classification tier.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search indexed docs..."
                className="rounded-lg border border-slate-800 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="inline-flex flex-wrap rounded-lg border border-slate-800 bg-slate-900 p-1">
              {(
                ['all', 'github', 'gdrive', 'file', 'url', 'slack'] as const
              ).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilterType(tab)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    filterType === tab
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab === 'all'
                    ? 'All'
                    : tab === 'github'
                      ? 'GitHub'
                      : tab === 'gdrive'
                        ? 'Google Drive'
                        : tab === 'file'
                          ? 'Files'
                          : tab === 'url'
                            ? 'URLs'
                            : 'Slack'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full min-w-[740px] text-left">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-xs font-medium text-slate-400">
                <th className="px-4 py-3">Document Title</th>
                <th className="px-4 py-3">Source Type</th>
                <th className="px-4 py-3">RBAC Tier</th>
                <th className="px-4 py-3 text-right">Vector Chunks</th>
                <th className="px-4 py-3">Ingestion State</th>
                <th className="px-4 py-3 text-right">Date Indexed</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {loading && documents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    Loading indexed documents from PostgreSQL...
                  </td>
                </tr>
              ) : filteredDocs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No matching knowledge sources found for {activeRole} clearance.
                  </td>
                </tr>
              ) : (
                filteredDocs.map((doc) => {
                  const isExpanded = expandedDocId === doc.id;
                  const tier = doc.accessLevel || 'Engineer';
                  return (
                    <React.Fragment key={doc.id}>
                      <tr
                        onClick={() =>
                          setExpandedDocId(isExpanded ? null : doc.id)
                        }
                        className="cursor-pointer transition-colors hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-3 font-medium text-white">
                          <div className="flex items-center gap-2.5">
                            {doc.sourceType === 'url' ? (
                              <Globe className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            ) : doc.sourceType === 'slack' ? (
                              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            ) : (
                              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            )}
                            <span className="truncate max-w-md">{doc.title}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          {formatSourceLabel(doc.sourceType)}
                        </td>
                        <td
                          className={`px-4 py-3 font-mono ${
                            tier === 'Admin'
                              ? 'text-amber-400'
                              : tier === 'Manager'
                                ? 'text-sky-400'
                                : 'text-emerald-400'
                          }`}
                        >
                          {tier}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-200 tabular-nums">
                          {doc.chunkCount}
                        </td>
                        <td className="px-4 py-3 text-emerald-400">
                          {doc.status}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-400 tabular-nums">
                          {new Date(doc.createdAt).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </td>
                        <td
                          className="px-4 py-3 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            disabled={!canDelete}
                            title={
                              canDelete
                                ? 'Remove document'
                                : 'Only Admin role can delete indexed documents'
                            }
                            onClick={() => handleDeleteClick(doc.id)}
                            aria-label={`Delete ${doc.title}`}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove</span>
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-950/80">
                          <td colSpan={7} className="px-6 py-4 space-y-2">
                            <div className="flex items-center justify-between text-[11px] text-slate-400">
                              <span>
                                Source URI: {doc.sourceUrl || 'Internal Upload'} ·
                                Required Clearance: {tier}
                              </span>
                              <span>
                                {doc.chunkCount} semantic vector chunk(s) stored
                              </span>
                            </div>
                            <pre className="whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-900/90 p-3 font-mono text-xs text-slate-200">
                              {doc.contentPreview}
                              {doc.contentPreview.length >= 240 ? '...' : ''}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
