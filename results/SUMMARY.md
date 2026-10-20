# Satya — evaluation results

Generated 2026-10-14T18:11:55.030Z by `npx satya report` from `results/*.jsonl` (laptop: qwen3:4b + bge-m3 + bge-reranker-base). Test splits; τ = 0.7004 (tuned on dev, see below). Accuracy and macro-F1 use the final label (abstention = NOT_ENOUGH_INFO; on HoVer REFUTED/NEI count as NOT_SUPPORTED). ECE and AURC use the raw label and confidence. ECE/AURC/s per claim in the main table are on SciFact.

## Main comparison

Every system is scored on the same claims of each dataset. Samples: scifact n = 80 of 776, fever n = 60 of 420, hover n = 40 of 210. Accuracy 95 % bootstrap intervals are in the per-dataset tables.

| System | SciFact Acc | SciFact F1 | FEVER Acc | HoVer Acc | ECE ↓ | AURC ↓ | s/claim |
|---|---|---|---|---|---|---|---|
| LLM-only (Qwen3-4B) | 42.5 | 40.9 | 55.0 | **60.0** | 0.431 | 0.528 | 3.4 |
| Single-agent RAG (Qwen3-4B) | 55.0 | 40.1 | 41.7 | 42.5 | 0.418 | 0.438 | 20.2 |
| Satya w/o debate (Qwen3-4B) | **68.8** | **68.9** | — | — | **0.221** | **0.228** | 222.2 |
| **Satya (Qwen3-4B, laptop)** | 61.3 | 62.1 | **60.0** | 55.0 | 0.274 | 0.322 | 264.9 |
| **Satya (gpt-oss-120b, deployed, 200-claim subset)** | — | — | — | — | — | — | — |

## scifact (test) — all metrics

| System | n | Acc [95 % CI] | Macro-F1 | ECE | AURC | Coverage@τ | Sel. acc@τ | s/claim (mean / median) | LLM calls | Tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|
| llm_only (n = 80 of 776) | 80 | 42.5 [31.3–53.8] | 40.9 | 0.431 | 0.528 | 92.5 | 43.2 | 3.4 / 3.1 | 1.0 | 104 / 159 |
| single_agent_rag (n = 80 of 776) | 80 | 55.0 [43.8–65.0] | 40.1 | 0.418 | 0.438 | 86.3 | 52.2 | 20.2 / 19.7 | 1.0 | 1220 / 265 |
| satya_no_debate (n = 80 of 776) | 80 | 68.8 [58.8–78.8] | 68.9 | 0.221 | 0.228 | 93.8 | 69.3 | 222.2 / 217.5 | 3.0 | 3628 / 8685 |
| satya_full (n = 80 of 776) | 80 | 61.3 [50.0–71.3] | 62.1 | 0.274 | 0.322 | 92.5 | 62.2 | 264.9 / 258.1 | 7.0 | 10651 / 10160 |

## fever (test) — all metrics

| System | n | Acc [95 % CI] | Macro-F1 | ECE | AURC | Coverage@τ | Sel. acc@τ | s/claim (mean / median) | LLM calls | Tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|
| llm_only (n = 60 of 420) | 60 | 55.0 [41.7–68.3] | 53.8 | 0.383 | 0.426 | 96.7 | 56.9 | 3.4 / 3.0 | 1.0 | 96 / 113 |
| single_agent_rag (n = 60 of 420) | 60 | 41.7 [28.3–55.0] | 32.8 | 0.517 | 0.595 | 90.0 | 40.7 | 22.1 / 20.1 | 2.0 | 1238 / 255 |
| satya_full (n = 60 of 420) | 60 | 60.0 [46.7–71.7] | 60.6 | 0.299 | 0.331 | 85.0 | 58.8 | 276.6 / 268.6 | 8.0 | 9682 / 9430 |

## hover (test) — all metrics

| System | n | Acc [95 % CI] | Macro-F1 | ECE | AURC | Coverage@τ | Sel. acc@τ | s/claim (mean / median) | LLM calls | Tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|
| llm_only (n = 40 of 210) | 40 | 60.0 [45.0–75.0] | 60.0 | 0.330 | 0.357 | 95.0 | 60.5 | 6.8 / 5.3 | 1.0 | 163 / 200 |
| single_agent_rag (n = 40 of 210) | 40 | 42.5 [27.5–57.5] | 39.4 | 0.455 | 0.498 | 90.0 | 47.2 | 17.6 / 17.0 | 2.0 | 972 / 336 |
| satya_full (n = 40 of 210) | 40 | 55.0 [40.0–70.0] | 43.6 | 0.221 | 0.347 | 55.0 | 68.2 | 284.1 / 258.1 | 8.0 | 7453 / 9606 |

## Ablations (SciFact test)

| System | Acc | Macro-F1 | ECE | AURC | s/claim |
|---|---|---|---|---|---|
| **Satya (Qwen3-4B, laptop)** | 61.3 | 62.1 | 0.274 | 0.322 | 264.9 |
| Satya, dense-only retrieval | — | — | — | — | — |
| Satya, no re-ranker | — | — | — | — | — |
| Satya, 1 debate round | — | — | — | — | — |
| Satya, 3 debate rounds | — | — | — | — | — |

## τ tuning (dev)

```json
{
  "tau": 0.7004,
  "previous": 0.55,
  "minCoverage": 0.7,
  "coverage": 0.9285714285714286,
  "selectiveAccuracy": 0.6826923076923077,
  "answered": 104,
  "tauExact": 0.7004232991891939,
  "devItems": {
    "scifact": 112
  },
  "configHash": "7ca8be20f151",
  "tunedAt": "2026-10-14T01:50:51.616Z"
}
```
