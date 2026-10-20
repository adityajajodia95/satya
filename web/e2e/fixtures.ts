// Shared E2E fixtures: every test fails on a console error or an uncaught page error, and helpers mock the
// platform status and a scripted live run (events in batches, then the final report) through route
// interception — the deployed UI is exercised unchanged, only the network answers are scripted.
import { type Page, type Route, test as base, expect } from "@playwright/test";

export interface GalleryEntry {
  id: string;
  slug: string;
  title: string;
  date: string;
  file: string;
  claims: number;
}
export interface Claim {
  id: string;
  text: string;
  checkworthy: boolean;
}
export interface Verdict {
  claimId: string;
  label: string;
  confidence: number;
  abstained: boolean;
  rationale: string;
  rawLabel?: string;
  cited?: string[];
  samples?: unknown[];
}
export interface Report {
  runId: string;
  title?: string;
  inputText: string;
  claims: Claim[];
  evidence: Record<string, unknown[]>;
  debate: Record<string, unknown[]>;
  verdicts: Record<string, Verdict>;
  factuality: number | null;
  trace: unknown[];
  partial: boolean;
  provider: string;
  createdAt: string;
}

/** Console guard: any console error or page error fails the test unless the test allowed it explicitly. */
export interface ConsoleGuard {
  allow(pattern: RegExp): void;
}

export const test = base.extend<{ consoleGuard: ConsoleGuard }>({
  consoleGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      // Content-Security-Policy violations (the deployed _headers policy) count as errors too.
      await page.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (e) =>
          console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
        ),
      );
      await use({ allow: (p) => void allowed.push(p) });
      expect(
        errors.filter((e) => !allowed.some((p) => p.test(e))),
        "console errors",
      ).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1000) < 700;

/** The newest recorded run (what the Desk opens on) and the whole gallery, read from the deployed site. */
export async function gallery(
  page: Page,
): Promise<{ runs: GalleryEntry[]; latest: GalleryEntry; richest: GalleryEntry }> {
  const res = await page.request.get("gallery/index.json");
  const { runs } = (await res.json()) as { runs: GalleryEntry[] };
  return {
    runs,
    latest: runs.reduce((a, b) => (b.date > a.date ? b : a)),
    // the run with the most claims: the scripted live/partial runs need at least two
    richest: runs.reduce((a, b) => (b.claims > a.claims ? b : a)),
  };
}

export async function recordedReport(page: Page, file: string): Promise<Report> {
  return (await (await page.request.get(`gallery/${file}`)).json()) as Report;
}

type DemoState = "live" | "capacity" | "waking" | "down";

/** Answers /api/status with the given Satya state (a real response is fetched and edited). */
export async function mockStatus(page: Page, state: DemoState, etaS = 60) {
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch().catch(() => null);
    const body = (await res?.json().catch(() => null)) as { projects: Record<string, unknown> } | null;
    if (!res || !body) return route.abort().catch(() => undefined); // the test already ended
    body.projects.satya = { live: state === "live", state, ...(state === "waking" ? { etaS } : {}) };
    await route.fulfill({ response: res, json: body }).catch(() => undefined);
  });
}

/** Owner mode in this browser: skips Turnstile in the UI (the mocked API never sees the token). */
export async function ownerMode(page: Page) {
  await page.addInitScript(() => localStorage.setItem("satya.ownerToken", "e2e-not-a-real-token"));
}

/** The verdict the cloud executor writes for a claim skipped when capacity ran out (same shape as runhub's). */
const capacityVerdict = (claimId: string): Verdict => ({
  claimId,
  label: "NOT_ENOUGH_INFO",
  rawLabel: "NOT_ENOUGH_INFO",
  confidence: 0,
  abstained: true,
  rationale: "capacity",
  cited: [],
  samples: [],
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * A scripted live run built from a recorded report: claims → evidence → verdicts arrive over three polls,
 * then the final report. `outcome` forces the partial (capacity) and failed endings.
 */
export async function mockLiveRun(
  page: Page,
  report: Report,
  outcome: "done" | "partial" | "failed" = "done",
  runId = "e2e-run-0001",
) {
  const checked = report.claims.filter((c) => c.checkworthy);
  const verdicts = checked.map((c) => report.verdicts[c.id]!).filter(Boolean);
  let seq = 0;
  const ev = (type: string, data: unknown) => ({ seq: ++seq, ts: Date.now(), type, data });
  const total = 20;
  const batches = [
    [ev("stage", { step: 1, of: total, last: "decompose" }), ev("claims", { claims: report.claims })],
    [
      ev("stage", { step: 8, of: total, last: `rerank:${checked[0]?.id}` }),
      ...checked.map((c) => ev("evidence", { claimId: c.id, evidence: report.evidence[c.id] ?? [] })),
    ],
    outcome === "failed"
      ? [ev("run_failed", { message: "The language model is unavailable right now." })]
      : outcome === "partial"
        ? [
            ev("verdict", verdicts[0]),
            ev("capacity", {
              claimIds: checked.slice(1).map((c) => c.id),
              message: "Today's free capacity ran out during this run.",
            }),
            ...checked.slice(1).map((c) => ev("verdict", capacityVerdict(c.id))),
            ev("run_completed", { factuality: null, partial: true }),
          ]
        : [...verdicts.map((v) => ev("verdict", v)), ev("run_completed", { factuality: report.factuality })],
  ];
  const final: Report =
    outcome === "partial"
      ? {
          ...report,
          runId,
          partial: true,
          factuality: null,
          verdicts: Object.fromEntries(
            checked.map((c, i) => [c.id, i === 0 ? verdicts[0]! : capacityVerdict(c.id)]),
          ),
        }
      : { ...report, runId };
  const status = { done: "done", partial: "partial", failed: "failed" }[outcome];

  let polls = 0;
  await page.route("**/api/satya/runs", (route) =>
    route.request().method() === "POST"
      ? json(route, { runId, cached: false, provider: "workersai" })
      : route.fallback(),
  );
  await page.route(`**/api/satya/runs/${runId}/events**`, (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
    const batch = batches[Math.min(polls++, batches.length - 1)]!.filter((e) => e.seq > after);
    return json(route, { events: batch });
  });
  await page.route(`**/api/satya/runs/${runId}`, (route) =>
    // Before the run ends the report endpoint says "running" (the UI then keeps polling events).
    json(route, { status: polls >= batches.length ? status : "running", report: final }),
  );
  return { runId, checked, final };
}

/** POST /api/satya/runs answers with an error body in the platform's standard shape. */
export async function mockCreateError(page: Page, status: number, code: string, message: string) {
  await page.route("**/api/satya/runs", (route) =>
    route.request().method() === "POST"
      ? json(route, { error: { code, message, retryAfterS: 0, fallback: "gallery" } }, status)
      : route.fallback(),
  );
}

export async function shot(page: Page, name: string) {
  const project = test.info().project.name;
  await page.screenshot({ path: `../qa/screens/${project}/${name}.png`, fullPage: true });
}

/** Margin notes (desktop) are stacked without overlapping — checked after layout settles (fonts loaded). */
export async function expectNotesApart(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const boxes = await page
        .getByRole("list", { name: "Verdicts" })
        .getByRole("button")
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
      return boxes.every(([top], i) => i === 0 || top! >= boxes[i - 1]![1]! - 0.5);
    })
    .toBe(true);
}
