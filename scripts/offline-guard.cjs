// Simulates "no internet" for a Node process: any socket to a non-loopback host throws.
// Usage (PowerShell): $env:NODE_OPTIONS="--require ./scripts/offline-guard.cjs"; npx satya verify --corpus scifact "..."
// Used by QA to prove the closed-corpus mode needs no network (Satya_Development.md §11).
const net = require("node:net");
const tls = require("node:tls");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const blocked = (host) => {
  const err = new Error(`offline-guard: blocked network access to ${host}`);
  err.code = "ENETUNREACH";
  throw err;
};
const hostOf = (args) => {
  const [a, b] = args;
  if (typeof a === "object" && a !== null)
    return a.host ?? a.hostname ?? (a.path ? "local-pipe" : "localhost");
  if (typeof a === "number") return typeof b === "string" ? b : "localhost";
  return "local-pipe";
};

for (const [mod, name] of [
  [net.Socket.prototype, "connect"],
  [tls, "connect"],
]) {
  const original = mod[name];
  mod[name] = function guarded(...args) {
    const host = hostOf(Array.isArray(args[0]) ? args[0] : args);
    if (host !== "local-pipe" && !LOOPBACK.has(String(host))) blocked(host);
    return original.apply(this, args);
  };
}
process.stderr.write("[offline-guard] non-loopback network disabled\n");
