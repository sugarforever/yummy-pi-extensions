import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { resolveClient, type Engine, type JevClient } from "./jev.js";
import { prefilter } from "./prefilter.js";
import { route as routeWithJev } from "./router.js";
import { buildState, lastUserTimestamp, type EntryLike } from "./state.js";
import { DEFAULT_CONFIG, type Decision, type Route, type RouterConfig } from "./types.js";

export type ExtensionDependencies = {
  client?: JevClient;
  via?: Engine | string;
  config?: Partial<RouterConfig>;
  now?: () => number;
};

type Pending = { text: string; images?: InputEvent["images"]; action: Exclude<Route, "continue"> };

const STATUS_KEY = "pi-jev-router";
const GO_COMMAND = "route-go";

const LABELS: Record<Route, string> = {
  continue: "Keep here",
  side_chat: "a quick unrelated question",
  fork: "a tangent that still needs this history",
  new_session: "an unrelated task",
};

function dialogTitle(decision: Decision): string {
  if (decision.rule === "stale_session") return "This session has been idle for a while. Where should this prompt go?";
  if (decision.rule === "context_full") return "This session's context is nearly full. Where should this prompt go?";
  return `This looks like ${LABELS[decision.route]} (${Math.round(decision.confidence * 100)}%). Where should it go?`;
}

export function registerPiJevRouter(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}): void {
  const resolved = dependencies.client ? { client: dependencies.client, via: dependencies.via ?? "custom" } : resolveClient();
  const config: RouterConfig = { ...DEFAULT_CONFIG, ...envConfig(), ...dependencies.config };
  const now = dependencies.now ?? Date.now;
  let enabled = true;
  let pending: Pending | undefined;
  let last: Decision | undefined;

  pi.on("session_start", async (_event, ctx) => {
    // "Stop asking this session" and /route-toggle are per session: a new, forked or resumed session starts enabled.
    enabled = true;
    pending = undefined;
    last = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, resolved ? `route: ready (${resolved.via})` : "route: no key");
  });

  pi.on("input", async (event, ctx) => {
    if (!enabled || !resolved) return { action: "continue" };
    const skip = prefilter(event.text, { streaming: event.streamingBehavior !== undefined, source: event.source, hasImages: !!event.images?.length });
    if (skip.skip) return { action: "continue" };

    const entries = ctx.sessionManager.getBranch() as EntryLike[];
    const state = buildState(entries, event.text, ctx.sessionManager.getSessionName());
    if (state.recent_user_messages.length === 0) return { action: "continue" }; // first prompt: nothing to compare against

    let decision = codeRules(entries, ctx, config, now());
    if (!decision) decision = await routeWithJev(state, resolved.client, config);
    last = decision;
    renderStatus(ctx, decision);
    if (decision.route === "continue") return { action: "continue" };

    if (!ctx.hasUI) return { action: "continue" };
    const choice = await ctx.ui.select(dialogTitle(decision), [LABELS.continue, "Fork from here", "New session", "Keep here and stop asking this session"]);
    if (choice === "Keep here and stop asking this session") enabled = false;
    if (!choice || choice.startsWith("Keep")) return { action: "continue" };

    pending = { text: event.text, images: event.images, action: choice === "New session" ? "new_session" : "fork" };
    ctx.ui.setEditorText(`/${GO_COMMAND}`);
    ctx.ui.notify(`Press Enter to ${choice === "New session" ? "start a new session" : "fork"} with your message.`, "info");
    return { action: "handled" };
  });

  pi.registerCommand(GO_COMMAND, {
    description: "Move the last routed prompt to a fork or a new session (set up by pi-jev-router)",
    handler: async (_args, ctx) => moveWithPending(ctx),
  });

  pi.registerCommand("route-status", {
    description: "Show the last routing decision and the router configuration",
    handler: async (_args, ctx) => {
      const lines = [
        `engine: ${resolved ? resolved.via : "none — set TYPESAFE_API_KEY, OPENROUTER_API_KEY or AI_GATEWAY_API_KEY"}`,
        `enabled: ${enabled}  threshold: ${config.threshold}  timeout: ${config.timeoutMs} ms  stale: ${config.staleAfterMinutes} min  context limit: ${config.contextUsageLimit}`,
        last ? describe(last) : "no decision yet",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("route-toggle", {
    description: "Enable or disable pi-jev-router for this session",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`pi-jev-router ${enabled ? "enabled" : "disabled"}`, "info");
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, enabled ? "route: ready" : "route: off");
    },
  });

  pi.registerCommand("route-threshold", {
    description: "Set the confidence needed before the router suggests leaving the session (0–1)",
    handler: async (args, ctx) => {
      const value = parseUnitInterval(args);
      if (value === undefined) return ctx.ui.notify(`usage: /route-threshold 0.6 (current: ${config.threshold})`, "error");
      config.threshold = value;
      ctx.ui.notify(`route threshold = ${value}`, "info");
    },
  });

  async function moveWithPending(ctx: ExtensionCommandContext): Promise<void> {
    const move = pending;
    pending = undefined;
    if (!move) return ctx.ui.notify("Nothing to move. Type a prompt first; the router will offer to fork it.", "warning");
    const content = move.images?.length ? [{ type: "text" as const, text: move.text }, ...move.images] : move.text;
    try {
      await ctx.waitForIdle();
      let result: { cancelled: boolean };
      if (move.action === "fork") {
        const leaf = ctx.sessionManager.getLeafId();
        if (!leaf) throw new Error("cannot fork an empty session");
        result = await ctx.fork(leaf, { position: "at", withSession: async (next) => next.sendUserMessage(content) });
      } else {
        result = await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
          withSession: async (next) => next.sendUserMessage(content),
        });
      }
      if (result.cancelled) {
        pending = move;
        ctx.ui.notify(`${move.action === "fork" ? "Fork" : "New session"} was cancelled; your prompt is still parked, run /${GO_COMMAND} again or paste it back.`, "warning");
      }
    } catch (cause) {
      // The editor was already emptied when the input was handled; keep the prompt so nothing is lost.
      pending = move;
      ctx.ui.setEditorText(move.text);
      ctx.ui.notify(`Could not move the prompt (${cause instanceof Error ? cause.message : String(cause)}); it is back in the editor.`, "error");
    }
  }
}

