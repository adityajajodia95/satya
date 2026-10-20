import { SELF, env, runInDurableObject } from "cloudflare:test";
import { initialState, variantFor } from "@satya/core";
import {
  FakeEmbedder,
  FakeReranker,
  FakeTools,
  GOLDEN_STEPS,
  GOLDEN_TEXT,
  goldenLlm,
} from "@satya/core/testing";
import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config";
import { type SatyaEnv, archiveOf, hubOf } from "../src/env";
import { cacheKeyFor } from "../src/index";
import type { RunHubDO } from "../src/runhub";
import { type StepDriver, orchestrate } from "../src/workflow";

const E = env as unknown as SatyaEnv & {
  GATEWAY: { setMode(m: string): Promise<void>; calls(): Promise<unknown[][]> };
};

/** Runs step.do callbacks immediately and records the names (a stand-in for the Workflows engine). */
function immediateSteps() {
  const names: string[] = [];
  const driver: StepDriver = {
    async do<T>(name: string, a: object | (() => Promise<T>), b?: () => Promise<T>) {
      names.push(name);
      return (typeof a === "function" ? a : b!)() as Promise<T>;
    },
  };
  return { driver, names };
}

async function goldenRun(runId: string) {
  const hub = hubOf(E, runId);
  const variant = variantFor("satya_full", CONFIG, { decompose: true, evidence: "tools" });
  await hub.init(
    { runId, createdAt: "2026-10-14T00:00:00Z", pin: "workersai", budgetClass: "demo" },
    initialState({ runId, text: GOLDEN_TEXT, sources: ["wikipedia"], maxClaims: 6, variant }),
  );
  await runInDurableObject(hub, (instance: RunHubDO) => {
    instance.portsOverride = {
      llm: goldenLlm(),
      embedder: new FakeEmbedder(),
      reranker: new FakeReranker(),
      tools: new FakeTools(),
    };
  });
  return hub;
}

describe("executor parity (§6.2, §8)", () => {
  it("the Workflow orchestration walks exactly the laptop's golden step sequence", async () => {
    await archiveOf(E).addRun({
      id: "golden-run-1",
      preview: GOLDEN_TEXT,
      model: "gpt-oss-120b",
      provider: "workersai",
      inputHash: "h",
      owner: null,
    });
    const hub = await goldenRun("golden-run-1");
    const { driver, names } = immediateSteps();
    const executed = await orchestrate(E, "golden-run-1", driver);
    expect(executed).toEqual(GOLDEN_STEPS);
    expect(names.filter((n) => !n.startsWith("frontier:") && n !== "start" && n !== "finalize")).toEqual(
      GOLDEN_STEPS,
    );
    const result = await hub.report();
    expect(result!.status).toBe("done");
    expect(result!.report.verdicts.c1).toMatchObject({ label: "SUPPORTED" });
    expect(result!.report.verdicts.c2).toMatchObject({ label: "REFUTED" });
    expect(result!.report.factuality).toBe(0.5);
    expect(result!.report.executor).toBe("cloud");
    const types = ((await hub.events(0)) as unknown as { type: string }[]).map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");
    expect((await archiveOf(E).runs(["golden-run-1"]))[0]).toMatchObject({
      status: "done",
      factuality: 0.5,
      nClaims: 2,
    });
  });

  it("a step that keeps failing marks only its claim NEI 'pipeline error'", async () => {
    const hub = await goldenRun("golden-run-2");
    const { driver } = immediateSteps();
    const failing: StepDriver = {
      async do<T>(name: string, a: object | (() => Promise<T>), b?: () => Promise<T>) {
        if (name === "argue:c2:r1:skeptic") throw new Error("model crashed after retries");
        return driver.do(name, a as object, b as () => Promise<T>);
      },
    };
    await orchestrate(E, "golden-run-2", failing);
    const r = (await hub.report())!.report;
    expect(r.verdicts.c2).toMatchObject({ label: "NOT_ENOUGH_INFO", rationale: "pipeline error" });
    expect(r.verdicts.c1!.label).toBe("SUPPORTED");
  });

  it("capacity running out mid-run finishes remaining claims as NEI 'capacity' and marks the report partial", async () => {
    const hub = await goldenRun("golden-run-3");
    await runInDurableObject(hub, (instance: RunHubDO) => {
      const llm = goldenLlm();
      instance.portsOverride = {
        ...instance.portsOverride,
        llm: {
          chat: (req) =>
            req.task === "judge"
              ? Promise.reject(new Error("gateway:capacity_exhausted:3600:today's free capacity is used"))
              : llm.chat(req),
        },
      };
    });
    await orchestrate(E, "golden-run-3", immediateSteps().driver);
    const r = await hub.report();
    expect(r!.status).toBe("partial");
    expect(r!.report.partial).toBe(true);
    expect(Object.values(r!.report.verdicts).every((v) => v.rationale === "capacity")).toBe(true);
    expect(((await hub.events(0)) as unknown as { type: string }[]).some((e) => e.type === "capacity")).toBe(
      true,
    );
  });
});

