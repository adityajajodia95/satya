# Satya — multi-agent fact verification at the edge

_Satya (सत्य) = truth._ Paste a paragraph and Satya splits it into single factual claims, gathers evidence from Wikipedia, the web and research papers, lets an **advocate** and a **skeptic** argue each claim over two rounds, and has **three judges** give a cited verdict — or **abstain** when the evidence is not enough.

**Live demo:** <https://aj-demos.pages.dev/satya/> · runs entirely on free tiers (₹0), with recorded runs when the day's free capacity is used. **Full documentation:** [DOCUMENTATION.md](DOCUMENTATION.md) · **How it's built (for any reader):** <https://aj-demos.pages.dev/satya/about>

One TypeScript pipeline runs in two places:

- **Laptop (research):** Qwen3-4B + bge-m3 on Ollama and an ONNX cross-encoder, within 6 GB of VRAM. It runs the benchmarks and works fully offline on the SciFact closed corpus.
- **Cloud (public demo):** a Cloudflare Workflow with one durable step per model or tool call, using gpt-oss-120b on Workers AI with the same model on Groq as a fallback.

## How it works

```
text ─► decompose ─► plan searches ─► research (MCP tools) ─► BM25 ∪ bge-m3 ─► RRF ─► re-rank (top 5)
                                                                                     │
          report ◄─ aggregate ◄─ verdict (τ abstention) ◄─ judge ×3 ◄─ advocate ⇄ skeptic (2 rounds)
```

| Stage     | What happens                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decompose | The LLM splits the text into atomic, check-worthy claims (strict JSON schema, one repair attempt).                                                                                                         |
| Research  | The research agent is an **MCP client**: it calls Satya's evidence tools (Wikipedia, Tavily web search, arXiv, Semantic Scholar, fetch_url with SSRF protection) through MCP `tools/call`.                 |
| Retrieval | **Hybrid BM25 + dense (bge-m3) retrieval fused with reciprocal rank fusion (k 60)**, then **cross-encoder re-ranking** (bge-reranker-base) to the top 5 passages.                                          |
| Debate    | An advocate and a skeptic argue over 2 rounds and must cite passage ids.                                                                                                                                   |
| Judge     | 3 judge samples, majority vote. Confidence = 0.7 × agreement + 0.3 × sigmoid(best re-rank score). **Below τ the verdict is "not enough info"** (confidence-based abstention; τ is tuned on the dev split). |

The pipeline is data: `planSteps(state)` returns the next frontier of steps, and each step returns a patch. The laptop runner and the Cloudflare Workflow execute the **same step sequence**, and a golden test asserts this for both executors.

```
packages/core     schemas, prompts, retrieval, agents, pipeline, metrics (no I/O)
packages/tools    wiki / web / arXiv / Semantic Scholar / fetch_url (Node and Workers)
packages/mcp      MCP server exposing the evidence tools
apps/cli          laptop executor: doctor, data, index, verify, eval, tune, report, record
apps/worker       satya-api: Workflow + Durable Objects (run hub, archive), cache, quotas, remote MCP
web               the Fact Desk UI (React, Vite) served at /satya/ on aj-demos.pages.dev
```

The demo sits behind the shared **aj-platform** gateway (model routing Workers AI → Groq, per-project daily budgets, Turnstile sessions, per-visitor limits, cache) and uses the **aj-demo-kit** UI pieces.

## Run it on a laptop (Windows 11, PowerShell)

Requirements: Node 22+, Ollama, an NVIDIA GPU with 6 GB or more (CPU works, slowly).

```powershell
npm install
ollama pull qwen3:4b ; ollama pull bge-m3
npx satya doctor                       # checks GPU, VRAM, models, cache paths
npx satya data download                # SciFact, FEVER, HoVer into data/
npx satya index scifact                # BM25 + bge-m3 index of the SciFact corpus
npx satya verify "The Eiffel Tower was completed in 1889. It is in Berlin."
npx satya eval --dataset scifact --system satya_full --split test --sample 80 --resume
npx satya tune ; npx satya report      # τ on dev → results/SUMMARY.md + benchmarks.json
```

Optional keys go in `.env` (never committed): `TAVILY_API_KEY` for web search. The model caches live wherever `OLLAMA_MODELS` and `HF_HOME` point.

## Deploy the cloud demo

Cloudflare (free plan) with the aj-platform gateway deployed first. Secrets are set with `wrangler secret put` and are never written to files.

