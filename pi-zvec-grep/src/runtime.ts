import { ChangeBatcher } from "./change-batcher.js";
import type { RuntimePhase, RuntimeStatus, SearchEngine, SearchResult } from "./types.js";
import { WorkspaceWatcher } from "./watcher.js";

export const INDEX_FAILURE_THRESHOLD = 3;
export const INDEX_FAILURE_BACKOFF_MS = 30_000;

export type WorkspaceRuntimeOptions = {
  watch?: boolean;
  debounceMs?: number;
  maxWaitMs?: number;
  reconcileIntervalMs?: number;
  closeTimeoutMs?: number;
  indexFailureBackoffMs?: number;
};

export class WorkspaceRuntime {
  private phase: RuntimePhase = "idle";
  private error?: string;
  private errorCode?: string;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private lastIndexedAt?: string;
  private initial?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private watcher?: WorkspaceWatcher;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private watcherRetryTimer?: ReturnType<typeof setTimeout>;
  private fullReconcilePending = false;
  private watcherState: RuntimeStatus["watcher"];
  private closed = false;
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();
  private readonly batcher: ChangeBatcher;
  private readonly failureBackoffMs: number;

  constructor(
    readonly root: string,
    private readonly engine: SearchEngine,
    private readonly options: WorkspaceRuntimeOptions = {},
  ) {
    this.watcherState = options.watch === false ? "disabled" : "starting";
    this.failureBackoffMs = options.indexFailureBackoffMs ?? INDEX_FAILURE_BACKOFF_MS;
    this.batcher = new ChangeBatcher((paths) => this.enqueueIndex(paths), {
      debounceMs: options.debounceMs,
      maxWaitMs: options.maxWaitMs,
    });
  }

  start(): void {
    if (this.initial || this.closed) return;
    this.phase = "indexing";
    this.emitStatus();
    this.initial = this.enqueueIndex(undefined, true);
    void this.initial.catch(() => {});
    if (this.options.watch !== false) {
      this.watcher = new WorkspaceWatcher(
        this.root,
        (path) => this.recordChangedPath(path),
        () => {
          this.fullReconcilePending = true;
          this.runBackground(this.batcher.flush().then(() => this.enqueueIndex()));
        },
        (state) => {
          this.watcherState = state;
          this.emitStatus();
        },
      );
      this.startWatcherWithRetry();
      const interval = this.options.reconcileIntervalMs ?? 60 * 60_000;
      if (interval > 0) {
        this.reconcileTimer = setInterval(() => this.runBackground(this.enqueueIndex()), interval);
        this.reconcileTimer.unref?.();
      }
    }
  }

  ready(): Promise<void> {
    return this.initial ?? Promise.resolve();
  }

