import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// Runs *.workers.test.ts inside workerd (the real Workers runtime) via Miniflare.
export default defineProject({
  plugins: [
    cloudflareTest({ miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] } }),
  ],
  test: { name: "tools-workers", include: ["test/**/*.workers.test.ts"] },
});
