CREATE TABLE "os"."nonce_reservations" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"nonce" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "os"."invites" ADD COLUMN "id" text;--> statement-breakpoint
-- Invites made before this migration get an id derived from their token hash; it grants nothing.
UPDATE "os"."invites" SET "id" = 'inv_' || substr("token_hash", 1, 32) WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "os"."invites" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD COLUMN "audit_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD COLUMN "audit_head" text;--> statement-breakpoint
-- The head of each existing chain, so verification compares against it from now on.
UPDATE "os"."workspaces" AS w SET "audit_seq" = h."seq", "audit_head" = h."hash"
FROM (
	SELECT DISTINCT ON ("workspace_id") "workspace_id", "seq", "hash"
	FROM "os"."audit_events" ORDER BY "workspace_id", "seq" DESC
) AS h
WHERE h."workspace_id" = w."id";--> statement-breakpoint
ALTER TABLE "os"."nonce_reservations" ADD CONSTRAINT "nonce_reservations_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."nonce_reservations" ADD CONSTRAINT "nonce_reservations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nonce_reservations_wallet_chain_idx" ON "os"."nonce_reservations" USING btree ("wallet_id","chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_wallet_idx" ON "os"."agents" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_id_idx" ON "os"."invites" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_one_treasury_idx" ON "os"."wallets" USING btree ("workspace_id") WHERE "os"."wallets"."kind" = 'treasury';