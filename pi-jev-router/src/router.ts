import type { Decision, JevAnswers, RouterConfig, RouterState } from "./types.js";
import type { JevClient } from "./jev.js";
import { applyPolicy } from "./policy.js";

/**
 * One routing decision: ask Jev with a hard timeout, apply the policy, never throw.
 * Any failure (no key, network, throttling, timeout) degrades to `continue` so the router can
 * never block the user's prompt.
 */
export async function route(state: RouterState, client: JevClient, config: RouterConfig): Promise<Decision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const answers: JevAnswers = await client(state, controller.signal);
    return applyPolicy(answers, config);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { route: "continue", confidence: 1, skipped: controller.signal.aborted ? `timeout after ${config.timeoutMs} ms` : message };
  } finally {
    clearTimeout(timer);
  }
}
