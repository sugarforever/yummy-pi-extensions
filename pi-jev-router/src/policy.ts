import type { Decision, JevAnswers, RouterConfig } from "./types.js";

/**
 * Jev supplies probabilities; this file owns the policy. Every rule is a named constant so the
 * thresholds can be reviewed and re-tuned against the eval set without touching the questions.
 *
 * The router has one job: keep unrelated work out of the session. It interrupts only when the
 * prompt looks unrelated; everything else, including same-topic variants and follow-ups, goes
 * through. Where the prompt goes next is the user's choice in the dialog.
 *
 * "Unrelated" is the mass Jev puts on side_chat + new_session. Gating on either route alone let a
 * split vote (side_chat 0.45 / new_session 0.47) slip under the threshold.
 */
export const ON_TOPIC_KEEPS = 0.6;

export function applyPolicy(answers: JevAnswers, config: Pick<RouterConfig, "threshold">): Decision {
  const p = answers.routeProbabilities;
  const unrelated = p.side_chat + p.new_session;
  if (unrelated < config.threshold) {
    return { route: "continue", confidence: p.continue, rule: unrelated > p.continue ? "below_threshold" : undefined, answers };
  }
  if (answers.onTopic >= ON_TOPIC_KEEPS) {
    return { route: "continue", confidence: p.continue, rule: "on_topic", answers };
  }
  return { route: "new_session", confidence: unrelated, answers };
}
