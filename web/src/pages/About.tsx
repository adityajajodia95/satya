// "How it's built": the project explained for a reader who wants to understand the design, not run it —
// the flow of a check, the system architecture, the models, why each choice was made over the alternatives,
// how it was evaluated and tested, its limits, and who built it. No code and no build steps (those live in
// the repository). Result numbers are read from benchmarks.json, never typed in.
import { Link } from "react-router-dom";
import { AUTHOR } from "../App";
import { type BenchmarkRow, useBenchmarks } from "../lib/benchmarks";
import s from "./pages.module.css";

const FLOW: { phase: string; steps: { name: string; detail: string }[] }[] = [
  {
    phase: "1 · Understand the text",
    steps: [
      {
        name: "Decompose",
        detail:
          "The language model splits the text into single, self-contained factual claims and marks which ones are worth checking (opinions and greetings are skipped). Up to 6 claims per check.",
      },
      {
        name: "Plan",
        detail:
          "For each claim it writes up to 3 search queries and decides whether the claim is scientific (then research papers are searched too).",
      },
    ],
  },
  {
    phase: "2 · Gather evidence",
    steps: [
      {
        name: "Research through MCP tools",
        detail:
          "The research agent is an MCP client: it calls the evidence tools — Wikipedia search and pages, web search (Tavily) with the top pages fetched, arXiv and Semantic Scholar — through the Model Context Protocol.",
      },
      {
        name: "Hybrid retrieval",
        detail:
          "Pages are cut into passages and ranked twice: BM25 (keyword match) and bge-m3 embeddings (meaning match). The two top-20 lists are merged with reciprocal rank fusion.",
      },
      {
        name: "Re-rank",
        detail:
          "A cross-encoder (bge-reranker-base) reads the claim and each passage together and keeps the 5 most relevant passages as numbered evidence (E1–E5).",
      },
    ],
  },
  {
    phase: "3 · Argue and decide",
    steps: [
      {
        name: "Advocate ⇄ skeptic debate",
        detail:
          "An advocate argues the claim is supported, a skeptic argues it is not, over 2 rounds. Every argument must cite evidence passages.",
      },
      {
        name: "Three judges",
        detail:
          "Three independent judge samples read the evidence and the debate and each give a label with cited passages; the majority wins.",
      },
      {
        name: "Confidence and abstention",
        detail:
          "Confidence = 0.7 × judge agreement + 0.3 × the best re-rank score. Below a threshold τ the verdict becomes “not enough info” instead of a guess.",
      },
    ],
  },
  {
    phase: "4 · Report",
    steps: [
      {
        name: "Cited report",
        detail:
          "Each claim is underlined in the text with its verdict (supported, refuted, not enough info), confidence and citations; a factuality score summarises the text. Every model call is visible in the Trace tab.",
      },
    ],
  },
];

const ARCH: { layer: string; parts: string[]; why: string }[] = [
  {
    layer: "Browser",
    parts: ["React single-page app (this site)", "Invisible Turnstile check before a live run"],
    why: "Shows recorded runs instantly; a live run streams its progress every 1.5 s.",
  },
  {
    layer: "Edge — Cloudflare Pages",
    parts: ["Static site + API router", "Strict Content-Security-Policy"],
    why: "One public address for every demo; the router forwards /api/satya/* to the Satya service.",
  },
  {
    layer: "Satya API — Cloudflare Worker",
    parts: [
      "Validation, cache check, per-visitor limit, capacity check",
      "Public MCP endpoint (5 read-only tools)",
    ],
    why: "Refuses work early and cheaply: cached texts and over-limit requests never reach a model.",
  },
  {
    layer: "Run engine — Workflow + Durable Objects",
    parts: [
      "Cloudflare Workflow: one durable step per model or tool call (3 retries, timeouts)",
      "Run-hub object: run state and live events",
      "Archive object: runs (30 days), result cache",
    ],
    why: "A one-claim check makes about 23 model and tool calls over 30–60 s (each extra claim adds about 22); durable steps resume after a failure instead of starting over.",
  },
  {
    layer: "AI gateway — shared Cloudflare Worker",
    parts: [
      "Model routing: Workers AI first, Groq as fallback (same model)",
      "Daily budgets, per-visitor limits, circuit breakers, cache",
    ],
    why: "One place enforces the free-tier budget for all my demos, and one provider is pinned per run.",
  },
  {
    layer: "Providers (free tiers)",
    parts: [
      "Workers AI: gpt-oss-120b, bge-m3, bge-reranker-base",
      "Groq: gpt-oss-120b",
      "Wikipedia, Tavily, arXiv, Semantic Scholar",
    ],
    why: "Everything runs at ₹0; when today's free capacity is used, the demo falls back to recorded runs.",
  },
];

