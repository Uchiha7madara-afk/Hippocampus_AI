import React, { useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Database,
  FileText,
  MessageSquare,
  Sliders,
  Terminal,
} from 'lucide-react';
import { AgentSettingItem, WorkspaceTab } from '../types/app.ts';

interface LandingViewProps {
  onEnterWorkspace: (initialTab?: WorkspaceTab) => void;
  settings: AgentSettingItem[];
  onToggleSetting: (key: string, enabled: boolean) => Promise<void>;
}

const HERO_IMAGE =
  '/src/assets/images/hero_knowledge_architecture_1794320768147.jpg';
const BENTO_WORKFLOW_IMAGE =
  '/src/assets/images/bento_slack_workflow_1794320770323.jpg';
const BENTO_VECTOR_IMAGE =
  '/src/assets/images/bento_vector_indexing_1794320768741.jpg';

const CASE_STUDIES = [
  {
    metric: '-68% Senior Engineer Interruptions in 30 Days',
    context: 'Measured across 140 engineers in #eng-onboarding & #platform-ops',
    quote:
      'Before Hippocampus, our staff engineers spent 6 hours a week pasting the same SSO, local Docker, and staging deploy links into Slack. Now new hires get verified, source-cited answers in 1.1 seconds.',
    author: 'Elena Rostova',
    role: 'VP of Platform Engineering, Meridian Cloud',
  },
  {
    metric: '1.4 Days Faster Time to First Merged PR',
    context: 'Down from 4.8 days median onboarding ramp time across 3 cohorts',
    quote:
      'Because Hippocampus chunks our actual Markdown runbooks and cites the exact document section in every Slack reply, junior engineers trust the answers and never get blocked waiting on time zones.',
    author: 'Marcus Vance',
    role: 'Head of Developer Experience, Kinetix Data',
  },
  {
    metric: '96.4% Citation Accuracy Across 12,400+ Queries',
    context: 'Zero hallucinated URLs with strict citation guardrails active',
    quote:
      'When documentation is missing, Hippocampus tells us directly instead of guessing. Our Query Telemetry log became our roadmap for which internal docs to write next.',
    author: 'Priya Nair',
    role: 'Principal Infrastructure Architect, Veloce Financial',
  },
];

const PRICING_PLANS = [
  {
    audience: 'For early-stage engineering teams',
    name: 'Starter',
    monthlyPrice: '$0',
    annualPrice: '$0',
    cadence: 'forever for up to 15 engineers',
    limits: [
      'Up to 50 indexed Markdown & TXT runbooks',
      '2,500 RAG vector queries per month',
      '1 Slack channel integration (#eng-onboarding)',
      '7-day query telemetry retention',
    ],
    cta: 'Start Free Workspace',
    featured: false,
  },
  {
    audience: 'For scaling product organizations',
    name: 'Growth Pro',
    monthlyPrice: '$79',
    annualPrice: '$64',
    cadence: 'per month · up to 150 engineers',
    limits: [
      'Unlimited indexed documents, URLs & Slack threads',
      '250,000 Gemini RAG queries per month (600 RPM)',
      'Unlimited Slack channels + proactive new-hire greetings',
      '90-day query telemetry & confidence analytics',
    ],
    cta: 'Launch Pro Console',
    featured: true,
  },
  {
    audience: 'For multi-workspace enterprises',
    name: 'Enterprise',
    monthlyPrice: '$290',
    annualPrice: '$240',
    cadence: 'per month · unlimited seats & SSO',
    limits: [
      'Dedicated PostgreSQL pgvector HNSW partition',
      'SAML 2.0 / Okta SSO & role-based access control',
      'Custom chunking overlap & strict citation SLAs',
      'Unlimited audit log retention & SOC 2 Type II report',
    ],
    cta: 'Open Enterprise Console',
    featured: false,
  },
];

const FAQS = [
  {
    q: 'How does Hippocampus prevent hallucinated answers?',
    a: 'Every query runs semantic cosine similarity against your indexed document chunks in PostgreSQL. The Gemini synthesis prompt enforces a strict citation guardrail: it answers exclusively from retrieved chunks and appends [Source: Document Title]. If similarity falls below threshold, it explicitly states that documentation is missing.',
  },
  {
    q: 'What document formats and sources can we index?',
    a: 'You can drag and drop Markdown (.md), Plain Text (.txt), HTML runbooks, or JSON API specs directly in the Knowledge Sources console, paste documentation URLs, or sync pinned resolutions from Slack channels.',
  },
  {
    q: 'How does the Slack Events API integration work?',
    a: 'Hippocampus exposes POST /api/slack/events with HMAC-SHA256 request signing verification (v0:timestamp:rawBody). It handles url_verification challenges automatically, replies in-thread to @Hippocampus mentions, and greets new members on member_joined_channel events.',
  },
  {
    q: 'Can we test the Slack bot before connecting our production workspace?',
    a: 'Yes. The built-in Slack Events Simulator and RAG Playground in the web console let you fire real @Hippocampus mentions and member_joined_channel payloads against your live PostgreSQL knowledge base.',
  },
];

