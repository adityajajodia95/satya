// Navigation, deep links, the Runs page (recorded runs; your checks: empty, listed, delete flow), Benchmarks,
// How it's built, the author credit, footer links, owner
// mode and the in-app 404.
import { expect, gallery, isMobile, recordedReport, shot, test } from "./fixtures";

test("main navigation reaches every page, marks the current one, and deep links load directly", async ({
  page,
}) => {
  await page.goto("./");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const [name, path, heading] of [
    ["Runs", "archive", "Runs"],
    ["Benchmarks", "benchmarks", "Benchmarks"],
    ["How it's built", "about", "How Satya is built"],
  ] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/satya/${path}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    await shot(page, path);
    await page.goto(path); // deep link served by the host
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await nav.getByRole("link", { name: "Desk" }).click();
  await expect(page).toHaveURL(/\/satya\/?$/);
  await page.getByRole("link", { name: "Satya — fact desk, home" }).click();
  await expect(page.getByRole("textbox", { name: "Paste text to check" })).toBeVisible();
});

test("unknown in-app path shows a not-found message with a way back", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => {
    history.pushState({}, "", "/satya/no-such-page");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("This page doesn't exist.")).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Desk" }).click();
  await expect(page.getByRole("textbox", { name: "Paste text to check" })).toBeVisible();
});

test("runs: every recorded run is listed and opens on the Desk; your checks start empty", async ({
  page,
}) => {
  const { runs } = await gallery(page);
  await page.goto("archive");
  const table = page.getByRole("table", { name: "Recorded runs" });
  await expect(table.getByRole("row")).toHaveCount(runs.length + 1);
  await expect(page.getByText(/None yet — paste a text on the Desk/)).toBeVisible();
  const pick = runs[runs.length - 1]!;
  await table.getByRole("link", { name: pick.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`\\?run=${pick.slug}$`));
  await expect(page.getByRole("combobox", { name: "Recorded runs" })).toHaveValue(pick.id);
  const report = await recordedReport(page, pick.file);
  await expect(page.locator("main")).toContainText(report.inputText.slice(0, 40));
});

test("archive: lists this browser's runs, opens one, deletes with confirmation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("satya.myRuns", JSON.stringify(["run-a", "run-b"])));
  const runs = [
    {
      id: "run-a",
      created: Date.UTC(2026, 9, 13, 10, 0),
      preview:
        "The Eiffel Tower was completed in 1889 and stands in Paris, the capital of France and home of",
      factuality: 0.5,
      nClaims: 2,
      status: "done",
      model: "gpt-oss-120b",
      provider: "workersai",
    },
    {
      id: "run-b",
      created: Date.UTC(2026, 9, 12, 9, 30),
      preview: "Short text",
      factuality: null,
      nClaims: 3,
      status: "partial",
      model: "gpt-oss-120b",
      provider: "groq",
    },
  ];
  let deleted = "";
  await page.route(/\/api\/satya\/runs\?ids=/, (r) => r.fulfill({ json: { runs } }));
  await page.route("**/api/satya/runs/run-a", (r) =>
    r.request().method() === "DELETE"
      ? ((deleted = "run-a"), r.fulfill({ json: { deleted: "run-a" } }))
      : r.fulfill({ status: 404, json: { error: { code: "not_found", message: "gone" } } }),
  );
  await page.goto("archive");
  const table = page.getByRole("table", { name: "Your checks" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table).toContainText("50%");
  await expect(table).toContainText("Partial (capacity)");
  await expect(table).toContainText("…"); // 80-character preview cut
  await shot(page, "archive-list");

  await table
    .getByRole("button", { name: /^Delete the check from/ })
    .first()
    .click();
  await expect(table.getByText("Delete this check?")).toBeVisible();
  await table.getByRole("button", { name: "Keep" }).click();
  await expect(table.getByText("Delete this check?")).toBeHidden();
  await table
    .getByRole("button", { name: /^Delete the check from/ })
    .first()
    .click();
  await table.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => deleted).toBe("run-a");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("satya.myRuns"))).not.toContain("run-a");

  await table.getByRole("link", { name: "Short text" }).click();
  await expect(page).toHaveURL(/\/satya\/run\/run-b$/);
});

test("archive: the API failing shows an error with a retry", async ({ page, consoleGuard }) => {
  consoleGuard.allow(/status of 500/);
  await page.addInitScript(() => localStorage.setItem("satya.myRuns", JSON.stringify(["run-a"])));
  let calls = 0;
  await page.route(
    /\/api\/satya\/runs\?ids=/,
    (r) => (calls++, r.fulfill({ status: 500, json: { error: { code: "internal", message: "boom" } } })),
  );
  await page.goto("archive");
  await expect(page.getByText("The archive couldn't be loaded.")).toBeVisible();
  const before = calls;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => calls).toBeGreaterThan(before);
});

