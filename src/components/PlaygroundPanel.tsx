import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  BookOpen,
  Bot,
  ChevronDown,
  RotateCcw,
  Send,
  User,
} from 'lucide-react';
import { RetrievedChunkPreview } from '../types/app.ts';

interface PlaygroundMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  confidence?: number;
  latencyMs?: number;
  chunks?: RetrievedChunkPreview[];
  timestamp: string;
}

interface PlaygroundPanelProps {
  onSendQuery: (query: string) => Promise<{
    answer: string;
    sources: string[];
    confidence: number;
    latencyMs: number;
    chunks: RetrievedChunkPreview[];
  }>;
}

const STARTER_PROMPTS = [
  'How do I configure SSO for my team and map SAML attributes?',
  'What is the API rate limit for the Pro plan and how do I roll an API key?',
  'How do I set up my local dev environment on Mac with pgvector?',
  'How do we configure Slack Events API webhooks and HMAC verification?',
  'What is our deployment process for staging and how do we roll back?',
];

export function PlaygroundPanel({ onSendQuery }: PlaygroundPanelProps) {
  const [messages, setMessages] = useState<PlaygroundMessage[]>([
    {
      id: 'initial-greeting',
      role: 'assistant',
      content:
        "Hello! I'm **Hippocampus**, your enterprise onboarding mentor. Ask me any question about your indexed engineering runbooks, SSO setup, API rate limits, local macOS environment, or deployment pipelines.",
      sources: ['Engineering Onboarding & SSO Setup Guide'],
      confidence: 99,
      latencyMs: 110,
      chunks: [],
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openChunksId, setOpenChunksId] = useState<string | null>(null);
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
      const res = await onSendQuery(trimmed);
      const assistantMsg: PlaygroundMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: res.answer,
        sources: res.sources,
        confidence: res.confidence,
        latencyMs: res.latencyMs,
        chunks: res.chunks,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
      setMessages((prev) => [...prev, assistantMsg]);
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Main Chat Viewport */}
      <div className="lg:col-span-8 flex h-[calc(100vh-11rem)] min-h-[540px] flex-col rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div>
            <h2 className="font-display text-sm font-semibold text-white">
              Interactive RAG Knowledge Playground
            </h2>
            <p className="text-xs text-slate-400">
              Queries run cosine similarity over PostgreSQL chunks and synthesize with Gemini
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMessages(messages.slice(0, 1))}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Session
          </button>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-5 space-y-5"
        >
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            const showChunks = openChunksId === msg.id;
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

                <div className="max-w-[82%] space-y-2">
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

                  {/* Unboxed Metadata & Citation Trail */}
                  {!isUser && (
                    <div className="space-y-2 pl-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
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
                        {typeof msg.confidence === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums text-emerald-400">
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
                                Inspect {msg.chunks.length} retrieved chunks
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

                      {showChunks && msg.chunks && (
                        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2.5">
                          <p className="text-[11px] font-semibold text-slate-300">
                            Top Semantic Chunks Matched from PostgreSQL:
                          </p>
                          {msg.chunks.map((c, idx) => (
                            <div
                              key={`${c.documentTitle}-${idx}`}
                              className="border-t border-slate-800/80 pt-2 first:border-t-0 first:pt-0 text-[11px]"
                            >
                              <div className="flex items-center justify-between text-slate-400">
                                <span className="font-medium text-white">
                                  {idx + 1}. {c.documentTitle}
                                </span>
                                <span className="font-mono text-emerald-400 tabular-nums">
                                  {c.similarity}% similarity
                                </span>
                              </div>
                              <p className="mt-1 font-mono text-slate-400 line-clamp-2">
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
                Embedding query, retrieving top-K vector chunks, and synthesizing answer...
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
              placeholder="Ask Hippocampus anything about your indexed engineering docs..."
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

      {/* Right Column: Starter Prompts & Pipeline Architecture Notes */}
      <div className="lg:col-span-4 space-y-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            Starter Engineering Inquiries
          </h3>
          <p className="text-xs text-slate-400">
            Click any question below to test retrieval accuracy and source
            attribution against your indexed runbooks.
          </p>
          <div className="space-y-2 pt-1">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={loading}
                onClick={() => submitQuestion(prompt)}
                className="w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3.5 py-2.5 text-left text-xs text-slate-300 transition-colors hover:border-emerald-500/50 hover:text-white disabled:opacity-50 cursor-pointer"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            Active RAG Pipeline Steps
          </h3>
          <ol className="space-y-2.5 text-xs text-slate-300">
            <li>
              <strong className="text-white">01. Query Embedding:</strong> Converts your question into a dense vector using <code>gemini-embedding-2</code>.
            </li>
            <li>
              <strong className="text-white">02. Top-K Similarity Match:</strong> Scores all document chunks in PostgreSQL via cosine similarity + lexical technical term boost.
            </li>
            <li>
              <strong className="text-white">03. Grounded Synthesis:</strong> Passes the top 4 chunks to <code>gemini-3.8-flash</code> with strict source-citation enforcement.
            </li>
            <li>
              <strong className="text-white">04. Telemetry Logging:</strong> Records latency, cited sources, and confidence into <code>query_logs</code>.
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
