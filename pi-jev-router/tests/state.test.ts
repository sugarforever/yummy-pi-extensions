import { describe, expect, test } from "vitest";
import { buildState, lastUserTimestamp, type EntryLike } from "../src/state.js";

const msg = (role: string, text: string, timestamp?: string): EntryLike => ({ type: "message", timestamp, message: { role, content: [{ type: "text", text }] } });

describe("buildState", () => {
  test("keeps the first prompt as title, the last three user prompts, and the assistant tail", () => {
    const entries: EntryLike[] = [
      msg("user", "plan a video about jev"),
      msg("assistant", "here is the plan"),
      msg("user", "Base directory for this skill: /x\nskill body"),
      msg("user", "shorter please"),
      msg("toolResult", "ignored"),
      msg("assistant", "a".repeat(2000)),
      msg("user", "now the cover"),
      msg("user", "blue background"),
    ];
    const state = buildState(entries, "unrelated: how do I install psql on macOS?");
    expect(state.session_title).toBe("plan a video about jev");
    expect(state.recent_user_messages).toEqual(["shorter please", "now the cover", "blue background"]);
    expect(state.last_assistant_reply_tail).toHaveLength(1500);
    expect(state.new_input).toBe("unrelated: how do I install psql on macOS?");
  });

  test("prefers the session name and truncates long inputs", () => {
    const state = buildState([msg("user", "x")], "y".repeat(5000), "My session");
    expect(state.session_title).toBe("My session");
    expect(state.new_input).toHaveLength(2000);
  });

  test("lastUserTimestamp returns the newest user message time on the branch", () => {
    const entries = [msg("user", "a", "2026-09-19T00:00:00Z"), msg("assistant", "b", "2026-09-19T00:01:00Z"), msg("user", "c", "2026-09-19T00:02:00Z")];
    expect(lastUserTimestamp(entries)).toBe(Date.parse("2026-09-19T00:02:00Z"));
    expect(lastUserTimestamp([])).toBeUndefined();
  });
});
