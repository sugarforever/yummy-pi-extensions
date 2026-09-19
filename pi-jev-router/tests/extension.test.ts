import { describe, expect, test } from "vitest";
import { registerPiJevRouter } from "../src/extension.js";
import type { JevAnswers, RouterState } from "../src/types.js";

type Handler = (event: any, ctx: any) => Promise<any>;

function harness(client: (state: RouterState) => Promise<JevAnswers>, options: { now?: () => number } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const pi = { on: (name: string, h: Handler) => handlers.set(name, h), registerCommand: (name: string, c: any) => commands.set(name, c) };
  // Fixtures are stamped 2026-09-19T10:00Z; pin "now" so the stale-session rule is exercised only on purpose.
  registerPiJevRouter(pi as never, { client: async (state) => client(state), via: "fake", now: options.now ?? (() => Date.parse("2026-09-19T10:05:00Z")) });
  return { handlers, commands };
}

const entry = (role: string, text: string, timestamp = "2026-09-19T10:00:00Z") => ({ type: "message", timestamp, message: { role, content: [{ type: "text", text }] } });

function ctxWith(overrides: Partial<any> = {}) {
  const calls = { select: [] as any[], notify: [] as any[], setEditorText: [] as any[], setStatus: [] as any[] };
  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [entry("user", "plan the jev video"), entry("assistant", "ok, here is the storyboard"), entry("user", "make the cover blue")],
      getSessionName: () => undefined,
      getLeafId: () => "leaf-1",
      getSessionFile: () => "/tmp/s.jsonl",
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    ui: {
      select: async (...args: any[]) => { calls.select.push(args); return overrides.choice; },
      notify: (...args: any[]) => calls.notify.push(args),
      setEditorText: (...args: any[]) => calls.setEditorText.push(args),
      setStatus: (...args: any[]) => calls.setStatus.push(args),
    },
    ...overrides.ctx,
  };
  return { ctx, calls };
}

const leave = (): JevAnswers => ({
  route: "new_session",
  routeProbabilities: { continue: 0.1, side_chat: 0.06, fork: 0.11, new_session: 0.73 },
  onTopic: 0.27, needsHistory: 0.3, oneOff: 0.15, inputTokens: 1389, latencyMs: 490,
});
const stay = (): JevAnswers => ({ ...leave(), route: "continue", routeProbabilities: { continue: 0.95, side_chat: 0.02, fork: 0.02, new_session: 0.01 }, onTopic: 0.9 });

