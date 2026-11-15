import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  BookOpen,
  Bot,
  ChevronDown,
  RotateCcw,
  Send,
  User,
  Wrench,
} from 'lucide-react';
import {
  AgentToolInvocation,
  HybridSearchMode,
  RetrievedChunkPreview,
} from '../types/app.ts';

interface PlaygroundMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  confidence?: number;
  latencyMs?: number;
  cacheHit?: boolean;
  totalTokens?: number;
  searchMode?: HybridSearchMode;
  toolCalls?: AgentToolInvocation[];
  chunks?: RetrievedChunkPreview[];
  timestamp: string;
}

interface PlaygroundPanelProps {
  initialQuery?: string | null;
  onClearInitialQuery?: () => void;
  onSendQuery: (
    query: string,
    bypassCache?: boolean,
    searchMode?: HybridSearchMode
  ) => Promise<{
    answer: string;
    sources: string[];
    confidence: number;
    latencyMs: number;
    cacheHit?: boolean;
    totalTokens?: number;
    searchMode?: HybridSearchMode;
    toolCalls?: AgentToolInvocation[];
    chunks: RetrievedChunkPreview[];
  }>;
}

const STARTER_PROMPTS: { label: string; prompt: string; tag: string }[] = [
  {
    label: 'Hybrid BM25 + Vector + Jira Tool',
    prompt:
      'Check Jira ticket ENG-1042 and explain how to fix ERR_SAML_SIGNATURE_SKEW during Okta SSO setup.',
    tag: 'Jira + Exact Error Code',
  },
  {
    label: 'GitHub PR Inspection + Hybrid RRF',
    prompt:
      'Inspect GitHub PR #418 and explain how our Hybrid RRF search combines pgvector and BM25.',
    tag: 'GitHub PR #418',
  },
  {
    label: 'Live Service Health + Incident Runbook',
    prompt:
      'Check the service health of vector-pipeline and slack-events-gateway, and summarize our rollback steps.',
    tag: 'Service Telemetry',
  },
  {
    label: 'Page On-Call + Staging Rollback',
    prompt:
      'Ping the on-call engineer for payments-service about elevated p95 latency and list staging rollback commands.',
    tag: 'On-Call Dispatch',
  },
  {
    label: 'API Rate Limits & Key Rotation',
    prompt:
      'What is the API rate limit for the Pro plan and how do I roll a compromised API key with zero downtime?',
    tag: 'Runbook Retrieval',
  },
];

const SEARCH_MODES: {
  id: HybridSearchMode;
  label: string;
  shortDesc: string;
}[] = [
  {
    id: 'hybrid_rrf',
    label: 'Hybrid RRF (Vector + BM25)',
    shortDesc: 'Reciprocal Rank Fusion (k=60) + Error Code Boost',
  },
  {
    id: 'vector_only',
    label: 'Dense Vector Only',
    shortDesc: 'Pure cosine similarity (gemini-embedding-2-preview)',
  },
  {
    id: 'bm25_lexical',
    label: 'BM25 Lexical',
    shortDesc: 'Okapi BM25 (k1=1.5, b=0.75) exact token matching',
  },
];

