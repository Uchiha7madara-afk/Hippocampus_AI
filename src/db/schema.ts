import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
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
  role: text('role').default('Admin').notNull(), // 'Admin' | 'Manager' | 'Engineer'
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documents = pgTable('documents', {
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
});

export const documentChunks = pgTable('document_chunks', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id')
    .references(() => documents.id, { onDelete: 'cascade' })
    .notNull(),
  chunkIndex: integer('chunk_index').default(0).notNull(),
  content: text('content').notNull(),
  embedding: jsonb('embedding').$type<number[]>().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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

export const semanticCache = pgTable('semantic_cache', {
  id: serial('id').primaryKey(),
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
});

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

export const userProgress = pgTable('user_progress', {
  id: serial('id').primaryKey(),
  userHandle: text('user_handle').notNull(), // e.g. '@alex.chen'
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
});

/**
 * Phase 4 Step 3 & 4: External Connectors Sync Audit Table (GitHub & Google Drive)
 */
export const connectorSyncLogs = pgTable('connector_sync_logs', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(), // 'github' | 'gdrive'
  target: text('target').notNull(), // e.g. 'Uchiha7madara-afk/Hippocampus' or 'Google Docs'
  branchOrFolder: text('branch_or_folder').default('main').notNull(),
  triggerType: text('trigger_type').default('manual_sync').notNull(), // 'oauth_sync' | 'webhook_push' | 'manual_sync' | 'drive_import'
  filesProcessed: integer('files_processed').default(0).notNull(),
  chunksUpserted: integer('chunks_upserted').default(0).notNull(),
  commitSha: text('commit_sha'),
  status: text('status').default('Completed').notNull(),
  details: text('details').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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
