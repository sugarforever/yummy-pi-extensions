import { describe, expect, test, vi } from "vitest";
import { INDEX_FAILURE_THRESHOLD, WorkspaceRuntime } from "../src/runtime.js";
import type { SearchEngine, SearchResult } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeResult(text: string): SearchResult {
  return { text, raw: { groups: [] } };
}

function lockBusyError(message = "LOCK.BUSY"): Error {
  return Object.assign(new Error(message), { code: "LOCK.BUSY" });
}

async function settleBusyOperation(operation: Promise<unknown>): Promise<void> {
  const settled = operation.then(() => {}, () => {});
  await vi.runAllTimersAsync();
  await settled;
}

describe("WorkspaceRuntime", () => {
  test("starts initial indexing without waiting for it", async () => {
    const initial = deferred<void>();
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => fakeResult("found"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    expect(runtime.status().phase).toBe("indexing");
    initial.resolve();
    await runtime.ready();
    expect(runtime.status().phase).toBe("ready");
  });

  test("publishes indexing and ready status changes", async () => {
    const initial = deferred<void>();
    const phases: string[] = [];
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => fakeResult("found"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    const unsubscribe = runtime.subscribe((status) => phases.push(status.phase));
    runtime.start();
    initial.resolve();
    await runtime.ready();
    unsubscribe();
    expect(phases).toEqual(["idle", "indexing", "ready"]);
  });

  test("aborts an in-flight initial index during close", async () => {
    let receivedSignal: AbortSignal | undefined;
    const engine: SearchEngine = {
      index: (_paths, options) => new Promise<void>((_resolve, reject) => {
        receivedSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await Promise.resolve();
    await runtime.close();
    expect(receivedSignal?.aborted).toBe(true);
    expect(runtime.status().phase).toBe("closed");
  });

  test("first search returns immediately while initial indexing is incomplete", async () => {
    const initial = deferred<void>();
    let searched = false;
    const engine: SearchEngine = {
      index: () => initial.promise,
      search: async () => { searched = true; return fakeResult("answer"); },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.search("where is auth?")).rejects.toThrow("Workspace index is not ready (indexing)");
    expect(searched).toBe(false);
    initial.resolve();
    await runtime.ready();
    await expect(runtime.search("where is auth?")).resolves.toEqual(fakeResult("answer"));
  });

  test("serializes incremental path batches behind the initial index", async () => {
    const first = deferred<void>();
    const calls: Array<readonly string[] | undefined> = [];
    let invocation = 0;
    const engine: SearchEngine = {
      index: async (paths) => {
        calls.push(paths);
        invocation += 1;
        if (invocation === 1) await first.promise;
      },
      search: async () => fakeResult("answer"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    runtime.recordChangedPath("/repo/a.ts");
    runtime.recordChangedPath("/repo/b.ts");
    first.resolve();
    await runtime.flushChanges();
    expect(calls).toEqual([undefined, ["/repo/a.ts", "/repo/b.ts"]]);
  });

  test("reports the number of paths waiting for an incremental update", async () => {
    const engine: SearchEngine = {
      index: async () => {},
      search: async () => fakeResult("answer"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 10_000 });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    runtime.recordChangedPath("/repo/b.ts");
    expect(runtime.status()).toMatchObject({ phase: "updating", pendingFiles: 2 });
    await runtime.close();
  });

  test("reports initial indexing failure and surfaces it to search", async () => {
    const engine: SearchEngine = {
      index: async () => { throw new Error("native binding unavailable"); },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("native binding unavailable");
    expect(runtime.status()).toMatchObject({ phase: "error", error: "native binding unavailable" });
    await expect(runtime.search("query")).rejects.toThrow("native binding unavailable");
  });

  test("close discards pending changes and closes the engine", async () => {
    const calls: Array<readonly string[] | undefined> = [];
    let closed = false;
    const engine: SearchEngine = {
      index: async (paths) => { calls.push(paths); },
      search: async () => fakeResult("answer"),
      close: async () => { closed = true; },
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    await runtime.close();
    expect(calls).toEqual([undefined]);
    expect(closed).toBe(true);
  });

  test("a successful reindex recovers searches after initial failure", async () => {
    let attempts = 0;
    const engine: SearchEngine = {
      index: async () => { if (++attempts === 1) throw new Error("busy"); },
      search: async () => fakeResult("recovered"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("busy");
    await runtime.reindex();
    await expect(runtime.search("query")).resolves.toEqual(fakeResult("recovered"));
  });

  test("does not begin an index while a search is using the engine", async () => {
    const searching = deferred<SearchResult>();
    let indexDuringSearch = false;
    let searchActive = false;
    const engine: SearchEngine = {
      index: async () => { if (searchActive) indexDuringSearch = true; },
      search: async () => { searchActive = true; const result = await searching.promise; searchActive = false; return result; },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    await runtime.ready();
    const result = runtime.search("query");
    await Promise.resolve();
    runtime.recordChangedPath("/repo/a.ts");
    const flush = runtime.flushChanges();
    await Promise.resolve();
    expect(indexDuringSearch).toBe(false);
    searching.resolve(fakeResult("done"));
    await result;
    await flush;
    expect(indexDuringSearch).toBe(false);
  });

  test("stops lock-busy retries when the tool call is aborted", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const engine: SearchEngine = {
      index: async () => {},
      search: async () => {
        attempts += 1;
        throw new Error("LOCK.BUSY");
      },
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    const search = runtime.search("query", { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("tool cancelled"));
    await expect(search).rejects.toThrow("tool cancelled");
    expect(attempts).toBe(1);
    await runtime.close();
  });

  test("closes native resources without starting a final change batch", async () => {
    let calls = 0;
    let closed = false;
    const engine: SearchEngine = {
      index: async () => { if (++calls > 1) throw new Error("write failed"); },
      search: async () => fakeResult("unused"),
      close: async () => { closed = true; },
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await runtime.ready();
    runtime.recordChangedPath("/repo/a.ts");
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(closed).toBe(true);
    expect(runtime.status().phase).toBe("closed");
  });

  test("keeps the last index error visible while a later pass is running", async () => {
    const second = deferred<void>();
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls === 1) throw new Error("FtsRocksdbReducer: source postings is not BitPacked. field=text");
        await second.promise;
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("BitPacked");
    expect(runtime.status()).toMatchObject({
      phase: "error",
      error: "FtsRocksdbReducer: source postings is not BitPacked. field=text",
      consecutiveFailures: 1,
    });

    const reindex = runtime.reindex();
    await Promise.resolve();
    expect(runtime.status()).toMatchObject({
      phase: "updating",
      error: "FtsRocksdbReducer: source postings is not BitPacked. field=text",
      consecutiveFailures: 1,
    });

    second.resolve();
    await reindex;
    expect(runtime.status().phase).toBe("ready");
    expect(runtime.status().error).toBeUndefined();
    expect(runtime.status().errorCode).toBeUndefined();
    expect(runtime.status().consecutiveFailures).toBe(0);
    await runtime.close();
  });

  test("records an error code from a failed index pass", async () => {
    const engine: SearchEngine = {
      index: async () => {
        throw Object.assign(new Error("merge failed"), { code: "FTS_CORRUPT" });
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("merge failed");
    expect(runtime.status()).toMatchObject({
      phase: "error",
      error: "merge failed",
      errorCode: "FTS_CORRUPT",
      consecutiveFailures: 1,
    });
    await runtime.close();
  });

  test("counts consecutive index failures and resets them after a successful pass", async () => {
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= 2) throw new Error("busy");
      },
      search: async () => fakeResult("ok"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("busy");
    expect(runtime.status().consecutiveFailures).toBe(1);

    runtime.recordChangedPath("/repo/a.ts");
    await expect(runtime.flushChanges()).rejects.toThrow("busy");
    expect(runtime.status().consecutiveFailures).toBe(2);

    await runtime.reindex();
    expect(runtime.status()).toMatchObject({ phase: "ready", consecutiveFailures: 0 });
    expect(runtime.status().error).toBeUndefined();
    await runtime.close();
  });

  test("pauses automatic re-enqueue after consecutive failures until backoff elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        throw new Error("FtsRocksdbReducer: source postings is not BitPacked. field=text");
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, {
      watch: false,
      debounceMs: 0,
      indexFailureBackoffMs: 5_000,
    });
    try {
      runtime.start();
      await expect(runtime.ready()).rejects.toThrow("BitPacked");

      runtime.recordChangedPath("/repo/a.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("BitPacked");
      runtime.recordChangedPath("/repo/b.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("BitPacked");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      runtime.recordChangedPath("/repo/c.ts");
      await runtime.flushChanges();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      await runtime.reindex().catch(() => {});
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);

      runtime.recordChangedPath("/repo/d.ts");
      await runtime.flushChanges();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);

      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      runtime.recordChangedPath("/repo/e.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("BitPacked");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 2);
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  test("deduplicates concurrent recovery requests after backoff elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        throw new Error("merge failed");
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, {
      watch: false,
      debounceMs: 0,
      indexFailureBackoffMs: 5_000,
    });
    try {
      runtime.start();
      await expect(runtime.ready()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/a.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/b.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      runtime.retryIndexingAfterBackoff();
      runtime.retryIndexingAfterBackoff();
      runtime.retryIndexingAfterBackoff();
      await runtime.flushChanges();

      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  test("a successful watcher-triggered pass after backoff resets failure state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= INDEX_FAILURE_THRESHOLD) throw new Error("merge failed");
      },
      search: async () => fakeResult("recovered"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, {
      watch: false,
      debounceMs: 0,
      indexFailureBackoffMs: 5_000,
    });
    try {
      runtime.start();
      await expect(runtime.ready()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/a.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/b.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      runtime.recordChangedPath("/repo/c.ts");
      await runtime.flushChanges();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);
      expect(runtime.status()).toMatchObject({ phase: "ready", consecutiveFailures: 0 });
      expect(runtime.status().error).toBeUndefined();
      await expect(runtime.search("query")).resolves.toEqual(fakeResult("recovered"));

      runtime.recordChangedPath("/repo/d.ts");
      await runtime.flushChanges();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 2);
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  test("explicit reindex during backoff recovers without waiting for the window", async () => {
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= INDEX_FAILURE_THRESHOLD) throw new Error("merge failed");
      },
      search: async () => fakeResult("recovered"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, {
      watch: false,
      debounceMs: 0,
      indexFailureBackoffMs: 60_000,
    });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("merge failed");
    runtime.recordChangedPath("/repo/a.ts");
    await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
    runtime.recordChangedPath("/repo/b.ts");
    await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
    expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

    await runtime.reindex();
    expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);
    expect(runtime.status()).toMatchObject({ phase: "ready", consecutiveFailures: 0 });
    await expect(runtime.search("query")).resolves.toEqual(fakeResult("recovered"));
    await runtime.close();
  });

  test("three consecutive lock-busy failures leave consecutiveFailures at 0", async () => {
    vi.useFakeTimers();
    const engine: SearchEngine = {
      index: async () => { throw lockBusyError(); },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    try {
      runtime.start();
      const initial = runtime.ready();
      await settleBusyOperation(initial);
      await expect(initial).rejects.toThrow("LOCK.BUSY");
      expect(runtime.status()).toMatchObject({
        phase: "error",
        error: "LOCK.BUSY",
        errorCode: "LOCK.BUSY",
        consecutiveFailures: 0,
      });

      runtime.recordChangedPath("/repo/a.ts");
      const second = runtime.flushChanges();
      await settleBusyOperation(second);
      await expect(second).rejects.toThrow("LOCK.BUSY");
      expect(runtime.status().consecutiveFailures).toBe(0);

      runtime.recordChangedPath("/repo/b.ts");
      const third = runtime.flushChanges();
      await settleBusyOperation(third);
      await expect(third).rejects.toThrow("LOCK.BUSY");
      expect(runtime.status()).toMatchObject({
        phase: "error",
        error: "LOCK.BUSY",
        errorCode: "LOCK.BUSY",
        consecutiveFailures: 0,
      });
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  test("interleaved lock-busy failures count only genuine errors toward the threshold", async () => {
    vi.useFakeTimers();
    const outcomes: Array<"busy" | "real"> = ["busy", "real", "busy", "real", "busy", "real"];
    let pass = 0;
    const engine: SearchEngine = {
      index: async () => {
        if (outcomes[pass] === "busy") throw lockBusyError();
        throw Object.assign(new Error("merge failed"), { code: "FTS_CORRUPT" });
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    try {
      runtime.start();
      const initial = runtime.ready();
      await settleBusyOperation(initial);
      await expect(initial).rejects.toThrow("LOCK.BUSY");
      pass += 1;
      expect(runtime.status()).toMatchObject({ phase: "error", consecutiveFailures: 0, error: "LOCK.BUSY" });

      runtime.recordChangedPath("/repo/a.ts");
      const second = runtime.flushChanges();
      await settleBusyOperation(second);
      await expect(second).rejects.toThrow("merge failed");
      pass += 1;
      expect(runtime.status()).toMatchObject({
        phase: "error",
        consecutiveFailures: 1,
        error: "merge failed",
        errorCode: "FTS_CORRUPT",
      });

      runtime.recordChangedPath("/repo/b.ts");
      const third = runtime.flushChanges();
      await settleBusyOperation(third);
      await expect(third).rejects.toThrow("LOCK.BUSY");
      pass += 1;
      expect(runtime.status().consecutiveFailures).toBe(1);

      runtime.recordChangedPath("/repo/c.ts");
      const fourth = runtime.flushChanges();
      await settleBusyOperation(fourth);
      await expect(fourth).rejects.toThrow("merge failed");
      pass += 1;
      expect(runtime.status().consecutiveFailures).toBe(2);

      runtime.recordChangedPath("/repo/d.ts");
      const fifth = runtime.flushChanges();
      await settleBusyOperation(fifth);
      await expect(fifth).rejects.toThrow("LOCK.BUSY");
      pass += 1;
      expect(runtime.status().consecutiveFailures).toBe(2);

      runtime.recordChangedPath("/repo/e.ts");
      const sixth = runtime.flushChanges();
      await settleBusyOperation(sixth);
      await expect(sixth).rejects.toThrow("merge failed");
      expect(runtime.status()).toMatchObject({
        phase: "error",
        error: "merge failed",
        errorCode: "FTS_CORRUPT",
        consecutiveFailures: INDEX_FAILURE_THRESHOLD,
      });
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  test("three genuine index failures still trip the terminal failure state", async () => {
    const engine: SearchEngine = {
      index: async () => {
        throw Object.assign(new Error("merge failed"), { code: "FTS_CORRUPT" });
      },
      search: async () => fakeResult("unused"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, { watch: false, debounceMs: 0 });
    runtime.start();
    await expect(runtime.ready()).rejects.toThrow("merge failed");
    runtime.recordChangedPath("/repo/a.ts");
    await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
    runtime.recordChangedPath("/repo/b.ts");
    await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
    expect(runtime.status()).toMatchObject({
      phase: "error",
      error: "merge failed",
      errorCode: "FTS_CORRUPT",
      consecutiveFailures: INDEX_FAILURE_THRESHOLD,
    });
    await runtime.close();
  });

  test("search after backoff enqueues a recovery pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const engine: SearchEngine = {
      index: async () => {
        calls += 1;
        if (calls <= INDEX_FAILURE_THRESHOLD) throw new Error("merge failed");
      },
      search: async () => fakeResult("recovered"),
      close: async () => {},
    };
    const runtime = new WorkspaceRuntime("/repo", engine, {
      watch: false,
      debounceMs: 0,
      indexFailureBackoffMs: 5_000,
    });
    try {
      runtime.start();
      await expect(runtime.ready()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/a.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      runtime.recordChangedPath("/repo/b.ts");
      await expect(runtime.flushChanges()).rejects.toThrow("merge failed");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      await expect(runtime.search("query")).rejects.toThrow("merge failed");
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD);

      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      await expect(runtime.search("query")).rejects.toThrow("merge failed");
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(INDEX_FAILURE_THRESHOLD + 1);
      expect(runtime.status()).toMatchObject({ phase: "ready", consecutiveFailures: 0 });
      await expect(runtime.search("query")).resolves.toEqual(fakeResult("recovered"));
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });
});