const MODELS: { model: string; role: string; why: string; over: string }[] = [
  {
    model: "gpt-oss-120b (OpenAI, open weights, Apache 2.0)",
    role: "All reasoning in the live demo: decomposition, planning, debate, judging",
    why: "Strong at structured, step-by-step reasoning and reliable JSON output, and served on two independent free tiers (Workers AI and Groq) — so the demo can fail over without changing the model mid-run.",
    over: "Paid APIs would cost money per check; hosting a model on my own GPU would cost money and need a server running all the time.",
  },
  {
    model: "Qwen3-4B (Alibaba, Apache 2.0) on Ollama",
    role: "The same pipeline on a laptop — used for all benchmark runs",
    why: "Fits a 6 GB GPU together with the embedding model while serving 3 requests in parallel (measured 5.12 GB). Its “thinking” mode improves judging, and Ollama constrains its output to a JSON schema. Runs offline, so benchmarks are reproducible and free.",
    over: "7–8B models would not leave room for parallel requests within 6 GB; 1–3B models are weaker at multi-step reasoning and structured output.",
  },
  {
    model: "bge-m3 (BAAI, MIT) embeddings",
    role: "Dense, meaning-based retrieval",
    why: "Strong multilingual retriever with long inputs (8,192 tokens), available both in Ollama and on Workers AI — so the laptop and the cloud compute identical embeddings.",
    over: "English-only small embedders (e.g. MiniLM) have short inputs; paid embedding APIs would add cost and a second provider.",
  },
  {
    model: "bge-reranker-base (BAAI, MIT) cross-encoder",
    role: "Picks the 5 best passages",
    why: "From the same family as the embedder, available on Workers AI and as an ONNX model for a laptop CPU — the same scorer in both places. The base size is fast enough on a CPU.",
    over: "Larger re-rankers are more accurate but too slow on a laptop CPU for evaluation runs.",
  },
];

const DECISIONS: { q: string; a: string }[] = [
  {
    q: "Why several agents instead of one prompt?",
    a: "Fact-checking has distinct jobs — splitting claims, searching, arguing, judging. Separate agents with their own instructions and strict output schemas make each step testable, visible in the trace, and replaceable. A single prompt hides where a mistake was made.",
  },
  {
    q: "Why an advocate–skeptic debate?",
    a: "It forces both sides of a claim to be argued from the same cited evidence before anyone judges, so the reasoning a reader sees is balanced and checkable. Its effect on accuracy is measured honestly (see Results): with the small laptop model it did not add accuracy on SciFact, and it is kept for transparent, cited reasoning.",
  },
  {
    q: "Why hybrid retrieval (BM25 + embeddings) rather than embeddings alone?",
    a: "Facts hinge on exact tokens — numbers, dates, names. BM25 matches them exactly; embeddings find paraphrases that share no words. Reciprocal rank fusion merges the two rankings using only positions, so their very different score scales never need calibrating.",
  },
  {
    q: "Why re-rank with a cross-encoder?",
    a: "Embeddings score the claim and a passage separately; a cross-encoder reads them together, which is much more precise. It is also slower, so it only re-scores the fused shortlist.",
  },
  {
    q: "Why three judges and a majority vote?",
    a: "Language models vary from sample to sample. Three samples and a vote reduce that noise, and how much the judges agree becomes part of the confidence score.",
  },
  {
    q: "Why abstain (“not enough info”)?",
    a: "For a fact-checker a confident wrong verdict is worse than an honest “not enough evidence”. The abstention threshold is tuned on a development split only, never on the test claims.",
  },
  {
    q: "Why MCP for the tools?",
    a: "The Model Context Protocol is an open standard for giving AI agents tools. Satya's own research agent uses its tools through MCP, and the same tools are a public MCP server any assistant (Claude Desktop, VS Code) can use.",
  },
  {
    q: "Why Cloudflare Workflows and Durable Objects instead of a server?",
    a: "A check is a chain of slow calls — about 23 for a single claim, more for longer texts. A normal serverless request would time out and a server would cost money all the time. A Workflow makes every call a durable step with retries and resumes where it stopped; Durable Objects give strongly consistent counters for budgets and limits. It all runs on the free plan.",
  },
  {
    q: "Why a shared gateway with failover and provider pinning?",
    a: "Free tiers run out and providers fail. The gateway tries Workers AI first and Groq second — the same model on both — and pins one provider for the whole run so a run never mixes models. Budgets, limits and caching live in one place for all my demos.",
  },
  {
    q: "Why Turnstile, per-visitor limits, a cache and recorded runs?",
    a: "They protect a small free budget: bots are stopped invisibly, each visitor gets 3 live checks a day, repeated texts are answered from the cache at zero cost, and the recorded runs keep the demo useful when the day's capacity is used.",
  },
  {
    q: "Why one pipeline with two executors (laptop and cloud)?",
    a: "Research needs fast, free, reproducible runs; the public demo needs a hosted, durable service. Both run the same pipeline code, and a test checks that the cloud executes exactly the same sequence of steps as the laptop.",
  },
];

