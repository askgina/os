// Upstream's World conformance suite (@workflow/world-testing), pointed at the encrypting World
// through the proof host's World module. Not a test file on its own: conformance.test.ts runs it
// in a child Vitest with test/conformance/vitest.config.ts and judges the result.
import { fileURLToPath } from "node:url";
import { createTestSuite } from "@workflow/world-testing";

createTestSuite(fileURLToPath(new URL("../harness/world.ts", import.meta.url)));
