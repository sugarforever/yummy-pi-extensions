export type Route = "continue" | "side_chat" | "fork" | "new_session";

export type RouterState = {
  session_title: string;
  recent_user_messages: string[];
  last_assistant_reply_tail: string;
  new_input: string;
};

/** Raw typed answers from Jev, normalised across the direct API and the AI Gateway. */
export type JevAnswers = {
  route: Route;
  routeProbabilities: Record<Route, number>;
  onTopic: number;
  needsHistory: number;
  oneOff: number;
  inputTokens: number;
  latencyMs: number;
};

export type Decision = {
  route: Route;
  /** Probability Jev assigned to the final route (after post-rules). */
  confidence: number;
  /** Which post-rule produced the final route, if any. */
  rule?: string;
  answers?: JevAnswers;
  /** Why no Jev call was made, when one was skipped. */
  skipped?: string;
};

export type RouterConfig = {
  /** Minimum route probability before the extension suggests leaving the session. */
  threshold: number;
  /** Jev call budget; on timeout the input continues untouched. */
  timeoutMs: number;
  /** A prompt after this many minutes of silence is offered a new session without asking Jev. */
  staleAfterMinutes: number;
  /** Turns whose context usage is above this fraction are offered a new session without asking Jev. */
  contextUsageLimit: number;
};

export const DEFAULT_CONFIG: RouterConfig = {
  threshold: 0.6,
  timeoutMs: 2500,
  staleAfterMinutes: 12 * 60,
  contextUsageLimit: 0.85,
};
