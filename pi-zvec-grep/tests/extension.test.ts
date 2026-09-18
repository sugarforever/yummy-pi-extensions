import { describe, expect, test, vi } from "vitest";
import { registerPiZvecGrep } from "../src/extension.js";
import { INDEX_FAILURE_THRESHOLD, type WorkspaceRuntimeOptions } from "../src/runtime.js";
import type { SearchEngine } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function installExtension(engine: SearchEngine, runtimeOptions: WorkspaceRuntimeOptions = {}) {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  registerPiZvecGrep(pi as never, {
    createEngine: async () => engine,
    resolveRoot: async () => "/repo",
    runtimeOptions: { watch: false, ...runtimeOptions },
  });
  const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
  return { handlers, tools, commands, ctx };
}

function lockBusyError(message = "LOCK.BUSY"): Error {
  return Object.assign(new Error(message), { code: "LOCK.BUSY" });
}

async function drainBusyRetries(): Promise<void> {
  await vi.runAllTimersAsync();
}

async function failIndexTimes(
  commands: Map<string, any>,
  ctx: unknown,
  extraFailures: number,
  drain?: () => Promise<void>,
): Promise<void> {
  for (let i = 0; i < extraFailures; i += 1) {
    const done = commands.get("zvec-reindex").handler("", ctx);
    if (drain) await drain();
    await done;
  }
}

