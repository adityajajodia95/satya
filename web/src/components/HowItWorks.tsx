// "How it works" panel with the MCP card: the public endpoint, a copy button and a 3-line config snippet.
import { useState } from "react";
import s from "./desk.module.css";

export const MCP_URL = "https://aj-demos.pages.dev/api/satya/mcp";
const SNIPPET = `"satya": {\n  "type": "http",\n  "url": "${MCP_URL}"\n}`;

export function HowItWorks() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <aside className={s.how} aria-labelledby="how-title">
      <h2 id="how-title" className="label">
        How it works
      </h2>
      <ol className={s.steps}>
        <li>
          <span className="mono">1</span> Split into claims
        </li>
        <li>
          <span className="mono">2</span> Find evidence
        </li>
        <li>
          <span className="mono">3</span> Argue both sides
        </li>
        <li>
          <span className="mono">4</span> Judge &amp; cite
        </li>
      </ol>
      <p className={s.howNote}>
        Wikipedia, the web and research papers are searched; an advocate and a skeptic debate each claim;
        three judges vote, and Satya abstains when the evidence is thin.
      </p>
      <section className={s.mcp} aria-labelledby="mcp-title">
        <h3 id="mcp-title" className="label">
          Use the evidence tools (MCP)
        </h3>
        <p className={s.howNote}>
          Satya's search tools are a public MCP server you can add to Claude Desktop or VS Code.
        </p>
        <div className={s.mcpUrl}>
          <code className="mono">{MCP_URL}</code>
          <button type="button" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className={s.snippet} aria-label="MCP client configuration" tabIndex={0}>
          <code>{SNIPPET}</code>
        </pre>
      </section>
    </aside>
  );
}
