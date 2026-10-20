// A stand-in for aj-gateway in tests: the same RPC surface, deterministic answers, and a switchable mode.
import { WorkerEntrypoint } from "cloudflare:workers";

let mode = "ok"; // ok | capacity | ratelimited | groq-only
const calls = [];

export default class FakeGateway extends WorkerEntrypoint {
  setMode(m) {
    mode = m;
    calls.length = 0;
  }
  calls() {
    return [...calls];
  }
  hashIp(ip) {
    return `hash-${ip}`;
  }
  checkSession({ token, ipHash }) {
    return token === `valid-for-${ipHash}` ? { ok: true, sessionId: "session-1" } : { ok: false };
  }
  consume(req) {
    calls.push(["consume", req.kind]);
    if (mode === "ratelimited")
      return { ok: false, remaining: 0, resetAt: new Date(Date.now() + 3600_000).toISOString() };
    return { ok: true, remaining: 2, resetAt: new Date(Date.now() + 3600_000).toISOString() };
  }
  remaining() {
    if (mode === "capacity") return { neurons: 0, groqTokens: 0, live: false };
    if (mode === "groq-only") return { neurons: 0, groqTokens: 100_000, live: true };
    return { neurons: 4500, groqTokens: 100_000, live: true };
  }
  llm(req) {
    calls.push(["llm", req.task, req.pin?.provider]);
    const text = req.task === "decomposer" ? JSON.stringify({ claims: [] }) : "{}";
    return {
      text,
      provider: req.pin?.provider ?? "workersai",
      model: "@cf/openai/gpt-oss-120b",
      usage: { input: 1, output: 1 },
      neurons: 0.1,
      latencyMs: 1,
      cached: false,
    };
  }
  embed({ texts }) {
    return texts.map(() => [1, 0, 0]);
  }
  rerank({ passages }) {
    return passages.map(() => 0);
  }
}
