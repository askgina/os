CREATE TABLE "os"."mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"mandate_hash" text NOT NULL,
	"mandate" "bytea" NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"grant_approval_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_ended_has_reason" CHECK (("os"."mandates"."status" = 'ended') = ("os"."mandates"."ended_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "os"."approvals" ALTER COLUMN "envelope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."approvals" ADD COLUMN "mandate_id" text;--> statement-breakpoint
ALTER TABLE "os"."intents" ADD COLUMN "mandate_id" text;--> statement-breakpoint
ALTER TABLE "os"."mandates" ADD CONSTRAINT "mandates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."mandates" ADD CONSTRAINT "mandates_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."mandates" ADD CONSTRAINT "mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "os"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."mandates" ADD CONSTRAINT "mandates_grant_approval_id_approvals_id_fk" FOREIGN KEY ("grant_approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mandates_wallet_idx" ON "os"."mandates" USING btree ("workspace_id","wallet_id","status");--> statement-breakpoint
CREATE INDEX "mandates_agent_idx" ON "os"."mandates" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_grant_idx" ON "os"."mandates" USING btree ("grant_approval_id");--> statement-breakpoint
ALTER TABLE "os"."approvals" ADD CONSTRAINT "approvals_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "os"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."intents" ADD CONSTRAINT "intents_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "os"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intents_mandate_idx" ON "os"."intents" USING btree ("mandate_id","created_at");--> statement-breakpoint
ALTER TABLE "os"."approvals" ADD CONSTRAINT "approvals_use_has_no_envelope" CHECK (("os"."approvals"."kind" = 'mandate-use') = ("os"."approvals"."envelope" IS NULL));--> statement-breakpoint
ALTER TABLE "os"."approvals" ADD CONSTRAINT "approvals_use_has_mandate" CHECK (("os"."approvals"."kind" = 'mandate-use') = ("os"."approvals"."mandate_id" IS NOT NULL));