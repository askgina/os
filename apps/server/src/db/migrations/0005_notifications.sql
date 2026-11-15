CREATE TABLE "os"."notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"event" text NOT NULL,
	"target" text NOT NULL,
	"user_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "os"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "os"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "os"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_idx" ON "os"."notification_deliveries" USING btree ("approval_id","event","target");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "os"."notification_deliveries" USING btree ("state","next_attempt_at");