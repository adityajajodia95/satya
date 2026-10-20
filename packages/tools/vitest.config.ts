import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "tools",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts", "test/**/*.workers.test.ts"],
  },
});
