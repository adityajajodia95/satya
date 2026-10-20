import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
  },
});
