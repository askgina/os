ALTER TABLE "os"."wallets" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."wallets" ADD COLUMN "destroy_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD COLUMN "destroy_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "os"."workspaces" ADD COLUMN "deleted_at" timestamp with time zone;