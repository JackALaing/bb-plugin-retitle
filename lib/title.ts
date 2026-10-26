// The prompt for the helper model, and the cleanup of its answer. These
// functions are pure, so the tests can run them without a bb server.

/** Characters of conversation sent to the model. */
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const MAX_TITLE_CHARS = 80;
export const MIN_TITLE_CHARS = 10;
/** Titles at or above this length keep the original, looser length rule. */
const PROMPT_LENGTH_HINT = 40;

/** Clamp the setting to a whole number of characters; anything unusable means the maximum. */
export function resolveMaxTitleLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_TITLE_CHARS;
  return Math.min(MAX_TITLE_CHARS, Math.max(MIN_TITLE_CHARS, Math.floor(value)));
}

export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

/**
 * bb cuts each outline message to 200 characters. Keep the first message,
 * because it gives the task, and then add messages from the newest back.
 */
export function buildTranscript(
  items: readonly OutlineItem[],
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const lines = items
    .map((item) => {
      const text = item.preview.replace(/\s+/g, " ").trim();
      return text === "" ? null : `${item.role === "user" ? "User" : "Assistant"}: ${text}`;
    })
    .filter((line): line is string => line !== null);

  const first = lines[0] ?? "";
  const kept: string[] = [];
  let used = first.length;
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]!;
    if (used + line.length > maxChars) break;
    kept.unshift(line);
    used += line.length;
  }
  const skipped = lines.length - 1 - kept.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier messages omitted …]`] : []), ...kept]
    .filter((line) => line !== "")
    .join("\n\n");
}

/**
 * Example titles, shown to the model so it sees the exact answer format. The
 * prompt shows the first three that fit the length limit, so that no example
 * breaks the rule that it is shown with.
 */
const EXAMPLES = [
  ["🐛", "Fix flaky login test"],
  ["🧭", "Add back and forward thread navigation"],
  ["📦", "Publish the retitle plugin"],
  ["🔍", "Debug CI cache"],
  ["🔧", "Fix CI"],
  ["✏️", "Fix typo"],
] as const;
const EXAMPLES_SHOWN = 3;

/** Number of user-perceived characters, so an emoji sequence counts as one. */
export function countCharacters(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
}

export function buildPrompt(args: {
  transcript: string;
  currentTitle: string | null;
  emoji: boolean;
  maxTitleLength?: number;
}): string {
  // The conversation comes first and the task last. With the task first, a
  // small model sometimes answered the instructions ("I understand…") and
  // ignored the conversation. The examples show the exact answer format. The
  // title rules copy bb's own title prompt, so these titles look like bb's.
  const maxTitleLength = args.maxTitleLength ?? MAX_TITLE_CHARS;
  const examples = EXAMPLES.map(([emoji, text]) => (args.emoji ? `${emoji} ${text}` : text))
    .filter((example) => countCharacters(example) <= maxTitleLength)
    .slice(0, EXAMPLES_SHOWN);
  return [
    "Here is a conversation between a user and a coding agent.",
    "",
    "<conversation>",
    args.transcript,
    "</conversation>",
    "",
    "Your task: write a title for the conversation above.",
    "",
    "Rules:",
    "- Sentence case, in the same language as the conversation.",
    maxTitleLength < PROMPT_LENGTH_HINT
      ? `- At most ${maxTitleLength} characters, including any emoji and spaces.`
      : "- Under about 40 characters; for scripts that do not separate words with spaces, that is roughly 20 characters.",
    args.emoji
      ? "- Start with one emoji that fits the topic, then a space. Use no other emoji."
      : "- No emoji.",
    "- No quotes and no trailing period.",
    "- Title the problem, not the tools. If the user names tools to solve a problem, the problem is the title.",
    "- Title what the conversation is about now, not only how it started.",
    ...(args.currentTitle
      ? [`- The current title is "${args.currentTitle}". Replace it if it no longer fits.`]
      : []),
    "",
    "Example titles:",
    ...examples,
    "",
    "Do not use tools. Do not answer the conversation, and do not ask a question.",
    "Your whole reply is the title, on one line, with nothing before or after it.",
  ].join("\n");
}

/**
 * Take the first line that is not empty, and remove quotes and markdown.
 * Length counts user-perceived characters, so a cut never splits an emoji.
 */
export function cleanTitle(raw: string, maxChars: number = MAX_TITLE_CHARS): string | null {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  const title = cleanLine(line);
  if (title === null) return null;
  const characters = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title),
    (part) => part.segment,
  );
  if (characters.length <= maxChars) return title;
  return `${characters.slice(0, maxChars - 1).join("").trimEnd()}…`;
}

/** Remove a label, markdown, and quotes from one line. */
function stripFormatting(line: string): string {
  return line
    .replace(/^(title|new title)\s*:\s*/i, "")
    .replace(/^[#>*_`\s-]+|[*_`\s]+$/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
}

/** Remove a label, markdown, quotes, and a trailing period from one line. */
function cleanLine(line: string): string | null {
  const title = stripFormatting(line).replace(/\.$/, "").trim();
  return title === "" ? null : title;
}

// Below PROMPT_LENGTH_HINT, a small model often writes a title a few
// characters too long, and a cut title says less than an uncut one. So for a
// short limit the helper writes three candidates in one answer, each shorter
// than the one before, and the plugin takes the first one that fits. Nothing
// is cut, and there is no second helper. The checks are on the format only:
// three lines of prose that fit the limit also pass.

/** True when the limit is short enough for candidate titles. */
export function usesCandidates(maxTitleLength: number): boolean {
  return maxTitleLength < PROMPT_LENGTH_HINT;
}

export const CANDIDATE_COUNT = 3;

/**
 * Example answers for candidate titles: short labels for one subject, each
 * shorter than the one before. The prompt shows the first two whose lines all
 * fit the limit.
 */
const CANDIDATE_EXAMPLES = [
  ["🧱", ["CI build cache redesign", "CI cache redesign", "CI caching"]],
  ["✈️", ["Kyoto trip in April", "Kyoto trip plan", "Kyoto trip"]],
  ["🧱", ["CI cache", "Caching", "Cache"]],
  ["🧾", ["Tax prep", "Taxes", "Tax"]],
] as const;
const CANDIDATE_EXAMPLES_SHOWN = 2;

export function buildCandidatePrompt(args: {
  transcript: string;
  currentTitle: string | null;
  emoji: boolean;
  maxTitleLength: number;
}): string {
  const max = args.maxTitleLength;
  const examples = CANDIDATE_EXAMPLES.map(([emoji, lines]) =>
    lines.map((text) => (args.emoji ? `${emoji} ${text}` : text)),
  )
    .filter((lines) => lines.every((line) => countCharacters(line) <= max))
    .slice(0, CANDIDATE_EXAMPLES_SHOWN);
  // A current title that does not fit, for example one cut by an earlier
  // version, would show the model a bad answer.
  const currentTitle =
    args.currentTitle && checkCandidate(args.currentTitle, max).problem === null ? args.currentTitle : null;
  return [
    "Here is a conversation between a user and an agent.",
    "",
    "<conversation>",
    args.transcript,
    "</conversation>",
    "",
    "Your task: write three candidate titles for the conversation above.",
    "",
    "Rules:",
    "- All three name the same subject: what the conversation is about now.",
    "- Best first. Each is shorter than the one before. Each is complete on its own.",
    `- At most ${max} characters each, including any emoji and spaces.`,
    "- A short label that names the subject. Use a verb only when the action is the subject.",
    "- If the conversation covers several tasks, name the current one or the goal that connects them. Do not list tasks.",
    "- Status checks, approvals, and small follow-ups do not change the subject.",
    "- Sentence case, in the same language as the conversation.",
    args.emoji
      ? "- Start each with one emoji that fits the topic, then a space. Use no other emoji."
      : "- No emoji.",
    "- No quotes, no numbering, no trailing period, and no ellipsis.",
    ...(currentTitle
      ? [`- The current title is "${currentTitle}". Replace it if it no longer fits.`]
      : []),
    "",
    ...examples.flatMap((lines) => ["Example answer:", ...lines, ""]),
    "Do not use tools. Do not answer the conversation, and do not ask a question.",
    "Your whole reply is the three titles, one per line, with nothing before or after them.",
  ].join("\n");
}

/**
 * Clean one candidate line and say why it cannot be the title, or null when
 * it can. Numbering, bullets, markdown, quotes, a label, and one trailing
 * period are removed. A line that ends with an ellipsis ("…", "..", "...")
 * before that cleanup is rejected, because it marks a cut title. Length
 * counts user-perceived characters.
 */
export function checkCandidate(line: string, maxChars: number): { text: string; problem: string | null } {
  const stripped = stripFormatting(line.trim().replace(/^\d+[.)]\s+/, "")).trim();
  const text = stripped.replace(/\.$/, "").trim();
  if (text === "") return { text, problem: "empty" };
  // Check before and after the period is removed: "Kyoto.." and "Kyoto…."
  // both mark a cut title.
  if (/(…|\.\.)$/u.test(stripped) || /…$/u.test(text)) return { text, problem: "ends with an ellipsis" };
  const length = countCharacters(text);
  if (length > maxChars) return { text, problem: `${length} characters` };
  return { text, problem: null };
}

/** A markdown code fence line, with or without a language tag. */
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Read an answer in the candidate format: exactly CANDIDATE_COUNT lines that
 * are not empty, and no code fence line. Any other answer has no title.
 * Otherwise take the first line that passes `checkCandidate`. `title` is null
 * when no line passes.
 */
export function pickCandidate(
  raw: string,
  maxChars: number,
): { title: string | null; problem: string | null; candidates: { text: string; problem: string | null }[] } {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== CANDIDATE_COUNT) {
    return { title: null, problem: `${lines.length} lines, not ${CANDIDATE_COUNT}`, candidates: [] };
  }
  if (lines.some((line) => FENCE.test(line))) return { title: null, problem: "code fence", candidates: [] };
  const candidates = lines.map((line) => checkCandidate(line, maxChars));
  const title = candidates.find((candidate) => candidate.problem === null)?.text ?? null;
  return { title, problem: title === null ? "no line fits" : null, candidates };
}
