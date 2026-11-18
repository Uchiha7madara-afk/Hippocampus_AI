import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from './index.ts';
import {
  agentSettings,
  AgentToolInvocation,
  connectorSyncLogs,
  documentChunks,
  documents,
  OnboardingPhase,
  onboardingTracks,
  queryLogs,
  RbacRole,
  semanticCache,
  userProgress,
  users,
} from './schema.ts';
import {
  computeDeterministicEmbedding,
  cosineSimilarity,
  generateEmbedding,
  RetrievedChunk,
} from '../lib/ai.ts';
import { emitStructuredLog, recordCacheEvent } from '../lib/logger.ts';
import { getAllowedTiersForRole, normalizeRbacRole } from '../lib/env.ts';
import type {
  ConnectorSyncLogItem,
  DocumentSourceType,
  EngineerCohortSummary,
  HybridSearchMode,
  OnboardingPayload,
  OnboardingTrackItem,
  UserMilestoneProgress,
} from '../types/app.ts';

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 140;
const SEMANTIC_CACHE_THRESHOLD = 0.94;

interface MemoryCacheItem {
  id: number;
  queryText: string;
  queryEmbedding: number[];
  answer: string;
  sources: string[];
  confidence: number;
  toolCalls: AgentToolInvocation[];
  hitCount: number;
}

const memorySemanticCache = new Map<string, MemoryCacheItem>();

