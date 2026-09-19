import type { RouterState } from "./types.js";

/** Minimal view of the session entries the router reads, decoupled from Pi's types for testing. */
export type EntryLike = {
  type: string;
  timestamp?: string;
  message?: { role: string; content: unknown };
};

const TITLE_CHARS = 300;
const RECENT_USER_CHARS = 300;
const RECENT_USER_COUNT = 3;
const ASSISTANT_TAIL_CHARS = 1500;
const INPUT_CHARS = 2000;

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Skill loads, handoff dumps and other injected blocks are not what the user said. */
function isSyntheticUserText(text: string): boolean {
  return text.startsWith("Base directory for this skill:") || text.startsWith("(Re-invocation of") || text.startsWith("<") || text.startsWith("[Image");
}

export function buildState(entries: EntryLike[], newInput: string, sessionName?: string): RouterState {
  const userTexts: string[] = [];
  let lastAssistant = "";
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const text = textOf(entry.message.content).trim();
    if (!text) continue;
    if (entry.message.role === "user" && !isSyntheticUserText(text)) userTexts.push(text);
    else if (entry.message.role === "assistant") lastAssistant = text;
  }
  const title = (sessionName?.trim() || userTexts[0] || "").slice(0, TITLE_CHARS);
  return {
    session_title: title,
    recent_user_messages: userTexts.slice(-RECENT_USER_COUNT).map((text) => text.slice(0, RECENT_USER_CHARS)),
    last_assistant_reply_tail: lastAssistant.slice(-ASSISTANT_TAIL_CHARS),
    new_input: newInput.slice(0, INPUT_CHARS),
  };
}

/** Timestamp of the last user message on the branch, for the stale-session rule. */
export function lastUserTimestamp(entries: EntryLike[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user" && entry.timestamp) {
      const ms = Date.parse(entry.timestamp);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return undefined;
}