test("benchmarks: dataset tabs respond and every dataset has results", async ({ page }) => {
  await page.goto("benchmarks");
  await expect(page.getByRole("heading", { level: 1, name: "Benchmarks" })).toBeVisible();
  for (const name of ["FEVER", "HoVer", "SciFact"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  }
  // No empty views: every dataset tab shows a results table (the deployed-model toggle exists only with data).
  for (const name of ["SciFact", "FEVER", "HoVer"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByRole("table").first()).toBeVisible();
  }
  await expect(page.getByRole("radio", { name: /Deployed/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "SciFact" }).click();
  // When results are published, the charts must draw them (risk–coverage + reliability lines).
  const published = (await page.request.get("benchmarks.json")).headers()["content-type"]?.includes("json");
  if (published) await expect.poll(() => page.locator(".recharts-line").count()).toBeGreaterThanOrEqual(2);
  await shot(page, "benchmarks");
});

test("how it's built: flow, architecture, models, decisions, evaluation, quality, limits, author", async ({
  page,
}) => {
  await page.goto("about");
  const main = page.getByRole("main");
  for (const heading of [
    "How a check works",
    "Architecture",
    "Models — and why these",
    "Design decisions — and why",
    "Evaluation",
    "Engineering quality",
    "Usage limits — and why",
    "Limitations and next steps",
    "Author",
  ])
    await expect(main.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  await expect(main.getByRole("list", { name: "Pipeline stages" }).getByRole("listitem")).not.toHaveCount(0);
  await expect(main.getByRole("list", { name: /System layers/ })).toContainText("AI gateway");
  for (const model of ["gpt-oss-120b", "Qwen3-4B", "bge-m3", "bge-reranker-base"])
    await expect(main.getByRole("heading", { level: 3, name: new RegExp(model) })).toBeVisible();
  // Results are read from the published benchmarks, one row per system.
  await expect(main.getByRole("table", { name: /Accuracy of each system/ }).getByRole("row")).not.toHaveCount(
    1,
  );
  // The table of contents jumps to each section.
  await main
    .getByRole("navigation", { name: "On this page" })
    .getByRole("link", { name: "Design decisions" })
    .click();
  await expect(page).toHaveURL(/#decisions$/);
  await expect(main.getByRole("table", { name: /Usage limits and the reason/ })).toContainText(
    "3 live checks per visitor per day",
  );
  await shot(page, "how-its-built");
});

test("the author credit is on every page", async ({ page }) => {
  for (const path of ["./", "archive", "benchmarks", "about"]) {
    await page.goto(path);
    const footer = page.getByRole("contentinfo");
    await expect(footer).toContainText("Aditya Jajodia");
    await expect(footer).toContainText("M.Tech in Data Science and Machine Learning");
    await expect(footer.getByRole("link", { name: "adityajajodia95@gmail.com" })).toHaveAttribute(
      "href",
      "mailto:adityajajodia95@gmail.com",
    );
  }
});

test("footer links: write-up opens How it's built, status page loads, no dead links", async ({ page }) => {
  await page.goto("./");
  const footer = page.getByRole("contentinfo");
  for (const link of await footer.getByRole("link").all()) {
    const href = (await link.getAttribute("href"))!;
    if (href.startsWith("mailto:")) continue;
    const res = await page.request.get(new URL(href, page.url()).href);
    expect(res.status(), href).toBe(200);
  }
  await footer.getByRole("link", { name: "Write-up" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "How Satya is built" })).toBeVisible();
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: /status/i })
    .click();
  await expect(page).toHaveURL(/\/status\/$/);
});

test("owner mode: hidden by default, ?owner shows the form, saving turns it on, Turn off clears it", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByLabel("Owner token")).toHaveCount(0);
  await page.goto("./?owner");
  await page.getByLabel("Owner token").fill("e2e-not-a-real-token");
  await page.getByRole("button", { name: "Save in this browser" }).click();
  await expect(page.getByText("Owner mode is on in this browser.")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("satya.ownerToken"))).toBe("e2e-not-a-real-token");
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Owner mode is on in this browser.")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("satya.ownerToken"))).toBeNull();
});

test("layout: no horizontal scroll on any page", async ({ page }) => {
  for (const path of ["./", "archive", "benchmarks", "about"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
  }
  if (isMobile(page)) await shot(page, "mobile-about");
});