export function splitIntoChunks(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length <= size) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = start + size;
    if (end >= cleaned.length) {
      chunks.push(cleaned.slice(start).trim());
      break;
    }

    const breakPoint = cleaned.lastIndexOf('\n', end);
    if (breakPoint > start + size * 0.5) {
      end = breakPoint;
    }

    chunks.push(cleaned.slice(start, end).trim());
    start = end - overlap;
    if (start < 0) start = 0;
  }

  return chunks.filter(Boolean);
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName?: string | null,
  role?: RbacRole
) {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName: displayName || email.split('@')[0],
        role: role || 'Admin',
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          displayName: displayName || email.split('@')[0],
          ...(role ? { role } : {}),
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    emitStructuredLog({
      level: 'error',
      component: 'db',
      event: 'db.user_upsert_failed',
      message: 'Database user upsert failed',
    });
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

export async function updateUserRole(uid: string, role: RbacRole) {
  try {
    const [updated] = await db
      .update(users)
      .set({ role })
      .where(eq(users.uid, uid))
      .returning();
    return updated;
  } catch (error) {
    throw new Error('Failed to update user RBAC role.', { cause: error });
  }
}

const INITIAL_DOCS: {
  title: string;
  sourceType: 'file' | 'url' | 'slack';
  sourceUrl: string;
  accessLevel: RbacRole;
  content: string;
}[] = [
  {
    title: 'Engineering Onboarding & SSO Setup Guide',
    sourceType: 'file',
    sourceUrl: 'docs://onboarding/sso-setup.md',
    accessLevel: 'Engineer',
    content: `# Engineering Onboarding & SSO Configuration
To configure SAML 2.0 / OIDC Single Sign-On (SSO) for your engineering team workspace:
1. Navigate to **Workspace Settings > Security & Identity > SSO Provider**.
2. Select your identity provider (Okta, Google Workspace SAML, or Azure Entra ID).
3. Copy the **ACS URL** (\`https://auth.hippocampus.internal/saml/callback\`) and **Entity ID** (\`urn:hippocampus:enterprise:sp\`) into your IdP console.
4. Map attributes: \`email\`, \`firstName\`, \`lastName\`, and \`groups\` (used for automatic RBAC role assignment).
5. Upload the IdP X.509 metadata certificate and run **Test SAML Assertion** before toggling **Enforce SSO for All Members**.

## Troubleshooting SAML Error Codes
- **ERR_SAML_SIGNATURE_SKEW**: Triggered when IdP and SP clocks drift by more than 120 seconds (tracked in Jira \`ENG-1042\` and resolved in \`PR #502\`).
- **ERR_SAML_GROUP_MAPPING_EMPTY**: Ensure Okta group attribute statement is named \`groups\` in lowercase.`,
  },
  {
    title: 'API Reference v2 — Rate Limits & Quotas',
    sourceType: 'url',
    sourceUrl: 'https://docs.hippocampus.internal/api/rate-limits',
    accessLevel: 'Manager',
    content: `# API Rate Limits & Tier Quotas (v2)
All Hippocampus REST and Vector Ingestion endpoints enforce sliding-window rate limits per API key:

- **Starter Plan**: 60 requests / minute · 10,000 vector queries / month · Max 25 indexed documents.
- **Pro Plan**: 600 requests / minute (10 req/sec burst up to 30 req/sec) · 250,000 vector queries / month · Unlimited document chunks.
- **Enterprise Plan**: 3,000 requests / minute · Dedicated pgvector HNSW index partition · Custom SLA with 99.95% uptime guarantee.

## Rate Limit Headers & Key Reset
Responses include \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, and \`X-RateLimit-Reset\` (UTC epoch seconds).
To reset or rotate a compromised API key without downtime: go to **Developer Console > API Keys > Roll Key**, select a 24-hour grace window for the old token, and update \`HIPPOCAMPUS_API_KEY\` in your secret manager.`,
  },
  {
    title: 'Slack Events Webhook & Signing Runbook',
    sourceType: 'slack',
    sourceUrl: 'slack://#platform-architecture/pinned',
    accessLevel: 'Admin',
    content: `# Configuring Slack Events API & Webhooks
Hippocampus listens to Slack workspace events at \`POST /api/slack/events\`.

## Step-by-Step Setup
1. In the Slack App Management portal, open **Event Subscriptions** and toggle **Enable Events**.
2. Set the Request URL to \`https://<your-domain>/api/slack/events\`. Hippocampus automatically responds to the \`url_verification\` challenge payload.
3. Subscribe to bot events: \`app_mention\`, \`member_joined_channel\`, and \`message.channels\`.
4. Copy the **Signing Secret** from **Basic Information > App Credentials** into \`SLACK_SIGNING_SECRET\`.
5. Every incoming request is verified using HMAC-SHA256 (\`v0:timestamp:rawBody\`) with \`crypto.timingSafeEqual\` and a strict 5-minute replay window (see Jira \`SEC-309\`).`,
  },
  {
    title: 'Local Mac Dev Environment & Docker Compose Setup',
    sourceType: 'file',
    sourceUrl: 'docs://runbooks/local-mac-setup.md',
    accessLevel: 'Engineer',
    content: `# Local Development Environment on macOS (Apple Silicon)
Follow these steps on day one to boot the full Hippocampus stack locally on macOS:

\`\`\`bash
# 1. Install Homebrew dependencies
brew install node@22 pnpm postgresql@16 pgvector redis

# 2. Clone repository and bootstrap environment variables
git clone git@github.com:org/hippocampus.git
cp .env.example .env.local

# 3. Start PostgreSQL 16 with pgvector and push Drizzle schema
pnpm db:push
pnpm dev
\`\`\`

If Docker Desktop or OrbStack is preferred, run \`docker compose up -d postgres-vector\` which exposes PostgreSQL with \`vector\` extension preloaded on port \`5432\`.`,
  },
  {
    title: 'Staging & Production Deployment Pipeline',
    sourceType: 'url',
    sourceUrl: 'https://docs.hippocampus.internal/ops/deployments',
    accessLevel: 'Manager',
    content: `# Staging & Production Deployment Process
Our CI/CD pipeline runs on GitHub Actions and deploys containerized services to Cloud Run.

## Staging Deployments
Every pull request merged into \`main\` automatically builds the container image, runs Drizzle schema verification (\`tsc --noEmit\` + integration suite), and deploys to \`staging.hippocampus.internal\`.
Engineers can also trigger an on-demand preview environment from Slack by messaging \`/deploy staging <branch-name>\` in \`#eng-releases\`.

## Production Promotion & Rollback
Production promotions require two senior engineer approvals on the release tag (\`v*.*.*\`) and zero P0/P1 alerts in the last 60 minutes. Instant traffic rollback is available via \`gcloud run services update-traffic --to-revisions=PREVIOUS=100\`.`,
  },
  {
    title: 'Data Pipeline & Supported Vector Databases',
    sourceType: 'file',
    sourceUrl: 'docs://architecture/vector-pipeline.md',
    accessLevel: 'Engineer',
    content: `# Supported Databases & Hybrid Vector Indexing Pipeline
Hippocampus uses **PostgreSQL with pgvector** combined with **Okapi BM25 Lexical Scoring** and **Reciprocal Rank Fusion (RRF)** (tracked in \`OPS-881\` and \`PR #418\`).

## Supported Ingestion Sources & Formats
- **Direct Document Upload**: Markdown (\`.md\`), Plain Text (\`.txt\`), Technical Runbooks, and HTML documentation.
- **URL Knowledge Crawler**: Internal wiki pages, API specs, and architecture decision records (ADRs).
- **Slack Channel Sync**: Pinned thread resolutions from \`#eng-onboarding\`, \`#platform-ops\`, and \`#incidents\`.

Documents are split into 900-character semantic chunks with a 140-character sliding overlap, embedded via \`gemini-embedding-2\`, and queried using Hybrid RRF search.`,
  },
  {
    title: 'Billing, Enterprise Invoicing & Seat Management',
    sourceType: 'url',
    sourceUrl: 'https://docs.hippocampus.internal/billing/overview',
    accessLevel: 'Admin',
    content: `# Billing Documentation & Enterprise Seat Management
Billing documentation, downloadable VAT/GST invoices, and usage telemetry are located under **Organization Settings > Billing & Usage**.

- **Annual Enterprise Contracts**: Support ACH/Wire invoicing with Net-30 terms and custom security review packages (SOC 2 Type II + HIPAA BAA).
- **Seat Policy**: Only active human workspace members who query Hippocampus more than twice per month count toward billed seats; guest accounts and bot integrations are free.`,
  },
];

const INITIAL_ONBOARDING_TRACKS: {
  phase: OnboardingPhase;
  title: string;
  description: string;
  category: string;
  targetRole: RbacRole;
  linkedDocTitle: string;
  verificationPrompt: string;
  estimatedMinutes: number;
  sortOrder: number;
}[] = [
  {
    phase: 'Day 1',
    title: 'Configure Okta SAML 2.0 SSO & Verify Group Claims',
    description:
      'Set up your workspace SSO session, map your Okta engineering group attribute, and verify zero clock-skew errors (ERR_SAML_SIGNATURE_SKEW).',
    category: 'Identity & Access',
    targetRole: 'Engineer',
    linkedDocTitle: 'Engineering Onboarding & SSO Setup Guide',
    verificationPrompt:
      'Check Jira ticket ENG-1042 and explain how to fix ERR_SAML_SIGNATURE_SKEW during Okta SSO setup.',
    estimatedMinutes: 20,
    sortOrder: 1,
  },
  {
    phase: 'Day 1',
    title: 'Boot Local macOS Dev Stack with PostgreSQL 16 & pgvector',
    description:
      'Install Node 22, PostgreSQL 16, and the pgvector extension via Homebrew or OrbStack, then push the Drizzle ORM schema.',
    category: 'Local Stack',
    targetRole: 'Engineer',
    linkedDocTitle: 'Local Mac Dev Environment & Docker Compose Setup',
    verificationPrompt:
      'How do I set up my local dev environment on Mac with pgvector and push the Drizzle schema?',
    estimatedMinutes: 35,
    sortOrder: 2,
  },
  {
    phase: 'Day 1',
    title: 'Trigger Your First @Hippocampus Mention in #eng-onboarding',
    description:
      'Verify the Slack Events API webhook listener, thread responder, and retry-loop idempotency guard.',
    category: 'Collaboration',
    targetRole: 'Engineer',
    linkedDocTitle: 'Slack Events Webhook & Signing Runbook',
    verificationPrompt:
      'How do we configure Slack Events API webhooks and HMAC-SHA256 verification?',
    estimatedMinutes: 15,
    sortOrder: 3,
  },
  {
    phase: 'Week 1',
    title: 'Deep-Dive Hybrid RRF Search (pgvector + Okapi BM25)',
    description:
      'Inspect PR #418 to understand how Hippocampus fuses dense Gemini embeddings with BM25 lexical scoring ($k_1=1.5, b=0.75$).',
    category: 'Architecture',
    targetRole: 'Engineer',
    linkedDocTitle: 'Data Pipeline & Supported Vector Databases',
    verificationPrompt:
      'Inspect GitHub PR #418 and explain how our Hybrid RRF search combines pgvector and BM25.',
    estimatedMinutes: 40,
    sortOrder: 4,
  },
  {
    phase: 'Week 1',
    title: 'Review Sliding-Window API Rate Limits & Token Rotation',
    description:
      'Understand our 25 req/min sliding-window quota guard, X-RateLimit-* headers, and zero-downtime API key rolling.',
    category: 'Security & Quotas',
    targetRole: 'Manager',
    linkedDocTitle: 'API Reference v2 — Rate Limits & Quotas',
    verificationPrompt:
      'What is the API rate limit for the Pro plan and how do I roll a compromised API key with zero downtime?',
    estimatedMinutes: 25,
    sortOrder: 5,
  },
  {
    phase: 'Month 1',
    title: 'Execute Staging Canary Deployment & Traffic Rollback Drill',
    description:
      'Deploy a feature branch to staging via GitHub Actions and practice an instant Cloud Run traffic rollback.',
    category: 'Production Ops',
    targetRole: 'Manager',
    linkedDocTitle: 'Staging & Production Deployment Pipeline',
    verificationPrompt:
      'Check the service health of vector-pipeline and slack-events-gateway, and summarize our rollback steps.',
    estimatedMinutes: 45,
    sortOrder: 6,
  },
  {
    phase: 'Month 1',
    title: 'Complete SOC 2 Type II Security & Enterprise Seat Audit',
    description:
      'Review RBAC access tiers (Admin, Manager, Engineer), active seat policies, and enterprise compliance guardrails.',
    category: 'Governance',
    targetRole: 'Admin',
    linkedDocTitle: 'Billing, Enterprise Invoicing & Seat Management',
    verificationPrompt:
      'How does our enterprise seat billing policy work and where are SOC 2 Type II packages located?',
    estimatedMinutes: 30,
    sortOrder: 7,
  },
];

const INITIAL_COHORT_ENGINEERS: {
  userHandle: string;
  displayName: string;
  engineerRole: string;
  completedSortOrders: number[];
}[] = [
  {
    userHandle: '@alex.chen',
    displayName: 'Alex Chen',
    engineerRole: 'Staff Platform Engineer',
    completedSortOrders: [1, 2, 3, 4, 5],
  },
  {
    userHandle: '@priya.patel',
    displayName: 'Priya Patel',
    engineerRole: 'Senior AI Systems Engineer',
    completedSortOrders: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    userHandle: '@marcus.vance',
    displayName: 'Marcus Vance',
    engineerRole: 'Backend Product Engineer',
    completedSortOrders: [1, 2, 3],
  },
  {
    userHandle: '@sarah.kim',
    displayName: 'Sarah Kim',
    engineerRole: 'Infrastructure Engineer (New Hire)',
    completedSortOrders: [1],
  },
];

const INITIAL_LOGS = [
  {
    userHandle: '@alex.chen',
    channel: 'Slack #eng-onboarding',
    query: 'How do I configure SSO for my team and check ENG-1042?',
    answer:
      'Navigate to Workspace Settings > Security & Identity > SSO Provider, configure your SAML 2.0 ACS URL and Entity ID, and upload your X.509 certificate [Source: Engineering Onboarding & SSO Setup Guide]. Jira ticket ENG-1042 is currently In Progress under @elena.rostova [Tool: fetchJiraTicket].',
    sources: ['Engineering Onboarding & SSO Setup Guide'],
    sourcesCited: 1,
    confidence: 96,
    latencyMs: 840,
    resolved: true,
    cacheHit: false,
    promptTokens: 312,
    completionTokens: 148,
    totalTokens: 460,
    searchMode: 'hybrid_rrf',
    requiredRole: 'Engineer',
    toolCalls: [
      {
        toolName: 'fetchJiraTicket',
        args: { ticketKey: 'ENG-1042' },
        result: {
          ticketKey: 'ENG-1042',
          status: 'In Progress',
          assignee: 'Elena Rostova (@elena.rostova)',
        },
        durationMs: 14,
      },
    ],
  },
];

const INITIAL_SETTINGS = [
  {
    key: 'slack_auto_thread_reply',
    label: 'Real-Time Slack @Mention Responder',
    description:
      'Automatically reply in-thread when engineers tag @Hippocampus in public or private channels with cited documentation chunks.',
    enabled: true,
  },
  {
    key: 'proactive_member_onboarding',
    label: 'Proactive New-Hire Channel Greeting',
    description:
      'Listen to member_joined_channel events and send a tailored onboarding checklist and starter runbook links.',
    enabled: true,
  },
  {
    key: 'strict_citation_enforcement',
    label: 'Strict Source Attribution Guardrail',
    description:
      'Reject ungrounded speculation and require every synthesized answer to cite at least one indexed document chunk.',
    enabled: true,
  },
  {
    key: 'auto_rechunk_on_update',
    label: 'Sliding-Window Overlap Chunking (900c / 140c)',
    description:
      'Preserve code blocks and markdown headers across chunk boundaries during vector ingestion.',
    enabled: true,
  },
];

interface FallbackDocRow {
  id: number;
  userId: string | null;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  status: string;
  accessLevel: RbacRole;
  chunkCount: number;
  contentPreview: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface FallbackChunkRow {
  id: number;
  documentId: number;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

const fallbackStore = (() => {
  const docs: FallbackDocRow[] = [];
  const chunks: FallbackChunkRow[] = [];
  let nextDocId = 1;
  let nextChunkId = 1;

  for (const item of INITIAL_DOCS) {
    const segs = splitIntoChunks(item.content);
    const docId = nextDocId++;
    docs.push({
      id: docId,
      userId: null,
      title: item.title,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      status: 'Indexed',
      accessLevel: item.accessLevel,
      chunkCount: segs.length,
      contentPreview: item.content.slice(0, 240),
      metadata: { seeded: true },
      createdAt: new Date(),
    });
    segs.forEach((seg, idx) => {
      chunks.push({
        id: nextChunkId++,
        documentId: docId,
        chunkIndex: idx,
        content: seg,
        embedding: computeDeterministicEmbedding(`${item.title}\n${seg}`, 64),
        metadata: { title: item.title },
      });
    });
  }

  const logs = INITIAL_LOGS.map((l, idx) => ({
    id: idx + 1,
    userHandle: l.userHandle,
    channel: l.channel,
    query: l.query,
    answer: l.answer,
    sources: l.sources,
    sourcesCited: l.sourcesCited,
    confidence: l.confidence,
    latencyMs: l.latencyMs,
    resolved: l.resolved,
    cacheHit: l.cacheHit,
    promptTokens: l.promptTokens,
    completionTokens: l.completionTokens,
    totalTokens: l.totalTokens,
    searchMode: l.searchMode,
    requiredRole: l.requiredRole as RbacRole,
    toolCalls: l.toolCalls,
    createdAt: new Date(),
  }));

  const settings = INITIAL_SETTINGS.map((s, idx) => ({
    id: idx + 1,
    key: s.key,
    label: s.label,
    description: s.description,
    enabled: s.enabled,
    updatedAt: new Date(),
  }));

  const tracks = INITIAL_ONBOARDING_TRACKS.map((t, idx) => ({
    id: idx + 1,
    ...t,
    createdAt: new Date(),
  }));

  const progress: {
    id: number;
    userHandle: string;
    displayName: string;
    engineerRole: string;
    trackId: number;
    completed: boolean;
    completedAt: Date | null;
    assignedBy: string;
    notes: string | null;
    updatedAt: Date;
  }[] = [];
  let nextProgId = 1;
  for (const eng of INITIAL_COHORT_ENGINEERS) {
    for (const track of tracks) {
      const isDone = eng.completedSortOrders.includes(track.sortOrder);
      progress.push({
        id: nextProgId++,
        userHandle: eng.userHandle,
        displayName: eng.displayName,
        engineerRole: eng.engineerRole,
        trackId: track.id,
        completed: isDone,
        completedAt: isDone ? new Date() : null,
        assignedBy: '@elena.rostova',
        notes: isDone ? 'Verified during onboarding check-in' : null,
        updatedAt: new Date(),
      });
    }
  }

  const connectorLogs: ConnectorSyncLogItem[] = [
    {
      id: 1,
      provider: 'github',
      target: 'Uchiha7madara-afk/Hippocampus',
      branchOrFolder: 'refs/heads/main',
      triggerType: 'webhook_push',
      status: 'Synced',
      filesProcessed: 2,
      chunksUpserted: 5,
      commitSha: '9f4c2e1',
      details:
        'Push to refs/heads/main: chunked & embedded README.md and docs/RUNBOOK_PGVECTOR.md (900c/140c overlap)',
      createdAt: new Date().toISOString(),
    },
    {
      id: 2,
      provider: 'gdrive',
      target: 'Q4 Production Incident Postmortem & Runbook',
      branchOrFolder: 'Engineering Specs',
      triggerType: 'drive_import',
      status: 'Synced',
      filesProcessed: 1,
      chunksUpserted: 3,
      commitSha: null,
      details:
        'Converted Google Doc structural elements to clean Markdown and indexed 3 semantic vector chunks',
      createdAt: new Date().toISOString(),
    },
  ];

  return {
    docs,
    chunks,
    logs,
    settings,
    tracks,
    progress,
    connectorLogs,
    getNextDocId: () => nextDocId++,
    getNextChunkId: () => nextChunkId++,
    getNextProgId: () => nextProgId++,
  };
})();

let seedPromise: Promise<void> | null = null;

export async function ensureSeedData(): Promise<void> {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    try {
      const existingDocs = await db.select().from(documents).limit(1);
      if (existingDocs.length === 0) {
        for (const item of INITIAL_DOCS) {
          const chunks = splitIntoChunks(item.content);
          const [insertedDoc] = await db
            .insert(documents)
            .values({
              title: item.title,
              sourceType: item.sourceType,
              sourceUrl: item.sourceUrl,
              status: 'Indexed',
              accessLevel: item.accessLevel,
              chunkCount: chunks.length,
              contentPreview: item.content.slice(0, 240),
              metadata: { seeded: true },
            })
            .returning();

          if (insertedDoc) {
            const chunkRows = chunks.map((content, idx) => ({
              documentId: insertedDoc.id,
              chunkIndex: idx,
              content,
              embedding: computeDeterministicEmbedding(
                `${item.title}\n${content}`,
                64
              ),
              metadata: { title: item.title },
            }));
            await db.insert(documentChunks).values(chunkRows);
          }
        }
      }

      const existingLogs = await db.select().from(queryLogs).limit(1);
      if (existingLogs.length === 0) {
        await db.insert(queryLogs).values(INITIAL_LOGS);
      }

      const existingSettings = await db.select().from(agentSettings).limit(1);
      if (existingSettings.length === 0) {
        await db.insert(agentSettings).values(INITIAL_SETTINGS);
      }

      // Phase 4 Step 1: Seed onboarding_tracks and user_progress
      const existingTracks = await db.select().from(onboardingTracks).limit(1);
      if (existingTracks.length === 0) {
        const insertedTracks = await db
          .insert(onboardingTracks)
          .values(INITIAL_ONBOARDING_TRACKS)
          .returning();

        const progressRows: {
          userHandle: string;
          displayName: string;
          engineerRole: string;
          trackId: number;
          completed: boolean;
          completedAt: Date | null;
          assignedBy: string;
          notes: string | null;
        }[] = [];

        for (const eng of INITIAL_COHORT_ENGINEERS) {
          for (const track of insertedTracks) {
            const isDone = eng.completedSortOrders.includes(track.sortOrder);
            progressRows.push({
              userHandle: eng.userHandle,
              displayName: eng.displayName,
              engineerRole: eng.engineerRole,
              trackId: track.id,
              completed: isDone,
              completedAt: isDone ? new Date() : null,
              assignedBy: '@elena.rostova',
              notes: isDone ? 'Verified during onboarding check-in' : null,
            });
          }
        }

        if (progressRows.length > 0) {
          await db.insert(userProgress).values(progressRows);
        }
      }
    } catch {
      seedPromise = null;
    }
  })();

  return seedPromise;
}

export async function lookupSemanticCache(
  query: string,
  role: RbacRole = 'Admin',
  searchMode: HybridSearchMode = 'hybrid_rrf'
): Promise<{
  hit: boolean;
  answer?: string;
  sources?: string[];
  confidence?: number;
  toolCalls?: AgentToolInvocation[];
  similarity?: number;
}> {
  try {
    const scopedQuery = `[${role}:${searchMode}] ${query.trim().toLowerCase()}`;
    const queryLocalVec = computeDeterministicEmbedding(scopedQuery, 64);

    for (const item of memorySemanticCache.values()) {
      const sim =
        item.queryText.toLowerCase() === scopedQuery
          ? 1.0
          : cosineSimilarity(queryLocalVec, item.queryEmbedding);
      if (sim >= SEMANTIC_CACHE_THRESHOLD) {
        item.hitCount += 1;
        recordCacheEvent(true, sim, query);
        db.update(semanticCache)
          .set({
            hitCount: item.hitCount,
            lastHitAt: new Date(),
          })
          .where(eq(semanticCache.id, item.id))
          .catch(() => {});

        return {
          hit: true,
          answer: item.answer,
          sources: item.sources,
          confidence: item.confidence,
          toolCalls: item.toolCalls,
          similarity: sim,
        };
      }
    }

    const cachedRows = await db
      .select()
      .from(semanticCache)
      .orderBy(desc(semanticCache.lastHitAt))
      .limit(50);

    for (const row of cachedRows) {
      const storedVec = Array.isArray(row.queryEmbedding)
        ? row.queryEmbedding
        : [];
      const sim =
        row.queryText.trim().toLowerCase() === scopedQuery
          ? 1.0
          : cosineSimilarity(queryLocalVec, storedVec);

      if (sim >= SEMANTIC_CACHE_THRESHOLD) {
        const nextHits = (row.hitCount || 1) + 1;
        await db
          .update(semanticCache)
          .set({ hitCount: nextHits, lastHitAt: new Date() })
          .where(eq(semanticCache.id, row.id));

        memorySemanticCache.set(scopedQuery, {
          id: row.id,
          queryText: row.queryText,
          queryEmbedding: storedVec,
          answer: row.answer,
          sources: row.sources,
          confidence: row.confidence,
          toolCalls: row.toolCalls || [],
          hitCount: nextHits,
        });

        recordCacheEvent(true, sim, query);
        return {
          hit: true,
          answer: row.answer,
          sources: row.sources,
          confidence: row.confidence,
          toolCalls: row.toolCalls || [],
          similarity: sim,
        };
      }
    }

    recordCacheEvent(false, undefined, query);
    return { hit: false };
  } catch {
    return { hit: false };
  }
}

export async function storeInSemanticCache(params: {
  query: string;
  role?: RbacRole;
  searchMode?: HybridSearchMode;
  answer: string;
  sources: string[];
  confidence: number;
  toolCalls?: AgentToolInvocation[];
}) {
  try {
    if (params.sources.length === 0 && (params.toolCalls?.length ?? 0) === 0)
      return;
    const role = params.role || 'Admin';
    const mode = params.searchMode || 'hybrid_rrf';
    const scopedQuery = `[${role}:${mode}] ${params.query.trim()}`;
    const localVec = computeDeterministicEmbedding(
      scopedQuery.toLowerCase(),
      64
    );

    const [inserted] = await db
      .insert(semanticCache)
      .values({
        queryText: scopedQuery,
        queryEmbedding: localVec,
        answer: params.answer,
        sources: params.sources,
        confidence: params.confidence,
        toolCalls: params.toolCalls ?? [],
        hitCount: 1,
      })
      .returning();

    if (inserted) {
      memorySemanticCache.set(scopedQuery.toLowerCase(), {
        id: inserted.id,
        queryText: inserted.queryText,
        queryEmbedding: localVec,
        answer: inserted.answer,
        sources: inserted.sources,
        confidence: inserted.confidence,
        toolCalls: inserted.toolCalls || [],
        hitCount: 1,
      });
    }
  } catch {
    // Non-blocking cache write
  }
}

export async function purgeSemanticCache() {
  memorySemanticCache.clear();
  try {
    await db.delete(semanticCache);
  } catch {
    // Fallback to L1 memory cache clear
  }
  emitStructuredLog({
    level: 'info',
    component: 'cache',
    event: 'semantic_cache.purged',
    message: 'Semantic cache purged across L1 memory and L2 PostgreSQL',
  });
  return { purged: true };
}

export async function getSemanticCacheEntries() {
  try {
    return await db
      .select()
      .from(semanticCache)
      .orderBy(desc(semanticCache.lastHitAt))
      .limit(20);
  } catch {
    return Array.from(memorySemanticCache.values()).map((item) => ({
      id: item.id,
      queryText: item.queryText,
      queryEmbedding: item.queryEmbedding,
      answer: item.answer,
      sources: item.sources,
      confidence: item.confidence,
      toolCalls: item.toolCalls,
      hitCount: item.hitCount,
      lastHitAt: new Date(),
      createdAt: new Date(),
    }));
  }
}

export async function getDocumentsList(role: RbacRole = 'Admin') {
  const allowedTiers = getAllowedTiersForRole(role);
  try {
    await ensureSeedData();
    return await db
      .select()
      .from(documents)
      .where(inArray(documents.accessLevel, allowedTiers))
      .orderBy(desc(documents.createdAt));
  } catch {
    return fallbackStore.docs.filter((d) =>
      allowedTiers.includes(d.accessLevel)
    );
  }
}

export async function ingestDocument(params: {
  title: string;
  sourceType: DocumentSourceType;
  sourceUrl?: string | null;
  accessLevel?: RbacRole;
  content: string;
  userId?: string | null;
}) {
  const chunks = splitIntoChunks(params.content);
  if (chunks.length === 0) {
    throw new Error('Document content cannot be empty.');
  }
  const accessLevel = normalizeRbacRole(params.accessLevel || 'Engineer');

  try {
    await ensureSeedData();

    const [createdDoc] = await db
      .insert(documents)
      .values({
        userId: params.userId ?? null,
        title: params.title.trim(),
        sourceType: params.sourceType,
        sourceUrl: params.sourceUrl?.trim() || null,
        status: 'Indexed',
        accessLevel,
        chunkCount: chunks.length,
        contentPreview: params.content.trim().slice(0, 260),
        metadata: { charLength: params.content.length, accessLevel },
      })
      .returning();

    const chunkRecords = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await generateEmbedding(`${params.title}\n${chunkText}`);
      chunkRecords.push({
        documentId: createdDoc.id,
        chunkIndex: i,
        content: chunkText,
        embedding,
        metadata: { title: params.title, accessLevel },
      });
    }

    if (chunkRecords.length > 0) {
      await db.insert(documentChunks).values(chunkRecords);
    }

    await purgeSemanticCache();
    return createdDoc;
  } catch {
    const newDoc: FallbackDocRow = {
      id: fallbackStore.getNextDocId(),
      userId: params.userId ?? null,
      title: params.title.trim(),
      sourceType: params.sourceType,
      sourceUrl: params.sourceUrl?.trim() || null,
      status: 'Indexed',
      accessLevel,
      chunkCount: chunks.length,
      contentPreview: params.content.trim().slice(0, 260),
      metadata: { charLength: params.content.length, accessLevel },
      createdAt: new Date(),
    };
    fallbackStore.docs.unshift(newDoc);
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await generateEmbedding(`${params.title}\n${chunkText}`);
      fallbackStore.chunks.push({
        id: fallbackStore.getNextChunkId(),
        documentId: newDoc.id,
        chunkIndex: i,
        content: chunkText,
        embedding,
        metadata: { title: params.title, accessLevel },
      });
    }
    await purgeSemanticCache();
    return newDoc;
  }
}

