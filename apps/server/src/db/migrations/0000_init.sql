CREATE SCHEMA IF NOT EXISTS "os";
--> statement-breakpoint
CREATE TABLE "os"."agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"wallet_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "os"."approval_assertions" (
	"approval_id" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_assertions_approval_id_user_id_pk" PRIMARY KEY("approval_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "os"."approval_rejections" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"envelope" jsonb NOT NULL,
	"threshold" integer NOT NULL,
	"detail" "bytea",
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"failure_code" text,
	"run_id" text,
	"resume_state" text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."approver_credentials" (
	"workspace_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approver_credentials_workspace_id_credential_id_pk" PRIMARY KEY("workspace_id","credential_id")
);
--> statement-breakpoint
CREATE TABLE "os"."audit_events" (
	"workspace_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"detail" "bytea" NOT NULL,
	"detail_digest" text NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "audit_events_workspace_id_seq_pk" PRIMARY KEY("workspace_id","seq")
);
--> statement-breakpoint
CREATE TABLE "os"."ceremonies" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"challenge" text NOT NULL,
	"user_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "os"."credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "os"."installation" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."intents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"intent_hash" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"presentation" "bytea" NOT NULL,
	"approval_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "os"."memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "os"."sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "os"."transactions" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"nonce" integer NOT NULL,
	"hash" text NOT NULL,
	"raw" "bytea" NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"block_number" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"policy" jsonb,
	"policy_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os"."workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"admin_threshold" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "os"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."agents" ADD CONSTRAINT "agents_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approval_assertions" ADD CONSTRAINT "approval_assertions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approval_assertions" ADD CONSTRAINT "approval_assertions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approval_rejections" ADD CONSTRAINT "approval_rejections_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approval_rejections" ADD CONSTRAINT "approval_rejections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approver_credentials" ADD CONSTRAINT "approver_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approver_credentials" ADD CONSTRAINT "approver_credentials_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "os"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."approver_credentials" ADD CONSTRAINT "approver_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."intents" ADD CONSTRAINT "intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."intents" ADD CONSTRAINT "intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "os"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."intents" ADD CONSTRAINT "intents_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD CONSTRAINT "transactions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD CONSTRAINT "transactions_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "os"."intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."wallets" ADD CONSTRAINT "wallets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_token_hash_idx" ON "os"."agents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agents_workspace_idx" ON "os"."agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "approvals_workspace_status_idx" ON "os"."approvals" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approvals_subject_idx" ON "os"."approvals" USING btree ("kind","subject_id");--> statement-breakpoint
CREATE INDEX "approvals_resume_idx" ON "os"."approvals" USING btree ("resume_state");--> statement-breakpoint
CREATE INDEX "approver_credentials_user_idx" ON "os"."approver_credentials" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "credentials_user_idx" ON "os"."credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "intents_workspace_idx" ON "os"."intents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "intents_agent_idx" ON "os"."intents" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "os"."memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "os"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_wallet_chain_idx" ON "os"."transactions" USING btree ("wallet_id","chain_id","status");--> statement-breakpoint
CREATE INDEX "wallets_workspace_idx" ON "os"."wallets" USING btree ("workspace_id");