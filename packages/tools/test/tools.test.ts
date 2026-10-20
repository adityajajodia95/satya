import { describe, expect, it } from "vitest";
import { HostRateLimiter, assertPublicHttpUrl, createTools } from "../src/index";
import { parseRetryAfterMs } from "../src/http";
import { context, fakeFetch, fixture, json } from "./helpers";

const host = (h: string) => (url: URL) => url.host === h;
const serve = (match: (u: URL) => boolean, res: () => Response) => (u: URL) => (match(u) ? res() : undefined);

describe("wiki_search", () => {
  it("parses real search results into docs with plain-text snippets", async () => {
    const { fetch, calls } = fakeFetch(
      serve(host("en.wikipedia.org"), () => json(fixture("wiki_search.json"))),
    );
    const result = await createTools(context({ fetch })).call("wiki_search", {
      query: "Eiffel Tower completed 1889",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs.length).toBeGreaterThan(0);
    const top = result.docs[0]!;
    expect(top.source).toBe("wikipedia");
    expect(top.url).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
    expect(result.docs.every((d) => !/<span|&quot;/.test(d.text))).toBe(true);
    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: "query",
      list: "search",
      format: "json",
      srsearch: "Eiffel Tower completed 1889",
      srlimit: "5",
    });
    expect(new Headers(calls[0]!.init?.headers).get("user-agent")).toContain("SatyaFactCheck/1.0");
  });
});

