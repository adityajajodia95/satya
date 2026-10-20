import { readFileSync } from "node:fs";
import { MemoryToolCache, type ToolContext, type ToolsConfig } from "../src/index";
import { htmlToTextNode } from "../src/text/node";

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export const CONFIG: ToolsConfig = {
  enabled: ["web_search", "wiki_search", "wiki_page", "arxiv_search", "scholar_search", "fetch_url"],
  maxResults: 5,
  fetchMaxBytes: 150_000,
  fetchTextChars: 20_000,
  userAgent: "SatyaFactCheck/1.0 (+https://adityajajodia.com; adityajajodia95@gmail.com)",
};

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** A fake fetch: the first route returning a Response wins; every request is recorded. */
export function fakeFetch(...routes: Route[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new TypeError(`fetch failed: no route for ${url.href}`);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });

export function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: CONFIG,
    htmlToText: htmlToTextNode,
    cache: new MemoryToolCache(),
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  };
}
