import { desc, eq } from 'drizzle-orm';
import { db } from './index.ts';
import {
  agentSettings,
  documentChunks,
  documents,
  queryLogs,
  users,
} from './schema.ts';
import {
  computeDeterministicEmbedding,
  cosineSimilarity,
  generateEmbedding,
  RetrievedChunk,
} from '../lib/ai.ts';

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 140;

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
  displayName?: string | null
) {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName: displayName || email.split('@')[0],
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          displayName: displayName || email.split('@')[0],
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database user upsert failed:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

const INITIAL_DOCS = [
  {
    title: 'Engineering Onboarding & SSO Setup Guide',
    sourceType: 'file',
    sourceUrl: 'docs://onboarding/sso-setup.md',
    content: `# Engineering Onboarding & SSO Configuration
To configure SAML 2.0 / OIDC Single Sign-On (SSO) for your engineering team workspace:
1. Navigate to **Workspace Settings > Security & Identity > SSO Provider**.
2. Select your identity provider (Okta, Google Workspace SAML, or Azure Entra ID).
3. Copy the **ACS URL** (\`https://auth.hippocampus.internal/saml/callback\`) and **Entity ID** (\`urn:hippocampus:enterprise:sp\`) into your IdP console.
4. Map attributes: \`email\`, \`firstName\`, \`lastName\`, and \`groups\` (used for automatic RBAC role assignment).
5. Upload the IdP X.509 metadata certificate and run **Test SAML Assertion** before toggling **Enforce SSO for All Members**.

## Inviting Team Members
Workspace Admins can invite new engineers via **Settings > Members > Invite by Email** or enable **Just-in-Time (JIT) Provisioning** for verified domain emails (\`@yourcompany.com\`).`,
  },
  {
    title: 'API Reference v2 — Rate Limits & Quotas',
    sourceType: 'url',
    sourceUrl: 'https://docs.hippocampus.internal/api/rate-limits',
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
    content: `# Configuring Slack Events API & Webhooks
Hippocampus listens to Slack workspace events at \`POST /api/slack/events\`.

## Step-by-Step Setup
1. In the Slack App Management portal, open **Event Subscriptions** and toggle **Enable Events**.
2. Set the Request URL to \`https://<your-domain>/api/slack/events\`. Hippocampus automatically responds to the \`url_verification\` challenge payload.
3. Subscribe to bot events: \`app_mention\`, \`member_joined_channel\`, and \`message.channels\`.
4. Copy the **Signing Secret** from **Basic Information > App Credentials** into \`SLACK_SIGNING_SECRET\`.
5. Every incoming request is verified using HMAC-SHA256 (\`v0:timestamp:rawBody\`) with \`crypto.timingSafeEqual\` and a strict 5-minute replay window.`,
  },
  {
    title: 'Local Mac Dev Environment & Docker Compose Setup',
    sourceType: 'file',
    sourceUrl: 'docs://runbooks/local-mac-setup.md',
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
    content: `# Supported Databases & Vector Indexing Pipeline
Hippocampus uses **PostgreSQL with pgvector** as its primary relational + vector store, managed via **Drizzle ORM** and connection pooling.

## Supported Ingestion Sources & Formats
- **Direct Document Upload**: Markdown (\`.md\`), Plain Text (\`.txt\`), Technical Runbooks, and HTML documentation.
- **URL Knowledge Crawler**: Internal wiki pages, API specs, and architecture decision records (ADRs).
- **Slack Channel Sync**: Pinned thread resolutions from \`#eng-onboarding\`, \`#platform-ops\`, and \`#incidents\`.

Documents are split into 900-character semantic chunks with a 140-character sliding overlap, embedded via \`gemini-embedding-2\`, and queried using cosine similarity with source attribution.`,
  },
  {
    title: 'Billing, Enterprise Invoicing & Seat Management',
    sourceType: 'url',
    sourceUrl: 'https://docs.hippocampus.internal/billing/overview',
    content: `# Billing Documentation & Enterprise Seat Management
Billing documentation, downloadable VAT/GST invoices, and usage telemetry are located under **Organization Settings > Billing & Usage**.

- **Annual Enterprise Contracts**: Support ACH/Wire invoicing with Net-30 terms and custom security review packages (SOC 2 Type II + HIPAA BAA).
- **Seat Policy**: Only active human workspace members who query Hippocampus more than twice per month count toward billed seats; guest accounts and bot integrations are free.`,
  },
];

const INITIAL_LOGS = [
  {
    userHandle: '@alex.chen',
    channel: 'Slack #eng-onboarding',
    query: 'How do I configure SSO for my team?',
    answer:
      'Navigate to Workspace Settings > Security & Identity > SSO Provider, configure your SAML 2.0 ACS URL and Entity ID, map email/groups attributes, and upload your X.509 certificate [Source: Engineering Onboarding & SSO Setup Guide].',
    sources: ['Engineering Onboarding & SSO Setup Guide'],
    sourcesCited: 1,
    confidence: 96,
    latencyMs: 840,
    resolved: true,
  },
  {
    userHandle: '@sarah.lin',
    channel: 'Slack #platform-ops',
    query: 'What is the API rate limit for the Pro plan?',
    answer:
      'The Pro Plan allows 600 requests per minute (10 req/sec sustained, burst up to 30 req/sec) and 250,000 vector queries per month with unlimited document chunks [Source: API Reference v2 — Rate Limits & Quotas].',
    sources: ['API Reference v2 — Rate Limits & Quotas'],
    sourcesCited: 1,
    confidence: 94,
    latencyMs: 720,
    resolved: true,
  },
  {
    userHandle: '@marcus.vance',
    channel: 'Playground',
    query: 'How to set up webhooks for Slack integration?',
    answer:
      'Enable Event Subscriptions in the Slack App portal, point the Request URL to POST /api/slack/events, subscribe to app_mention and member_joined_channel, and set SLACK_SIGNING_SECRET for HMAC-SHA256 verification [Source: Slack Events Webhook & Signing Runbook].',
    sources: ['Slack Events Webhook & Signing Runbook'],
    sourcesCited: 1,
    confidence: 95,
    latencyMs: 910,
    resolved: true,
  },
  {
    userHandle: '@priya.nair',
    channel: 'Slack #eng-releases',
    query: 'What is our deployment process for staging?',
    answer:
      'Every PR merged to main automatically builds, runs schema checks, and deploys to staging.hippocampus.internal. You can also trigger branch previews via /deploy staging <branch> [Source: Staging & Production Deployment Pipeline].',
    sources: ['Staging & Production Deployment Pipeline'],
    sourcesCited: 1,
    confidence: 92,
    latencyMs: 1050,
    resolved: true,
  },
  {
    userHandle: '@jordan.reid',
    channel: 'Slack #eng-onboarding',
    query: 'How do I set up local dev environment on Mac?',
    answer:
      'Install node@22, pnpm, postgresql@16, and pgvector via Homebrew (or run docker compose up -d postgres-vector), copy .env.example to .env.local, and run pnpm db:push && pnpm dev [Source: Local Mac Dev Environment & Docker Compose Setup].',
    sources: ['Local Mac Dev Environment & Docker Compose Setup'],
    sourcesCited: 1,
    confidence: 97,
    latencyMs: 790,
    resolved: true,
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
    } catch (error) {
      console.error('Seed check error:', error);
      seedPromise = null;
    }
  })();

  return seedPromise;
}