describe("public API (§7 M10)", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch("https://aj-demos.pages.dev/api/satya/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
      body: JSON.stringify(body),
    });

  it("requires a Turnstile session (or owner mode)", async () => {
    await E.GATEWAY.setMode("ok");
    expect((await post({ text: "The Eiffel Tower is in Paris." })).status).toBe(401);
    const ok = await post(
      { text: "The Eiffel Tower is in Paris." },
      { Cookie: "aj_s=valid-for-hash-203.0.113.9" },
    );
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ cached: false, provider: "workersai" });
  });

  it("validates input: empty and over 2,000 characters → 400", async () => {
    const owner = { "X-Satya-Owner": "test-owner" };
    expect((await post({ text: "  " }, owner)).status).toBe(400);
    expect((await post({ text: "x".repeat(2001) }, owner)).status).toBe(400);
    expect((await post({ text: "ok", sources: ["blogs"] }, owner)).status).toBe(400);
  });

  it("per-IP limit → 429 rate_limited with the gallery fallback", async () => {
    await E.GATEWAY.setMode("ratelimited");
    const res = await post({ text: "Water boils at 100 C." }, { Cookie: "aj_s=valid-for-hash-203.0.113.9" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited", fallback: "gallery" } });
  });

  it("owner mode skips the per-IP limit", async () => {
    await E.GATEWAY.setMode("ratelimited");
    expect(
      (await post({ text: "Water boils at 100 C at sea level." }, { "X-Satya-Owner": "test-owner" })).status,
    ).toBe(202);
    expect((await E.GATEWAY.calls()).some((c) => c[0] === "consume")).toBe(false);
  });

  it("no capacity → 507 capacity_exhausted with the gallery fallback, and the visitor's quota is not spent", async () => {
    await E.GATEWAY.setMode("capacity");
    const res = await post(
      { text: "Mount Everest is the tallest mountain." },
      { Cookie: "aj_s=valid-for-hash-203.0.113.9" },
    );
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ error: { code: "capacity_exhausted", fallback: "gallery" } });
    expect((await E.GATEWAY.calls()).some((c) => c[0] === "consume")).toBe(false);
  });

  it("pins Groq when only Groq has capacity", async () => {
    await E.GATEWAY.setMode("groq-only");
    const res = await post({ text: "Penicillin was discovered in 1928." }, { "X-Satya-Owner": "test-owner" });
    expect(await res.json()).toMatchObject({ provider: "groq" });
  });

  it("a cache hit returns {runId, cached: true} before any quota is consumed (C3, C4)", async () => {
    await E.GATEWAY.setMode("ok");
    const text = "The Taj Mahal is in Agra.";
    await archiveOf(E).cachePut(await cacheKeyFor(text, ["papers", "web", "wikipedia"]), "cached-run-1", 30);
    const res = await post({ text }, { Cookie: "aj_s=valid-for-hash-203.0.113.9" });
    expect(await res.json()).toEqual({ runId: "cached-run-1", cached: true });
    expect((await E.GATEWAY.calls()).some((c) => c[0] === "consume")).toBe(false);
    // different sources → different key → not a hit
    const other = await post({ text, sources: ["wikipedia"] }, { Cookie: "aj_s=valid-for-hash-203.0.113.9" });
    expect(await other.json()).toMatchObject({ cached: false });
  });

  it("serves events, the report, the per-browser archive, and creator-only delete (C5)", async () => {
    await goldenRun("golden-run-4");
    await archiveOf(E).addRun({
      id: "golden-run-4",
      preview: GOLDEN_TEXT,
      model: "gpt-oss-120b",
      provider: "workersai",
      inputHash: "h",
      owner: "session-1",
    });
    await orchestrate(E, "golden-run-4", immediateSteps().driver);
    const events = (await (
      await SELF.fetch("https://x/api/satya/runs/golden-run-4/events?after=3")
    ).json()) as { events: { seq: number }[] };
    expect(events.events[0]!.seq).toBe(4);
    const report = (await (await SELF.fetch("https://x/api/satya/runs/golden-run-4")).json()) as {
      status: string;
    };
    expect(report.status).toBe("done");
    const list = (await (
      await SELF.fetch("https://x/api/satya/runs?ids=golden-run-4,unknown-run-99")
    ).json()) as { runs: { id: string }[] };
    expect(list.runs.map((r) => r.id)).toEqual(["golden-run-4"]);
    const del = (cookie: string) =>
      SELF.fetch("https://x/api/satya/runs/golden-run-4", {
        method: "DELETE",
        headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.9" },
      });
    expect((await del("aj_s=nope")).status).toBe(403);
    expect((await del("aj_s=valid-for-hash-203.0.113.9")).status).toBe(200);
    expect(
      (await (await SELF.fetch("https://x/api/satya/runs/missing-run-0")).json()) as object,
    ).toMatchObject({ error: { code: "not_found" } });
  });

  it("serves the gallery index", async () => {
    expect(await (await SELF.fetch("https://x/api/satya/gallery")).json()).toMatchObject({
      project: "satya",
    });
  });

  it("MCP tools/list lists the five public tools (no web_search); foreign browser origins are refused", async () => {
    const rpc = (body: object, headers: Record<string, string> = {}) =>
      SELF.fetch("https://aj-demos.pages.dev/api/satya/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const text = await res.text();
    const payload = JSON.parse(text.includes("data:") ? text.split("data:").slice(-1)[0]!.trim() : text) as {
      result: { tools: { name: string }[] };
    };
    expect(payload.result.tools.map((t) => t.name).sort()).toEqual([
      "arxiv_search",
      "fetch_url",
      "scholar_search",
      "wiki_page",
      "wiki_search",
    ]);
    expect(
      (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { Origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("admin parity routes need the bearer token; enqueue → status → results", async () => {
    const admin = { Authorization: "Bearer test-admin", "Content-Type": "application/json" };
    expect((await SELF.fetch("https://x/api/satya/admin/parity/status")).status).toBe(401);
    const items = [{ id: "fever:1", dataset: "fever", claim: "Paris is in France.", gold: "SUPPORTED" }];
    const enq = await SELF.fetch("https://x/api/satya/admin/parity/enqueue", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ items }),
    });
    expect(await enq.json()).toMatchObject({ added: 1, counts: { queued: 1 } });
    expect((await SELF.fetch("https://x/api/satya/admin/parity/results", { headers: admin })).status).toBe(
      200,
    );
  });
});
