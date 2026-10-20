import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Routes, Durable Objects and the Workflow driver run inside workerd; the gateway and tools are faked.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: { SATYA_ADMIN_TOKEN: "test-admin", SATYA_OWNER_TOKEN: "test-owner" },
        // aj-gateway stand-in with the same RPC surface (test/fake-gateway.js).
        workers: [
          {
            name: "aj-gateway",
            modules: true,
            scriptPath: "./test/fake-gateway.js",
            compatibilityDate: "2026-10-01",
          },
        ],
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
