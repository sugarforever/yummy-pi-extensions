import { describe, expect, test } from "vitest";
import { OPENROUTER_MODEL, OPENROUTER_URL, TYPESAFE_MODEL, TYPESAFE_URL, resolveClient, systemOneClient } from "../src/jev.js";

const state = { session_title: "t", recent_user_messages: ["a"], last_assistant_reply_tail: "b", new_input: "c" };

function fakeFetch(capture: { url?: string; init?: RequestInit }, body: unknown, status = 200): typeof fetch {
  return (async (url: any, init: any) => {
    capture.url = String(url);
    capture.init = init;
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
}

const answers = {
  answers: {
    route: { type: "choice", choice: "fork", probabilities: { continue: 0.2, side_chat: 0.1, fork: 0.6, new_session: 0.1 }, confidence: 0.6 },
    on_topic: { type: "noul", noul: 0.3 },
    needs_history: { type: "noul", noul: 0.8 },
    one_off: { type: "noul", noul: 0.1 },
  },
  usage: { input_tokens: 1234, output_tokens: 0, cost: 0.00005 },
};

describe("resolveClient", () => {
  test("prefers TypeSafe, then OpenRouter, then the gateway", () => {
    expect(resolveClient({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o", AI_GATEWAY_API_KEY: "g" })?.via).toBe("typesafe");
    expect(resolveClient({ OPENROUTER_API_KEY: "o", AI_GATEWAY_API_KEY: "g" })?.via).toBe("openrouter");
    expect(resolveClient({ AI_GATEWAY_API_KEY: "g" })?.via).toBe("gateway");
    expect(resolveClient({})).toBeUndefined();
  });

  test("PI_JEV_ROUTER_ENGINE forces one engine and fails closed on unknown names", () => {
    expect(resolveClient({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o", PI_JEV_ROUTER_ENGINE: "openrouter" })?.via).toBe("openrouter");
    expect(resolveClient({ TYPESAFE_API_KEY: "t", PI_JEV_ROUTER_ENGINE: "openrouter" })).toBeUndefined();
    expect(resolveClient({ TYPESAFE_API_KEY: "t", PI_JEV_ROUTER_ENGINE: "bogus" })).toBeUndefined();
  });
});

describe("systemOneClient", () => {
  test("sends the System One body to OpenRouter with the jev-1.13 model and attribution headers", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const client = systemOneClient("or-key", { url: OPENROUTER_URL, model: OPENROUTER_MODEL, via: "openrouter", extraHeaders: { "X-Title": "pi-jev-router" } }, fakeFetch(capture, answers));
    const result = await client(state, new AbortController().signal);
    expect(capture.url).toBe("https://openrouter.ai/api/v1/systemone");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["X-Title"]).toBe("pi-jev-router");
    const body = JSON.parse(String(capture.init?.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toEqual(state);
    expect(Object.keys(body.questions)).toEqual(["route", "on_topic", "needs_history", "one_off"]);
    expect(body.questions.route).toMatchObject({ type: "choice", criteria: expect.objectContaining({ fork: expect.any(String) }) });
    expect(body.questions.on_topic.type).toBe("noul");
    expect(result).toMatchObject({ route: "fork", onTopic: 0.3, needsHistory: 0.8, oneOff: 0.1, inputTokens: 1234 });
    expect(result.routeProbabilities).toEqual({ continue: 0.2, side_chat: 0.1, fork: 0.6, new_session: 0.1 });
  });

  test("TypeSafe direct uses its own endpoint and jev-latest", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await systemOneClient("ts-key", { url: TYPESAFE_URL, model: TYPESAFE_MODEL, via: "typesafe" }, fakeFetch(capture, answers))(state, new AbortController().signal);
    expect(capture.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(capture.init?.body)).model).toBe("jev-latest");
  });

  test("a non-2xx response throws with the engine name so the router can degrade", async () => {
    const client = systemOneClient("k", { url: OPENROUTER_URL, model: OPENROUTER_MODEL, via: "openrouter" }, fakeFetch({}, { error: "rate limited" }, 429));
    await expect(client(state, new AbortController().signal)).rejects.toThrow(/^openrouter 429/);
  });
});
