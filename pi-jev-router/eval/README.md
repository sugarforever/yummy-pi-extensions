# pi-jev-router eval

A small, hand-labelled regression suite for the router's one job: **interrupt when a prompt is unrelated to the session, and let everything else through.** It runs the scenarios through a built copy of the extension (its questions, its Jev client, its policy) and reports how many unrelated prompts were flagged and how many other prompts were interrupted.

The scenarios were written and labelled by the author. This is a regression suite for tuning the policy, not a public benchmark; a clean score here does not mean the router never misjudges real sessions.

## Scenarios

Each scenario is a compact session state plus a new prompt and the expected route:

```json
{
  "id": "obvious-pivot-zh",
  "expected": "new_session",
  "title": "排查 Kubernetes OOM",
  "recent": ["排查 checkout pod OOM", "heap dump 指向图片处理"],
  "assistant": "建议把图片处理移到 worker。",
  "input": "帮我比较一下三款适合客厅的扫地机器人"
}
```

| file | count | purpose |
|---|---|---|
| `scenarios/dev.json` | 30 | used while changing the policy |
| `scenarios/heldout.json` | 22 | labelled **before** the 0.3.0 change and not looked at while tuning |
| `scenarios/regress.json` | 3 | follow-up and "create a separate session" phrasings, all expected to pass |

Labels:

- `new_session` — unrelated to the session (a quick unrelated question counts too). The router should interrupt.
- `continue` — advances, corrects, tests, documents or replaces the current work. Must pass silently.
- `fork` — a variant or follow-up of the current work (for example “make a 60-second version of this script”). Still the session's topic, so it must pass silently too; the user can fork in Pi if they want.

The scenarios cover same-topic follow-ups, corrections and new constraints, code → tests / docs / deploy, Chinese / English / mixed input, short and vague prompts, pasted code and error logs, word-overlap traps and same-topic variants.

## Run

```bash
npm run build
OPENROUTER_API_KEY=... node eval/run.mjs                      # current build, label = package version
node eval/run.mjs --dist /path/to/other/dist/index.js --label 0.2.0 --runs 2
```

Any engine the extension supports works (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`). Each run writes `results/<label>-run<N>.json` with every decision, Jev's raw probabilities, latency and input tokens, and prints a summary. A full run is 55 calls.

## Results

Jev 1.13 on OpenRouter, 2026-09-26, two runs per version. 0.2.0 is the npm release; 0.3.0 is the version that sums `side_chat` + `new_session` before the threshold and no longer interrupts same-topic variants.

| | 0.2.0 run 1 | 0.2.0 run 2 | 0.3.0 run 1 | 0.3.0 run 2 |
|---|---|---|---|---|
| unrelated prompts flagged (dev + held-out) | 10/14 | 12/14 | 14/14 | 14/14 |
| other prompts interrupted (all sets) | 1/41 | 1/41 | 0/41 | 0/41 |
| mean latency | 307 ms | 277 ms | 284 ms | 272 ms |
| input tokens per call | 792 | 792 | 792 | 792 |

What 0.2.0 missed, and why. Every miss is the same pattern: Jev did judge the prompt unrelated, but split that vote across `side_chat` and `new_session`, and 0.2.0 required one of them to clear 0.6 on its own.

| scenario | set | run 1 (side_chat / new_session) | run 2 |
|---|---|---|---|
| `paste-log-unrelated` — another project's Redis error while writing migration docs | dev | 0.50 / 0.41, missed | 0.43 / 0.49, missed |
| `false-positive-word-overlap` — Apple Watch sync question in an Apple earnings-video session | dev | 0.40 / 0.59, missed | 0.45 / 0.54, missed |
| `h-new-email` — writing a leave email during a form-validation debug | held-out | 0.42 / 0.58, missed | 0.40 / 0.60, flagged |
| `h-new-other-repo` — another repo's Go memory leak during a Python ETL session | held-out | 0.36 / 0.59, missed | 0.31 / 0.64, flagged |

`h-fork-ending` was interrupted in both runs: a same-topic variant (“write a different ending with the same setting”) routed to `fork`, which 0.2.0 treated as a reason to interrupt.

0.3.0 treats `side_chat` + `new_session` as one “unrelated” mass for the interrupt decision and lets `fork` through; the dialog still offers Fork as Pi's own session operation.

## Files

- `run.mjs` — the runner
- `scenarios/*.json` — the labelled scenarios
- `results/*.json` — the raw results behind the table above
