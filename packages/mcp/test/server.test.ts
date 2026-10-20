import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ToolName, Tools } from "@satya/core";
import { FakeTools } from "@satya/core/testing";
import { describe, expect, it } from "vitest";
import { PUBLIC_TOOLS, type SatyaMcpOptions, createSatyaMcpServer, formatDocs } from "../src/index";

async function connect(tools: Tools, opts: SatyaMcpOptions) {
  const server = createSatyaMcpServer(tools, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("Satya MCP server", () => {
  it("lists the 5 public read-only tools; web_search only when exposed", async () => {
    const pub = await connect(new FakeTools(), { exposeWebSearch: false });
    const { tools } = await pub.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...PUBLIC_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const wiki = tools.find((t) => t.name === "wiki_search")!;
    expect(wiki.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    });
    expect(wiki.description).toMatch(/Wikipedia/);

    const laptop = await connect(new FakeTools(), { exposeWebSearch: true });
    expect((await laptop.listTools()).tools.map((t) => t.name)).toContain("web_search");
  });

  it("wiki_search('Eiffel Tower') returns results as text and structured content", async () => {
    const client = await connect(new FakeTools(), { exposeWebSearch: false });
    const result = await client.callTool({ name: "wiki_search", arguments: { query: "Eiffel Tower" } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { docs: { title: string }[]; cached: boolean };
    expect(structured.docs[0]!.title).toBe("Eiffel Tower");
    expect((result.content as { type: string; text: string }[])[0]!.text).toMatch(
      /^1\. Eiffel Tower — https:\/\/en\.wikipedia\.org\/wiki\/Eiffel_Tower/,
    );
  });

  it("tool failures and refused calls come back as isError results", async () => {
    const failing = await connect(new FakeTools(new Set<ToolName>(["wiki_search"])), {
      exposeWebSearch: false,
    });
    const r1 = await failing.callTool({ name: "wiki_search", arguments: { query: "x" } });
    expect(r1.isError).toBe(true);
    expect((r1.content as { text: string }[])[0]!.text).toBe("rate_limited: forced failure");

    const seen: ToolName[] = [];
    const limited = await connect(new FakeTools(), {
      exposeWebSearch: false,
      beforeCall: async (tool) => {
        seen.push(tool);
        if (seen.length > 1) throw new Error("Daily MCP limit reached for your IP (60 calls)");
      },
    });
    expect(
      (await limited.callTool({ name: "wiki_page", arguments: { title: "Eiffel Tower" } })).isError,
    ).toBeFalsy();
    const refused = await limited.callTool({ name: "wiki_page", arguments: { title: "Eiffel Tower" } });
    expect(refused.isError).toBe(true);
    expect(seen).toEqual(["wiki_page", "wiki_page"]);
  });

  it("rejects invalid arguments via the input schema", async () => {
    const client = await connect(new FakeTools(), { exposeWebSearch: false });
    const r = await client.callTool({ name: "fetch_url", arguments: { url: "not a url" } });
    expect(r.isError).toBe(true);
  });

  it("formats docs for text-only clients", () => {
    expect(formatDocs([])).toBe("No results.");
    expect(
      formatDocs([
        {
          source: "arxiv",
          url: "https://arxiv.org/abs/1",
          title: "T",
          text: "abstract",
          published: "2020-01-01",
        },
      ]),
    ).toBe("1. T — https://arxiv.org/abs/1 (2020-01-01)\nabstract");
  });
});
