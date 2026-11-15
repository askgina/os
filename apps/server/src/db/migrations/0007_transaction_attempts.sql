CREATE TABLE "os"."transaction_attempts" (
	"approval_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"hash" text NOT NULL,
	"raw" "bytea" NOT NULL,
	"gas" text NOT NULL,
	"max_fee_per_gas" text NOT NULL,
	"max_priority_fee_per_gas" text NOT NULL,
	"cancel_approval_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_attempts_approval_id_attempt_pk" PRIMARY KEY("approval_id","attempt"),
	CONSTRAINT "transaction_attempts_after_first" CHECK ("os"."transaction_attempts"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD COLUMN "latest_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD COLUMN "mined_attempt" integer;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD COLUMN "stuck_reason" text;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD COLUMN "last_broadcast_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "os"."transactions" ADD COLUMN "reprice_tried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "os"."transaction_attempts" ADD CONSTRAINT "transaction_attempts_approval_id_transactions_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."transactions"("approval_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."transaction_attempts" ADD CONSTRAINT "transaction_attempts_cancel_approval_id_approvals_id_fk" FOREIGN KEY ("cancel_approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;