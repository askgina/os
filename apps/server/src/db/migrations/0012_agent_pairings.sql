CREATE TABLE "os"."agent_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"user_code" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"workspace_id" text,
	"agent_id" text,
	"wallet_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "os"."agent_pairings" ADD CONSTRAINT "agent_pairings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."agent_pairings" ADD CONSTRAINT "agent_pairings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "os"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."agent_pairings" ADD CONSTRAINT "agent_pairings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pairings_expires_at_idx" ON "os"."agent_pairings" USING btree ("expires_at");