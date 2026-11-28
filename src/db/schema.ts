import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export type RbacRole = 'Admin' | 'Manager' | 'Engineer';
export type OnboardingPhase = 'Day 1' | 'Week 1' | 'Month 1';

export interface AgentToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
}

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  role: text('role').default('Engineer').notNull(), // 'Admin' | 'Manager' | 'Engineer'
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documents = pgTable(
  'documents',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id'),
    title: text('title').notNull(),
    sourceType: text('source_type').notNull(), // 'file' | 'url' | 'slack' | 'github' | 'gdrive'
    sourceUrl: text('source_url'),
    status: text('status').default('Indexed').notNull(), // 'Indexed' | 'Processing' | 'Failed'
    accessLevel: text('access_level').default('Engineer').notNull(), // 'Admin' | 'Manager' | 'Engineer'
    chunkCount: integer('chunk_count').default(0).notNull(),
    contentPreview: text('content_preview').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('documents_access_level_idx').on(table.accessLevel),
    index('documents_source_url_idx').on(table.sourceUrl),
  ]
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: serial('id').primaryKey(),
    documentId: integer('document_id')
      .references(() => documents.id, { onDelete: 'cascade' })
      .notNull(),
    chunkIndex: integer('chunk_index').default(0).notNull(),
    content: text('content').notNull(),
    embedding: jsonb('embedding').$type<number[]>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('document_chunks_document_id_idx').on(table.documentId)]
);

