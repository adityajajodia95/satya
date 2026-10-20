// ESLint 10 flat config (replaces the spec's legacy .eslintrc.cjs; see PROGRESS.md deviations).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.tsbuild/**",
      "**/node_modules/**",
      "**/*.generated.ts",
      "data/**",
      "coverage/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // §0.5: no `any` in packages/core.
    files: ["packages/core/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", process: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
);