export async function deleteDocumentById(id: number) {
  try {
    await db.delete(documents).where(eq(documents.id, id));
  } catch {
    const idx = fallbackStore.docs.findIndex((d) => d.id === id);
    if (idx >= 0) fallbackStore.docs.splice(idx, 1);
  }
  await purgeSemanticCache();
  return { deletedId: id };
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'how',
  'what',
  'where',
  'when',
  'why',
  'who',
  'can',
  'our',
  'are',
  'you',
  'from',
  'that',
  'this',
  'into',
]);

export function tokenizeForBm25(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface CandidateChunkInput {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  sourceType: string;
  accessLevel: string;
  content: string;
  embedding: number[];
}

export interface RankCandidateOptions {
  topK?: number;
  searchMode?: HybridSearchMode;
  role?: RbacRole;
  queryGeminiVec?: number[];
  queryLocalVec?: number[];
  rrfAlpha?: number;
  rrfK?: number;
  tauConf?: number;
  enforceConfidenceGate?: boolean;
}

/**
 * Phase 1 Modularized Retrieval & Ranking Engine
 * Supports 4 distinct experimental modes:
 * - "sparse_bm25" (or "bm25_lexical"): Pure Okapi BM25 lexical scoring (k1=1.5, b=0.75)
 * - "dense_vector" (or "vector_only"): Pure dense vector cosine similarity
 * - "linear_sum": Min-Max normalized linear combination (alpha=0.65)
 * - "hybrid_rrf": Weighted Reciprocal Rank Fusion RRF(q,c) = alpha/(60+rank_dense) + (1-alpha)/(60+rank_bm25) with alpha=0.65 + confidence abstention gate tau_conf
 */
export function rankCandidateChunks(
  query: string,
  rawCandidates: CandidateChunkInput[],
  options: RankCandidateOptions = {}
): (RetrievedChunk & { accessLevel: RbacRole; abstained?: boolean })[] {
  const {
    topK = 5,
    searchMode = 'hybrid_rrf',
    role = 'Admin',
    queryGeminiVec,
    queryLocalVec: providedLocalVec,
    rrfAlpha = 0.65,
    rrfK = 60,
    tauConf = 0.26,
    enforceConfidenceGate = false,
  } = options;

  // Step 1: Pre-Retrieval RBAC Candidate Filtering C_adm(r_u)
  const allowedTiers = new Set<RbacRole>(getAllowedTiersForRole(role));
  const admissibleChunks = rawCandidates.filter((row) =>
    allowedTiers.has(normalizeRbacRole(row.accessLevel))
  );

  if (admissibleChunks.length === 0) return [];

  const queryLocalVec =
    providedLocalVec || computeDeterministicEmbedding(query, 64);
  const effectiveGeminiVec = queryGeminiVec || queryLocalVec;
  const queryTokens = tokenizeForBm25(query);

  const N = admissibleChunks.length;
  const tokenizedDocs = admissibleChunks.map((row) =>
    tokenizeForBm25(`${row.documentTitle} ${row.content}`)
  );
  const totalLength = tokenizedDocs.reduce((acc, d) => acc + d.length, 0);
  const avgdl = Math.max(1, totalLength / N);

  const docFreq = new Map<string, number>();
  for (const qToken of new Set(queryTokens)) {
    let df = 0;
    for (const docTokens of tokenizedDocs) {
      if (docTokens.some((dt) => dt === qToken)) {
        df += 1;
      }
    }
    docFreq.set(qToken, df);
  }

  const k1 = 1.5;
  const b = 0.75;

  const rawScored = admissibleChunks.map((row, idx) => {
    const storedVec = Array.isArray(row.embedding) ? row.embedding : [];
    const refVec =
      storedVec.length === effectiveGeminiVec.length
        ? effectiveGeminiVec
        : queryLocalVec;

    const vectorScore = Math.max(
      0,
      Math.min(0.99, cosineSimilarity(refVec, storedVec))
    );

    const docTokens = tokenizedDocs[idx];
    const dl = docTokens.length;
    const matchedTerms: string[] = [];
    let rawBm25 = 0;
    let exactTechnicalMatches = 0;

    for (const qToken of new Set(queryTokens)) {
      const exactTf = docTokens.filter((dt) => dt === qToken).length;

      if (exactTf > 0) {
        matchedTerms.push(qToken);
        const df = docFreq.get(qToken) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const num = exactTf * (k1 + 1);
        const denom = exactTf + k1 * (1 - b + b * (dl / avgdl));
        rawBm25 += idf * (num / denom);

        if (/[-_0-9]/.test(qToken) || qToken.startsWith('err')) {
          rawBm25 += 2.2;
          exactTechnicalMatches += 1;
        }
      }
    }

    const bm25Score = Math.min(
      0.99,
      Number((rawBm25 / (rawBm25 + 2.2)).toFixed(4))
    );

    return {
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      sourceType: row.sourceType,
      accessLevel: normalizeRbacRole(row.accessLevel),
      content: row.content,
      vectorScore,
      rawBm25,
      bm25Score,
      exactTechnicalMatches,
      matchedTerms,
      vectorRank: N + 1,
      bm25Rank: N + 1,
    };
  });

  // Dense ranking (1..N)
  const byVector = [...rawScored].sort(
    (a, b) => b.vectorScore - a.vectorScore || a.chunkId - b.chunkId
  );
  byVector.forEach((item, rankIdx) => {
    item.vectorRank = rankIdx + 1;
  });

  // Sparse BM25 ranking (only rank items with rawBm25 > 0; zero-overlap items receive tail rank N + 1)
  const byBm25 = [...rawScored].sort(
    (a, b) => b.rawBm25 - a.rawBm25 || a.chunkId - b.chunkId
  );
  byBm25.forEach((item, rankIdx) => {
    item.bm25Rank = item.rawBm25 > 0 ? rankIdx + 1 : N + 1;
  });

  // Min-max bounds for linear_sum mode
  const denseValues = rawScored.map((r) => r.vectorScore);
  const bm25Values = rawScored.map((r) => r.bm25Score);
  const minDense = Math.min(...denseValues);
  const maxDense = Math.max(...denseValues);
  const minBm25 = Math.min(...bm25Values);
  const maxBm25 = Math.max(...bm25Values);

  const maxPossibleRrf = rrfAlpha / (rrfK + 1) + (1 - rrfAlpha) / (rrfK + 1);

  const fused = rawScored.map((item) => {
    // Weighted RRF: RRF(q, c) = alpha / (60 + rank_dense) + (1 - alpha) / (60 + rank_bm25)
    const rawRrf =
      rrfAlpha / (rrfK + item.vectorRank) +
      (1 - rrfAlpha) / (rrfK + item.bm25Rank);
    const normalizedRrf = Math.min(0.99, rawRrf / maxPossibleRrf);

    // Min-Max Normalized Linear Combination: S_lin = alpha * S_hat_dense + (1 - alpha) * S_hat_bm25
    const normDense =
      maxDense - minDense > 1e-6
        ? (item.vectorScore - minDense) / (maxDense - minDense)
        : item.vectorScore;
    const normBm25 =
      maxBm25 - minBm25 > 1e-6
        ? (item.bm25Score - minBm25) / (maxBm25 - minBm25)
        : item.bm25Score;
    const linearSumScore = Math.min(
      0.99,
      rrfAlpha * normDense + (1 - rrfAlpha) * normBm25
    );

    // Evidence-calibrated Hybrid RRF score
    const evidenceScore = 0.55 * item.vectorScore + 0.45 * item.bm25Score;
    const calibratedHybridScore = Math.min(
      0.99,
      normalizedRrf * 0.42 +
        evidenceScore * 0.58 +
        (item.exactTechnicalMatches > 0 ? 0.14 : 0)
    );

    let finalSimilarity = calibratedHybridScore;
    if (searchMode === 'dense_vector' || searchMode === 'vector_only') {
      finalSimilarity = item.vectorScore;
    } else if (searchMode === 'sparse_bm25' || searchMode === 'bm25_lexical') {
      finalSimilarity = item.bm25Score;
    } else if (searchMode === 'linear_sum') {
      finalSimilarity = linearSumScore;
    } else {
      finalSimilarity = calibratedHybridScore;
    }

    return {
      chunkId: item.chunkId,
      documentId: item.documentId,
      documentTitle: item.documentTitle,
      sourceType: item.sourceType,
      accessLevel: item.accessLevel,
      content: item.content,
      similarity: Number(finalSimilarity.toFixed(4)),
      vectorScore: Number(item.vectorScore.toFixed(4)),
      bm25Score: Number(item.bm25Score.toFixed(4)),
      rrfScore: Number(normalizedRrf.toFixed(4)),
      matchedTerms: item.matchedTerms,
    };
  });

  fused.sort((a, b) => b.similarity - a.similarity || a.chunkId - b.chunkId);

  // Step 4: Confidence Abstention Gate (tau_conf) for hybrid_rrf
  if (
    enforceConfidenceGate &&
    searchMode === 'hybrid_rrf' &&
    fused.length > 0
  ) {
    const topCandidate = fused[0];
    const topEvidence =
      0.55 * topCandidate.vectorScore + 0.45 * topCandidate.bm25Score;
    const hasExactTechnicalToken = topCandidate. matchedTerms.some(
      (t) => /[-_0-9]/.test(t) || t.startsWith('err')
    );
    if (
      topEvidence < tauConf ||
      (topCandidate.vectorScore < 0.48 &&
        !hasExactTechnicalToken &&
        topCandidate.bm25Score < 0.68)
    ) {
      return [];
    }
  }

  return fused.slice(0, topK);
}

export async function searchKnowledgeChunks(
  query: string,
  topK = 4,
  searchMode: HybridSearchMode = 'hybrid_rrf',
  role: RbacRole = 'Admin'
): Promise<(RetrievedChunk & { accessLevel: RbacRole })[]> {
  const allowedTiers = getAllowedTiersForRole(role);
  let allChunks: CandidateChunkInput[] = [];

  try {
    await ensureSeedData();
    const dbRows = await db
      .select({
        chunkId: documentChunks.id,
        documentId: documentChunks.documentId,
        content: documentChunks.content,
        embedding: documentChunks.embedding,
        documentTitle: documents.title,
        sourceType: documents.sourceType,
        accessLevel: documents.accessLevel,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(inArray(documents.accessLevel, allowedTiers));

    allChunks = dbRows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      content: r.content,
      embedding: Array.isArray(r.embedding) ? r.embedding : [],
      documentTitle: r.documentTitle,
      sourceType: r.sourceType,
      accessLevel: r.accessLevel,
    }));
  } catch {
    const docMap = new Map(fallbackStore.docs.map((d) => [d.id, d]));
    const mapped: CandidateChunkInput[] = [];
    for (const c of fallbackStore.chunks) {
      const d = docMap.get(c.documentId);
      if (d && allowedTiers.includes(d.accessLevel)) {
        mapped.push({
          chunkId: c.id,
          documentId: c.documentId,
          content: c.content,
          embedding: c.embedding,
          documentTitle: d.title,
          sourceType: d.sourceType,
          accessLevel: d.accessLevel,
        });
      }
    }
    allChunks = mapped;
  }

  if (allChunks.length === 0) return [];

  const queryGeminiVec = await generateEmbedding(query);
  const queryLocalVec = computeDeterministicEmbedding(query, 64);

  return rankCandidateChunks(query, allChunks, {
    topK,
    searchMode,
    role,
    queryGeminiVec,
    queryLocalVec,
    rrfAlpha: 0.65,
    rrfK: 60,
    tauConf: 0.26,
    enforceConfidenceGate: false,
  });
}

