import type { JevAnswers, Route, RouterState } from "./types.js";
import { QUESTIONS, ROUTE_CRITERIA } from "./questions.js";

export type JevClient = (state: RouterState, signal: AbortSignal) => Promise<JevAnswers>;

const ROUTES = Object.keys(ROUTE_CRITERIA) as Route[];

/** The three ways to reach Jev. TypeSafe and OpenRouter share the System One wire format. */
export type Engine = "typesafe" | "openrouter" | "gateway";
export const ENGINES: Engine[] = ["typesafe", "openrouter", "gateway"];

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone";
export const OPENROUTER_MODEL = "typesafe/jev-1.13";
export const GATEWAY_MODEL = "typesafe-ai/jev";

export type SystemOneOptions = {
  url: string;
  model: string;
  /** Label used in error messages and the status line. */
  via: Engine;
  extraHeaders?: Record<string, string>;
};

/**
 * Pick a client from the environment. `PI_JEV_ROUTER_ENGINE` forces one; otherwise the first key
 * found wins in this order: TypeSafe direct, OpenRouter, Vercel AI Gateway.
 */
export function resolveClient(env: NodeJS.ProcessEnv = process.env): { client: JevClient; via: Engine } | undefined {
  const forced = env.PI_JEV_ROUTER_ENGINE?.trim().toLowerCase();
  if (forced && !ENGINES.includes(forced as Engine)) return undefined;
  const order = forced ? [forced as Engine] : ENGINES;
  for (const engine of order) {
    const client = clientFor(engine, env);
    if (client) return { client, via: engine };
  }
  return undefined;
}

function clientFor(engine: Engine, env: NodeJS.ProcessEnv): JevClient | undefined {
  switch (engine) {
    case "typesafe":
      return env.TYPESAFE_API_KEY
        ? systemOneClient(env.TYPESAFE_API_KEY, { url: env.TYPESAFE_BASE_URL ?? TYPESAFE_URL, model: env.TYPESAFE_MODEL ?? TYPESAFE_MODEL, via: "typesafe" })
        : undefined;
    case "openrouter":
      return env.OPENROUTER_API_KEY
        ? systemOneClient(env.OPENROUTER_API_KEY, {
            url: env.OPENROUTER_BASE_URL ?? OPENROUTER_URL,
            model: env.OPENROUTER_MODEL ?? OPENROUTER_MODEL,
            via: "openrouter",
            // Optional attribution headers OpenRouter uses for its app rankings.
            extraHeaders: { "HTTP-Referer": "https://github.com/sugarforever/yummy-pi-extensions", "X-Title": "pi-jev-router" },
          })
        : undefined;
    case "gateway":
      return env.AI_GATEWAY_API_KEY ? gatewayClient(env.PI_JEV_ROUTER_MODEL ?? GATEWAY_MODEL) : undefined;
  }
}

function normaliseProbabilities(raw: Record<string, number> | undefined, choice: Route): Record<Route, number> {
  const out = { continue: 0, side_chat: 0, fork: 0, new_session: 0 } as Record<Route, number>;
  for (const route of ROUTES) out[route] = raw?.[route] ?? 0;
  if (!raw) out[choice] = 1;
  return out;
}

/** Kept for callers of 0.1.x: a TypeSafe direct client with default endpoint and model. */
export function directClient(apiKey: string, fetchImpl: typeof fetch = fetch): JevClient {
  return systemOneClient(apiKey, { url: TYPESAFE_URL, model: TYPESAFE_MODEL, via: "typesafe" }, fetchImpl);
}

/**
 * System One wire format: `POST {url}` with `{ model, state, questions }`, answers keyed by question.
 * Used verbatim by TypeSafe (`api.typesafe.ai/v1/systemone`) and OpenRouter (`openrouter.ai/api/v1/systemone`).
 */
export function systemOneClient(apiKey: string, options: SystemOneOptions, fetchImpl: typeof fetch = fetch): JevClient {
  const questions = {
    route: { type: "choice", instructions: QUESTIONS.route.instructions, criteria: QUESTIONS.route.criteria },
    on_topic: { type: "noul", instructions: QUESTIONS.on_topic.instructions },
    needs_history: { type: "noul", instructions: QUESTIONS.needs_history.instructions },
    one_off: { type: "noul", instructions: QUESTIONS.one_off.instructions },
  };
  return async (state, signal) => {
    const started = performance.now();
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...options.extraHeaders },
      body: JSON.stringify({ model: options.model, state, questions }),
      signal,
    });
    if (!response.ok) throw new Error(`${options.via} ${response.status}: ${(await response.text()).slice(0, 200)}`);
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
export function gatewayClient(model: string = GATEWAY_MODEL): JevClient {
  // Import once, eagerly, so module loading never counts against the per-call timeout. A failed
  // import must surface on the first routed prompt (where it degrades to "continue"), not as an
  // unhandled rejection at startup.
  const modules = Promise.all([import("ai"), import("@ai-sdk/gateway")]);
  modules.catch(() => {});
  return async (state, signal) => {
    const [{ experimental_evaluate: evaluate }, { gateway }] = await modules;
    const started = performance.now();
    const result = await evaluate({
      model: gateway.evaluationModel(model),
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