/** Rules that need no judgment: a stale session or a nearly full context is offered a new session outright. */
function codeRules(entries: EntryLike[], ctx: ExtensionContext, config: RouterConfig, nowMs: number): Decision | undefined {
  const lastAt = lastUserTimestamp(entries);
  if (lastAt !== undefined && nowMs - lastAt > config.staleAfterMinutes * 60_000) {
    return { route: "new_session", confidence: 1, rule: "stale_session" };
  }
  const usage = ctx.getContextUsage?.();
  const fraction = typeof usage?.percent === "number" ? usage.percent / 100 : undefined;
  if (fraction !== undefined && fraction >= config.contextUsageLimit) {
    return { route: "new_session", confidence: 1, rule: "context_full" };
  }
  return undefined;
}

function envConfig(env: NodeJS.ProcessEnv = process.env): Partial<RouterConfig> {
  const out: Partial<RouterConfig> = {};
  const threshold = parseUnitInterval(env.PI_JEV_ROUTER_THRESHOLD);
  if (threshold !== undefined) out.threshold = threshold;
  const timeout = Number(env.PI_JEV_ROUTER_TIMEOUT_MS);
  if (timeout > 0) out.timeoutMs = timeout;
  const stale = Number(env.PI_JEV_ROUTER_STALE_MINUTES);
  if (stale > 0) out.staleAfterMinutes = stale;
  return out;
}

/** "0.6" → 0.6; empty, non-numeric or out-of-range input → undefined. */
export function parseUnitInterval(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function describe(decision: Decision): string {
  if (decision.skipped) return `last: continue (router skipped: ${decision.skipped})`;
  const a = decision.answers;
  const detail = a
    ? ` jev=${a.route} on_topic=${a.onTopic.toFixed(2)} needs_history=${a.needsHistory.toFixed(2)} one_off=${a.oneOff.toFixed(2)} ${a.latencyMs} ms ${a.inputTokens} tok`
    : "";
  return `last: ${decision.route} (${Math.round(decision.confidence * 100)}%)${decision.rule ? ` via ${decision.rule}` : ""}${detail}`;
}

function renderStatus(ctx: ExtensionContext, decision: Decision): void {
  if (!ctx.hasUI) return;
  const short = decision.skipped ? "route: skipped" : `route: ${decision.route} ${Math.round(decision.confidence * 100)}%${decision.answers ? ` ${decision.answers.latencyMs}ms` : ""}`;
  ctx.ui.setStatus(STATUS_KEY, short);
}