export async function getDocumentsList() {
  try {
    await ensureSeedData();
    return await db
      .select()
      .from(documents)
      .orderBy(desc(documents.createdAt));
  } catch (error) {
    console.error('Database query failed in getDocumentsList:', error);
    throw new Error('Failed to load indexed documents.', { cause: error });
  }
}

export async function ingestDocument(params: {
  title: string;
  sourceType: 'file' | 'url' | 'slack';
  sourceUrl?: string | null;
  content: string;
  userId?: string | null;
}) {
  try {
    await ensureSeedData();
    const chunks = splitIntoChunks(params.content);
    if (chunks.length === 0) {
      throw new Error('Document content cannot be empty.');
    }

    const [createdDoc] = await db
      .insert(documents)
      .values({
        userId: params.userId ?? null,
        title: params.title.trim(),
        sourceType: params.sourceType,
        sourceUrl: params.sourceUrl?.trim() || null,
        status: 'Indexed',
        chunkCount: chunks.length,
        contentPreview: params.content.trim().slice(0, 260),
        metadata: { charLength: params.content.length },
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
        metadata: { title: params.title },
      });
    }

    if (chunkRecords.length > 0) {
      await db.insert(documentChunks).values(chunkRecords);
    }

    return createdDoc;
  } catch (error) {
    console.error('Database ingestion failed:', error);
    throw new Error('Failed to ingest and embed document.', { cause: error });
  }
}

