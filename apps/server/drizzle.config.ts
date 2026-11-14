import { defineConfig } from "drizzle-kit";

// Only used by `bun run db:generate` to turn src/db/schema.ts into SQL migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  schemaFilter: ["os"],
});