  subscribe(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  recordChangedPath(path: string): void {
    this.batcher.add(path);
    this.emitStatus();
  }

  async flushChanges(): Promise<void> {
    await this.batcher.flush();
    await this.queue;
  }

  async search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult> {
    this.retryIndexingAfterBackoff();
    const status = this.status();
    if (status.phase === "error") throw new Error(status.error ?? `Workspace index failed: ${this.root}`);
    if (status.phase !== "ready") throw new IndexNotReadyError(status.phase, this.root);
    const operation = this.queue.then(() => withBusyRetry(() => this.engine.search(query, options), options?.signal));
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }

  async reindex(): Promise<void> {
    const operation = this.enqueueIndex(undefined, false, true);
    this.initial = operation;
    await operation;
  }

  retryIndexingAfterBackoff(): void {
    if (this.closed) return;
    if (this.consecutiveFailures < INDEX_FAILURE_THRESHOLD) return;
    if (this.phase === "indexing" || this.phase === "updating") return;
    if (Date.now() < this.backoffUntil) return;
    this.runBackground(this.enqueueIndex());
  }

  status(): RuntimeStatus {
    const phase = this.phase === "ready" && this.batcher.pending ? "updating" : this.phase;
    return {
      root: this.root,
      phase,
      error: this.error,
      errorCode: this.errorCode,
      consecutiveFailures: this.consecutiveFailures,
      lastIndexedAt: this.lastIndexedAt,
      pendingFiles: this.batcher.pendingCount,
      watcher: this.watcherState,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.watcherRetryTimer) clearTimeout(this.watcherRetryTimer);
    this.abortController.abort(new Error(`Workspace runtime closed: ${this.root}`));
    await this.watcher?.close();
    let failure: unknown;
    try {
      await this.batcher.close();
    } catch (cause) {
      failure = cause;
    } finally {
      await settleWithin(this.queue, this.options.closeTimeoutMs ?? 2_000);
      await this.engine.close();
      this.phase = "closed";
      this.watcherState = "stopped";
      this.emitStatus();
      this.listeners.clear();
    }
    if (failure) throw failure;
  }

  private enqueueIndex(paths?: readonly string[], initial = false, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!force && !initial && this.shouldSkipAutomaticIndex()) {
      this.fullReconcilePending = true;
      return Promise.resolve();
    }
    const changedPaths = this.fullReconcilePending ? undefined : paths;
    this.fullReconcilePending = false;
    const operation = this.queue.then(async () => {
      if (this.closed && !initial) return;
      const nextPhase = initial ? "indexing" : "updating";
      const phaseChanged = this.phase !== nextPhase;
      this.phase = nextPhase;
      if (phaseChanged) this.emitStatus();
      try {
        await withBusyRetry(() => this.engine.index(changedPaths, { signal: this.abortController.signal }), this.abortController.signal);
        this.lastIndexedAt = new Date().toISOString();
        this.phase = "ready";
        this.error = undefined;
        this.errorCode = undefined;
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        this.emitStatus();
      } catch (cause) {
        this.recordIndexFailure(cause);
        throw cause;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private shouldSkipAutomaticIndex(): boolean {
    return this.consecutiveFailures >= INDEX_FAILURE_THRESHOLD && Date.now() < this.backoffUntil;
  }

  private recordIndexFailure(cause: unknown): void {
    if (this.closed && this.abortController.signal.aborted) return;
    const { message, code } = describeError(cause);
    this.error = message;
    this.errorCode = code;
    if (!isBusyError(cause)) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= INDEX_FAILURE_THRESHOLD) {
        this.backoffUntil = Date.now() + this.failureBackoffMs;
      }
    }
    this.phase = "error";
    this.emitStatus();
  }

  private captureError(cause: unknown): void {
    if (this.closed && this.abortController.signal.aborted) return;
    const { message, code } = describeError(cause);
    this.error = message;
    if (code) this.errorCode = code;
    this.phase = "error";
    this.emitStatus();
  }

  private runBackground(operation: Promise<unknown>): void {
    void operation.catch((cause) => this.captureError(cause));
  }

  private startWatcherWithRetry(): void {
    if (!this.watcher || this.closed) return;
    void this.watcher.start().catch((cause) => {
      this.watcherState = "recovering";
      this.emitStatus();
      if (this.closed) return;
      this.watcherRetryTimer = setTimeout(() => this.startWatcherWithRetry(), 1_000);
      this.watcherRetryTimer.unref?.();
    });
  }

  private emitStatus(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}

export class IndexNotReadyError extends Error {
  constructor(readonly phase: RuntimePhase, readonly root: string) {
    super(`Workspace index is not ready (${phase}): ${root}`);
    this.name = "IndexNotReadyError";
  }
}

async function withBusyRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (cause) {
      if (attempt >= 60 || !isBusyError(cause)) throw cause;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(100 * 2 ** attempt, 2_000));
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  }
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

function isBusyError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.message.includes("LOCK.BUSY") || cause.message.toLowerCase().includes("lock busy") || ("code" in cause && String(cause.code).includes("LOCK.BUSY"));
}

function describeError(cause: unknown): { message: string; code?: string } {
  if (!(cause instanceof Error)) return { message: String(cause) };
  const code = "code" in cause && cause.code != null && String(cause.code) !== "" ? String(cause.code) : undefined;
  return { message: cause.message, code };
}