export const queryLogs = pgTable('query_logs', {
  id: serial('id').primaryKey(),
  userHandle: text('user_handle').default('@alex.chen').notNull(),
  channel: text('channel').default('Playground').notNull(),
  query: text('query').notNull(),
  answer: text('answer').notNull(),
  sources: jsonb('sources').$type<string[]>().default([]).notNull(),
  sourcesCited: integer('sources_cited').default(0).notNull(),
  confidence: integer('confidence').default(92).notNull(),
  latencyMs: integer('latency_ms').default(850).notNull(),
  resolved: boolean('resolved').default(true).notNull(),
  cacheHit: boolean('cache_hit').default(false).notNull(),
  promptTokens: integer('prompt_tokens').default(0).notNull(),
  completionTokens: integer('completion_tokens').default(0).notNull(),
  totalTokens: integer('total_tokens').default(0).notNull(),
  searchMode: text('search_mode').default('hybrid_rrf').notNull(),
  requiredRole: text('required_role').default('Engineer').notNull(), // 'Admin' | 'Manager' | 'Engineer'
  toolCalls: jsonb('tool_calls')
    .$type<AgentToolInvocation[]>()
    .default([])
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Mission 001.6 (AUD-001): Strictly Authorization-Scoped Semantic Cache
 * Enforces exact required_role, search_mode, and cache_version matching in SQL before cosine similarity.
 */
export const semanticCache = pgTable(
  'semantic_cache',
  {
    id: serial('id').primaryKey(),
    cacheKey: text('cache_key').notNull().unique(),
    requiredRole: text('required_role').default('Engineer').notNull(), // 'Admin' | 'Manager' | 'Engineer'
    searchMode: text('search_mode').default('hybrid_rrf').notNull(),
    cacheVersion: integer('cache_version').default(2).notNull(),
    queryText: text('query_text').notNull(),
    queryEmbedding: jsonb('query_embedding').$type<number[]>().notNull(),
    answer: text('answer').notNull(),
    sources: jsonb('sources').$type<string[]>().default([]).notNull(),
    confidence: integer('confidence').default(95).notNull(),
    toolCalls: jsonb('tool_calls')
      .$type<AgentToolInvocation[]>()
      .default([])
      .notNull(),
    hitCount: integer('hit_count').default(1).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastHitAt: timestamp('last_hit_at').defaultNow().notNull(),
  },
  (table) => [
    index('semantic_cache_scope_idx').on(
      table.requiredRole,
      table.searchMode,
      table.cacheVersion,
      table.lastHitAt
    ),
  ]
);

export const agentSettings = pgTable('agent_settings', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Phase 4 Step 1: Interactive Onboarding Checklists Schema
 */
export const onboardingTracks = pgTable('onboarding_tracks', {
  id: serial('id').primaryKey(),
  phase: text('phase').notNull(), // 'Day 1' | 'Week 1' | 'Month 1'
  title: text('title').notNull(),
  description: text('description').notNull(),
  category: text('category').default('Environment').notNull(),
  targetRole: text('target_role').default('Engineer').notNull(), // 'Engineer' | 'Manager' | 'Admin'
  linkedDocTitle: text('linked_doc_title'),
  verificationPrompt: text('verification_prompt'),
  estimatedMinutes: integer('estimated_minutes').default(25).notNull(),
  sortOrder: integer('sort_order').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userProgress = pgTable(
  'user_progress',
  {
    id: serial('id').primaryKey(),
    userUid: text('user_uid'), // Immutable Firebase UID (primary user identity — AUD-013)
    userHandle: text('user_handle').notNull(), // Display handle (e.g. '@alex.chen')
    displayName: text('display_name').notNull(),
    engineerRole: text('engineer_role').default('Backend Engineer').notNull(),
    trackId: integer('track_id')
      .references(() => onboardingTracks.id, { onDelete: 'cascade' })
      .notNull(),
    completed: boolean('completed').default(false).notNull(),
    completedAt: timestamp('completed_at'),
    assignedBy: text('assigned_by').default('@elena.rostova').notNull(),
    notes: text('notes'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_progress_handle_track_uidx')
      .on(table.userHandle, table.trackId)
      .where(sql`${table.userUid} IS NULL`),
    uniqueIndex('user_progress_uid_track_partial_uidx')
      .on(table.userUid, table.trackId)
      .where(sql`${table.userUid} IS NOT NULL`),
    index('user_progress_user_uid_idx').on(table.userUid),
  ]
);

/**
 * Phase 4 Step 3 & 4: External Connectors Sync Audit Table (GitHub & Google Drive)
 */
export const connectorSyncLogs = pgTable('connector_sync_logs', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(), // 'github' | 'gdrive'
  target: text('target').notNull(),
  branchOrFolder: text('branch_or_folder').default('main').notNull(),
  triggerType: text('trigger_type').default('manual_sync').notNull(),
  filesProcessed: integer('files_processed').default(0).notNull(),
  chunksUpserted: integer('chunks_upserted').default(0).notNull(),
  commitSha: text('commit_sha'),
  status: text('status').default('Completed').notNull(),
  details: text('details').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Mission 001 + 001.6 (AUD-014): Persistent Security Audit Log Table
 * Database-enforced append-only via PostgreSQL BEFORE UPDATE OR DELETE trigger
 * and REVOKE UPDATE/DELETE/TRUNCATE on the application database role.
 */
export const securityAuditLogs = pgTable(
  'security_audit_logs',
  {
    id: serial('id').primaryKey(),
    actorUid: text('actor_uid').notNull(),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role').notNull(), // 'Admin' | 'Manager' | 'Engineer' | 'None' | 'System'
    action: text('action').notNull(),
    targetResource: text('target_resource').notNull(),
    outcome: text('outcome').notNull(), // 'success' | 'denied' | 'failure'
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('security_audit_logs_created_at_idx').on(table.createdAt),
    index('security_audit_logs_actor_uid_idx').on(table.actorUid),
  ]
);

/**
 * Mission 001: Persistent Webhook Delivery Idempotency Table (Replay Protection)
 */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(), // 'github' | 'slack'
  deliveryId: text('delivery_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  status: text('status').default('processed').notNull(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
});

/**
 * Mission 001.6 (AUD-004 / AUD-010): Distributed, Atomic Single-Use OAuth State Store
 * Stores only SHA-256 hashes of state/browser-binding and AES-256-GCM encrypted PKCE verifier.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: serial('id').primaryKey(),
    stateHash: text('state_hash').notNull().unique(),
    provider: text('provider').default('github').notNull(),
    actorUid: text('actor_uid').notNull(),
    actorRole: text('actor_role').notNull(),
    bindingHash: text('binding_hash').notNull(),
    codeVerifierEnc: text('code_verifier_enc').notNull(),
    targetOrigin: text('target_origin').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
  },
  (table) => [index('oauth_states_expires_at_idx').on(table.expiresAt)]
);

/**
 * Mission 001.6 (AUD-004): Per-User Encrypted External Connector Credentials
 * Tokens are encrypted at rest via AES-256-GCM and strictly bound to user_uid.
 */
export const userConnectorConnections = pgTable(
  'user_connector_connections',
  {
    id: serial('id').primaryKey(),
    userUid: text('user_uid').notNull(),
    provider: text('provider').notNull(), // 'github'
    externalUsername: text('external_username').notNull(),
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    status: text('status').default('connected').notNull(), // 'connected' | 'revoked' | 'error'
    lastError: text('last_error'),
    connectedAt: timestamp('connected_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_connector_connections_uid_provider_uidx').on(
      table.userUid,
      table.provider
    ),
  ]
);

export const documentsRelations = relations(documents, ({ many }) => ({
  chunks: many(documentChunks),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, {
    fields: [documentChunks.documentId],
    references: [documents.id],
  }),
}));

export const onboardingTracksRelations = relations(
  onboardingTracks,
  ({ many }) => ({
    progressEntries: many(userProgress),
  })
);

export const userProgressRelations = relations(userProgress, ({ one }) => ({
  track: one(onboardingTracks, {
    fields: [userProgress.trackId],
    references: [onboardingTracks.id],
  }),
}));