export async function recordQueryLog(entry: {
  userHandle?: string;
  channel?: string;
  query: string;
  answer: string;
  sources: string[];
  confidence: number;
  latencyMs: number;
  resolved?: boolean;
  cacheHit?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  searchMode?: string;
  requiredRole?: RbacRole;
  toolCalls?: AgentToolInvocation[];
}) {
  try {
    const [created] = await db
      .insert(queryLogs)
      .values({
        userHandle: entry.userHandle || '@workspace-admin',
        channel: entry.channel || 'Playground',
        query: entry.query,
        answer: entry.answer,
        sources: entry.sources,
        sourcesCited: entry.sources.length,
        confidence: entry.confidence,
        latencyMs: entry.latencyMs,
        resolved:
          entry.resolved ??
          (entry.sources.length > 0 || (entry.toolCalls?.length ?? 0) > 0),
        cacheHit: entry.cacheHit ?? false,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
        totalTokens: entry.totalTokens ?? 0,
        searchMode: entry.searchMode || 'hybrid_rrf',
        requiredRole: entry.requiredRole || 'Engineer',
        toolCalls: entry.toolCalls ?? [],
      })
      .returning();
    return created;
  } catch {
    const fallbackItem = {
      id: fallbackStore.logs.length + 1,
      userHandle: entry.userHandle || '@workspace-admin',
      channel: entry.channel || 'Playground',
      query: entry.query,
      answer: entry.answer,
      sources: entry.sources,
      sourcesCited: entry.sources.length,
      confidence: entry.confidence,
      latencyMs: entry.latencyMs,
      resolved:
        entry.resolved ??
        (entry.sources.length > 0 || (entry.toolCalls?.length ?? 0) > 0),
      cacheHit: entry.cacheHit ?? false,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      searchMode: entry.searchMode || 'hybrid_rrf',
      requiredRole: (entry.requiredRole || 'Engineer') as RbacRole,
      toolCalls: entry.toolCalls ?? [],
      createdAt: new Date(),
    };
    fallbackStore.logs.unshift(fallbackItem as never);
    return fallbackItem;
  }
}

