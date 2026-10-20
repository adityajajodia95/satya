import type { ToolDoc } from "@satya/core";
import { type ToolContext, ToolFailure } from "./context";
import { request } from "./http";

const MAX_REDIRECTS = 5;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

function ipv4Blocked(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

function ipv6Blocked(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped addresses; URL parsing normalises ::ffff:127.0.0.1 to ::ffff:7f00:1.
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return ipv4Blocked(dotted[1] as string);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1] as string, 16), parseInt(hex[2] as string, 16)];
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h); // unique-local fc00::/7, link-local fe80::/10
}

/**
 * Only public http(s) URLs. Hostnames are checked literally (runtime-agnostic: Workers cannot resolve
 * DNS, and Cloudflare's egress cannot reach private networks anyway).
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolFailure("blocked", "not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolFailure("blocked", `only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new ToolFailure("blocked", "URLs with credentials are not allowed");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!host.includes(".") && !host.includes(":")) ||
    ipv4Blocked(host) ||
    ipv6Blocked(host)
  ) {
    throw new ToolFailure("blocked", `private or local address not allowed: ${host}`);
  }
  return url;
}

/** Reads at most `maxBytes` of the body (then cancels the stream) and decodes it as UTF-8. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, maxBytes - total);
    chunks.push(take);
    total += take.length;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8").decode(bytes); // replacement characters for invalid bytes (non-fatal default)
}

export async function fetchUrl(ctx: ToolContext, rawUrl: string): Promise<ToolDoc[]> {
  let url = assertPublicHttpUrl(rawUrl);
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await request(ctx, url.href, {
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel();
    url = assertPublicHttpUrl(new URL(location, url).href);
    res = undefined;
  }
  if (!res) throw new ToolFailure("blocked", "too many redirects");
  const type = res.headers.get("content-type") ?? "";
  if (!HTML_TYPES.test(type)) {
    await res.body?.cancel();
    throw new ToolFailure("blocked", `not an HTML page (${type || "unknown type"})`);
  }
  const html = await readCapped(res, ctx.config.fetchMaxBytes);
  const page = await ctx.htmlToText(html, ctx.config.fetchTextChars);
  if (!page.text) throw new ToolFailure("not_found", "page has no readable text");
  return [
    { source: "web", url: url.href, title: page.title || url.hostname, text: page.text, published: null },
  ];
}