const DATASETS: { name: string; what: string; why: string }[] = [
  {
    name: "SciFact",
    what: "Scientific claims checked against 5,183 research abstracts; labels supported / refuted / not enough info.",
    why: "A closed corpus, so runs are offline and reproducible; it tests reading scientific evidence.",
  },
  {
    name: "FEVER",
    what: "General claims about Wikipedia topics; supported / refuted / not enough info.",
    why: "Closest to what people paste into a fact-checker; the evidence is searched live on Wikipedia.",
  },
  {
    name: "HoVer",
    what: "Multi-hop claims that need 2–4 linked facts; supported / not supported.",
    why: "The hardest case: finding every hop of evidence.",
  },
];

const SYSTEM_NAMES: Record<string, string> = {
  llm_only: "LLM only (answers from memory)",
  single_agent_rag: "Single-agent RAG (one retrieval + one answer)",
  satya_no_debate: "Satya without debate (ablation)",
  satya_full: "Satya (full pipeline)",
};
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

function ResultsTable() {
  const { data, isError, isLoading } = useBenchmarks();
  if (isLoading) return <p className={s.note}>Loading results…</p>;
  if (isError || !data) return <p className={s.note}>Results are on the Benchmarks page.</p>;
  const datasets = ["scifact", "fever", "hover"].filter((d) => data.laptop.some((r) => r.dataset === d));
  const systems = Object.keys(SYSTEM_NAMES).filter((sys) => data.laptop.some((r) => r.system === sys));
  const cell = (d: string, sys: string): BenchmarkRow | undefined =>
    data.laptop.find((r) => r.dataset === d && r.system === sys);
  const label: Record<string, string> = { scifact: "SciFact", fever: "FEVER", hover: "HoVer" };
  return (
    <div className={s.tableWrap} role="region" aria-label="Accuracy by dataset" tabIndex={0}>
      <table className={s.config}>
        <caption className="sr-only">Accuracy of each system on each dataset, on the same claims</caption>
        <thead>
          <tr>
            <th scope="col">System</th>
            {datasets.map((d) => {
              const n = cell(d, "satya_full")?.n ?? data.laptop.find((r) => r.dataset === d)?.n;
              return (
                <th scope="col" key={d} className={s.num}>
                  {label[d]} (n = {n})
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {systems.map((sys) => (
            <tr key={sys}>
              <th scope="row">{SYSTEM_NAMES[sys]}</th>
              {datasets.map((d) => {
                const r = cell(d, sys);
                return (
                  <td key={d} className={s.num}>
                    {r ? pct(r.accuracy) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function About() {
  return (
    <article className={s.page} aria-labelledby="about-title">
      <h1 id="about-title">How Satya is built</h1>
      <p className={s.lead}>
        Satya (सत्य, “truth”) is a multi-agent fact-checker. Paste a paragraph and it splits it into single
        claims, gathers evidence from Wikipedia, the web and research papers, lets an advocate and a skeptic
        argue each claim, and has three judges give a cited verdict — or say “not enough info” when the
        evidence is thin. This page explains how it works and why it is designed this way.
      </p>

      <nav className={s.toc} aria-label="On this page">
        <a href="#flow">How a check works</a> · <a href="#architecture">Architecture</a> ·{" "}
        <a href="#models">Models</a> · <a href="#decisions">Design decisions</a> ·{" "}
        <a href="#evaluation">Evaluation</a> · <a href="#quality">Engineering quality</a> ·{" "}
        <a href="#usage">Usage limits</a> · <a href="#limits">Limitations</a> · <a href="#author">Author</a>
      </nav>

      <section aria-labelledby="flow">
        <h2 id="flow" className={s.h2}>
          How a check works
        </h2>
        <p className={s.note}>The flow of one check, from pasted text to a cited verdict.</p>
        <ol className={s.flow} aria-label="Pipeline stages">
          {FLOW.map((phase) => (
            <li key={phase.phase} className={s.phase}>
              <p className={`label ${s.phaseTitle}`}>{phase.phase}</p>
              <ol className={s.steps}>
                {phase.steps.map((step) => (
                  <li key={step.name} className={s.step}>
                    <strong>{step.name}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="architecture">
        <h2 id="architecture" className={s.h2}>
          Architecture
        </h2>
        <p className={s.note}>
          The live demo runs entirely on Cloudflare's free plan; a request travels down these layers.
        </p>
        <ol className={s.arch} aria-label="System layers, from the browser to the model providers">
          {ARCH.map((l) => (
            <li key={l.layer} className={s.layer}>
              <p className={s.layerTitle}>{l.layer}</p>
              <ul className={s.layerParts}>
                {l.parts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className={s.layerWhy}>{l.why}</p>
            </li>
          ))}
        </ol>
        <div className={s.twin}>
          <div>
            <h3 className={s.h3}>Two executors, one pipeline</h3>
            <p>
              The pipeline is written once, as data: at each moment it lists the next steps that can run. The
              cloud runs those steps as a durable Workflow; a laptop runs the same steps locally with
              Qwen3-4B, bge-m3 and the re-ranker on a 6 GB GPU, with a local search index of the SciFact
              abstracts (7,145 passages) so research runs work offline.
            </p>
          </div>
          <div>
            <h3 className={s.h3}>Evidence tools over MCP</h3>
            <p>
              The five read-only evidence tools are an MCP server. Satya&apos;s research agent connects to it
              as an MCP client, and anyone can add the public endpoint (shown on the Desk) to their own AI
              assistant.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="models">
        <h2 id="models" className={s.h2}>
          Models — and why these
        </h2>
        <div className={s.cards}>
          {MODELS.map((m) => (
            <div key={m.model} className={s.card}>
              <h3 className={s.h3}>{m.model}</h3>
              <p className={s.role}>{m.role}</p>
              <p>
                <strong>Why:</strong> {m.why}
              </p>
              <p>
                <strong>Instead of:</strong> {m.over}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="decisions">
        <h2 id="decisions" className={s.h2}>
          Design decisions — and why
        </h2>
        <dl className={s.decisions}>
          {DECISIONS.map((d) => (
            <div key={d.q}>
              <dt>{d.q}</dt>
              <dd>{d.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="evaluation">
        <h2 id="evaluation" className={s.h2}>
          Evaluation
        </h2>
        <p>
          Satya is compared with two simpler systems on three public benchmarks, using the laptop model so
          every run is free and reproducible. All systems are scored on <strong>the same claims</strong>, the
          abstention threshold is tuned on a separate development split, and every number is generated by the
          evaluation code.
        </p>
        <div className={s.tableWrap} role="region" aria-label="Datasets" tabIndex={0}>
          <table className={s.config}>
            <caption className="sr-only">Benchmark datasets</caption>
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">What it contains</th>
                <th scope="col">Why it is used</th>
              </tr>
            </thead>
            <tbody>
              {DATASETS.map((d) => (
                <tr key={d.name}>
                  <th scope="row">{d.name}</th>
                  <td>{d.what}</td>
                  <td>{d.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className={s.h3}>What is measured</h3>
        <ul className={s.list}>
          <li>
            <strong>Accuracy and macro-F1</strong> — how often the final verdict is right, with every label
            weighted equally.
          </li>
          <li>
            <strong>Calibration (ECE)</strong> — whether a 90 % confidence really means right 90 % of the
            time; a fact-checker's confidence has to be trustworthy.
          </li>
          <li>
            <strong>Risk–coverage (AURC) and selective accuracy</strong> — how accuracy improves when Satya
            answers only the claims it is most confident about; this is what abstention is for.
          </li>
          <li>
            <strong>95 % confidence intervals</strong> (bootstrap) — samples are small, so differences are
            reported with their uncertainty.
          </li>
        </ul>
        <h3 className={s.h3}>Results (stratified samples of the test splits)</h3>
        <ResultsTable />
        <ul className={s.list}>
          <li>
            The Satya pipeline beats both baselines on SciFact and FEVER, the two datasets that include “not
            enough info”, and it is better calibrated than answering from memory.
          </li>
          <li>
            On HoVer (multi-hop) it often abstains, because its searches rarely find every hop — but it never
            called a false HoVer claim true.
          </li>
          <li>
            With the small laptop model, removing the debate scored higher on SciFact in this sample; the
            intervals overlap, so this is reported as an open, measured question rather than hidden.
          </li>
        </ul>
        <p className={s.note}>
          Full charts, confidence intervals and confusion matrices are on the{" "}
          <Link to="/benchmarks">Benchmarks</Link> page.
        </p>
      </section>

      <section aria-labelledby="quality">
        <h2 id="quality" className={s.h2}>
          Engineering quality
        </h2>
        <ul className={s.list}>
          <li>
            <strong>Tests at every level:</strong> 232 automated tests for the pipeline, retrieval, agents,
            tools, MCP, API and web app, plus 41 for the gateway and real-model integration tests; a test
            checks that the cloud and laptop run the identical step sequence.
          </li>
          <li>
            <strong>Every screen and state tested in a real browser:</strong> 132 automated browser tests
            across desktop and mobile, light and dark themes — live run, recorded run, partial run, capacity
            used, waking, errors — each failing on any console error.
          </li>
          <li>
            <strong>Accessibility:</strong> Lighthouse accessibility score 100 on every page; automated WCAG
            2.1 AA checks in both themes; full keyboard use.
          </li>
          <li>
            <strong>Failure handling:</strong> retries with backoff, timeouts, circuit breakers, provider
            failover, and partial results when capacity runs out mid-check — each forced and tested.
          </li>
          <li>
            <strong>Security and cost:</strong> no secrets in code or bundles (scanned), strict
            Content-Security-Policy, bot protection, per-visitor limits, and a total running cost of ₹0.
          </li>
        </ul>
      </section>

      <section aria-labelledby="usage">
        <h2 id="usage" className={s.h2}>
          Usage limits — and why
        </h2>
        <p>
          The whole demo runs on free tiers: about 10,000 Workers AI “neurons” and 200,000 Groq tokens a day,
          shared by every visitor. One live check of a short text uses roughly 900 neurons, so the budget only
          stretches if it is shared fairly.
        </p>
        <div className={s.tableWrap} role="region" aria-label="Usage limits" tabIndex={0}>
          <table className={s.config}>
            <caption className="sr-only">Usage limits and the reason for each</caption>
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">3 live checks per visitor per day</th>
                <td>
                  Each check makes dozens of model calls on a shared free budget; without a per-visitor limit,
                  one visitor (or a bot) could use up the day for everyone. Visitors are counted by a salted,
                  daily hash of their network address — the address itself is never stored.
                </td>
              </tr>
              <tr>
                <th scope="row">Up to 2,000 characters and 6 claims per check</th>
                <td>
                  Every claim adds about 22 model and tool calls; the cap keeps one check to about a minute
                  and within its share of the budget.
                </td>
              </tr>
              <tr>
                <th scope="row">Repeated texts are free</th>
                <td>
                  A text already checked with the same sources is answered from the cache and does not count
                  towards the limit.
                </td>
              </tr>
              <tr>
                <th scope="row">Recorded runs are unlimited</th>
                <td>They are stored results, so browsing them costs nothing.</td>
              </tr>
              <tr>
                <th scope="row">60 evidence-tool calls per day on the public MCP endpoint</th>
                <td>Keeps the free search APIs behind the tools within their own limits.</td>
              </tr>
              <tr>
                <th scope="row">Daily reset at 05:30 IST</th>
                <td>The providers' free quotas reset at midnight UTC, which is 05:30 in India.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="limits">
        <h2 id="limits" className={s.h2}>
          Limitations and next steps
        </h2>
        <ul className={s.list}>
          <li>
            Results come from samples (40–80 claims per dataset); the full test sets and more ablations are
            the next evaluation step.
          </li>
          <li>
            Multi-hop claims need iterative search (search again using what was found) — the main planned
            improvement.
          </li>
          <li>
            The live demo uses a larger model than the benchmarks; a side-by-side evaluation of the deployed
            model is planned.
          </li>
          <li>
            Free tiers allow a handful of live checks per day; after that, recorded runs remain available
            until 05:30 IST.
          </li>
        </ul>
        <p className={s.note}>
          Data: SciFact (CC BY-NC 2.0), FEVER (fever.ai licence), HoVer (MIT); none is shipped with the demo.
          Texts you check are kept for 30 days and listed only in your own browser.
        </p>
      </section>

      <section aria-labelledby="author" className={s.authorCard}>
        <h2 id="author" className={s.h2}>
          Author
        </h2>
        <p>
          Designed and built by <strong>{AUTHOR.name}</strong>, {AUTHOR.degree}.
        </p>
        <p>
          Contact: <a href={`mailto:${AUTHOR.email}`}>{AUTHOR.email}</a>
        </p>
      </section>
    </article>
  );
}