export function PlaygroundPanel({
  initialQuery,
  onClearInitialQuery,
  onSendQuery,
}: PlaygroundPanelProps) {
  const [messages, setMessages] = useState<PlaygroundMessage[]>([
    {
      id: 'initial-greeting',
      role: 'assistant',
      content:
        "Hello! I'm **Hippocampus**, now upgraded with **Phase 2 Hybrid Search (pgvector + Okapi BM25 Reciprocal Rank Fusion)** and **Agentic Tool Calling**.\n\nAsk me about exact error codes (e.g. `ERR_SAML_SIGNATURE_SKEW`), internal runbooks, or ask me to inspect live **Jira tickets** (`ENG-1042`), **GitHub PRs** (`PR #418`), **service health**, or **page the on-call engineer**.",
      sources: ['Engineering Onboarding & SSO Setup Guide'],
      confidence: 99,
      latencyMs: 11,
      cacheHit: true,
      totalTokens: 0,
      searchMode: 'hybrid_rrf',
      toolCalls: [],
      chunks: [],
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  ]);
  const [input, setInput] = useState('');
  const [bypassCache, setBypassCache] = useState(false);
  const [searchMode, setSearchMode] = useState<HybridSearchMode>('hybrid_rrf');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openChunksId, setOpenChunksId] = useState<string | null>(null);
  const [openToolsId, setOpenToolsId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, loading]);

  const submitQuestion = async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed || loading) return;

    setError(null);
    const userMsg: PlaygroundMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await onSendQuery(trimmed, bypassCache, searchMode);
      const msgId = `assistant-${Date.now()}`;
      const assistantMsg: PlaygroundMessage = {
        id: msgId,
        role: 'assistant',
        content: res.answer,
        sources: res.sources,
        confidence: res.confidence,
        latencyMs: res.latencyMs,
        cacheHit: res.cacheHit,
        totalTokens: res.totalTokens,
        searchMode: res.searchMode || searchMode,
        toolCalls: res.toolCalls || [],
        chunks: res.chunks,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (res.toolCalls && res.toolCalls.length > 0) {
        setOpenToolsId(msgId);
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to retrieve RAG answer from knowledge base.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitQuestion(input);
  };

  useEffect(() => {
    if (initialQuery && initialQuery.trim()) {
      const q = initialQuery.trim();
      onClearInitialQuery?.();
      submitQuestion(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const formatSearchModeLabel = (mode?: HybridSearchMode) => {
    if (mode === 'vector_only') return 'Dense Vector';
    if (mode === 'bm25_lexical') return 'BM25 Lexical';
    return 'Hybrid RRF';
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Main Chat Viewport */}
      <div className="lg:col-span-8 flex h-[calc(100vh-10.5rem)] min-h-[580px] flex-col rounded-xl border border-slate-800 bg-slate-900/40">
        {/* Top Control Bar: Search Mode + Cache Bypass */}
        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-white">
                Hybrid RAG &amp; Agentic Function Calling Playground
              </h2>
              <p className="text-xs text-slate-400">
                pgvector + Okapi BM25 Reciprocal Rank Fusion · Gemini Structured Tool Calling
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bypassCache}
                  onChange={(e) => setBypassCache(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-0"
                />
                <span>Bypass Semantic Cache</span>
              </label>
              <button
                type="button"
                onClick={() => setMessages(messages.slice(0, 1))}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset Session
              </button>
            </div>
          </div>

          {/* Segmented Hybrid Retrieval Mode Selector */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[11px] font-medium text-slate-400">
              Retrieval Engine:
            </span>
            <div className="inline-flex flex-wrap rounded-lg border border-slate-800 bg-slate-950 p-1 gap-1">
              {SEARCH_MODES.map((m) => {
                const active = searchMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSearchMode(m.id)}
                    title={m.shortDesc}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Message Transcript */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-5 space-y-5"
        >
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            const showChunks = openChunksId === msg.id;
            const showTools = openToolsId === msg.id;
            const toolCount = msg.toolCalls?.length ?? 0;

            return (
              <div
                key={msg.id}
                className={`flex items-start gap-3.5 ${
                  isUser ? 'flex-row-reverse' : ''
                }`}
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                    isUser
                      ? 'border-slate-700 bg-slate-800 text-slate-200'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  }`}
                >
                  {isUser ? (
                    <User className="h-4 w-4" />
                  ) : (
                    <Bot className="h-4 w-4" />
                  )}
                </div>

                <div className="max-w-[84%] space-y-2">
                  <div
                    className={`rounded-xl px-4 py-3 text-xs leading-relaxed ${
                      isUser
                        ? 'bg-emerald-500 text-slate-950 font-medium'
                        : 'border border-slate-800 bg-slate-950/90 text-slate-200'
                    }`}
                  >
                    {isUser ? (
                      <p>{msg.content}</p>
                    ) : (
                      <div className="prose prose-invert prose-xs max-w-none space-y-2">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {/* Unboxed Metadata, Hybrid Retrieval Mode, Agentic Tools & Token Trail */}
                  {!isUser && (
                    <div className="space-y-2 pl-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        <span className="font-mono text-slate-300">
                          {formatSearchModeLabel(msg.searchMode)}
                        </span>
                        <span aria-hidden="true">·</span>
                        {msg.sources && msg.sources.length > 0 ? (
                          <>
                            <BookOpen className="h-3 w-3 text-emerald-400" />
                            <span className="text-slate-300 font-medium">
                              Sources: {msg.sources.join(' · ')}
                            </span>
                          </>
                        ) : (
                          <span>No matching sources cited</span>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-emerald-400">
                          {msg.cacheHit
                            ? 'Semantic Cache Hit (0 tokens)'
                            : `Gemini Synthesized (${msg.totalTokens ?? 0} tokens)`}
                        </span>
                        {typeof msg.confidence === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {msg.confidence}% confidence
                            </span>
                          </>
                        )}
                        {typeof msg.latencyMs === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {msg.latencyMs}ms
                            </span>
                          </>
                        )}
                        {toolCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() =>
                                setOpenToolsId(showTools ? null : msg.id)
                              }
                              className="inline-flex items-center gap-1 font-mono text-amber-300 hover:underline cursor-pointer"
                            >
                              <Wrench className="h-3 w-3" />
                              <span>
                                {toolCount} Agent Tool{toolCount > 1 ? 's' : ''}{' '}
                                Executed
                              </span>
                              <ChevronDown
                                className={`h-3 w-3 transition-transform ${
                                  showTools ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                          </>
                        )}
                        {msg.chunks && msg.chunks.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() =>
                                setOpenChunksId(showChunks ? null : msg.id)
                              }
                              className="inline-flex items-center gap-1 text-emerald-400 hover:underline cursor-pointer"
                            >
                              <span>
                                Inspect {msg.chunks.length} hybrid chunks
                              </span>
                              <ChevronDown
                                className={`h-3 w-3 transition-transform ${
                                  showChunks ? 'rotate-180' : ''
                                }`}
                              />
                            </button>
                          </>
                        )}
                      </div>

                      {/* Expandable Agentic Function Call Inspector */}
                      {showTools && msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="rounded-lg border border-amber-500/30 bg-slate-950 p-3 space-y-2.5">
                          <p className="text-[11px] font-semibold text-amber-300">
                            Gemini Structured Function Calls Executed:
                          </p>
                          {msg.toolCalls.map((tc, idx) => (
                            <div
                              key={`${tc.toolName}-${idx}`}
                              className="border-t border-slate-800/80 pt-2 first:border-t-0 first:pt-0 text-[11px] space-y-1"
                            >
                              <div className="flex items-center justify-between text-slate-300">
                                <span className="font-mono font-semibold text-white">
                                  {idx + 1}. {tc.toolName}(
                                  {JSON.stringify(tc.args)})
                                </span>
                                <span className="font-mono text-emerald-400 tabular-nums">
                                  EXECUTED · {tc.durationMs}ms
                                </span>
                              </div>
                              <pre className="mt-1 overflow-x-auto rounded bg-slate-900/90 p-2 font-mono text-[10px] text-slate-300">
                                {JSON.stringify(tc.result, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Expandable Hybrid Retrieval Breakdown Inspector */}
                      {showChunks && msg.chunks && (
                        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2.5">
                          <p className="text-[11px] font-semibold text-slate-300">
                            Hybrid Retrieval Scoring Breakdown ({formatSearchModeLabel(msg.searchMode)}):
                          </p>
                          {msg.chunks.map((c, idx) => (
                            <div
                              key={`${c.documentTitle}-${idx}`}
                              className="border-t border-slate-800/80 pt-2 first:border-t-0 first:pt-0 text-[11px] space-y-1"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                                <span className="font-medium text-white">
                                  {idx + 1}. {c.documentTitle}
                                </span>
                                <span className="font-mono text-emerald-400 tabular-nums">
                                  Hybrid: {c.similarity}% · Vec:{' '}
                                  {c.vectorScore ?? c.similarity}% · BM25:{' '}
                                  {c.bm25Score ?? 0}%
                                </span>
                              </div>
                              {c.matchedTerms && c.matchedTerms.length > 0 && (
                                <p className="font-mono text-[10px] text-slate-400">
                                  Matched lexical terms:{' '}
                                  <span className="text-slate-200">
                                    {c.matchedTerms.join(', ')}
                                  </span>
                                </p>
                              )}
                              <p className="font-mono text-slate-400 line-clamp-2">
                                {c.excerpt}...
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                <Bot className="h-4 w-4" />
              </div>
              <span>
                Running {formatSearchModeLabel(searchMode)} retrieval &amp; evaluating agentic tools...
              </span>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <form
          onSubmit={handleFormSubmit}
          className="border-t border-slate-800 p-4"
        >
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
              placeholder="Ask about error codes (ERR_SAML_SIGNATURE_SKEW), Jira tickets (ENG-1042), PR #418, or runbooks..."
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Send className="h-3.5 w-3.5" />
              Ask Mentor
            </button>
          </div>
        </form>
      </div>

      {/* Right Column: Starter Prompts & Phase 2 Architecture Notes */}
      <div className="lg:col-span-4 space-y-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            Hybrid RAG &amp; Agentic Tool Inquiries
          </h3>
          <p className="text-xs text-slate-400">
            Test exact error-code lexical matching (`BM25`) fused with `pgvector` embeddings and live Gemini function calling.
          </p>
          <div className="space-y-2 pt-1">
            {STARTER_PROMPTS.map((item) => (
              <button
                key={item.prompt}
                type="button"
                disabled={loading}
                onClick={() => submitQuestion(item.prompt)}
                className="w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-left text-xs text-slate-300 transition-colors hover:border-emerald-500/50 hover:text-white disabled:opacity-50 cursor-pointer space-y-1"
              >
                <div className="flex items-center justify-between text-[11px] text-emerald-400 font-mono">
                  <span>{item.label}</span>
                  <span>{item.tag}</span>
                </div>
                <p className="text-slate-200">{item.prompt}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            Phase 2 Advanced RAG Architecture
          </h3>
          <ol className="space-y-2.5 text-xs text-slate-300">
            <li>
              <strong className="text-white">01. Hybrid RRF Retrieval:</strong> Combines dense cosine similarity with Okapi BM25 ($k_1=1.5, b=0.75$) and exact identifier boosting (`ENG-1042`, `ERR_*`).
            </li>
            <li>
              <strong className="text-white">02. Structured Tool Calling:</strong> Equips `gemini-3.8-flash` with `fetchJiraTicket`, `inspectGithubPullRequest`, `checkServiceHealth`, and `pingOnCallEngineer`.
            </li>
            <li>
              <strong className="text-white">03. Mode-Aware Semantic Cache:</strong> Caches synthesized answers and tool invocations keyed by normalized embedding + retrieval mode.
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