export async function deleteDocumentById(id: number) {
  try {
    await db.delete(documents).where(eq(documents.id, id));
    return { deletedId: id };
  } catch (error) {
    console.error('Failed to delete document:', error);
    throw new Error('Failed to delete document from knowledge base.', {
      cause: error,
    });
  }
}

export async function searchKnowledgeChunks(
  query: string,
  topK = 4
): Promise<RetrievedChunk[]> {
  try {
    await ensureSeedData();
    const allChunks = await db
      .select({
        chunkId: documentChunks.id,
        documentId: documentChunks.documentId,
        content: documentChunks.content,
        embedding: documentChunks.embedding,
        documentTitle: documents.title,
        sourceType: documents.sourceType,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id));

    if (allChunks.length === 0) return [];

    const queryGeminiVec = await generateEmbedding(query);
    const queryLocalVec = computeDeterministicEmbedding(query, 64);
    const queryTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const scored = allChunks.map((row) => {
      const storedVec = Array.isArray(row.embedding) ? row.embedding : [];
      const refVec =
        storedVec.length === queryGeminiVec.length
          ? queryGeminiVec
          : queryLocalVec;

      const vecSim = cosineSimilarity(refVec, storedVec);

      // Lexical boost for exact technical term matches
      const hay = `${row.documentTitle} ${row.content}`.toLowerCase();
      let termHits = 0;
      for (const term of queryTerms) {
        if (hay.includes(term)) termHits += 1;
      }
      const lexicalBoost =
        queryTerms.length > 0 ? (termHits / queryTerms.length) * 0.35 : 0;

      const combinedScore = Math.min(0.99, Math.max(0.1, vecSim * 0.75 + lexicalBoost));

      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentTitle: row.documentTitle,
        sourceType: row.sourceType,
        content: row.content,
        similarity: combinedScore,
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  } catch (error) {
    console.error('Vector search failed:', error);
    throw new Error('Failed to execute semantic search over knowledge base.', {
      cause: error,
    });
  }
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
        resolved: entry.resolved ?? entry.sources.length > 0,
      })
      .returning();
    return created;
  } catch (error) {
    console.error('Failed to record query log:', error);
    throw new Error('Failed to store query log entry.', { cause: error });
  }
}

export async function getRecentQueryLogs() {
  try {
    await ensureSeedData();
    return await db
      .select()
      .from(queryLogs)
      .orderBy(desc(queryLogs.createdAt))
      .limit(50);
  } catch (error) {
    console.error('Failed to fetch query logs:', error);
    throw new Error('Failed to fetch query logs.', { cause: error });
  }
}

export async function getAgentSettingsList() {
  try {
    await ensureSeedData();
    return await db.select().from(agentSettings).orderBy(agentSettings.id);
  } catch (error) {
    console.error('Failed to fetch agent settings:', error);
    throw new Error('Failed to fetch agent configuration.', { cause: error });
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
  } catch (error) {
    console.error('Failed to update agent setting:', error);
    throw new Error('Failed to update agent setting.', { cause: error });
  }
}

export async function getOverviewPayload() {
  try {
    await ensureSeedData();
    const [allDocs, allChunks, allLogs, settings] = await Promise.all([
      db.select().from(documents).orderBy(desc(documents.createdAt)),
      db.select().from(documentChunks),
      db.select().from(queryLogs).orderBy(desc(queryLogs.createdAt)).limit(30),
      db.select().from(agentSettings).orderBy(agentSettings.id),
    ]);

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
        totalChunks: allChunks.length,
        totalQueries: allLogs.length,
        avgConfidence,
        avgLatencyMs,
      },
      recentDocuments: allDocs.slice(0, 6),
      recentLogs: allLogs.slice(0, 8),
      settings,
    };
  } catch (error) {
    console.error('Failed to build overview payload:', error);
    throw new Error('Failed to load dashboard overview.', { cause: error });
  }
}
