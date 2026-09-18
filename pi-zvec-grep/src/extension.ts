import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createZvecSearchEngine } from "./engine.js";
import { INDEX_FAILURE_THRESHOLD, WorkspaceRuntime, type WorkspaceRuntimeOptions } from "./runtime.js";
import type { RuntimeStatus, SearchEngine } from "./types.js";
import { resolveWorkspaceRoot } from "./workspace.js";

type ExtensionDependencies = {
  createEngine?: (root: string) => Promise<SearchEngine>;
  resolveRoot?: (cwd: string) => Promise<string>;
  runtimeOptions?: WorkspaceRuntimeOptions;
};

export function registerPiZvecGrep(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}): void {
  const createEngine = dependencies.createEngine ?? createZvecSearchEngine;
  const resolveRoot = dependencies.resolveRoot ?? resolveWorkspaceRoot;
  let runtime: WorkspaceRuntime | undefined;
  let generation = 0;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nWorkspace search guidance:\n- Use zvec_search for semantic questions, cross-file concepts, architecture, or when the wording and location are unknown.\n- Use grep or the built-in exact-search tools for known exact identifiers, literals, file names, and regular expressions.\n- If zvec_search reports indexing or updating with retryable true, do not loop or wait indefinitely; use exact search, continue other work, or retry later.\n- If zvec_search reports retryable false, the workspace index is broken; use grep or read and do not retry zvec_search until the index is rebuilt.`,
  }));

  pi.registerTool({
    name: "zvec_search",
    label: "Zvec Search",
    description: "Search the current workspace for semantic concepts and cross-file relationships when exact wording or location is unknown. Use grep for exact identifiers, literals, filenames, or regex. The index is maintained automatically.",
    parameters: Type.Object({
      query: Type.String({ description: "A natural-language concept or question to find in the workspace" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30, description: "Maximum ranked results (default 10)" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!runtime) return toolError("zvec workspace runtime is not ready; start a Pi session in a workspace and retry");
      try {
        runtime.retryIndexingAfterBackoff();
        const status = runtime.status();
        if (status.consecutiveFailures >= INDEX_FAILURE_THRESHOLD && status.error) return indexBroken(status);
        if (status.phase === "indexing" || status.phase === "updating") return indexNotReady(status);
        const result = await runtime.search(params.query, { limit: params.limit, signal });
        return { content: [{ type: "text", text: result.text }], details: result.raw };
      } catch (cause) {
        return toolError(errorMessage(cause));
      }
    },
  });

  pi.registerCommand("zvec-status", {
    description: "Show automatic workspace-index status",
    handler: async (_args, ctx) => {
      const status = runtime?.status();
      ctx.ui.notify(status ? `${status.phase}: ${status.root}${status.error ? ` — ${status.error}` : ""}` : "zvec runtime is not started", status?.error ? "error" : "info");
    },
  });

  pi.registerCommand("zvec-reindex", {
    description: "Request a full workspace reconciliation (normally unnecessary)",
    handler: async (_args, ctx) => {
      if (!runtime) return ctx.ui.notify("zvec runtime is not started", "error");
      ctx.ui.notify(`Reconciling ${runtime.root}…`, "info");
      try {
        await runtime.reindex();
        ctx.ui.notify(`zvec index is fresh: ${runtime.root}`, "info");
      } catch (cause) {
        ctx.ui.notify(`zvec reconcile failed: ${errorMessage(cause)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const ownGeneration = ++generation;
    const previous = runtime;
    runtime = undefined;
    await previous?.close();
    const root = await resolveRoot(ctx.cwd);
    const engine = await createEngine(root);
    if (ownGeneration !== generation) {
      await engine.close();
      return;
    }
    runtime = new WorkspaceRuntime(root, engine, dependencies.runtimeOptions);
    if (ctx.hasUI) {
      runtime.subscribe((status) => renderStatus(ctx, status));
    }
    runtime.start();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    const current = runtime;
    runtime = undefined;
    await current?.close();
    if (ctx.hasUI) ctx.ui.setStatus("pi-zvec-grep", undefined);
  });
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
}

function indexNotReady(status: RuntimeStatus) {
  const details = {
    status: status.phase,
    retryable: true as const,
    root: status.root,
    message: "The workspace index is not ready. Choose whether to use grep/read now or retry zvec_search later.",
    ...(status.error ? { error: status.error, ...(status.errorCode ? { errorCode: status.errorCode } : {}) } : {}),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function indexBroken(status: RuntimeStatus) {
  const error = status.error ?? `Workspace index failed: ${status.root}`;
  const details = {
    status: status.phase,
    retryable: false as const,
    root: status.root,
    error,
    ...(status.errorCode ? { errorCode: status.errorCode } : {}),
    consecutiveFailures: status.consecutiveFailures,
    message: `The workspace index failed repeatedly (${error}). It is not retryable. Rebuild the index with /zvec-reindex, or delete ${status.root}/.zvec-grep and retry.`,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: true };
}

function renderStatus(ctx: any, status: RuntimeStatus): void {
  const theme = ctx.ui.theme;
  const degraded = status.phase === "ready" && status.watcher === "recovering";
  const label = degraded ? "degraded" : status.phase;
  const color = status.phase === "ready" && !degraded ? "success" : status.phase === "error" ? "error" : status.phase === "updating" ? "accent" : "warning";
  const detail = status.phase === "updating" && status.pendingFiles > 0 ? ` ${status.pendingFiles} files` : "";
  ctx.ui.setStatus("pi-zvec-grep", theme?.fg ? theme.fg(color, `zvec: ${label}${detail} ${status.root}`) : `zvec: ${label}${detail} ${status.root}`);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
