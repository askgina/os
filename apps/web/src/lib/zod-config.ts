import { z } from "zod";

// Zod probes `new Function` to speed up parsing. Under the strict Content-Security-Policy this
// UI is served with, that probe is a CSP violation, so turn the optimisation off. This module is
// imported first in main.tsx, before any schema is used.
z.config({ jitless: true });
