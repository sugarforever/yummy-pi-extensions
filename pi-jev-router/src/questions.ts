/**
 * The question set sent to Jev. Wording is data: change it here, re-run the eval, never reach for prose.
 * The same definitions are used for the direct TypeSafe API and the Vercel AI Gateway path.
 */
const DEF =
  'The "session" is an ongoing conversation between a user and a coding agent. "Recent context" is what was just discussed. "New input" is the message the user is about to send.';

export const ROUTE_CRITERIA = {
  continue:
    "The new input builds on, answers, corrects, or advances the task in the recent context. It belongs in this session.",
  side_chat:
    "The new input is a quick, self-contained question or request (a lookup, a definition, a one-off command) that does not need the session history and whose answer the main task does not need.",
  fork:
    "The new input needs the session history but explores an alternative, tangent, or what-if that should not become part of the main thread. Copy the history into a branch and continue there.",
  new_session:
    "The new input starts an unrelated task or project that will take several turns and does not need this session history. Start a fresh session.",
} as const;

export const QUESTIONS = {
  route: { type: "choice" as const, instructions: `${DEF} Decide where the new input belongs.`, criteria: ROUTE_CRITERIA },
  on_topic: { type: "boolean" as const, instructions: `${DEF} The new input continues the same task or topic as the recent context.` },
  needs_history: {
    type: "boolean" as const,
    instructions: `${DEF} A good answer to the new input requires knowing the recent context (files, decisions, earlier messages).`,
  },
  one_off: { type: "boolean" as const, instructions: `${DEF} The new input can be fully handled in a single reply with no follow-up work.` },
};
