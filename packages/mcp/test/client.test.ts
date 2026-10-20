// The research agent's MCP path must hand the pipeline exactly what the direct path does: real tools on
// recorded Wikipedia responses are called both ways and compared result by result, including errors and
// the cache flag; every tool error code survives the MCP round trip.
import { readFileSync } from "node:fs";
import { ToolErrorCode, type ToolName, type ToolResult, type Tools } from "@satya/core";
import { FakeTools } from "@satya/core/testing";
import { MemoryToolCache, createTools } from "@satya/tools";
import { htmlToTextNode } from "@satya/tools/text/node";
import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS, connectInProcess, lazyMcpTools } from "../src/index";

const fixture = (name: string) =>
  readFileSync(new URL(`../../tools/test/fixtures/${name}`, import.meta.url), "utf8");

/** Real tools whose only network is the recorded Wikipedia fixtures (anything else: not found). */
function recordedTools(): Tools {
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: string) => new Response(body, { headers: { "content-type": "application/json" } });
    if (url.searchParams.get("list") === "search") return json(fixture("wiki_search.json"));
    if (url.searchParams.get("titles")?.toLowerCase() === "eiffel tower")
      return json(fixture("wiki_page.json"));
    if (url.searchParams.has("titles")) return json(fixture("wiki_page_missing.json"));
    throw new TypeError(`fetch failed: ${url.href}`);
  }) as typeof globalThis.fetch;
  return createTools({
    config: {
      enabled: ["wiki_search", "wiki_page", "arxiv_search", "scholar_search", "fetch_url"],
      maxResults: 5,
      fetchMaxBytes: 150_000,
      fetchTextChars: 20_000,
      userAgent: "SatyaTest/1.0",
    },
    htmlToText: htmlToTextNode,
    cache: new MemoryToolCache(),
    fetch,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
}

const CALLS: [ToolName, object][] = [
  ["wiki_search", { query: "Eiffel Tower completed 1889" }],
  ["wiki_page", { title: "Eiffel tower" }],
  ["wiki_page", { title: "Zzqxv no such page 4821" }],
  ["wiki_search", { query: "Eiffel Tower completed 1889" }], // second time: served from the cache
];

describe("McpTools (research agent as an MCP client)", () => {
  it("returns exactly the direct path's results, errors and cache flags", async () => {
    const direct = recordedTools();
    const mcp = await connectInProcess(recordedTools(), { exposeWebSearch: false });
    const viaDirect: ToolResult[] = [];
    const viaMcp: ToolResult[] = [];
    for (const [name, args] of CALLS) {
      viaDirect.push(await direct.call(name, args));
      viaMcp.push(await mcp.call(name, args));
    }
    expect(viaMcp).toEqual(viaDirect);
    expect(viaMcp.map((r) => (r.ok ? `ok:${r.cached}` : r.error.code))).toEqual([
      "ok:false",
      "ok:false",
      "not_found",
      "ok:true",
    ]);
    await mcp.close();
  });

  it("discovers the tools over tools/list", async () => {
    const mcp = await connectInProcess(new FakeTools(), { exposeWebSearch: true });
    expect((await mcp.list()).sort()).toEqual(["web_search", ...PUBLIC_TOOLS].sort());
    await mcp.close();
  });

  it("keeps every tool error code across the MCP round trip", async () => {
    for (const code of ToolErrorCode.options) {
      const failing: Tools = {
        call: (name) =>
          Promise.resolve({ ok: false, tool: name, error: { code, message: `forced: ${code}` } }),
      };
      const mcp = await connectInProcess(failing, { exposeWebSearch: false });
      expect(await mcp.call("wiki_search", { query: "x" })).toEqual({
        ok: false,
        tool: "wiki_search",
        error: { code, message: `forced: ${code}` },
      });
      await mcp.close();
    }
  });

  it("a refused call (quota) and an unknown tool become tool errors, never exceptions", async () => {
    const mcp = await connectInProcess(new FakeTools(), {
      exposeWebSearch: false,
      beforeCall: () => Promise.reject(new Error("Daily MCP limit reached")),
    });
    expect(await mcp.call("wiki_search", { query: "x" })).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "Daily MCP limit reached" },
    });
    expect(await mcp.call("web_search", { query: "x" })).toMatchObject({ ok: false, tool: "web_search" });
    await mcp.close();
  });

  it("connects lazily; a failed handshake is a tool error and is retried on the next call", async () => {
    let attempts = 0;
    const tools = lazyMcpTools(() => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("connection refused"))
        : connectInProcess(new FakeTools(), { exposeWebSearch: false });
    });
    expect(attempts).toBe(0);
    expect(await tools.call("wiki_search", { query: "Eiffel Tower 1889" })).toMatchObject({
      ok: false,
      error: { code: "network", message: "MCP connect: connection refused" },
    });
    expect(await tools.call("wiki_search", { query: "Eiffel Tower 1889" })).toMatchObject({ ok: true });
    await tools.call("wiki_search", { query: "Eiffel Tower 1889" });
    expect(attempts).toBe(2);
  });
});
