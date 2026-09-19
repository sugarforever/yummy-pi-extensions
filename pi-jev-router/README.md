# pi-jev-router

`pi-jev-router` is a [Pi](https://pi.dev/) extension that watches every prompt you type and, **before it enters the session**, asks [Jev](https://typesafe.ai) (TypeSafe's System One model) one question: does this belong here, or is it a tangent that should be forked, or an unrelated task that deserves a fresh session?

The failure it prevents: you are 300k tokens into a video-production or PR session, you fire an unrelated question by habit, the model answers it, and from then on every turn carries that noise. The router catches the prompt, offers to move it, and gets out of the way.

- ~0.5 s per routed prompt, ~$0.00006 (about 1.4k Jev input tokens). Output is free.
- ~45% of prompts never call Jev: tiny steers ("merged", "Try again"), pasted images, file paths, slash commands, skill loads, and anything queued while the agent is streaming.
- Never blocks you: any error, throttle or timeout falls through to "continue".
- Jev supplies probabilities; the policy lives in code (`src/policy.ts`) with named thresholds.

## Requirements

- Node.js 22 or newer
- Pi
- One of:
  - `TYPESAFE_API_KEY` — a TypeSafe key (direct API, fastest)
  - `AI_GATEWAY_API_KEY` — a Vercel AI Gateway key (model `typesafe-ai/jev`; the free tier throttles after a handful of calls)

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
export TYPESAFE_API_KEY=...        # or AI_GATEWAY_API_KEY=...
pi
```

The status line shows `route: ready (typesafe)` or `route: ready (gateway)`. With no key it shows `route: no key` and the extension does nothing.

## What happens when you type

1. The prompt goes through the prefilter. Steers, paths, images, commands: straight through.
2. A stale session (default: last prompt more than 12 h ago) or a nearly full context (default: ≥ 85%) is offered a new session outright, no API call.
3. Otherwise Jev sees a compact state — session name (or first prompt), your last three prompts, the tail of the last reply, and the new prompt — and answers four typed questions (`route`, `on_topic`, `needs_history`, `one_off`).
4. The policy turns the probabilities into one of `continue` / `fork` / `new_session` / `side_chat`. Anything under the confidence threshold (default 0.6) is a `continue`.
5. If the answer is not `continue`, a dialog asks:

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
| `/route-toggle` | enable / disable for this session |
| `/route-threshold 0.7` | confidence needed before the router suggests leaving |

## Configuration

| env | default | meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | direct TypeSafe API |
| `AI_GATEWAY_API_KEY` | — | Vercel AI Gateway fallback |
| `PI_JEV_ROUTER_THRESHOLD` | `0.6` | minimum confidence to suggest leaving |
| `PI_JEV_ROUTER_TIMEOUT_MS` | `2500` | Jev budget per prompt; on timeout the prompt continues |
| `PI_JEV_ROUTER_STALE_MINUTES` | `720` | silence after which a prompt is offered a new session without asking Jev |
| `PI_JEV_ROUTER_MODEL` | `typesafe-ai/jev` | gateway model id |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | direct endpoint override |

## Policy

```
on_topic ≥ 0.6                                   → continue
(side_chat | new_session) and needs_history ≥ 0.7 → fork
new_session and one_off ≥ 0.7                    → side_chat
route ≠ continue and confidence < threshold      → continue
Jev error / timeout                              → continue
```

These came from a hand-labeled set of 13 real pivot prompts taken from the author's own Claude Code transcripts (12/13 acceptable, zero false "move this out" suggestions, three of four genuine pivots caught). The `needs_history` question did more work than the `route` choice: in both history-needing pivots Jev's top choice was `new_session` while `needs_history` was 0.75–0.89, and the fork rule is what produced the right answer. Treat the choice as a prior.

`side_chat` is currently surfaced with the same dialog as `new_session`; a true one-off side answer that never touches the session is planned.

## Development

```bash
cd pi-jev-router
npm install
npm run check      # vitest, tsc, tsdown
```

Tests cover the prefilter, the state builder, the policy (with the eval numbers as fixtures) and the input → dialog → `/route-go` flow with a fake Jev client. No network is needed.

## Release

Bump `version` in `package.json`, merge to `main`, then tag `pi-jev-router-v<version>`; `.github/workflows/release-pi-jev-router.yml` verifies the tag, runs `npm run check` and publishes to npm with Trusted Publishing.
