// End-to-end QA of the deployed demo (§11 QA): every page in light and dark, desktop and mobile.
// Runs against https://aj-demos.pages.dev/satya/ by default; E2E_BASE_URL points it elsewhere (e.g. a preview).
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "https://aj-demos.pages.dev/satya/";
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } };
const mobile = { ...devices["Pixel 7"] };

export default defineConfig({
  testDir: "e2e",
  outputDir: "../qa/test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "../qa/e2e-results.json" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
    { name: "mobile-light", use: { ...mobile, colorScheme: "light" } },
    { name: "mobile-dark", use: { ...mobile, colorScheme: "dark" } },
  ],
});
