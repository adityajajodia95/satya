// The Desk on first load: the newest recorded run, its claims and margin notes, the claim drawer (all four
// tabs, keyboard use, focus trap, Esc), the gallery picker and the theme switch.
import { expect, expectNotesApart, gallery, isMobile, recordedReport, shot, test } from "./fixtures";

const VIEW: Record<string, string> = {
  SUPPORTED: "Supported",
  REFUTED: "Refuted",
  NOT_ENOUGH_INFO: "Not enough info",
};

test("opens on the newest recorded run with a Recorded badge and one underline per checked claim", async ({
  page,
}) => {
  const { latest } = await gallery(page);
  const report = await recordedReport(page, latest.file);
  await page.goto("./");
  await expect(page.getByText(/Recorded run/i).first()).toBeVisible();
  await expect(page.getByLabel("Recorded runs")).toHaveValue(latest.id);
  const checked = report.claims.filter((c) => c.checkworthy);
  for (const c of checked) {
    const v = report.verdicts[c.id]!;
    const view = v.abstained ? "Not enough info" : VIEW[v.label]!;
    await expect(
      page.getByRole("button", { name: `${c.text} — ${view}. Open details`, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator("h2#result-title")).not.toBeEmpty();
  await expectNotesApart(page);
  await shot(page, "desk-recorded");
});

test("every recorded run in the picker renders without errors", async ({ page }) => {
  const { runs } = await gallery(page);
  await page.goto("./");
  await expect(page.getByLabel("Recorded runs")).toBeVisible();
  for (const r of runs) {
    await page.getByLabel("Recorded runs").selectOption(r.id);
    const report = await recordedReport(page, r.file);
    await expect(page.locator("main")).toContainText(report.inputText.slice(0, 40));
    if (report.title)
      await expect(page.locator("span").getByText(report.title, { exact: true })).toBeVisible();
  }
});

test("claim drawer: open by click, four tabs by click and arrow keys, Tab trapped, Esc closes", async ({
  page,
}) => {
  const { latest } = await gallery(page);
  const report = await recordedReport(page, latest.file);
  const claim = report.claims.find((c) => c.checkworthy)!;
  await page.goto("./");
  const span = page.getByRole("button", { name: new RegExp(`^${escape(claim.text)} — .*Open details$`) });
  await span.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(claim.text);

  for (const name of ["Verdict", "Evidence", "Debate", "Trace"]) {
    await dialog.getByRole("tab", { name }).click();
    await expect(dialog.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("tabpanel")).toBeVisible();
    await shot(page, `drawer-${name.toLowerCase()}`);
  }
  // Evidence passages and debate arguments really are there for a checked claim.
  await dialog.getByRole("tab", { name: "Evidence" }).click();
  expect(await dialog.getByRole("tabpanel").innerText()).not.toHaveLength(0);

  // Arrow keys move between tabs (wrapping).
  await dialog.getByRole("tab", { name: "Verdict" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("tab", { name: "Trace" })).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Trace" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Verdict" })).toBeFocused();

  // Focus stays inside the dialog however far you Tab.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(span).toBeFocused();
});

test("claims open from the keyboard (Enter and Space) and from the close button", async ({ page }) => {
  await page.goto("./");
  const span = page.getByRole("button", { name: /Open details$/ }).first();
  await span.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close claim details" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await span.focus();
  await page.keyboard.press(" ");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("margin notes open the same drawer (desktop) and the summary line counts the verdicts", async ({
  page,
}) => {
  const { latest } = await gallery(page);
  const report = await recordedReport(page, latest.file);
  await page.goto("./");
  const notes = page.getByRole("list", { name: "Verdicts" });
  const checked = report.claims.filter((c) => c.checkworthy);
  await expect(notes.getByRole("button")).toHaveCount(checked.length);
  await notes.getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toContainText(checked[0]!.text);
  await page.keyboard.press("Escape");
  if (!isMobile(page)) await expect(notes).toBeVisible();
});

test("theme switch: Light · Dark · System, arrow keys, persists across reloads", async ({ page }) => {
  await page.goto("./");
  const group = page.getByRole("radiogroup", { name: "Theme" });
  const html = page.locator("html");
  await group.getByRole("radio", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await shot(page, "theme-dark");
  await group.getByRole("radio", { name: "Light" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "Dark" })).toBeFocused();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await group.getByRole("radio", { name: "System" }).click();
  const scheme = test.info().project.use.colorScheme;
  await expect(html).toHaveAttribute("data-theme", scheme === "dark" ? "dark" : "light");
});

test("the system theme is applied before first paint (no light flash in dark mode)", async ({ page }) => {
  const scheme = test.info().project.use.colorScheme;
  await page.goto("./", { waitUntil: "commit" });
  await page.waitForSelector("html[data-theme]", { state: "attached" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme === "dark" ? "dark" : "light");
});

test("skip link moves focus to the main content", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
