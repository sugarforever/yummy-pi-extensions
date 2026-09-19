import type { JevAnswers, Route, RouterState } from "./types.js";
import { QUESTIONS, ROUTE_CRITERIA } from "./questions.js";

export type JevClient = (state: RouterState, signal: AbortSignal) => Promise<JevAnswers>;

const ROUTES = Object.keys(ROUTE_CRITERIA) as Route[];
export const TYPESAFE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
export const GATEWAY_MODEL = process.env.PI_JEV_ROUTER_MODEL ?? "typesafe-ai/jev";

/** Pick a client from the environment: direct TypeSafe key first, Vercel AI Gateway second. */
export function resolveClient(env: NodeJS.ProcessEnv = process.env): { client: JevClient; via: string } | undefined {
  if (env.TYPESAFE_API_KEY) return { client: directClient(env.TYPESAFE_API_KEY), via: "typesafe" };
  if (env.AI_GATEWAY_API_KEY) return { client: gatewayClient(), via: "gateway" };
  return undefined;
}

function normaliseProbabilities(raw: Record<string, number> | undefined, choice: Route): Record<Route, number> {
  const out = { continue: 0, side_chat: 0, fork: 0, new_session: 0 } as Record<Route, number>;
  for (const route of ROUTES) out[route] = raw?.[route] ?? 0;
  if (!raw) out[choice] = 1;
  return out;
}

/** POST https://api.typesafe.ai/v1/systemone */
export function directClient(apiKey: string, fetchImpl: typeof fetch = fetch): JevClient {
  const questions = {
    route: { type: "choice", instructions: QUESTIONS.route.instructions, criteria: QUESTIONS.route.criteria },
    on_topic: { type: "noul", instructions: QUESTIONS.on_topic.instructions },
    needs_history: { type: "noul", instructions: QUESTIONS.needs_history.instructions },
    one_off: { type: "noul", instructions: QUESTIONS.one_off.instructions },
  };
  return async (state, signal) => {
    const started = performance.now();
    const response = await fetchImpl(TYPESAFE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal,
    });
    if (!response.ok) throw new Error(`TypeSafe ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = (await response.json()) as {
      answers: Record<string, { choice?: string; noul?: number; probabilities?: Record<string, number> }>;
      usage?: { input_tokens?: number };
    };
    const route = (body.answers.route?.choice ?? "continue") as Route;
    return {
      route,
      routeProbabilities: normaliseProbabilities(body.answers.route?.probabilities, route),
      onTopic: body.answers.on_topic?.noul ?? 0,
      needsHistory: body.answers.needs_history?.noul ?? 0,
      oneOff: body.answers.one_off?.noul ?? 0,
      inputTokens: body.usage?.input_tokens ?? 0,
      latencyMs: Math.round(performance.now() - started),
    };
  };
}

/** Vercel AI Gateway: only reachable through the AI SDK's experimental_evaluate. Loaded lazily. */
export function gatewayClient(): JevClient {
  // Import once, eagerly, so module loading never counts against the per-call timeout. A failed
  // import must surface on the first routed prompt (where it degrades to "continue"), not as an
  // unhandled rejection at startup.
  const modules = Promise.all([import("ai"), import("@ai-sdk/gateway")]);
  modules.catch(() => {});
  return async (state, signal) => {
    const [{ experimental_evaluate: evaluate }, { gateway }] = await modules;
    const started = performance.now();
    const result = await evaluate({
      model: gateway.evaluationModel(GATEWAY_MODEL),
      state: state as never,
      questions: QUESTIONS as never,
      maxRetries: 0,
      abortSignal: signal,
    });
    const answers = result.answers as Record<string, { choice?: string; probability?: number; probabilities?: Record<string, number> }>;
    const route = (answers.route?.choice ?? "continue") as Route;
    return {
      route,
      routeProbabilities: normaliseProbabilities(answers.route?.probabilities, route),
      onTopic: answers.on_topic?.probability ?? 0,
      needsHistory: answers.needs_history?.probability ?? 0,
      oneOff: answers.one_off?.probability ?? 0,
      inputTokens: result.usage?.inputTokens ?? 0,
      latencyMs: Math.round(performance.now() - started),
    };
  };
}