describe("wiki_page", () => {
  it("returns the plain-text extract (following redirects), capped at fetchTextChars", async () => {
    const { fetch, calls } = fakeFetch(
      serve(host("en.wikipedia.org"), () => json(fixture("wiki_page.json"))),
    );
    const result = await createTools(context({ fetch })).call("wiki_page", { title: "Eiffel tower" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]!.title).toBe("Eiffel Tower");
    expect(result.docs[0]!.text).toContain("1889");
    expect(result.docs[0]!.text.length).toBeLessThanOrEqual(20_000);
    expect(new URL(calls[0]!.url).searchParams.get("redirects")).toBe("1");
    expect(new URL(calls[0]!.url).searchParams.get("explaintext")).toBe("1");
  });

  it("maps a missing page to a friendly not_found error", async () => {
    const { fetch } = fakeFetch(
      serve(host("en.wikipedia.org"), () => json(fixture("wiki_page_missing.json"))),
    );
    const result = await createTools(context({ fetch })).call("wiki_page", {
      title: "Zzqxv no such page 4821",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("scholar_search", () => {
  it("parses real results and skips papers without an abstract", async () => {
    const raw = JSON.parse(fixture("scholar.json")) as { data: { abstract: string | null }[] };
    const { fetch } = fakeFetch(serve(host("api.semanticscholar.org"), () => json(raw)));
    const result = await createTools(context({ fetch })).call("scholar_search", {
      query: "scientific claim verification",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs).toHaveLength(raw.data.filter((p) => p.abstract).length);
    expect(result.docs.every((d) => d.source === "scholar" && d.text.length > 0)).toBe(true);
  });

  it("backs off on 429 honouring Retry-After, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const { fetch } = fakeFetch(
      serve(host("api.semanticscholar.org"), () =>
        ++n === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
          : json(fixture("scholar.json")),
      ),
    );
    const sleep = (ms: number) => (waits.push(ms), Promise.resolve());
    const result = await createTools(context({ fetch, sleep })).call("scholar_search", { query: "x" });
    expect(result.ok).toBe(true);
    expect(waits).toEqual([2000]);
  });

  it("degrades to a friendly rate_limited error after the retries", async () => {
    const { fetch, calls } = fakeFetch(
      serve(host("api.semanticscholar.org"), () => new Response("", { status: 429 })),
    );
    const result = await createTools(context({ fetch })).call("scholar_search", { query: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(calls).toHaveLength(3); // 1 try + 2 retries
  });
});

describe("web_search (Tavily)", () => {
  it("is unavailable without a key and never calls the API", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await createTools(context({ fetch })).call("web_search", { query: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(calls).toHaveLength(0);
  });

  it("respects the monthly credit guard", async () => {
    const { fetch, calls } = fakeFetch();
    const guard = { tryConsume: () => Promise.resolve(false) };
    const result = await createTools(context({ fetch, tavily: { apiKey: "k", guard } })).call("web_search", {
      query: "x",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "quota" } });
    expect(calls).toHaveLength(0);
  });

  it("sends a basic search with bearer auth and maps results", async () => {
    const { fetch, calls } = fakeFetch(serve(host("api.tavily.com"), () => json(fixture("tavily.json"))));
    const result = await createTools(context({ fetch, tavily: { apiKey: "tvly-test" } })).call("web_search", {
      query: "Eiffel Tower completed",
      maxResults: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs.every((d) => d.source === "web" && d.url)).toBe(true);
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tvly-test");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "Eiffel Tower completed",
      search_depth: "basic",
      include_answer: false,
      max_results: 3,
    });
  });
});

describe("fetch_url", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://localhost:8787/",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://printer.local/",
    "http://intranet/",
    "http://user:pw@example.com/",
  ])("blocks %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });

  it("allows public http(s) URLs", () => {
    expect(assertPublicHttpUrl("https://www.cdc.gov/flu/about/index.html").host).toBe("www.cdc.gov");
    expect(assertPublicHttpUrl("http://8.8.8.8/").host).toBe("8.8.8.8");
  });

  it("extracts readable text from an HTML page", async () => {
    const { fetch } = fakeFetch(
      serve(
        host("www.cdc.gov"),
        () =>
          new Response(fixture("pages/cdc-flu.html"), {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );
    const result = await createTools(context({ fetch })).call("fetch_url", {
      url: "https://www.cdc.gov/flu/about/index.html",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs[0]).toMatchObject({ source: "web", title: "About Influenza | Influenza (Flu) | CDC" });
    expect(result.docs[0]!.text).toMatch(/influenza/i);
  });

  it("re-checks every redirect and blocks a redirect to a private address", async () => {
    const { fetch } = fakeFetch(
      serve(
        host("example.com"),
        () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      ),
    );
    const result = await createTools(context({ fetch })).call("fetch_url", { url: "https://example.com/" });
    expect(result).toMatchObject({ ok: false, error: { code: "blocked" } });
  });

  it("follows a public redirect", async () => {
    const { fetch } = fakeFetch(
      serve(
        host("example.com"),
        () => new Response(null, { status: 301, headers: { location: "https://www.example.org/p" } }),
      ),
      serve(
        host("www.example.org"),
        () => new Response("<title>P</title><p>Hello</p>", { headers: { "content-type": "text/html" } }),
      ),
    );
    const result = await createTools(context({ fetch })).call("fetch_url", { url: "https://example.com/" });
    expect(result).toMatchObject({
      ok: true,
      docs: [{ url: "https://www.example.org/p", title: "P", text: "Hello" }],
    });
  });

  it("refuses non-HTML content", async () => {
    const { fetch } = fakeFetch(
      serve(
        host("example.com"),
        () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      ),
    );
    const result = await createTools(context({ fetch })).call("fetch_url", {
      url: "https://example.com/a.pdf",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "blocked" } });
  });

  it("reads at most fetchMaxBytes of the body", async () => {
    const big = `<p>${"a".repeat(400_000)}</p>`;
    const { fetch } = fakeFetch(
      serve(host("example.com"), () => new Response(big, { headers: { "content-type": "text/html" } })),
    );
    const tools = createTools(
      context({ fetch, config: { ...context().config, fetchMaxBytes: 1000, fetchTextChars: 100_000 } }),
    );
    const result = await tools.call("fetch_url", { url: "https://example.com/" });
    expect(result.ok && result.docs[0]!.text.length).toBe(997); // 1000 bytes minus "<p>"
  });
});

describe("registry", () => {
  it("rejects invalid arguments without calling out", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await createTools(context({ fetch })).call("wiki_search", { query: "" });
    expect(result).toMatchObject({ ok: false, error: { code: "blocked" } });
    expect(calls).toHaveLength(0);
  });

  it("refuses tools that are not enabled", async () => {
    const tools = createTools(context({ config: { ...context().config, enabled: ["wiki_search"] } }));
    expect(await tools.call("fetch_url", { url: "https://example.com" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("serves repeated calls from the cache and marks them cached", async () => {
    const { fetch, calls } = fakeFetch(
      serve(host("en.wikipedia.org"), () => json(fixture("wiki_search.json"))),
    );
    const tools = createTools(context({ fetch }));
    const first = await tools.call("wiki_search", { query: "Eiffel", maxResults: 5 });
    const second = await tools.call("wiki_search", { maxResults: 5, query: "Eiffel" });
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
  });

  it("never throws: network errors and timeouts become error results", async () => {
    const failing = createTools(
      context({ fetch: (() => Promise.reject(new TypeError("ECONNRESET"))) as typeof fetch }),
    );
    expect(await failing.call("wiki_search", { query: "x" })).toMatchObject({
      ok: false,
      error: { code: "network" },
    });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = createTools(context({ fetch: (() => Promise.reject(timeout)) as typeof fetch }));
    expect(await slow.call("wiki_search", { query: "x" })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });
});

describe("politeness and retry helpers", () => {
  it("spaces requests to the same host ≥ 1 s apart, hosts independent, arXiv 3 s", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new HostRateLimiter(
      1000,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    await limiter.wait("en.wikipedia.org");
    await limiter.wait("en.wikipedia.org");
    await limiter.wait("api.semanticscholar.org");
    await limiter.wait("export.arxiv.org");
    await limiter.wait("export.arxiv.org");
    expect(slept).toEqual([1000, 3000]);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(
      10_000,
    );
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

describe("arxiv_search", () => {
  it("parses the real Atom feed (titles, abstracts, https URLs, dates)", async () => {
    const { fetch, calls } = fakeFetch(
      serve(
        host("export.arxiv.org"),
        () => new Response(fixture("arxiv.xml"), { headers: { "content-type": "application/atom+xml" } }),
      ),
    );
    const result = await createTools(context({ fetch })).call("arxiv_search", {
      query: "fact verification scientific claims",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.docs.length).toBeGreaterThan(0);
    for (const doc of result.docs) {
      expect(doc.source).toBe("arxiv");
      expect(doc.url).toMatch(/^https:\/\/arxiv\.org\/abs\//);
      expect(doc.title.length).toBeGreaterThan(5);
      expect(doc.text.length).toBeGreaterThan(50);
      expect(doc.text).not.toMatch(/<|&lt;|\s{2}/);
      expect(doc.published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(new URL(calls[0]!.url).searchParams.get("search_query")).toBe(
      "all:fact verification scientific claims",
    );
  });

  it("maps arXiv's error feed to a bad_response instead of a paper titled 'Error'", async () => {
    const { fetch } = fakeFetch(
      serve(host("export.arxiv.org"), () => new Response(fixture("arxiv_error.xml"))),
    );
    const result = await createTools(context({ fetch })).call("arxiv_search", { query: "x" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "bad_response", message: "arXiv error: incorrect id format for 1234.12345" },
    });
  });

  it("treats a non-Atom body as a bad response", async () => {
    const { fetch } = fakeFetch(serve(host("export.arxiv.org"), () => new Response("Rate exceeded.")));
    const result = await createTools(context({ fetch })).call("arxiv_search", { query: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });
});