export async function getRecentQueryLogs(role: RbacRole = 'Admin') {
  const allowedTiers = getAllowedTiersForRole(role);
  try {
    await ensureSeedData();
    return await db
      .select()
      .from(queryLogs)
      .where(inArray(queryLogs.requiredRole, allowedTiers))
      .orderBy(desc(queryLogs.createdAt))
      .limit(50);
  } catch {
    return fallbackStore.logs.filter((l) =>
      allowedTiers.includes(l.requiredRole)
    );
  }
}

export async function getAgentSettingsList() {
  try {
    await ensureSeedData();
    return await db.select().from(agentSettings).orderBy(agentSettings.id);
  } catch {
    return fallbackStore.settings;
  }
}

export async function updateAgentSettingByKey(key: string, enabled: boolean) {
  try {
    const [updated] = await db
      .update(agentSettings)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(agentSettings.key, key))
      .returning();
    return updated;
  } catch {
    const found = fallbackStore.settings.find((s) => s.key === key);
    if (found) {
      found.enabled = enabled;
      found.updatedAt = new Date();
    }
    return found;
  }
}

export async function getOverviewPayload(role: RbacRole = 'Admin') {
  const allowedTiers = getAllowedTiersForRole(role);
  try {
    await ensureSeedData();

    const [allDocs, allLogs, settings, cacheEntries] = await Promise.all([
      db
        .select()
        .from(documents)
        .where(inArray(documents.accessLevel, allowedTiers))
        .orderBy(desc(documents.createdAt)),
      db
        .select()
        .from(queryLogs)
        .where(inArray(queryLogs.requiredRole, allowedTiers))
        .orderBy(desc(queryLogs.createdAt))
        .limit(30),
      db.select().from(agentSettings).orderBy(agentSettings.id),
      db
        .select()
        .from(semanticCache)
        .orderBy(desc(semanticCache.lastHitAt))
        .limit(15),
    ]);

    const totalChunks = allDocs.reduce((acc, doc) => acc + doc.chunkCount, 0);

    const avgConfidence =
      allLogs.length > 0
        ? Number(
            (
              allLogs.reduce((acc, l) => acc + l.confidence, 0) / allLogs.length
            ).toFixed(1)
          )
        : 94.5;

    const avgLatencyMs =
      allLogs.length > 0
        ? Math.round(
            allLogs.reduce((acc, l) => acc + l.latencyMs, 0) / allLogs.length
          )
        : 820;

    return {
      stats: {
        totalDocuments: allDocs.length,
        totalChunks,
        totalQueries: allLogs.length,
        avgConfidence,
        avgLatencyMs,
        cachedQueriesCount: cacheEntries.length,
      },
      recentDocuments: allDocs.slice(0, 6),
      recentLogs: allLogs.slice(0, 8),
      settings,
      activeRole: role,
    };
  } catch {
    const allDocs = fallbackStore.docs.filter((d) =>
      allowedTiers.includes(d.accessLevel)
    );
    const allLogs = fallbackStore.logs.filter((l) =>
      allowedTiers.includes(l.requiredRole)
    );
    const totalChunks = allDocs.reduce((acc, doc) => acc + doc.chunkCount, 0);
    return {
      stats: {
        totalDocuments: allDocs.length,
        totalChunks,
        totalQueries: allLogs.length,
        avgConfidence: 96.0,
        avgLatencyMs: 840,
        cachedQueriesCount: memorySemanticCache.size,
      },
      recentDocuments: allDocs.slice(0, 6),
      recentLogs: allLogs.slice(0, 8),
      settings: fallbackStore.settings,
      activeRole: role,
    };
  }
}