describe("registerPiJevRouter", () => {
  test("registers the input hook and its commands", () => {
    const { handlers, commands } = harness(async () => stay());
    expect(handlers.has("input")).toBe(true);
    expect([...commands.keys()]).toEqual(["route-go", "route-status", "route-toggle", "route-threshold"]);
  });

  test("tiny steers never reach Jev", async () => {
    let asked = 0;
    const { handlers } = harness(async () => { asked += 1; return stay(); });
    const { ctx } = ctxWith();
    expect(await handlers.get("input")!({ type: "input", text: "merged", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(asked).toBe(0);
  });

  test("an on-topic prompt continues without a dialog", async () => {
    let seen: RouterState | undefined;
    const { handlers } = harness(async (state) => { seen = state; return stay(); });
    const { ctx, calls } = ctxWith();
    const result = await handlers.get("input")!({ type: "input", text: "also add the qr code to the 4:3 cover", source: "interactive" }, ctx);
    expect(result).toEqual({ action: "continue" });
    expect(calls.select).toHaveLength(0);
    expect(seen?.recent_user_messages).toEqual(["plan the jev video", "make the cover blue"]);
    expect(seen?.last_assistant_reply_tail).toBe("ok, here is the storyboard");
    expect(calls.setStatus.at(-1)?.[1]).toContain("route: continue 95%");
  });

  test("a pivot offers a choice; choosing a new session parks the prompt behind /route-go", async () => {
    const { handlers, commands } = harness(async () => leave());
    const { ctx, calls } = ctxWith({ choice: "New session" });
    const result = await handlers.get("input")!({ type: "input", text: "look into ~/github/other-project and review the recent sessions", source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
    expect(calls.select[0]?.[0]).toContain("an unrelated task (73%)");
    expect(calls.setEditorText).toEqual([["/route-go"]]);

    const sent: any[] = [];
    let newSessionArgs: any;
    const cmdCtx = {
      ...ctx,
      waitForIdle: async () => {},
      newSession: async (args: any) => { newSessionArgs = args; await args.withSession({ sendUserMessage: async (c: any) => sent.push(c) }); return { cancelled: false }; },
      fork: async () => { throw new Error("should not fork"); },
    };
    await commands.get("route-go").handler("", cmdCtx);
    expect(newSessionArgs.parentSession).toBe("/tmp/s.jsonl");
    expect(sent).toEqual(["look into ~/github/other-project and review the recent sessions"]);
    await commands.get("route-go").handler("", cmdCtx); // second run has nothing to move
    expect(calls.notify.at(-1)?.[0]).toContain("Nothing to move");
  });

  test("choosing fork forks at the leaf with the prompt, keeping images", async () => {
    const { handlers, commands } = harness(async () => leave());
    const { ctx } = ctxWith({ choice: "Fork from here" });
    const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
    await handlers.get("input")!({ type: "input", text: "try the same storyboard but re-cut it as a 9:16 vertical short with the hook moved to the first three seconds", images, source: "interactive" }, ctx);
    const sent: any[] = [];
    let forkArgs: any;
    const cmdCtx = { ...ctx, waitForIdle: async () => {}, fork: async (id: string, args: any) => { forkArgs = [id, args]; await args.withSession({ sendUserMessage: async (c: any) => sent.push(c) }); return { cancelled: false }; } };
    await commands.get("route-go").handler("", cmdCtx);
    expect(forkArgs[0]).toBe("leaf-1");
    expect(forkArgs[1].position).toBe("at");
    expect(sent[0]).toEqual([{ type: "text", text: "try the same storyboard but re-cut it as a 9:16 vertical short with the hook moved to the first three seconds" }, ...images]);
  });

  test("dismissing the dialog keeps the prompt here; the opt-out silences the session", async () => {
    let asked = 0;
    const { handlers } = harness(async () => { asked += 1; return leave(); });
    const { ctx } = ctxWith({ choice: "Keep here and stop asking this session" });
    const event = { type: "input", text: "look into ~/github/other-project and review the recent sessions", source: "interactive" };
    expect(await handlers.get("input")!(event, ctx)).toEqual({ action: "continue" });
    expect(await handlers.get("input")!(event, ctx)).toEqual({ action: "continue" });
    expect(asked).toBe(1);
  });

  test("a Jev failure or timeout never blocks the prompt", async () => {
    const { handlers } = harness(async () => { throw new Error("429 rate-limited"); });
    const { ctx, calls } = ctxWith();
    expect(await handlers.get("input")!({ type: "input", text: "look into ~/github/other-project and review the recent sessions", source: "interactive" }, ctx)).toEqual({ action: "continue" });
    expect(calls.setStatus.at(-1)?.[1]).toBe("route: skipped");
  });

  test("/route-threshold rejects empty and out-of-range input", async () => {
    const { commands } = harness(async () => stay());
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => notes.push(m) } };
    await commands.get("route-threshold").handler("", ctx);
    await commands.get("route-threshold").handler("1.5", ctx);
    await commands.get("route-threshold").handler("0.7", ctx);
    expect(notes[0]).toContain("usage");
    expect(notes[1]).toContain("usage");
    expect(notes[2]).toBe("route threshold = 0.7");
  });

  test("a failed move restores the prompt to the editor", async () => {
    const { handlers, commands } = harness(async () => leave());
    const { ctx, calls } = ctxWith({ choice: "New session" });
    const text = "look into ~/github/other-project and review the recent sessions";
    await handlers.get("input")!({ type: "input", text, source: "interactive" }, ctx);
    const cmdCtx = { ...ctx, waitForIdle: async () => {}, newSession: async () => { throw new Error("disk full"); } };
    await commands.get("route-go").handler("", cmdCtx);
    expect(calls.setEditorText.at(-1)).toEqual([text]);
    expect(calls.notify.at(-1)?.[0]).toContain("disk full");
    // the prompt is still parked, so a retry can move it
    const sent: any[] = [];
    await commands.get("route-go").handler("", { ...cmdCtx, newSession: async (args: any) => { await args.withSession({ sendUserMessage: async (c: any) => sent.push(c) }); return { cancelled: false }; } });
    expect(sent).toEqual([text]);
  });

  test("a stale session is offered a new session without asking Jev", async () => {
    let asked = 0;
    const { handlers } = harness(async () => { asked += 1; return stay(); }, { now: () => Date.parse("2026-09-21T10:00:00Z") });
    const { ctx, calls } = ctxWith({ choice: undefined });
    await handlers.get("input")!({ type: "input", text: "continue where we left off with the cover please", source: "interactive" }, ctx);
    expect(asked).toBe(0);
    expect(calls.select[0]?.[0]).toContain("idle for a while");
  });
});
