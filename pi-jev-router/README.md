# pi-jev-router

`pi-jev-router` is a [Pi](https://pi.dev/) extension that watches every prompt you type and, **before it enters the session**, asks [Jev](https://typesafe.ai) (TypeSafe's System One model) one question: does this belong here, or is it unrelated work that would pollute the session's context? Only unrelated prompts trigger a reminder; you decide where they go.

The failure it prevents: you are 300k tokens into a video-production or PR session, you fire an unrelated question by habit, the model answers it, and from then on every turn carries that noise. The router catches the prompt, offers to move it, and gets out of the way.

- ~0.5 s per routed prompt, ~$0.00006 (about 1.4k Jev input tokens). Output is free.
- ~45% of prompts never call Jev: tiny steers ("merged", "Try again"), pasted images, file paths, slash commands, skill loads, and anything queued while the agent is streaming.
- Never blocks you: any error, throttle or timeout falls through to "continue".
- Jev supplies probabilities; the policy lives in code (`src/policy.ts`) with named thresholds.

## Requirements

- Node.js 22 or newer
- Pi
- One of, checked in this order:
  - `TYPESAFE_API_KEY` — a TypeSafe key (direct API)
  - `OPENROUTER_API_KEY` — an [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) key (model `typesafe/jev-1.13`, same wire format, pay-as-you-go, no free-tier throttle)
  - `AI_GATEWAY_API_KEY` — a Vercel AI Gateway key (model `typesafe-ai/jev`; the free tier throttles after a handful of calls)

  `PI_JEV_ROUTER_ENGINE=typesafe|openrouter|gateway` forces one when several keys are set.

## Installation

```bash
pi install npm:@sugarforever/pi-jev-router
```

Or per project, in `.pi/settings.json`:

```json
{ "packages": ["npm:@sugarforever/pi-jev-router"] }
```

Export a key in the shell you start Pi from:

```bash
export OPENROUTER_API_KEY=...      # or TYPESAFE_API_KEY=... / AI_GATEWAY_API_KEY=...
pi
```

The status line shows `route: ready (typesafe)`, `route: ready (openrouter)` or `route: ready (gateway)`. With no key it shows `route: no key` and the extension does nothing.

## What happens when you type

1. The prompt goes through the prefilter. Steers, paths, images, commands: straight through.
2. A stale session (default: last prompt more than 12 h ago) or a nearly full context (default: ≥ 85%) is offered a new session outright, no API call.
3. Otherwise Jev sees a compact state — session name (or first prompt), your last three prompts, the tail of the last reply, and the new prompt — and answers four typed questions (`route`, `on_topic`, `needs_history`, `one_off`).
4. The policy asks one thing of those answers: is this prompt unrelated to the session? Only then does it interrupt. Same-topic prompts, including variants and follow-ups, go straight through.
5. If the prompt looks unrelated, a dialog asks where it should go. The router only flags; the choice is yours:

   ```
   This looks like an unrelated task (73%). Where should it go?
   › Keep here
     Fork from here
     New session
     Keep here and stop asking this session
   ```

6. Choose **Fork from here** or **New session** and the router parks your prompt, puts `/route-go` in the editor and asks you to press Enter. That second keystroke is deliberate: Pi only allows session control from a command, not from the input hook. `/route-go` forks at the current leaf (or opens a new session with the current one as parent) and sends your prompt there, images included.

The status line shows the last decision, e.g. `route: continue 95% 480ms`.

## Commands

| command | what it does |
|---|---|
| `/route-go` | move the last routed prompt (set up by the dialog) |
| `/route-status` | engine, thresholds and the full last decision with Jev's raw probabilities |
| `/route-toggle` | enable / disable for this session (a new, forked or resumed session starts enabled) |
| `/route-threshold 0.7` | how sure Jev must be that a prompt is unrelated before the router interrupts |

## Configuration

| env | default | meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | direct TypeSafe API |
| `OPENROUTER_API_KEY` | — | OpenRouter (`POST /api/v1/systemone`) |
| `AI_GATEWAY_API_KEY` | — | Vercel AI Gateway fallback |
| `PI_JEV_ROUTER_ENGINE` | first key found | force `typesafe`, `openrouter` or `gateway` |
| `OPENROUTER_MODEL` | `typesafe/jev-1.13` | OpenRouter model id (`~typesafe/jev-latest` also works) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1/systemone` | OpenRouter endpoint override |
| `TYPESAFE_MODEL` | `jev-latest` | TypeSafe model id |
| `PI_JEV_ROUTER_THRESHOLD` | `0.6` | minimum P(side_chat) + P(new_session) before interrupting |
| `PI_JEV_ROUTER_TIMEOUT_MS` | `2500` | Jev budget per prompt; on timeout the prompt continues |
| `PI_JEV_ROUTER_STALE_MINUTES` | `720` | silence after which a prompt is offered a new session without asking Jev |
| `PI_JEV_ROUTER_MODEL` | `typesafe-ai/jev` | gateway model id |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | direct endpoint override |

## Policy

The router has one job: keep unrelated work out of the session. It judges and offers a choice; it never moves a prompt on its own.

```
unrelated = P(side_chat) + P(new_session)
unrelated < threshold            → continue
on_topic ≥ 0.6                   → continue
otherwise                        → dialog (Keep here / Fork from here / New session / stop asking)
Jev error / timeout              → continue
```

Jev's `route` choice splits "unrelated" across two options (`side_chat` for a quick question, `new_session` for a new task). Gating on either one alone let genuinely unrelated prompts through on a split vote, e.g. 0.45 / 0.47 for another project's Redis error log, so the two are summed. `fork` is not a reason to interrupt: a variant or follow-up of the current work is still the session's topic. Fork stays available in the dialog as Pi's own session operation.

Evaluated on 2026-09-26 against Jev 1.13 on OpenRouter, two runs each, over 30 development scenarios and 22 held-out scenarios labelled before the policy change:

| | 0.2.0 | this policy |
|---|---|---|
| unrelated prompts flagged | 11–12/14 | 14/14 |
| other prompts interrupted (incl. same-topic variants) | 1/38 | 0/38 |

The scenarios are hand-written, so treat this as a regression suite rather than a benchmark.

## Development

```bash
cd pi-jev-router
npm install
npm run check      # vitest, tsc, tsdown
```

Tests cover the prefilter, the state builder, the policy (with the eval numbers as fixtures) and the input → dialog → `/route-go` flow with a fake Jev client. No network is needed.

## Release

Bump `version` in `package.json`, merge to `main`, then tag `pi-jev-router-v<version>`; `.github/workflows/release-pi-jev-router.yml` verifies the tag, runs `npm run check` and publishes to npm with Trusted Publishing.
