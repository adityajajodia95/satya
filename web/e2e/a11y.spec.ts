// Automated accessibility (WCAG 2.1 AA rules via axe-core) on every page and on the open claim drawer,
// in each project — so dark mode and mobile are checked too (Lighthouse only audits the light theme).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const scan = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

for (const path of ["./", "archive", "benchmarks", "about"])
  test(`no WCAG A/AA violations: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await scan(page)).toEqual([]);
  });

test("no WCAG A/AA violations: claim drawer, every tab", async ({ page }) => {
  test.setTimeout(120_000); // four full axe scans
  await page.goto("./");
  await page
    .getByRole("button", { name: /Open details$/ })
    .first()
    .click();
  for (const name of ["Verdict", "Evidence", "Debate", "Trace"]) {
    await page.getByRole("dialog").getByRole("tab", { name }).click();
    expect(await scan(page), name).toEqual([]);
  }
});