/**
 * Phase 4 Step 1: Interactive Onboarding Checklists & Manager Cohort Queries
 */
export async function getOnboardingPayload(
  activeUserHandle = '@alex.chen',
  role: RbacRole = 'Admin'
): Promise<OnboardingPayload> {
  try {
    await ensureSeedData();

    const rawTracks = await db
      .select()
      .from(onboardingTracks)
      .orderBy(asc(onboardingTracks.sortOrder), asc(onboardingTracks.id));

    const tracks: OnboardingTrackItem[] = rawTracks.map((t) => ({
      id: t.id,
      phase: (t.phase as OnboardingPhase) || 'Day 1',
      title: t.title,
      description: t.description,
      category: t.category,
      targetRole: normalizeRbacRole(t.targetRole),
      linkedDocTitle: t.linkedDocTitle,
      verificationPrompt: t.verificationPrompt,
      estimatedMinutes: t.estimatedMinutes,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt.toISOString(),
    }));

    let allProgress = await db.select().from(userProgress);

    // Ensure the active userHandle exists in userProgress so signed-in users immediately have a track
    const hasActiveUser = allProgress.some(
      (p) => p.userHandle.toLowerCase() === activeUserHandle.toLowerCase()
    );
    if (!hasActiveUser && tracks.length > 0) {
      const displayName = activeUserHandle
        .replace(/^@/, '')
        .split(/[._-]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      const newRows = tracks.map((t, index) => ({
        userHandle: activeUserHandle,
        displayName: displayName || 'Workspace Engineer',
        engineerRole: 'Full-Stack Engineer',
        trackId: t.id,
        completed: index < 2,
        completedAt: index < 2 ? new Date() : null,
        assignedBy: '@elena.rostova',
        notes: null,
      }));
      await db.insert(userProgress).values(newRows);
      allProgress = await db.select().from(userProgress);
    }

    // Group progress by engineer handle
    const handleMap = new Map<
      string,
      {
        userHandle: string;
        displayName: string;
        engineerRole: string;
        lastUpdatedAt: string | null;
        progressByTrackId: Record<number, UserMilestoneProgress>;
      }
    >();

    for (const row of allProgress) {
      let entry = handleMap.get(row.userHandle);
      if (!entry) {
        entry = {
          userHandle: row.userHandle,
          displayName: row.displayName,
          engineerRole: row.engineerRole,
          lastUpdatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
          progressByTrackId: {},
        };
        handleMap.set(row.userHandle, entry);
      }

      if (
        row.updatedAt &&
        (!entry.lastUpdatedAt ||
          row.updatedAt.toISOString() > entry.lastUpdatedAt)
      ) {
        entry.lastUpdatedAt = row.updatedAt.toISOString();
      }

      entry.progressByTrackId[row.trackId] = {
        trackId: row.trackId,
        completed: row.completed,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        assignedBy: row.assignedBy,
        notes: row.notes,
      };
    }

    const day1Tracks = tracks.filter((t) => t.phase === 'Day 1');
    const week1Tracks = tracks.filter((t) => t.phase === 'Week 1');
    const month1Tracks = tracks.filter((t) => t.phase === 'Month 1');

    const fullCohort: EngineerCohortSummary[] = Array.from(
      handleMap.values()
    ).map((eng) => {
      const countCompleted = (subset: OnboardingTrackItem[]) =>
        subset.filter((t) => eng.progressByTrackId[t.id]?.completed).length;

      const completedCount = countCompleted(tracks);
      const totalCount = tracks.length;
      const completionRate =
        totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

      return {
        userHandle: eng.userHandle,
        displayName: eng.displayName,
        engineerRole: eng.engineerRole,
        completedCount,
        totalCount,
        completionRate,
        day1Completed: countCompleted(day1Tracks),
        day1Total: day1Tracks.length,
        week1Completed: countCompleted(week1Tracks),
        week1Total: week1Tracks.length,
        month1Completed: countCompleted(month1Tracks),
        month1Total: month1Tracks.length,
        lastUpdatedAt: eng.lastUpdatedAt,
        progressByTrackId: eng.progressByTrackId,
      };
    });

    // RBAC Filtering: Engineer only sees their own checklist; Manager/Admin sees full cohort
    const filteredCohort =
      role === 'Engineer'
        ? fullCohort.filter(
            (c) =>
              c.userHandle.toLowerCase() === activeUserHandle.toLowerCase()
          )
        : fullCohort;

    return {
      activeUserHandle,
      activeRole: role,
      tracks,
      cohort:
        filteredCohort.length > 0 ? filteredCohort : fullCohort.slice(0, 1),
    };
  } catch {
    const tracks: OnboardingTrackItem[] = fallbackStore.tracks.map((t) => ({
      id: t.id,
      phase: t.phase,
      title: t.title,
      description: t.description,
      category: t.category,
      targetRole: t.targetRole,
      linkedDocTitle: t.linkedDocTitle,
      verificationPrompt: t.verificationPrompt,
      estimatedMinutes: t.estimatedMinutes,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt.toISOString(),
    }));

    const day1Tracks = tracks.filter((t) => t.phase === 'Day 1');
    const week1Tracks = tracks.filter((t) => t.phase === 'Week 1');
    const month1Tracks = tracks.filter((t) => t.phase === 'Month 1');

    const fullCohort: EngineerCohortSummary[] = INITIAL_COHORT_ENGINEERS.map(
      (eng) => {
        const progressByTrackId: Record<number, UserMilestoneProgress> = {};
        for (const t of tracks) {
          const done = eng.completedSortOrders.includes(t.sortOrder);
          progressByTrackId[t.id] = {
            trackId: t.id,
            completed: done,
            completedAt: done ? new Date().toISOString() : null,
            assignedBy: '@elena.rostova',
            notes: null,
          };
        }
        const countCompleted = (subset: OnboardingTrackItem[]) =>
          subset.filter((t) => progressByTrackId[t.id]?.completed).length;
        const completedCount = countCompleted(tracks);
        return {
          userHandle: eng.userHandle,
          displayName: eng.displayName,
          engineerRole: eng.engineerRole,
          completedCount,
          totalCount: tracks.length,
          completionRate: Math.round((completedCount / tracks.length) * 100),
          day1Completed: countCompleted(day1Tracks),
          day1Total: day1Tracks.length,
          week1Completed: countCompleted(week1Tracks),
          week1Total: week1Tracks.length,
          month1Completed: countCompleted(month1Tracks),
          month1Total: month1Tracks.length,
          lastUpdatedAt: new Date().toISOString(),
          progressByTrackId,
        };
      }
    );

    return {
      activeUserHandle,
      activeRole: role,
      tracks,
      cohort:
        role === 'Engineer'
          ? fullCohort.filter(
              (c) =>
                c.userHandle.toLowerCase() === activeUserHandle.toLowerCase()
            )
          : fullCohort,
    };
  }
}

export async function toggleOnboardingMilestone(params: {
  userHandle: string;
  displayName?: string;
  engineerRole?: string;
  trackId: number;
  completed: boolean;
  assignedBy?: string;
  notes?: string | null;
}) {
  try {
    await ensureSeedData();
    const existing = await db
      .select()
      .from(userProgress)
      .where(
        and(
          eq(userProgress.userHandle, params.userHandle),
          eq(userProgress.trackId, params.trackId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db
        .update(userProgress)
        .set({
          completed: params.completed,
          completedAt: params.completed ? new Date() : null,
          notes:
            params.notes !== undefined ? params.notes : existing[0].notes,
          updatedAt: new Date(),
        })
        .where(eq(userProgress.id, existing[0].id))
        .returning();

      return updated;
    }

    const [inserted] = await db
      .insert(userProgress)
      .values({
        userHandle: params.userHandle,
        displayName: params.displayName || params.userHandle.replace(/^@/, ''),
        engineerRole: params.engineerRole || 'Software Engineer',
        trackId: params.trackId,
        completed: params.completed,
        completedAt: params.completed ? new Date() : null,
        assignedBy: params.assignedBy || '@elena.rostova',
        notes: params.notes ?? null,
      })
      .returning();

    return inserted;
  } catch {
    return {
      id: fallbackStore.getNextProgId(),
      userHandle: params.userHandle,
      displayName: params.displayName || params.userHandle.replace(/^@/, ''),
      engineerRole: params.engineerRole || 'Software Engineer',
      trackId: params.trackId,
      completed: params.completed,
      completedAt: params.completed ? new Date() : null,
      assignedBy: params.assignedBy || '@elena.rostova',
      notes: params.notes ?? null,
      updatedAt: new Date(),
    };
  }
}

export async function createOnboardingTrack(params: {
  phase: OnboardingPhase;
  title: string;
  description: string;
  category: string;
  targetRole: RbacRole;
  linkedDocTitle?: string | null;
  verificationPrompt?: string | null;
  estimatedMinutes: number;
}) {
  try {
    await ensureSeedData();
    const existingTracks = await db.select().from(onboardingTracks);
    const maxSort = existingTracks.reduce(
      (max, t) => Math.max(max, t.sortOrder),
      0
    );

    const [created] = await db
      .insert(onboardingTracks)
      .values({
        phase: params.phase,
        title: params.title.trim(),
        description: params.description.trim(),
        category: params.category.trim(),
        targetRole: params.targetRole,
        linkedDocTitle: params.linkedDocTitle?.trim() || null,
        verificationPrompt: params.verificationPrompt?.trim() || null,
        estimatedMinutes: params.estimatedMinutes,
        sortOrder: maxSort + 1,
      })
      .returning();

    return created;
  } catch {
    const created = {
      id: fallbackStore.tracks.length + 1,
      phase: params.phase,
      title: params.title.trim(),
      description: params.description.trim(),
      category: params.category.trim(),
      targetRole: params.targetRole,
      linkedDocTitle: params.linkedDocTitle?.trim() || '',
      verificationPrompt: params.verificationPrompt?.trim() || '',
      estimatedMinutes: params.estimatedMinutes,
      sortOrder: fallbackStore.tracks.length + 1,
      createdAt: new Date(),
    };
    fallbackStore.tracks.push(created);
    return created;
  }
}

export async function upsertConnectorDocument(params: {
  title: string;
  sourceType: 'github' | 'gdrive';
  sourceUrl: string;
  accessLevel?: RbacRole;
  content: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const chunks = splitIntoChunks(params.content, CHUNK_SIZE, CHUNK_OVERLAP);
  if (chunks.length === 0) {
    throw new Error('Connector document content cannot be empty.');
  }
  const accessLevel = normalizeRbacRole(params.accessLevel || 'Engineer');
  const cleanTitle = params.title.trim();
  const cleanUrl = params.sourceUrl.trim();

  try {
    await ensureSeedData();

    const existingDocs = await db
      .select()
      .from(documents)
      .where(eq(documents.sourceUrl, cleanUrl))
      .limit(1);

    let targetDocId: number;
    let action: 'inserted' | 'updated' = 'inserted';

    if (existingDocs.length > 0) {
      targetDocId = existingDocs[0].id;
      action = 'updated';
      await db
        .update(documents)
        .set({
          title: cleanTitle,
          sourceType: params.sourceType,
          accessLevel,
          status: 'Indexed',
          chunkCount: chunks.length,
          contentPreview: params.content.trim().slice(0, 260),
          metadata: {
            charLength: params.content.length,
            accessLevel,
            ...(params.metadata || {}),
          },
        })
        .where(eq(documents.id, targetDocId));

      await db
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, targetDocId));
    } else {
      const [createdDoc] = await db
        .insert(documents)
        .values({
          userId: params.userId ?? null,
          title: cleanTitle,
          sourceType: params.sourceType,
          sourceUrl: cleanUrl,
          status: 'Indexed',
          accessLevel,
          chunkCount: chunks.length,
          contentPreview: params.content.trim().slice(0, 260),
          metadata: {
            charLength: params.content.length,
            accessLevel,
            ...(params.metadata || {}),
          },
        })
        .returning();
      targetDocId = createdDoc.id;
    }

    const chunkRecords = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await generateEmbedding(`${cleanTitle}\n${chunkText}`);
      chunkRecords.push({
        documentId: targetDocId,
        chunkIndex: i,
        content: chunkText,
        embedding,
        metadata: {
          title: cleanTitle,
          accessLevel,
          sourceType: params.sourceType,
          sourceUrl: cleanUrl,
        },
      });
    }

    if (chunkRecords.length > 0) {
      await db.insert(documentChunks).values(chunkRecords);
    }

    await purgeSemanticCache();

    return {
      documentId: targetDocId,
      title: cleanTitle,
      chunksUpserted: chunkRecords.length,
      action,
    };
  } catch {
    const docId = fallbackStore.getNextDocId();
    fallbackStore.docs.unshift({
      id: docId,
      userId: params.userId ?? null,
      title: cleanTitle,
      sourceType: params.sourceType,
      sourceUrl: cleanUrl,
      status: 'Indexed',
      accessLevel,
      chunkCount: chunks.length,
      contentPreview: params.content.trim().slice(0, 260),
      metadata: params.metadata || {},
      createdAt: new Date(),
    });
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const embedding = await generateEmbedding(`${cleanTitle}\n${chunkText}`);
      fallbackStore.chunks.push({
        id: fallbackStore.getNextChunkId(),
        documentId: docId,
        chunkIndex: i,
        content: chunkText,
        embedding,
        metadata: { title: cleanTitle, accessLevel },
      });
    }
    await purgeSemanticCache();
    return {
      documentId: docId,
      title: cleanTitle,
      chunksUpserted: chunks.length,
      action: 'inserted' as const,
    };
  }
}

