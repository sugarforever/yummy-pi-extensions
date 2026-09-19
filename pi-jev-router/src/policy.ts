import type { Decision, JevAnswers, Route, RouterConfig } from "./types.js";

/**
 * Jev supplies probabilities; this file owns the policy. Every rule is a named constant so the
 * thresholds can be reviewed and re-tuned against the eval set without touching the questions.
 */
export const ON_TOPIC_KEEPS = 0.6;
export const NEEDS_HISTORY_FORKS = 0.7;
export const ONE_OFF_IS_SIDE_CHAT = 0.7;

export function applyPolicy(answers: JevAnswers, config: Pick<RouterConfig, "threshold">): Decision {
  const p = answers.routeProbabilities;
  let route: Route = answers.route;
  let rule: string | undefined;

  if (route !== "continue" && answers.onTopic >= ON_TOPIC_KEEPS) {
    route = "continue";
    rule = "on_topic";
  } else if ((route === "side_chat" || route === "new_session") && answers.needsHistory >= NEEDS_HISTORY_FORKS) {
    route = "fork";
    rule = "needs_history";
  } else if (route === "new_session" && answers.oneOff >= ONE_OFF_IS_SIDE_CHAT) {
    route = "side_chat";
    rule = "one_off";
  }

  // Confidence is the mass Jev put on the family of "leave" routes when a post-rule moved us within
  // that family, otherwise the probability of the chosen route.
  const leaveMass = p.side_chat + p.fork + p.new_session;
  const confidence = route === "continue" ? p.continue : rule ? leaveMass : p[route];

  if (route !== "continue" && confidence < config.threshold) {
    return { route: "continue", confidence: p.continue, rule: "below_threshold", answers };
  }
  return { route, confidence, rule, answers };
}
