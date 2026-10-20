import { defineConfig } from "vitest/config";

// Opt-in integration tests against real local services (Ollama, transformers.js). `npm run test:integration`
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.integration.test.ts", "packages/*/test/**/*.integration.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