describe("registerPiZvecGrep", () => {
  test("adds routing guidance for semantic versus exact workspace search", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: () => {},
      registerCommand: () => {},
    };
    registerPiZvecGrep(pi as never);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {});
    expect(result).toMatchObject({ systemPrompt: expect.stringContaining("zvec_search") });
    expect((result as any).systemPrompt).toContain("exact identifiers");
    expect((result as any).systemPrompt).toContain("grep");
    expect((result as any).systemPrompt).toContain("retryable");
  });

  test("registers search immediately and manages runtime through session lifecycle", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const statuses: Array<[string, string | undefined]> = [];
    let closed = false;
    const engine: SearchEngine = {
      index: async () => {},
      search: async (query) => ({ text: `result:${query}`, raw: {} }),
      close: async () => { closed = true; },
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
    };

    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["zvec_search"]);
    expect([...commands.keys()]).toEqual(["zvec-status", "zvec-reindex"]);

    const ctx = { cwd: "/repo/src", hasUI: true, ui: { setStatus: (key: string, value?: string) => statuses.push([key, value]), notify: () => {} } };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await tools[0].execute("call-1", { query: "auth flow", limit: 5 }, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: "text", text: "result:auth flow" }]);
    expect(statuses.some(([, value]) => value?.includes("/repo"))).toBe(true);

    await handlers.get("session_shutdown")?.({}, ctx);
    expect(closed).toBe(true);
  });

  test("search before session startup returns an actionable error", async () => {
    const tools: any[] = [];
    const pi = { on: () => {}, registerTool: (tool: any) => tools.push(tool), registerCommand: () => {} };
    registerPiZvecGrep(pi as never, { createEngine: async () => { throw new Error("unused"); } });
    const result = await tools[0].execute("call-1", { query: "auth" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("workspace runtime is not ready");
  });

  test("returns structured retryable status instead of waiting for initial indexing", async () => {
    const initial = deferred<void>();
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools: any[] = [];
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
    };
    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });
    const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const pending = await Promise.race([
      tools[0].execute("call-1", { query: "auth" }),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 20)),
    ]);

    expect(pending).not.toBe("timed-out");
    expect(pending).toMatchObject({
      details: { status: "indexing", retryable: true, root: "/repo" },
    });
    expect((pending as any).isError).toBeUndefined();
    expect(JSON.parse((pending as any).content[0].text)).toMatchObject({
      status: "indexing",
      retryable: true,
    });
    initial.resolve();
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("keeps the TUI status synchronized during a manual reconciliation", async () => {
    const secondIndex = deferred<void>();
    let indexes = 0;
    const statuses: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const commands = new Map<string, any>();
    const engine: SearchEngine = {
      index: async () => { if (++indexes === 2) await secondIndex.promise; },
      search: async () => ({ text: "unused", raw: {} }),
      close: async () => {},
    };
    const pi = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: () => {},
      registerCommand: (name: string, command: any) => commands.set(name, command),
    };
    registerPiZvecGrep(pi as never, {
      createEngine: async () => engine,
      resolveRoot: async () => "/repo",
      runtimeOptions: { watch: false },
    });
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, value?: string) => { if (value) statuses.push(value); },
        notify: () => {},
      },
    };
    await handlers.get("session_start")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconcile = commands.get("zvec-reindex").handler("", ctx);
    await Promise.resolve();
    expect(statuses.at(-1)).toContain("updating");
    secondIndex.resolve();
    await reconcile;
    expect(statuses.at(-1)).toContain("ready");
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("a single index failure during a later pass stays retryable", async () => {
    const second = deferred<void>();
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient merge glitch");
        await second.promise;
      },
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine);
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = await tools[0].execute("call-1", { query: "auth" });
    expect(failed.isError).toBe(true);
    expect(failed.details?.retryable).not.toBe(false);

    const reconcile = commands.get("zvec-reindex").handler("", ctx);
    await Promise.resolve();
    const pending = await tools[0].execute("call-2", { query: "auth" });
    expect(pending).toMatchObject({
      details: { status: "updating", retryable: true, root: "/repo", error: "transient merge glitch" },
    });
    expect(pending.isError).toBeUndefined();

    second.resolve();
    await reconcile;
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("zvec_search is terminal after consecutive failures even while a later pass is running", async () => {
    const fourth = deferred<void>();
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= INDEX_FAILURE_THRESHOLD) {
          throw Object.assign(new Error("FtsRocksdbReducer: source postings is not BitPacked. field=text"), { code: "FTS_CORRUPT" });
        }
        await fourth.promise;
      },
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine);
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await failIndexTimes(commands, ctx, INDEX_FAILURE_THRESHOLD - 1);
    expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

    const reconcile = commands.get("zvec-reindex").handler("", ctx);
    await Promise.resolve();
    const result = await tools[0].execute("call-1", { query: "auth" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      retryable: false,
      root: "/repo",
      error: "FtsRocksdbReducer: source postings is not BitPacked. field=text",
      errorCode: "FTS_CORRUPT",
    });
    expect(result.details.consecutiveFailures).toBeGreaterThanOrEqual(INDEX_FAILURE_THRESHOLD);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.retryable).toBe(false);
    expect(payload.message).toContain("BitPacked");
    expect(payload.message.toLowerCase()).toMatch(/rebuild/);

    fourth.resolve();
    await reconcile;
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("zvec_search is terminal after consecutive failures when no pass is running", async () => {
    const engine: SearchEngine = {
      index: async () => {
        throw new Error("FtsRocksdbReducer: source postings is not BitPacked. field=text");
      },
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine);
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await failIndexTimes(commands, ctx, INDEX_FAILURE_THRESHOLD - 1);

    const result = await tools[0].execute("call-1", { query: "auth" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      retryable: false,
      root: "/repo",
      error: "FtsRocksdbReducer: source postings is not BitPacked. field=text",
    });
    expect(JSON.parse(result.content[0].text).retryable).toBe(false);
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  test("three consecutive lock-busy failures stay retryable and never return the terminal payload", async () => {
    vi.useFakeTimers();
    const engine: SearchEngine = {
      index: async () => { throw lockBusyError(); },
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine);
    try {
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await Promise.resolve();
      await drainBusyRetries();
      await failIndexTimes(commands, ctx, INDEX_FAILURE_THRESHOLD - 1, drainBusyRetries);

      const result = await tools[0].execute("call-1", { query: "auth" });
      expect(result.isError).toBe(true);
      expect(result.details?.retryable).not.toBe(false);
      expect(result.details?.consecutiveFailures).toBeUndefined();
      expect(result.details?.error ?? result.content[0].text).toContain("LOCK.BUSY");
      expect(result.content[0].text).toContain("LOCK.BUSY");
      expect(result.content[0].text).not.toMatch(/not retryable/i);
      expect(result.content[0].text).not.toMatch(/Rebuild the index/i);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      vi.useRealTimers();
    }
  });

  test("interleaved lock-busy failures count only genuine errors toward the terminal response", async () => {
    vi.useFakeTimers();
    const outcomes: Array<"busy" | "real"> = ["busy", "real", "busy", "real", "real"];
    let pass = 0;
    const engine: SearchEngine = {
      index: async () => {
        if (outcomes[pass] === "busy") throw lockBusyError();
        throw new Error("merge failed");
      },
      search: async () => ({ text: "must not search", raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine);
    try {
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await Promise.resolve();
      await drainBusyRetries();
      pass += 1;

      await failIndexTimes(commands, ctx, 1, drainBusyRetries);
      pass += 1;
      await failIndexTimes(commands, ctx, 1, drainBusyRetries);
      pass += 1;
      await failIndexTimes(commands, ctx, 1, drainBusyRetries);
      pass += 1;

      const stillRetryable = await tools[0].execute("call-1", { query: "auth" });
      expect(stillRetryable.details?.retryable).not.toBe(false);
      expect(stillRetryable.details?.consecutiveFailures).toBeUndefined();
      expect(stillRetryable.content[0].text).not.toMatch(/not retryable/i);

      await failIndexTimes(commands, ctx, 1, drainBusyRetries);
      const result = await tools[0].execute("call-2", { query: "auth" });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        retryable: false,
        error: "merge failed",
        consecutiveFailures: INDEX_FAILURE_THRESHOLD,
      });
      expect(JSON.parse(result.content[0].text).retryable).toBe(false);
      expect(JSON.parse(result.content[0].text).message).toMatch(/Rebuild the index/i);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      vi.useRealTimers();
    }
  });

  test("zvec_search after the backoff window recovers once a later pass succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= INDEX_FAILURE_THRESHOLD) throw new Error("merge failed");
      },
      search: async (query) => ({ text: `result:${query}`, raw: {} }),
      close: async () => {},
    };
    const { handlers, tools, commands, ctx } = installExtension(engine, { indexFailureBackoffMs: 5_000 });
    try {
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      await Promise.resolve();
      await Promise.resolve();
      await failIndexTimes(commands, ctx, INDEX_FAILURE_THRESHOLD - 1);
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      const blocked = await tools[0].execute("call-1", { query: "auth" });
      expect(blocked.isError).toBe(true);
      expect(blocked.details.retryable).toBe(false);
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      const retry = await tools[0].execute("call-2", { query: "auth" });
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);
      const recovered = retry.content[0].text === "result:auth"
        ? retry
        : await tools[0].execute("call-3", { query: "auth" });
      expect(recovered.content).toEqual([{ type: "text", text: "result:auth" }]);
      expect(recovered.isError).toBeUndefined();
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      vi.useRealTimers();
    }
  });
});
