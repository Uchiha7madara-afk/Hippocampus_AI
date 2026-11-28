-- =============================================================================
-- Hippocampus AI — Mission 001.6 Safe Incremental Security Remediation Migration
-- =============================================================================
-- Safe to run against:
--   1. A clean empty database (after 0000_mission001_security_hardening.sql)
--   2. A pre-Mission-001 database (idempotently creates missing security tables)
--   3. An existing production database with live users, Admin accounts,
--      documents, chunks, audit logs, and duplicate user_progress rows.
--
-- NON-DESTRUCTIVE GUARANTEES:
--   - Preserves all existing users (does NOT downgrade existing Admin accounts).
--   - Preserves all existing documents, document_chunks, connector_sync_logs,
--     and security_audit_logs.
--   - Safely deduplicates user_progress(user_handle, track_id) keeping the
--     most recent completed/updated row before introducing uniqueness.
--   - Enforces PostgreSQL-level append-only immutability on security_audit_logs.
-- =============================================================================

-- 1. Ensure security tables exist for pre-Mission-001 databases (idempotent)
CREATE TABLE IF NOT EXISTS "security_audit_logs" (
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

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processed' NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint

-- 2. Apply least-privilege default role on users without altering existing Admin rows
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'Engineer';
--> statement-breakpoint

-- 3. AUD-001: Upgrade semantic_cache with strict authorization scope columns
--    Existing unscoped rows are tagged with cache_version = 1 so v2 authorization-scoped
--    lookups never serve legacy unscoped entries across role boundaries.
ALTER TABLE "semantic_cache" ADD COLUMN IF NOT EXISTS "cache_key" text;
--> statement-breakpoint
ALTER TABLE "semantic_cache" ADD COLUMN IF NOT EXISTS "required_role" text DEFAULT 'Admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "semantic_cache" ADD COLUMN IF NOT EXISTS "search_mode" text DEFAULT 'hybrid_rrf' NOT NULL;
--> statement-breakpoint
ALTER TABLE "semantic_cache" ADD COLUMN IF NOT EXISTS "cache_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

UPDATE "semantic_cache"
SET "cache_key" = 'legacy:v1:' || "id"::text
WHERE "cache_key" IS NULL;
--> statement-breakpoint

ALTER TABLE "semantic_cache" ALTER COLUMN "cache_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "semantic_cache" ALTER COLUMN "required_role" SET DEFAULT 'Engineer';
--> statement-breakpoint
ALTER TABLE "semantic_cache" ALTER COLUMN "cache_version" SET DEFAULT 2;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "semantic_cache_cache_key_unique"
  ON "semantic_cache" ("cache_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_cache_scope_idx"
  ON "semantic_cache" ("required_role", "search_mode", "cache_version", "last_hit_at" DESC);
--> statement-breakpoint

-- 4. AUD-004 & AUD-010: Distributed single-use OAuth state & per-user encrypted connector tokens
CREATE TABLE IF NOT EXISTS "oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"actor_uid" text NOT NULL,
	"actor_role" text NOT NULL,
	"binding_hash" text NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"target_origin" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_states_expires_at_idx"
  ON "oauth_states" ("expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_connector_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_uid" text NOT NULL,
	"provider" text NOT NULL,
	"external_username" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connector_connections_uid_provider_uidx"
  ON "user_connector_connections" ("user_uid", "provider");
--> statement-breakpoint

-- 5. AUD-013 & AUD-006: Add immutable user_uid to user_progress and safely deduplicate before uniqueness
ALTER TABLE "user_progress" ADD COLUMN IF NOT EXISTS "user_uid" text;
--> statement-breakpoint

-- Safely deduplicate any existing legacy duplicate (user_handle, track_id) records,
-- preserving completed=true first, then most recently updated row, then highest id.
WITH ranked_progress AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_handle, track_id
      ORDER BY completed DESC, updated_at DESC, id DESC
    ) AS rn
  FROM "user_progress"
  WHERE "user_uid" IS NULL
)
DELETE FROM "user_progress"
WHERE id IN (SELECT id FROM ranked_progress WHERE rn > 1);
--> statement-breakpoint

DROP INDEX IF EXISTS "user_progress_handle_track_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_progress_handle_track_uidx"
  ON "user_progress" ("user_handle", "track_id")
  WHERE "user_uid" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_progress_user_uid_idx"
  ON "user_progress" ("user_uid");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_progress_uid_track_partial_uidx"
  ON "user_progress" ("user_uid", "track_id")
  WHERE "user_uid" IS NOT NULL;
--> statement-breakpoint

-- 6. AUD-006: Missing security & query performance indexes
CREATE INDEX IF NOT EXISTS "security_audit_logs_created_at_idx"
  ON "security_audit_logs" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_audit_logs_actor_uid_idx"
  ON "security_audit_logs" ("actor_uid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_document_id_idx"
  ON "document_chunks" ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_access_level_idx"
  ON "documents" ("access_level");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_source_url_idx"
  ON "documents" ("source_url");
--> statement-breakpoint

-- 7. AUD-014: Database-enforced append-only immutability on security_audit_logs
CREATE OR REPLACE FUNCTION prevent_security_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_logs is append-only; % operations are prohibited', TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_security_audit_logs_append_only ON "security_audit_logs";
--> statement-breakpoint

CREATE TRIGGER trg_security_audit_logs_append_only
BEFORE UPDATE OR DELETE ON "security_audit_logs"
FOR EACH ROW
EXECUTE FUNCTION prevent_security_audit_log_mutation();
--> statement-breakpoint

-- Restrict application database role (app_user) to SELECT + INSERT on security_audit_logs when present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "security_audit_logs" FROM app_user;
    GRANT SELECT, INSERT ON TABLE "security_audit_logs" TO app_user;
  END IF;
END
$$;