export async function recordConnectorSyncLog(params: {
  provider: 'github' | 'gdrive';
  target: string;
  branchOrFolder?: string;
  triggerType: 'oauth_sync' | 'webhook_push' | 'manual_sync' | 'drive_import';
  status: 'Synced' | 'Skipped' | 'Failed' | 'Completed';
  filesProcessed: number;
  chunksUpserted: number;
  commitSha?: string | null;
  details: string;
}) {
  try {
    const [inserted] = await db
      .insert(connectorSyncLogs)
      .values({
        provider: params.provider,
        target: params.target,
        branchOrFolder: params.branchOrFolder || 'main',
        triggerType: params.triggerType,
        status: params.status,
        filesProcessed: params.filesProcessed,
        chunksUpserted: params.chunksUpserted,
        commitSha: params.commitSha ?? null,
        details: params.details,
      })
      .returning();

    return inserted;
  } catch {
    const item: ConnectorSyncLogItem = {
      id: fallbackStore.connectorLogs.length + 1,
      provider: params.provider,
      target: params.target,
      branchOrFolder: params.branchOrFolder || 'main',
      triggerType: params.triggerType,
      status: params.status,
      filesProcessed: params.filesProcessed,
      chunksUpserted: params.chunksUpserted,
      commitSha: params.commitSha ?? null,
      details: params.details,
      createdAt: new Date().toISOString(),
    };
    fallbackStore.connectorLogs.unshift(item);
    return item;
  }
}

