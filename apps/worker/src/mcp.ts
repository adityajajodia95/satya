// Remote MCP server at /api/satya/mcp (§7 M10): Streamable HTTP, stateless, read-only tools, no web_search,
// 60 tool calls per IP per day (gateway quota), browser origins restricted.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createSatyaMcpServer } from "@satya/mcp";
import { HostRateLimiter, createTools } from "@satya/tools";
import { htmlToTextWorkers } from "@satya/tools/text/workers";
import { CONFIG } from "./config";
import { type SatyaEnv, archiveOf, gatewayOf } from "./env";

/** Browser pages may call the MCP endpoint only from our own origins; MCP clients send no Origin. */
export const ALLOWED_ORIGIN_HOSTNAMES = new Set([
  "aj-demos.pages.dev",
  "demos.adityajajodia.com",
  "localhost",
  "127.0.0.1",
]);

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return ALLOWED_ORIGIN_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function handleMcp(request: Request, env: SatyaEnv): Promise<Response> {
  if (!originAllowed(request)) return new Response("Origin not allowed", { status: 403 });
  const gateway = gatewayOf(env);
  const archive = archiveOf(env);
  const ipHash = await gateway.hashIp(request.headers.get("CF-Connecting-IP") ?? "0.0.0.0");
  const tools = createTools({
    config: CONFIG.tools,
    htmlToText: htmlToTextWorkers,
    limiter: new HostRateLimiter(),
    cache: { get: (k) => archive.toolGet(k), put: (k, d, t) => archive.toolPut(k, d, t) },
  });
  const handler = createMcpHandler(
    () =>
      createSatyaMcpServer(tools, {
        exposeWebSearch: false,
        beforeCall: async () => {
          const r = await gateway.consume({ project: "satya", kind: "mcp", ipHash });
          if (!r.ok)
            throw new Error(`Daily limit reached for your IP (60 tool calls); resets at ${r.resetAt}`);
        },
      }),
    { legacy: "stateless" },
  );
  return handler.fetch(request);
}
