import { defineConfig } from "vitest/config";

// Unit tests for the web app's pure helpers; the UI itself is covered by the Playwright suite in e2e/.
export default defineConfig({
  test: { name: "web", include: ["test/**/*.test.ts"], environment: "node" },
});
