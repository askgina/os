CREATE UNLOGGED TABLE IF NOT EXISTS "os"."rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL
);