```powershell
cd apps/worker ; npx wrangler deploy                       # satya-api (Workflow, DOs, cron)
cd ../../web   ; npm run build                              # → web/dist (base /satya/)
cd ../../aj-platform/site
node scripts/assemble.mjs --local "satya=..\..\Satya\web\dist"
npx wrangler pages deploy dist --project-name aj-demos --branch main
```

## Results

All numbers are produced by `npx satya report` from the stored evaluation runs ([results/SUMMARY.md](results/SUMMARY.md), also on the demo's Benchmarks page). Laptop model Qwen3-4B; test-split **stratified samples** (seed 13); within a dataset every system is scored on **the same claims**; brackets are 95 % bootstrap intervals. Accuracy uses the final label (an abstention counts as "not enough info"; on HoVer it counts as "not supported").

| Same claims per dataset         | SciFact (n = 80)       | FEVER (n = 60)         | HoVer (n = 40)         |
| ------------------------------- | ---------------------- | ---------------------- | ---------------------- |
| LLM-only                        | 42.5 % [31.3–53.8]     | 55.0 % [41.7–68.3]     | **60.0 %** [45.0–75.0] |
| Single-agent RAG                | 55.0 % [43.8–65.0]     | 41.7 % [28.3–55.0]     | 42.5 % [27.5–57.5]     |
| **Satya (debate)**              | **61.3 %** [50.0–71.3] | **60.0 %** [46.7–71.7] | 55.0 % [40.0–70.0]     |
| Satya without debate (ablation) | 68.8 % [58.8–78.8]     | —                      | —                      |

What the numbers say:

- **Satya beats both baselines on SciFact and FEVER**, the two datasets with all three labels (supported / refuted / not enough info). On SciFact it scores +18.8 points over LLM-only on identical claims, with much better calibration (ECE 0.274 vs 0.431).
- **When Satya gives a verdict it rarely gets the direction wrong.** On SciFact it never confused supported with refuted; its errors involve "not enough info".
- **HoVer (multi-hop) is the weak spot.** Satya abstained on 18 of 20 supported claims because its three searches rarely retrieve every hop, though it never wrongly supported a false claim. The LLM-only baseline does better here by answering from memory.
- **In this small SciFact sample, the debate did not add accuracy** (68.8 % without vs 61.3 % with; the intervals overlap). Debate stays the primary design for its transparent, cited reasoning, and its effect is a measured, open question.
- Samples are small (40–80 claims), so differences under ~10 points are within noise. The full evaluation (all test claims, ablations) continues with `scripts/full-eval.ps1`; the deployed model (gpt-oss-120b) has no parity numbers yet.

## Use the evidence tools from your own assistant (MCP)

Satya's five read-only evidence tools — `wiki_search`, `wiki_page`, `arxiv_search`, `scholar_search`, `fetch_url` — are a public MCP server (rate-limited, no keys needed). Add it to Claude Desktop or VS Code:

```json
{
  "mcpServers": {
    "satya": { "type": "http", "url": "https://aj-demos.pages.dev/api/satya/mcp" }
  }
}
```

Locally, `npx satya mcp` serves the same tools over stdio (and also `web_search` when you set your own Tavily key).

Satya's own research agent uses these tools the same way: on the laptop it connects an MCP client to the server in-process (`packages/mcp/src/client.ts`), or to any remote MCP server with `SATYA_MCP_URL=https://…/mcp`. A test asserts the evidence is identical to calling the tools directly. The cloud Workflow calls the same tool code directly, because each Workflow step is a separate, short-lived invocation.

## Limitations

- Free tiers allow a handful of live checks per day (3 per visitor). After that the demo shows recorded runs until 05:30 IST.
- Claims are judged only on the evidence retrieved. Paywalled or very recent facts may end in "not enough info".
- The laptop model (Qwen3-4B) and the demo model (gpt-oss-120b) differ. The Benchmarks page labels which numbers come from which.
- Evaluation numbers are preliminary until the full run finishes (see Results).

## Data and licences

Code: MIT ([LICENSE](LICENSE)). Benchmarks: SciFact (CC BY-NC 2.0), FEVER (fever.ai licence), HoVer (MIT, per the Parquet mirror used). None of them is redistributed here; `satya data download` fetches them from the original sources. Models: Qwen3-4B (Apache 2.0), bge-m3 and bge-reranker-base (MIT), gpt-oss-120b (Apache 2.0).

Progress log and deviations: [PROGRESS.md](PROGRESS.md) · QA evidence: [QA_REPORT.md](QA_REPORT.md) · 90-second demo: [DEMO_SCRIPT.md](DEMO_SCRIPT.md) · Full documentation: [DOCUMENTATION.md](DOCUMENTATION.md)