export function LandingView({
  onEnterWorkspace,
  settings,
  onToggleSetting,
}: LandingViewProps) {
  const [workflowMode, setWorkflowMode] = useState<'solution' | 'problem'>(
    'solution'
  );
  const [billingCycle, setBillingCycle] = useState<'annual' | 'monthly'>(
    'annual'
  );
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [workflowImgFailed, setWorkflowImgFailed] = useState(false);
  const [vectorImgFailed, setVectorImgFailed] = useState(false);

  // Validated onboarding request form state
  const [workEmail, setWorkEmail] = useState('');
  const [teamSize, setTeamSize] = useState('25-100 engineers');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitted, setFormSubmitted] = useState(false);

  const handleLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = workEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setFormError('Please enter a valid work email address (e.g. alex@company.com).');
      return;
    }
    setFormError(null);
    setFormSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#090D16]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-8 px-6">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#top"
            className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            Hippocampus
          </a>

          {/* Zone 2: 4-5 concise single-line text links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
            <a
              href="#capabilities"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Capabilities
            </a>
            <a
              href="#architecture"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Architecture
            </a>
            <a
              href="#impact"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Impact
            </a>
            <a
              href="#pricing"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Pricing
            </a>
            <a
              href="#faq"
              className="hover:text-white hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              FAQ
            </a>
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              onClick={() => onEnterWorkspace('dashboard')}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Console
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section id="top" className="mx-auto max-w-7xl px-6 pt-14 pb-20">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-stretch">
          <div className="flex flex-col justify-between lg:col-span-6 space-y-6">
            <div className="space-y-5">
              <p className="text-xs font-medium text-slate-400">
                Enterprise Knowledge Agent · PostgreSQL Vector Search · Slack Events API
              </p>
              <h1
                className="font-display font-bold tracking-tight text-white"
                style={{
                  fontSize: 'clamp(2.25rem, 4vw, 3.5rem)',
                  lineHeight: 1.08,
                  textWrap: 'balance',
                }}
              >
                Turn scattered engineering runbooks into an instant Slack mentor.
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-slate-300">
                Hippocampus indexes your Markdown guides, architecture docs, and
                pinned Slack resolutions into PostgreSQL vector chunks—answering
                new-hire questions in threads with exact source attribution.
              </p>
            </div>

            <div className="space-y-6 pt-2">
              <div className="flex flex-wrap items-center gap-4">
                <button
                  onClick={() => onEnterWorkspace('dashboard')}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Open Knowledge Console
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  onClick={() => onEnterWorkspace('playground')}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/70 px-5 py-3 text-sm font-medium text-slate-200 transition-colors hover:border-slate-500 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Test RAG Playground
                </button>
              </div>

              <div className="border-t border-slate-800/80 pt-5 text-xs text-slate-400">
                <span>900-char sliding-window chunking</span>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <span>HMAC-SHA256 verified Slack webhooks</span>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <span>Strict citation guardrails</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-6 flex">
            <div className="relative w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 flex flex-col justify-between">
              {!heroImgFailed ? (
                <img
                  src={HERO_IMAGE}
                  alt="Hippocampus semantic vector indexing and knowledge graph architecture"
                  referrerPolicy="no-referrer"
                  onError={() => setHeroImgFailed(true)}
                  className="h-full w-full object-cover aspect-video lg:aspect-auto"
                />
              ) : (
                <div className="flex h-full min-h-[320px] flex-col items-center justify-center bg-slate-900 p-8 text-center">
                  <Database className="mb-3 h-10 w-10 text-emerald-400" />
                  <p className="font-display text-base font-semibold text-white">
                    PostgreSQL pgvector + Gemini RAG Engine
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Document Ingestion · Semantic Embedding · Cited Thread Resolution
                  </p>
                </div>
              )}
              <div className="bg-gradient-to-t from-black/90 via-black/60 to-transparent p-5">
                <p className="text-xs font-medium text-slate-200">
                  Live Architecture · Every query embeds via Gemini, matches top-K PostgreSQL chunks, and cites the verified source title.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Full-Width 4-Column Quantitative Strip Below Hero Split */}
        <div className="mt-12 grid grid-cols-1 gap-4 border-y border-slate-800/80 py-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-mono text-2xl font-semibold text-white tabular-nums">
              &lt; 1.2s
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Median Slack @mention thread response latency
            </p>
          </div>
          <div>
            <p className="font-mono text-2xl font-semibold text-white tabular-nums">
              900 / 140
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Character chunk window with overlap preservation
            </p>
          </div>
          <div>
            <p className="font-mono text-2xl font-semibold text-white tabular-nums">
              96.4%
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Mean mentor confidence across indexed runbooks
            </p>
          </div>
          <div>
            <p className="font-mono text-2xl font-semibold text-white tabular-nums">
              100%
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Answers linked to explicit source document titles
            </p>
          </div>
        </div>
      </section>

      {/* Capabilities & Asymmetric Bento Grid */}
      <section
        id="capabilities"
        className="mx-auto max-w-7xl px-6 py-16 border-b border-slate-800/80"
      >
        <div className="max-w-2xl space-y-3">
          <p className="text-xs font-medium text-emerald-400">
            Core Architecture & Capabilities
          </p>
          <h2
            className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white"
            style={{ textWrap: 'balance' }}
          >
            Engineered for high-signal technical onboarding without hallucinations.
          </h2>
          <p className="text-sm leading-relaxed text-slate-400">
            Every component from document ingestion to Slack HMAC verification is
            wired directly to PostgreSQL and Gemini.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Bento Card 1: col-span-2 */}
          <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-900/50 p-6 flex flex-col justify-between gap-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-12 items-center">
              <div className="md:col-span-7 space-y-3">
                <h3 className="font-display text-lg font-semibold text-white">
                  01. Sliding-Window Document Ingestion & Vector Indexing
                </h3>
                <p className="text-sm leading-relaxed text-slate-300">
                  Upload Markdown runbooks, plain-text guides, or internal URLs.
                  Hippocampus splits documents along natural paragraph boundaries
                  with a 140-character overlap so CLI commands and code blocks
                  never lose context.
                </p>
                <div className="pt-2 text-xs text-slate-400">
                  <span>Supports .md, .txt, .html, URLs & Slack</span>
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  <span>Automatic chunk embedding</span>
                </div>
                <div className="pt-2">
                  <button
                    onClick={() => onEnterWorkspace('sources')}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Manage Knowledge Sources
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="md:col-span-5 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                {!vectorImgFailed ? (
                  <img
                    src={BENTO_VECTOR_IMAGE}
                    alt="Optical precision representing vector chunking"
                    referrerPolicy="no-referrer"
                    onError={() => setVectorImgFailed(true)}
                    className="h-48 w-full object-cover"
                  />
                ) : (
                  <div className="flex h-48 items-center justify-center bg-slate-900 p-4 text-xs text-slate-400">
                    Vector Chunking Pipeline
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bento Card 2: col-span-1 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <h3 className="font-display text-lg font-semibold text-white">
                02. Sub-2s Slack Thread Mentorship
              </h3>
              <p className="text-sm leading-relaxed text-slate-300">
                When an engineer tags <code className="text-emerald-300">@Hippocampus</code> in Slack or joins <code className="text-emerald-300">#eng-onboarding</code>, the agent replies in-thread with step-by-step instructions and source citations.
              </p>
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
              {!workflowImgFailed ? (
                <img
                  src={BENTO_WORKFLOW_IMAGE}
                  alt="Software engineer working with documentation and Slack"
                  referrerPolicy="no-referrer"
                  onError={() => setWorkflowImgFailed(true)}
                  className="h-36 w-full object-cover"
                />
              ) : (
                <div className="flex h-36 items-center justify-center bg-slate-900 p-4 text-xs text-slate-400">
                  Slack Thread Responder
                </div>
              )}
            </div>
            <button
              onClick={() => onEnterWorkspace('slack')}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Launch Slack Event Simulator
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* Interactive Mechanism Section: Live Agent Guardrails & Workflow Comparison */}
      <section
        id="architecture"
        className="mx-auto max-w-7xl px-6 py-16 border-b border-slate-800/80"
      >
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
          {/* Left: Problem vs Solution Interactive Switcher */}
          <div className="lg:col-span-6 space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-medium text-emerald-400">
                03. Workflow Transformation
              </p>
              <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                Eliminate repetitive Slack shoulder-taps.
              </h2>
              <p className="text-sm text-slate-400">
                Compare how engineering teams handle onboarding questions before
                and after deploying Hippocampus.
              </p>
            </div>

            {/* Interactive Segmented Control */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1">
              <button
                type="button"
                onClick={() => setWorkflowMode('solution')}
                className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  workflowMode === 'solution'
                    ? 'bg-emerald-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                With Hippocampus RAG
              </button>
              <button
                type="button"
                onClick={() => setWorkflowMode('problem')}
                className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  workflowMode === 'problem'
                    ? 'bg-slate-800 text-white font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Legacy Manual Onboarding
              </button>
            </div>

            {workflowMode === 'solution' ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>#eng-onboarding · Slack Event Stream</span>
                  <span className="font-mono text-emerald-400 tabular-nums">
                    Resolved in 840ms
                  </span>
                </div>
                <div className="space-y-3 text-sm">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-3.5">
                    <p className="text-xs font-medium text-slate-400">
                      @alex.chen · 10:14 AM
                    </p>
                    <p className="mt-1 text-slate-200">
                      @Hippocampus How do I configure SAML SSO and what attributes are required?
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/90 p-4 space-y-2">
                    <p className="text-xs font-medium text-emerald-400">
                      Hippocampus Mentor · App · 10:14 AM
                    </p>
                    <p className="text-slate-200 text-xs leading-relaxed">
                      Open <strong>Workspace Settings &gt; Security &amp; Identity &gt; SSO Provider</strong>, configure the ACS URL (<code>https://auth.hippocampus.internal/saml/callback</code>), and map <code>email</code>, <code>firstName</code>, <code>lastName</code>, and <code>groups</code> before uploading your X.509 certificate.
                    </p>
                    <p className="text-[11px] text-slate-400 pt-1">
                      Source: Engineering Onboarding &amp; SSO Setup Guide · Confidence: 96%
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>#eng-onboarding · Manual Thread</span>
                  <span className="font-mono text-amber-400 tabular-nums">
                    4h 20m delay
                  </span>
                </div>
                <div className="space-y-3 text-sm">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-3.5">
                    <p className="text-xs font-medium text-slate-400">
                      @alex.chen · 10:14 AM
                    </p>
                    <p className="mt-1 text-slate-200">
                      Hey team, where is the latest doc on setting up local Postgres vector extensions and SAML SSO? The Notion link from 2024 is broken.
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
                    <p className="text-xs font-medium text-slate-400">
                      @staff.engineer · 2:34 PM
                    </p>
                    <p className="mt-1 text-xs text-slate-300">
                      Sorry, was in incident review. Check the pinned message in #platform-ops or DM Sarah—she updated the script last sprint.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right: Live Database-Backed Agent Capability Toggles */}
          <div className="lg:col-span-6 space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-medium text-emerald-400">
                04. Live Agent Guardrail Controls
              </p>
              <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                Configure Hippocampus behavior in real time.
              </h2>
              <p className="text-sm text-slate-400">
                These toggles persist directly to your PostgreSQL database and
                govern how the agent processes Slack events and RAG queries.
              </p>
            </div>

            <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/50">
              {settings.map((item) => (
                <div
                  key={item.key}
                  className="flex items-start justify-between gap-4 p-4"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-white">
                      {item.label}
                    </p>
                    <p className="text-xs leading-relaxed text-slate-400">
                      {item.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={item.enabled}
                    onClick={() => onToggleSetting(item.key, !item.enabled)}
                    className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      item.enabled ? 'bg-emerald-500' : 'bg-slate-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        item.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Proof of Impact Section (Claim-to-Proof Adjacency) */}
      <section
        id="impact"
        className="mx-auto max-w-7xl px-6 py-16 border-b border-slate-800/80"
      >
        <div className="max-w-2xl space-y-2">
          <p className="text-xs font-medium text-emerald-400">
            Verified Engineering Outcomes
          </p>
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Measured across production engineering workspaces.
          </h2>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {CASE_STUDIES.map((study) => (
            <div
              key={study.author}
              className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-5"
            >
              <div className="space-y-3">
                <p className="font-display text-lg font-bold text-white">
                  {study.metric}
                </p>
                <p className="text-xs text-emerald-400">{study.context}</p>
                <p className="text-sm leading-relaxed text-slate-300">
                  &ldquo;{study.quote}&rdquo;
                </p>
              </div>
              <div className="border-t border-slate-800/80 pt-4 text-xs">
                <p className="font-semibold text-white">{study.author}</p>
                <p className="text-slate-400">{study.role}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Section */}
      <section
        id="pricing"
        className="mx-auto max-w-7xl px-6 py-16 border-b border-slate-800/80"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-medium text-emerald-400">
              Predictable Workspace Pricing
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Scale your onboarding knowledge base with zero per-query surprises.
            </h2>
          </div>

          <div className="inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1 self-start">
            <button
              type="button"
              onClick={() => setBillingCycle('annual')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                billingCycle === 'annual'
                  ? 'bg-emerald-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Annual Billing (Save 20%)
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                billingCycle === 'monthly'
                  ? 'bg-slate-800 text-white font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Monthly Billing
            </button>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`flex flex-col justify-between rounded-xl border p-6 ${
                plan.featured
                  ? 'border-emerald-500/60 bg-slate-900/80'
                  : 'border-slate-800 bg-slate-900/40'
              }`}
            >
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-slate-400">{plan.audience}</p>
                  <h3 className="mt-1 font-display text-xl font-bold text-white">
                    {plan.name}
                  </h3>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-bold text-white tabular-nums">
                    {billingCycle === 'annual'
                      ? plan.annualPrice
                      : plan.monthlyPrice}
                  </span>
                  <span className="text-xs text-slate-400">{plan.cadence}</span>
                </div>
                <ul className="space-y-2.5 pt-2">
                  {plan.limits.map((lim) => (
                    <li
                      key={lim}
                      className="flex items-start gap-2.5 text-xs text-slate-300"
                    >
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      <span>{lim}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <button
                type="button"
                onClick={() => onEnterWorkspace('dashboard')}
                className={`mt-6 w-full rounded-lg px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  plan.featured
                    ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                    : 'border border-slate-700 bg-slate-900 text-white hover:border-slate-500'
                }`}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ & Validated Lead Capture */}
      <section id="faq" className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7 space-y-4">
            <p className="text-xs font-medium text-emerald-400">
              Technical Questions
            </p>
            <h2 className="font-display text-2xl font-bold tracking-tight text-white">
              Frequently Asked Questions
            </h2>
            <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
              {FAQS.map((item, idx) => {
                const isOpen = openFaqIndex === idx;
                return (
                  <div key={item.q}>
                    <button
                      type="button"
                      onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left cursor-pointer"
                    >
                      <span className="text-sm font-medium text-white">
                        {item.q}
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-4 text-xs leading-relaxed text-slate-300">
                        {item.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-4">
              <h3 className="font-display text-lg font-bold text-white">
                Request Custom Slack &amp; SSO Deployment Guide
              </h3>
              <p className="text-xs leading-relaxed text-slate-400">
                Need a dedicated pgvector architecture review or immediate access
                to the console? Enter your work email or jump straight into the
                live workspace.
              </p>

              {formSubmitted ? (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-2">
                  <p className="text-xs font-semibold text-emerald-300">
                    Deployment Architecture Pack Scheduled
                  </p>
                  <p className="text-xs text-slate-300">
                    We recorded the onboarding request for <strong>{workEmail}</strong> ({teamSize}). You can also explore the live console right now.
                  </p>
                  <button
                    type="button"
                    onClick={() => onEnterWorkspace('dashboard')}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 cursor-pointer"
                  >
                    Enter Live Console
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <form onSubmit={handleLeadSubmit} className="space-y-3" noValidate>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Work Email
                    </label>
                    <input
                      type="email"
                      value={workEmail}
                      onChange={(e) => setWorkEmail(e.target.value)}
                      placeholder="alex@company.com"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Engineering Organization Size
                    </label>
                    <select
                      value={teamSize}
                      onChange={(e) => setTeamSize(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                    >
                      <option value="1-25 engineers">1–25 engineers</option>
                      <option value="25-100 engineers">25–100 engineers</option>
                      <option value="100-500 engineers">100–500 engineers</option>
                      <option value="500+ engineers">500+ engineers</option>
                    </select>
                  </div>
                  {formError && (
                    <p className="text-xs text-red-400">{formError}</p>
                  )}
                  <button
                    type="submit"
                    className="w-full rounded-lg bg-white px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Send Deployment Guide
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 sm:flex-row text-xs text-slate-400">
          <div className="flex items-center gap-3">
            <span className="font-display font-bold text-white">Hippocampus</span>
            <span aria-hidden="true">·</span>
            <span>Enterprise Onboarding Mentor &amp; RAG Knowledge Agent</span>
          </div>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => onEnterWorkspace('dashboard')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => onEnterWorkspace('sources')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Knowledge Sources
            </button>
            <button
              type="button"
              onClick={() => onEnterWorkspace('playground')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              RAG Playground
            </button>
            <button
              type="button"
              onClick={() => onEnterWorkspace('logs')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Query Telemetry
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
