CREATE TABLE "os"."venue_orders" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"network" text NOT NULL,
	"cloid" text,
	"action_nonce" bigint NOT NULL,
	"expires_after" bigint,
	"request" "bytea" NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"venue_order_id" bigint,
	"filled_size" text,
	"average_price" text,
	"venue_error" text,
	"submitted_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "os"."venue_orders" ADD CONSTRAINT "venue_orders_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "os"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."venue_orders" ADD CONSTRAINT "venue_orders_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "os"."intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os"."venue_orders" ADD CONSTRAINT "venue_orders_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "os"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "venue_orders_status_idx" ON "os"."venue_orders" USING btree ("status","submitted_at");