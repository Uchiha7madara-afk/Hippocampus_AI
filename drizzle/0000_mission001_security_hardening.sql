CREATE TABLE "agent_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "connector_sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"target" text NOT NULL,
	"branch_or_folder" text DEFAULT 'main' NOT NULL,
	"trigger_type" text DEFAULT 'manual_sync' NOT NULL,
	"files_processed" integer DEFAULT 0 NOT NULL,
	"chunks_upserted" integer DEFAULT 0 NOT NULL,
	"commit_sha" text,
	"status" text DEFAULT 'Completed' NOT NULL,
	"details" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"status" text DEFAULT 'Indexed' NOT NULL,
	"access_level" text DEFAULT 'Engineer' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"content_preview" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'Environment' NOT NULL,
	"target_role" text DEFAULT 'Engineer' NOT NULL,
	"linked_doc_title" text,
	"verification_prompt" text,
	"estimated_minutes" integer DEFAULT 25 NOT NULL,
	"sort_order" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_handle" text DEFAULT '@alex.chen' NOT NULL,
	"channel" text DEFAULT 'Playground' NOT NULL,
	"query" text NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources_cited" integer DEFAULT 0 NOT NULL,
	"confidence" integer DEFAULT 92 NOT NULL,
	"latency_ms" integer DEFAULT 850 NOT NULL,
	"resolved" boolean DEFAULT true NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"search_mode" text DEFAULT 'hybrid_rrf' NOT NULL,
	"required_role" text DEFAULT 'Engineer' NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_uid" text NOT NULL,
	"actor_email" text,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"target_resource" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"query_text" text NOT NULL,
	"query_embedding" jsonb NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" integer DEFAULT 95 NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_hit_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_handle" text NOT NULL,
	"display_name" text NOT NULL,
	"engineer_role" text DEFAULT 'Backend Engineer' NOT NULL,
	"track_id" integer NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"assigned_by" text DEFAULT '@elena.rostova' NOT NULL,
	"notes" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'Engineer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_uid_unique" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processed' NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_track_id_onboarding_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."onboarding_tracks"("id") ON DELETE cascade ON UPDATE no action;