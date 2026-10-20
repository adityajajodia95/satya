// The pipeline's `Tools` port backed by an MCP client: agents reach their evidence through `tools/call` on
// Satya's MCP server (in-process, or any Streamable HTTP endpoint such as the deployed /api/satya/mcp),
// so the research agent is a genuine MCP client. Results map back to the exact `ToolResult` the direct
// path returns (asserted in test/client.test.ts), so switching transport never changes model input.
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ToolErrorCode, type ToolName, type ToolResult, type Tools } from "@satya/core";
import { SERVER_INFO, type SatyaMcpOptions, ToolOutput, createSatyaMcpServer } from "./server";

const CLIENT_INFO = { name: "satya-research-agent", version: SERVER_INFO.version } as const;

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

/** Error results carry "code: message" (see server.ts); anything else is an unavailable tool. */
function parseError(tool: ToolName, result: CallResult): ToolResult {
  const text = (result.content as { type: string; text?: string }[] | undefined)?.find(
    (c) => c.type === "text",
  )?.text;
  const match = /^([a-z_]+): ([\s\S]*)$/.exec(text ?? "");
  const code = ToolErrorCode.safeParse(match?.[1]);
  return code.success
    ? { ok: false, tool, error: { code: code.data, message: match![2]! } }
    : { ok: false, tool, error: { code: "unavailable", message: text || "The MCP tool call failed" } };
}

export class McpTools implements Tools {
  constructor(
    private readonly client: Client,
    private readonly onClose: () => Promise<void> = () => client.close(),
  ) {}

  async call(name: ToolName, args: object): Promise<ToolResult> {
    let result: CallResult;
    try {
      result = await this.client.callTool({ name, arguments: args as Record<string, unknown> });
    } catch (e) {
      return { ok: false, tool: name, error: { code: "network", message: `MCP: ${(e as Error).message}` } };
    }
    if (result.isError) return parseError(name, result);
    const out = ToolOutput.safeParse(result.structuredContent);
    if (!out.success)
      return { ok: false, tool: name, error: { code: "bad_response", message: "MCP result without docs" } };
    return { ok: true, tool: name, docs: out.data.docs, cached: out.data.cached };
  }

  /** Tool names the server offers (`tools/list`). */
  async list(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  close(): Promise<void> {
    return this.onClose();
  }
}

/** Satya's MCP server and an MCP client joined in-process (full MCP protocol, no network hop). */
export async function connectInProcess(tools: Tools, opts: SatyaMcpOptions): Promise<McpTools> {
  const server = createSatyaMcpServer(tools, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return new McpTools(client, async () => {
    await client.close();
    await server.close();
  });
}

/** An MCP client for a remote Streamable HTTP server (e.g. https://aj-demos.pages.dev/api/satya/mcp). */
export async function connectHttp(
  url: ConstructorParameters<typeof StreamableHTTPClientTransport>[0],
): Promise<McpTools> {
  const client = new Client(CLIENT_INFO);
  await client.connect(new StreamableHTTPClientTransport(url));
  return new McpTools(client);
}

/** `Tools` that open their MCP connection on first use (ports are built synchronously). */
export function lazyMcpTools(connect: () => Promise<McpTools>): Tools {
  let connection: Promise<McpTools> | undefined;
  return {
    call: async (name, args) => {
      connection ??= connect().catch((e: unknown) => {
        connection = undefined; // retry the handshake on the next call
        throw e;
      });
      let tools: McpTools;
      try {
        tools = await connection;
      } catch (e) {
        return {
          ok: false,
          tool: name,
          error: { code: "network", message: `MCP connect: ${(e as Error).message}` },
        };
      }
      return tools.call(name, args);
    },
  };
}
