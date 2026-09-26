import { describe, expect, test } from "vitest";
import { applyPolicy } from "../src/policy.js";
import type { JevAnswers, Route } from "../src/types.js";

function answers(route: Route, probs: Partial<Record<Route, number>>, rest: Partial<JevAnswers> = {}): JevAnswers {
  return {
    route,
    routeProbabilities: { continue: 0, side_chat: 0, fork: 0, new_session: 0, ...probs },
    onTopic: 0.2, needsHistory: 0.2, oneOff: 0.2, inputTokens: 790, latencyMs: 290,
    ...rest,
  };
}
const config = { threshold: 0.6 };

// Numbers are Jev 1.13 answers from the dev and held-out eval sets, 2026-09-26.
describe("applyPolicy", () => {
  test("a plain continue stays a continue", () => {
    expect(applyPolicy(answers("continue", { continue: 0.98, fork: 0.02 }, { onTopic: 0.95 }), config)).toMatchObject({ route: "continue", confidence: 0.98 });
  });

  test("an unrelated prompt interrupts", () => {
    // Kubernetes OOM session → "帮我比较一下三款适合客厅的扫地机器人"
    expect(applyPolicy(answers("new_session", { new_session: 1 }, { onTopic: 0.02 }), config)).toMatchObject({ route: "new_session", confidence: 1 });
  });

  test("a split side_chat / new_session vote still interrupts", () => {
    // migration-docs session → another project's Redis ECONNREFUSED log: 0.45 / 0.47, neither clears 0.6 alone
    const d = applyPolicy(answers("new_session", { side_chat: 0.45, new_session: 0.47, fork: 0.07, continue: 0.01 }, { onTopic: 0.08, needsHistory: 0.55 }), config);
    expect(d.route).toBe("new_session");
    expect(d.confidence).toBeCloseTo(0.92, 5);
  });

  test("same-topic variants go through without a dialog", () => {
    // "如果改成 60 秒竖屏版，沿用这些论点但重新设计开场" — fork 0.55 is not a reason to interrupt
    expect(applyPolicy(answers("fork", { fork: 0.55, continue: 0.45 }, { onTopic: 0.69, needsHistory: 0.51 }), config)).toMatchObject({ route: "continue" });
    expect(applyPolicy(answers("fork", { fork: 1 }, { onTopic: 0.94, needsHistory: 0.9 }), config)).toMatchObject({ route: "continue" });
  });

  test("an on-topic prompt is kept even when Jev leans unrelated", () => {
    const d = applyPolicy(answers("new_session", { new_session: 0.7, continue: 0.3 }, { onTopic: 0.8 }), config);
    expect(d).toMatchObject({ route: "continue", rule: "on_topic", confidence: 0.3 });
  });

  test("a weak unrelated signal is suppressed", () => {
    const d = applyPolicy(answers("new_session", { new_session: 0.4, side_chat: 0.1, continue: 0.35, fork: 0.15 }), config);
    expect(d).toMatchObject({ route: "continue", rule: "below_threshold" });
  });
});
