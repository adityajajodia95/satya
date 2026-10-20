import { defineConfig } from "vitest/config";

// Each workspace package has its own vitest config; integration tests live in a
// separate, opt-in project (`npm run test:integration`).
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "web", "packages/tools/vitest.workers.config.ts"],
  },
});
