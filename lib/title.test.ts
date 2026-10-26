import { describe, expect, it } from "vitest";
import {
  MAX_TITLE_CHARS,
  MIN_TITLE_CHARS,
  buildCandidatePrompt,
  buildPrompt,
  buildTranscript,
  cleanTitle,
  countCharacters,
  pickCandidate,
  resolveMaxTitleLength,
  usesCandidates,
} from "./title";

const user = (preview: string) => ({ role: "user" as const, preview });
const assistant = (preview: string) => ({ role: "assistant" as const, preview });

describe("buildTranscript", () => {
  it("labels each message with its role", () => {
    expect(buildTranscript([user("Fix the login test"), assistant("It passes now")])).toBe(
      "User: Fix the login test\n\nAssistant: It passes now",
    );
  });

  it("joins whitespace and drops empty messages", () => {
    expect(buildTranscript([user("  Fix\n\nthe   test "), assistant("   ")])).toBe(
      "User: Fix the test",
    );
  });

  it("returns an empty string when there are no messages", () => {
    expect(buildTranscript([])).toBe("");
  });

  it("keeps the first message and the newest messages when the text is too long", () => {
    const items = [user("first"), user("aaaa"), user("bbbb"), user("cccc")];
    // "User: first" is 11 characters and each other line is 10.
    const transcript = buildTranscript(items, 31);

    expect(transcript).toBe(
      "User: first\n\n[… 1 earlier messages omitted …]\n\nUser: bbbb\n\nUser: cccc",
    );
  });
});

describe("buildPrompt", () => {
  it("asks for an emoji, and shows emoji examples, when the setting is on", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: true });
    expect(prompt).toContain("- Start with one emoji");
    expect(prompt).toContain("\n🐛 Fix flaky login test\n");
    expect(prompt).not.toContain("- No emoji.");
  });

  it("forbids emoji, and shows plain examples, when the setting is off", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false });
    expect(prompt).toContain("- No emoji.");
    expect(prompt).toContain("\nFix flaky login test\n");
    expect(prompt).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("ends with the answer format", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: true });
    expect(prompt.endsWith("Your whole reply is the title, on one line, with nothing before or after it.")).toBe(true);
  });

  it("names the current title only when there is one", () => {
    expect(
      buildPrompt({ transcript: "User: hi", currentTitle: "Old title", emoji: false }),
    ).toContain('- The current title is "Old title".');
    expect(
      buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false }),
    ).not.toContain("The current title is");
  });

  it("puts the conversation first and the task after it", () => {
    const prompt = buildPrompt({ transcript: "User: hi", currentTitle: null, emoji: false });
    const conversation = prompt.indexOf("<conversation>\nUser: hi\n</conversation>");
    const task = prompt.indexOf("Your task: write a title for the conversation above.");

    expect(conversation).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(conversation);
  });
});

describe("cleanTitle", () => {
  it.each([
    ["Fix flaky login test", "Fix flaky login test"],
    ['"Fix flaky login test."', "Fix flaky login test"],
    ["Title: Fix flaky login test", "Fix flaky login test"],
    ["**Fix flaky login test**", "Fix flaky login test"],
    ["# Fix flaky login test", "Fix flaky login test"],
    ["“Fix flaky login test”", "Fix flaky login test"],
    ["\n\n  Fix flaky login test  \nSecond line", "Fix flaky login test"],
    ["🐛 Fix flaky login test", "🐛 Fix flaky login test"],
  ])("cleans %j", (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected);
  });

  it("returns null for an empty answer", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("  \n \n")).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });

  it("cuts a long answer to the maximum length", () => {
    const title = cleanTitle("x".repeat(200));
    expect(title).toHaveLength(MAX_TITLE_CHARS);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("counts an emoji sequence as one character and never splits it", () => {
    const coder = "🧑🏽‍💻";
    expect(cleanTitle(`${"x".repeat(28)}${coder}z`, 30)).toBe(`${"x".repeat(28)}${coder}z`);
    expect(cleanTitle(`${"x".repeat(28)}${coder}yz`, 30)).toBe(`${"x".repeat(28)}${coder}…`);
    expect(cleanTitle(`${"x".repeat(29)}${coder}yz`, 30)).toBe(`${"x".repeat(29)}…`);
  });

  it("does not leave a space before the ellipsis", () => {
    expect(cleanTitle("Fix flaky login tests", 11)).toBe("Fix flaky…");
  });
});

