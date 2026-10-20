// Live-run states, forced through scripted network answers: a live run that streams in, a partial run
// (capacity ran out mid-run), a failed run, capacity exhausted before starting, the waking overlay, API and
// network errors, and the form's own validation.
import type { Page } from "@playwright/test";
import {
  expect,
  expectNotesApart,
  gallery,
  mockCreateError,
  mockLiveRun,
  mockStatus,
  ownerMode,
  recordedReport,
  shot,
  test,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await ownerMode(page);
  await mockStatus(page, "live");
});

async function startRun(page: Page, text: string) {
  await page.goto("./");
  await page.getByRole("textbox", { name: "Paste text to check" }).fill(text);
  await page.getByRole("button", { name: "Check facts" }).click();
}

test("live run: claims appear, the status line tracks progress, verdicts land, badge says Live", async ({
  page,
}) => {
  const { richest } = await gallery(page);
  const report = await recordedReport(page, richest.file);
  const { runId, checked } = await mockLiveRun(page, report, "done");
  await startRun(page, report.inputText);
  await expect(page).toHaveURL(new RegExp(`/satya/run/${runId}$`));
  await expect(page.locator("p[role=status]")).toBeVisible();
  await expectNotesApart(page);
  await shot(page, "live-running");
  for (const c of checked)
    await expect(page.getByRole("button", { name: new RegExp(`^${esc(c.text)} — `) })).toBeVisible();
  await expect(page.getByText(/Live run/i).first()).toBeVisible();
  await expect(page.locator("h2#result-title")).toHaveText(/checks? out|closer look/);
  await expect(page.locator("p[role=status]")).toBeHidden();
  await expectNotesApart(page);
  await shot(page, "live-done");
  // The archive remembers the run in this browser.
  expect(await page.evaluate(() => localStorage.getItem("satya.myRuns"))).toContain(runId);
});

test("partial run: a capacity notice, skipped claims marked Not checked", async ({ page }) => {
  const { richest } = await gallery(page);
  const report = await recordedReport(page, richest.file);
  const { checked } = await mockLiveRun(page, report, "partial");
  test.skip(checked.length < 2, "needs a run with at least two checked claims");
  await startRun(page, report.inputText);
  await expect(page.getByText(/free capacity ran out during this check/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^${esc(checked[1]!.text)} — Not checked \\(capacity\\)`) }),
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${esc(checked[1]!.text)} — `) }).click();
  await expect(page.getByRole("dialog")).toContainText("today's free capacity ran out");
  await page.keyboard.press("Escape");
  await shot(page, "live-partial");
});

test("failed run: an error banner says the check couldn't finish", async ({ page }) => {
  const { richest } = await gallery(page);
  const report = await recordedReport(page, richest.file);
  await mockLiveRun(page, report, "failed");
  await startRun(page, report.inputText);
  await expect(page.getByText(/This check couldn't finish: The language model is unavailable/)).toBeVisible();
  await shot(page, "live-failed");
});

test("capacity exhausted before starting: the notice replaces the button, recorded runs stay usable", async ({
  page,
}) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockStatus(page, "capacity");
  await page.goto("./");
  await expect(page.getByText(/Today's free capacity is used/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Check facts" })).toHaveCount(0);
  await page
    .getByRole("button", { name: /Open details$/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await shot(page, "capacity-exhausted");
});

test("capacity answered by the API on submit (507) switches to the capacity notice", async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 507/); // the browser logs every error response it receives
  await mockCreateError(page, 507, "capacity_exhausted", "Today's free capacity is used.");
  await startRun(page, "The Eiffel Tower is in Paris.");
  await expect(page.getByText(/Today's free capacity is used/)).toBeVisible();
  await expect(page).toHaveURL(/\/satya\/?$/);
});

test("waking: the overlay shows while the backend wakes", async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockStatus(page, "waking", 45);
  await page.goto("./");
  await expect(page.getByText(/waking/i).first()).toBeVisible();
  await shot(page, "waking");
});

test("API error on submit: a readable error, the text is kept, no navigation", async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 400/);
  await mockCreateError(page, 400, "bad_request", "The text is longer than 2,000 characters.");
  await startRun(page, "Some claim.");
  await expect(page.getByText("The text is longer than 2,000 characters.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Paste text to check" })).toHaveValue("Some claim.");
});

test("network failure on submit: a generic error, no crash", async ({ page, consoleGuard }) => {
  await page.route("**/api/satya/runs", (r) =>
    r.request().method() === "POST" ? r.abort("internetdisconnected") : r.fallback(),
  );
  // The browser itself logs the failed request; that line (only) is expected here.
  consoleGuard.allow(/net::ERR_INTERNET_DISCONNECTED/);
  await startRun(page, "Some claim.");
  await expect(page.getByText(/Network error/)).toBeVisible();
});

test("form validation: empty text, no sources, character counter and limit", async ({ page }) => {
  await page.goto("./");
  // The daily limit is stated next to the button, with its reason.
  await expect(page.getByText(/3 per visitor per day/)).toBeVisible();
  await expect(page.getByText(/free model tiers shared by every visitor/)).toBeVisible();
  await page.getByRole("button", { name: "Check facts" }).click();
  await expect(page.getByText("Paste a sentence or a paragraph to check.")).toBeVisible();
  for (const name of ["Wikipedia", "Web", "Papers"]) {
    const box = page.getByRole("checkbox", { name });
    if (await box.isChecked()) await box.uncheck();
  }
  await expect(page.getByRole("button", { name: "Check facts" })).toBeDisabled();
  await expect(page.getByText("Choose at least one source.")).toBeVisible();
  await page.getByRole("checkbox", { name: "Papers" }).check();
  await expect(page.getByRole("button", { name: "Check facts" })).toBeEnabled();
  const box = page.getByRole("textbox", { name: "Paste text to check" });
  await box.fill("x".repeat(2100));
  await expect(box).toHaveValue("x".repeat(2000));
  await expect(page.getByText("2,000 / 2,000 characters")).toBeVisible();
});

test("an unknown run id shows an error rather than a blank page", async ({ page, consoleGuard }) => {
  await page.route("**/api/satya/runs/does-not-exist**", (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not_found", message: "This check doesn't exist or has expired." },
      }),
    }),
  );
  consoleGuard.allow(/status of 404/);
  await page.goto("run/does-not-exist");
  await expect(page.getByText("This check doesn't exist or has expired.")).toBeVisible();
  await shot(page, "run-not-found");
});

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
