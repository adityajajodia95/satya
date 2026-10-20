// Imported first by main.tsx, so it runs before any module that builds or parses a zod schema (@satya/core).
// zod otherwise probes for eval with `Function("")`, which the site CSP (no 'unsafe-eval') reports as a
// violation; jitless mode parses the same way without the probe.
import { z } from "zod";

z.config({ jitless: true });
