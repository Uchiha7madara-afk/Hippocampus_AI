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

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  role: text('role').default('Engineering Admin').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  userId: text('user_id'),
  title: text('title').notNull(),
  sourceType: text('source_type').notNull(), // 'file' | 'url' | 'slack'
  sourceUrl: text('source_url'),
  status: text('status').default('Indexed').notNull(), // 'Indexed' | 'Processing' | 'Failed'
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agentSettings = pgTable('agent_settings', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
