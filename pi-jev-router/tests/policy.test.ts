import { describe, expect, test } from "vitest";
import { applyPolicy } from "../src/policy.js";
import type { JevAnswers, Route } from "../src/types.js";

function answers(route: Route, probs: Partial<Record<Route, number>>, rest: Partial<JevAnswers> = {}): JevAnswers {
  return {
    route,
    routeProbabilities: { continue: 0, side_chat: 0, fork: 0, new_session: 0, ...probs },
    onTopic: 0.2, needsHistory: 0.2, oneOff: 0.2, inputTokens: 1000, latencyMs: 400,
    ...rest,
  };
}
const config = { threshold: 0.6 };

describe("applyPolicy (numbers from the hard-set eval)", () => {
  test("a plain continue stays a continue", () => {
    expect(applyPolicy(answers("continue", { continue: 0.98 }), config)).toMatchObject({ route: "continue", confidence: 0.98 });
  });

  test("on-topic input is kept even when Jev's top choice was to leave", () => {
    // "Yes. Create a separate session to work on it" — fork 0.46 / new 0.36, on_topic 0.64
    const d = applyPolicy(answers("fork", { fork: 0.46, new_session: 0.36, continue: 0.17 }, { onTopic: 0.64, needsHistory: 0.75 }), config);
    expect(d).toMatchObject({ route: "continue", rule: "on_topic" });
  });

  test("new_session that needs history becomes a fork", () => {
    // post-/compact "基于上一期视频…接下来规划一期视频" — new_session 0.63, needs_history 0.89
    const d = applyPolicy(answers("new_session", { new_session: 0.63, continue: 0.28, fork: 0.09 }, { onTopic: 0.42, needsHistory: 0.89 }), config);
    expect(d).toMatchObject({ route: "fork", rule: "needs_history" });
    expect(d.confidence).toBeCloseTo(0.72, 2);
  });

  test("a genuine pivot is offered a new session", () => {
    // this session's own pivot — new_session 0.73, on_topic 0.27, needs_history 0.79 → fork via needs_history
    const d = applyPolicy(answers("new_session", { new_session: 0.73, fork: 0.11, continue: 0.1, side_chat: 0.06 }, { onTopic: 0.27, needsHistory: 0.79 }), config);
    expect(d.route).toBe("fork");
    const e = applyPolicy(answers("new_session", { new_session: 0.73, fork: 0.11, continue: 0.1, side_chat: 0.06 }, { onTopic: 0.27, needsHistory: 0.3 }), config);
    expect(e).toMatchObject({ route: "new_session", confidence: 0.73 });
  });

  test("a one-off unrelated question is a side chat", () => {
    const d = applyPolicy(answers("new_session", { new_session: 0.7, side_chat: 0.2 }, { oneOff: 0.8 }), config);
    expect(d).toMatchObject({ route: "side_chat", rule: "one_off" });
  });

  test("low-confidence leave suggestions are suppressed", () => {
    const d = applyPolicy(answers("fork", { fork: 0.4, continue: 0.35, new_session: 0.15, side_chat: 0.1 }), config);
    expect(d).toMatchObject({ route: "continue", rule: "below_threshold" });
  });
});
