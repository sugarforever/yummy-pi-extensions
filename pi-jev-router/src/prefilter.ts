/**
 * Inputs that never need a judgment call. On the author's own transcripts this settles ~45% of
 * mid-session prompts with no API call: tiny steers ("merged", "Try again"), pasted images, bare
 * file paths, slash commands, skill loads, and anything queued while the agent is streaming.
 */
export type PrefilterResult = { skip: true; reason: string } | { skip: false };

const TINY_STEER_MAX_CHARS = 15;

export function prefilter(text: string, options: { streaming?: boolean; source?: string; hasImages?: boolean } = {}): PrefilterResult {
  const trimmed = text.trim();
  if (options.source && options.source !== "interactive") return { skip: true, reason: `source:${options.source}` };
  if (options.streaming) return { skip: true, reason: "streaming" };
  if (!trimmed) return { skip: true, reason: "empty" };
  if (/^(@|~\/|\/Users\/|\/home\/|[A-Za-z]:\\)\S+$/.test(trimmed)) return { skip: true, reason: "file-ref" };
  if (/^\/[A-Za-z0-9_:.-]+(\s|$)/.test(trimmed)) return { skip: true, reason: "command" };
  if (trimmed.startsWith("!")) return { skip: true, reason: "bash" };
  if (trimmed.length <= TINY_STEER_MAX_CHARS) return { skip: true, reason: "tiny-steer" };
  if (/^\[(Image|Request interrupted)/.test(trimmed)) return { skip: true, reason: "image-or-interrupt" };
  if (options.hasImages && trimmed.length < 80) return { skip: true, reason: "image-with-short-caption" };
  if (/^Base directory for this skill:/.test(trimmed)) return { skip: true, reason: "skill-load" };
  return { skip: false };
}