export async function getConnectorSyncLogs(): Promise<ConnectorSyncLogItem[]> {
  try {
    await ensureSeedData();
    let rows = await db
      .select()
      .from(connectorSyncLogs)
      .orderBy(desc(connectorSyncLogs.createdAt))
      .limit(30);

    if (rows.length === 0) {
      await db.insert(connectorSyncLogs).values([
        {
          provider: 'github',
          target: 'Uchiha7madara-afk/Hippocampus',
          branchOrFolder: 'refs/heads/main',
          triggerType: 'webhook_push',
          status: 'Synced',
          filesProcessed: 2,
          chunksUpserted: 5,
          commitSha: '9f4c2e1',
          details:
            'Push to refs/heads/main: chunked & embedded README.md and docs/RUNBOOK_PGVECTOR.md (900c/140c overlap)',
        },
        {
          provider: 'gdrive',
          target: 'Q4 Production Incident Postmortem & Runbook',
          branchOrFolder: 'Engineering Specs',
          triggerType: 'drive_import',
          status: 'Synced',
          filesProcessed: 1,
          chunksUpserted: 3,
          commitSha: null,
          details:
            'Converted Google Doc structural elements to clean Markdown and indexed 3 semantic vector chunks',
        },
      ]);
      rows = await db
        .select()
        .from(connectorSyncLogs)
        .orderBy(desc(connectorSyncLogs.createdAt))
        .limit(30);
    }

    return rows.map((r) => ({
      id: r.id,
      provider: (r.provider as 'github' | 'gdrive') || 'github',
      target: r.target,
      branchOrFolder: r.branchOrFolder,
      triggerType: r.triggerType,
      status: r.status,
      filesProcessed: r.filesProcessed,
      chunksUpserted: r.chunksUpserted,
      commitSha: r.commitSha,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return fallbackStore.connectorLogs;
  }
}