describe("resolveMaxTitleLength", () => {
  it.each([
    [undefined, MAX_TITLE_CHARS],
    [Number.NaN, MAX_TITLE_CHARS],
    [Number.POSITIVE_INFINITY, MAX_TITLE_CHARS],
    ["30", MAX_TITLE_CHARS],
    [0, 10],
    [-5, 10],
    [33.7, 33],
    [1000, MAX_TITLE_CHARS],
  ])("resolves %j to %j", (value, expected) => {
    expect(resolveMaxTitleLength(value)).toBe(expected);
  });
});

describe("buildPrompt length rule", () => {
  const base = { transcript: "User: hi", currentTitle: null, emoji: false };

  it("keeps the original rule at 40 characters or more", () => {
    expect(buildPrompt(base)).toContain("Under about 40 characters");
    expect(buildPrompt({ ...base, maxTitleLength: 40 })).toContain("Under about 40 characters");
  });

  it("states a shorter limit exactly", () => {
    const prompt = buildPrompt({ ...base, maxTitleLength: 24 });
    expect(prompt).toContain("At most 24 characters, including any emoji and spaces.");
    expect(prompt).not.toContain("Under about 40 characters");
  });
});

describe("buildPrompt examples", () => {
  const graphemes = (text: string) =>
    Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  const examplesIn = (prompt: string) =>
    prompt.split("Example titles:\n")[1]!.split("\n\n")[0]!.split("\n");

  it.each([true, false])("shows only examples that fit the limit (emoji: %s)", (emoji) => {
    for (let max = MIN_TITLE_CHARS; max <= MAX_TITLE_CHARS; max++) {
      const examples = examplesIn(
        buildPrompt({ transcript: "User: hi", currentTitle: null, emoji, maxTitleLength: max }),
      );
      expect(examples.length, `limit ${max}`).toBeGreaterThan(0);
      for (const example of examples) {
        expect(graphemes(example), `${JSON.stringify(example)} at limit ${max}`).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("candidate titles", () => {
  const prompt = (overrides: Partial<Parameters<typeof buildCandidatePrompt>[0]> = {}) =>
    buildCandidatePrompt({ transcript: "User: hi", currentTitle: null, emoji: false, maxTitleLength: 30, ...overrides });
  const exampleAnswers = (text: string) =>
    text
      .split("Example answer:\n")
      .slice(1)
      .map((block) => block.split("\n\n")[0]!.split("\n"));

  it("are used only for limits under 40", () => {
    expect(usesCandidates(MIN_TITLE_CHARS)).toBe(true);
    expect(usesCandidates(39)).toBe(true);
    expect(usesCandidates(40)).toBe(false);
    expect(usesCandidates(MAX_TITLE_CHARS)).toBe(false);
  });

  it.each([true, false])("show example answers that fit every short limit (emoji: %s)", (emoji) => {
    for (let max = MIN_TITLE_CHARS; max < 40; max++) {
      const answers = exampleAnswers(prompt({ emoji, maxTitleLength: max }));
      expect(answers.length, `limit ${max}`).toBeGreaterThan(0);
      for (const lines of answers) {
        const lengths = lines.map(countCharacters);
        expect(lengths, `limit ${max}`).toHaveLength(3);
        expect(Math.max(...lengths), `limit ${max}`).toBeLessThanOrEqual(max);
        expect(lengths[0]! > lengths[1]! && lengths[1]! > lengths[2]!, `${lines} at limit ${max}`).toBe(true);
      }
    }
  });

  it("asks for three titles, one per line, within the limit", () => {
    const text = prompt({ maxTitleLength: 24 });
    expect(text).toContain("At most 24 characters each, including any emoji and spaces.");
    expect(text.endsWith("Your whole reply is the three titles, one per line, with nothing before or after them.")).toBe(true);
    expect(text.indexOf("<conversation>")).toBeLessThan(text.indexOf("Your task:"));
  });

  it("shows the current title only when it fits", () => {
    expect(prompt({ currentTitle: "Kyoto trip plan" })).toContain('The current title is "Kyoto trip plan"');
    for (const currentTitle of ["Maintain editor plugin PRs an…", "x".repeat(31)]) {
      expect(prompt({ currentTitle })).not.toContain(currentTitle);
    }
  });
});

describe("pickCandidate", () => {
  const three = (first: string, second = "Kyoto trip", third = "Kyoto") => `${first}\n${second}\n${third}`;

  it.each([
    ["the first one when it fits", three("Kyoto trip in April"), "Kyoto trip in April"],
    ["the next one when the first is too long", "Editor plugin PR reviews and merges\nEditor plugin PRs\nPlugins", "Editor plugin PRs"],
    ["past a cut-off one", "Maintain editor plugin PRs an…\nEditor plugin PRs\nPRs", "Editor plugin PRs"],
    ["without numbers, bullets, and quotes", '1. "Kyoto trip in April"\n2) Kyoto trip\n- Kyoto', "Kyoto trip in April"],
    ["with blank lines between the lines", "\nKyoto trip in April\n\nKyoto trip\n\nKyoto\n", "Kyoto trip in April"],
    ["without one trailing period", three("**Kyoto trip in April.**"), "Kyoto trip in April"],
    [
      "in another language",
      "Declaración de la renta para autónomos\nDeducciones para autónomos\nAutónomos",
      "Deducciones para autónomos",
    ],
    ["in Japanese with an emoji", three("☁️ Cloudflare Pagesへの移行"), "☁️ Cloudflare Pagesへの移行"],
  ])("takes %s", (_name, raw, title) => {
    expect(pickCandidate(raw, 30).title).toBe(title);
  });

  it("counts an emoji sequence as one character", () => {
    expect(pickCandidate(three(`🧑🏽‍💻 ${"x".repeat(8)}`, "y".repeat(11), "z".repeat(11)), 10).title).toBe(
      `🧑🏽‍💻 ${"x".repeat(8)}`,
    );
    expect(pickCandidate(three(`🧑🏽‍💻 ${"x".repeat(9)}`, "y".repeat(11), "z".repeat(11)), 10).title).toBeNull();
    expect(pickCandidate(three("ブログの静的サイト移行"), 11).title).toBe("ブログの静的サイト移行");
  });

  it.each([
    ["..", "Kyoto trip.."],
    ["...", "Kyoto trip..."],
    ["…", "Kyoto trip…"],
    ["quoted ..", '"Kyoto trip.."'],
    ["quoted …", "“Kyoto trip…”"],
    ["bold ...", "**Kyoto trip...**"],
    ["numbered ..", "1. Kyoto trip.."],
    ["… and a period", "Kyoto…."],
    ["quoted … and a period", '"Kyoto trip…."'],
  ])("rejects a line that ends with an ellipsis (%s)", (_name, line) => {
    const pick = pickCandidate(three(line, "x".repeat(31), "y".repeat(31)), 30);
    expect(pick.title).toBeNull();
    expect(pick.candidates[0]?.problem).toBe("ends with an ellipsis");
  });

  it.each([
    ["an empty answer", "  \n\n"],
    ["one line", "Kyoto trip plan"],
    ["two lines", "Kyoto trip plan\nKyoto"],
    ["a lead-in and three titles", "Here are three titles:\nKyoto trip in April\nKyoto trip\nKyoto"],
    ["three titles and a closing line", "Kyoto trip in April\nKyoto trip\nKyoto\nI hope this helps"],
    ["a code fence", "```\nKyoto trip in April\nKyoto trip\nKyoto\n```"],
  ])("returns no title, without reading the lines, for %s", (_name, raw) => {
    const pick = pickCandidate(raw, 30);
    expect(pick.title).toBeNull();
    expect(pick.problem).toMatch(/^\d+ lines, not 3$/);
    expect(pick.candidates).toEqual([]);
  });

  it.each([
    ["a backtick fence", "```\nKyoto trip\n```"],
    ["a tilde fence", "~~~\nKyoto trip\n~~~"],
    ["a fence with a language tag", "```text\nKyoto trip\n```"],
    ["a long tilde fence with a tag", "~~~~ md\nKyoto trip\n~~~~"],
  ])("returns no title for three lines with %s", (_name, raw) => {
    expect(pickCandidate(raw, 30)).toEqual({ title: null, problem: "code fence", candidates: [] });
  });

  it("returns no title when no line fits", () => {
    const pick = pickCandidate(three("x".repeat(31), "y".repeat(32), "**"), 30);
    expect(pick).toMatchObject({ title: null, problem: "no line fits" });
    expect(pick.candidates.map((candidate) => candidate.problem)).toEqual(["31 characters", "32 characters", "empty"]);
  });

  it("checks the format only, so three lines of prose that fit pass", () => {
    expect(pickCandidate("Sure, I can help\nHere you go\nThanks", 30).title).toBe("Sure, I can help");
  });

  it("never cuts a candidate", () => {
    const { candidates } = pickCandidate(three("x".repeat(45)), 30);
    expect(candidates[0]).toEqual({ text: "x".repeat(45), problem: "45 characters" });
  });
});
