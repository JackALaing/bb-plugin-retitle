import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { HELPER_TITLE } from "./server";

const PLUGIN_ID = "retitle";
const THREAD_ID = "thr_target";
const HELPER_ID = "thr_helper";

type Message = { role: "user" | "assistant"; preview: string };
type CatalogModel = {
  model: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
};

/**
 * A fake bb host with one thread to rename. The helper thread answers with
 * `answer`, or ends in `helperStatus`. `update` changes the stored title, so a
 * later `get` returns the new one, as on a real server.
 */
function createHost(
  options: {
    title?: string | null;
    thread?: Partial<Parameters<typeof makeThreadResponse>[0]>;
    messages?: Message[];
    answer?: string;
    helperStatus?: "idle" | "error";
    /** Runs when the plugin reads the helper's answer, as if the user acted meanwhile. */
    onOutput?: (state: { title: string | null }) => void;
    spawnError?: string;
    models?: (string | CatalogModel)[];
    modelsError?: string;
    modelLoadError?: { providerId: string; code: "timeout" | "failed" };
    settings?: Record<string, string | number | boolean>;
  } = {},
) {
  const state = {
    title: options.title === undefined ? "What git rebase does" : options.title,
    answer: options.answer ?? '"🔄 Git rebase explained."',
    messages: options.messages ?? [
      { role: "user", preview: "In two sentences: what does git rebase do?" },
      { role: "assistant", preview: "It moves your commits onto a new base." },
    ],
  };
  const spawns: Record<string, unknown>[] = [];
  const updates: { threadId: string; title?: string | null }[] = [];
  const deleted: string[] = [];

  const target = () =>
    makeThreadResponse({
      id: THREAD_ID,
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "claude-code",
      ...options.thread,
      title: state.title,
    });

  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(options.settings ? { settings: options.settings } : {}),
    sdk: {
      providers: {
        models: async () => {
          if (options.modelsError) throw new Error(options.modelsError);
          return {
            modelLoadError: options.modelLoadError ?? null,
            models: (options.models ?? ["claude-opus-5-5[1m]", "claude-haiku-4-5-20251001"]).map(
              (entry) => {
                const { model, efforts, defaultEffort, isDefault } =
                  typeof entry === "string" ? { model: entry } : entry;
                return {
                  id: model,
                  model,
                  ...(isDefault !== undefined ? { isDefault } : {}),
                  ...(defaultEffort !== undefined ? { defaultReasoningEffort: defaultEffort } : {}),
                  ...(efforts
                    ? {
                        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
                          reasoningEffort,
                          description: "",
                        })),
                      }
                    : {}),
                };
              },
            ),
          };
        },
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threadId === THREAD_ID
            ? target()
            : makeThreadResponse({
                id: threadId,
                providerId: "claude-code",
                status: options.helperStatus ?? "idle",
                visibility: "hidden",
                originPluginId: PLUGIN_ID,
              }),
        conversationOutline: async () => ({
          items: state.messages.map((message, index) => ({
            id: `msg_${index}`,
            role: message.role,
            preview: message.preview,
            attachmentSummary: null,
          })),
          maxSeq: state.messages.length,
        }),
        spawn: async (args: unknown) => {
          if (options.spawnError) throw new Error(options.spawnError);
          spawns.push(args as Record<string, unknown>);
          return makeThreadResponse({ id: HELPER_ID, visibility: "hidden" });
        },
        output: async () => {
          options.onOutput?.(state);
          return { output: state.answer };
        },
        update: async (args: { threadId: string; title?: string | null }) => {
          updates.push(args);
          if (args.title !== undefined) state.title = args.title;
          return target();
        },
        stop: async () => ({ ok: true }),
        delete: async ({ threadId }: { threadId: string }) => {
          deleted.push(threadId);
          return { ok: true };
        },
      },
    },
  });

  return { ...host, state, spawns, updates, deleted };
}

async function load(host: ReturnType<typeof createHost>) {
  await plugin(host.bb);
  return host;
}

/** Let the rename that a thread event starts in the background finish. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function idle(host: ReturnType<typeof createHost>, thread: Partial<Parameters<typeof makeThreadResponse>[0]> = {}) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: THREAD_ID, title: host.state.title, ...thread }),
    lastAssistantText: "done",
  });
}

describe("renaming on demand", () => {
  it("writes the cleaned answer onto the thread", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(result).toEqual({
      title: "🔄 Git rebase explained",
      previousTitle: "What git rebase does",
    });
    expect(host.updates).toEqual([{ threadId: THREAD_ID, title: "🔄 Git rebase explained" }]);
  });

  it("runs a hidden helper on Haiku in the environment of the thread", async () => {
    const host = await load(createHost());

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]).toMatchObject({
      projectId: "proj_1",
      environment: { type: "reuse", environmentId: "env_1" },
      title: HELPER_TITLE,
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
      reasoningLevel: "low",
      visibility: "hidden",
      lifecycleOwnerThreadId: THREAD_ID,
    });
  });

  it("deletes the helper after it answers", async () => {
    const host = await load(createHost());

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.deleted).toEqual([HELPER_ID]);
  });

  it("uses the provider's default model when no small model is listed", async () => {
    const host = await load(createHost({ models: ["claude-opus-5-5[1m]"] }));

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).not.toHaveProperty("model");
  });

  it("uses the provider and model from the settings when they are set", async () => {
    const host = await load(
      createHost({ settings: { providerId: "codex", model: "gpt-5.4-mini" } }),
    );

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).toMatchObject({ providerId: "codex", model: "gpt-5.4-mini" });
  });

  it("asks for an emoji by default and not when the setting is off", async () => {
    const withEmoji = await load(createHost());
    await withEmoji.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(withEmoji.spawns[0]!.prompt).toContain("- Start with one emoji");

    const without = await load(createHost({ settings: { emoji: false } }));
    await without.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(without.spawns[0]!.prompt).toContain("- No emoji.");
  });

  it("fails at once when the helper thread fails, and still deletes it", async () => {
    const host = await load(createHost({ helperStatus: "error" }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/helper thread on claude-code failed/);
    expect(host.updates).toEqual([]);
    expect(host.deleted).toEqual([HELPER_ID]);
  });

  it("reports a helper that cannot start", async () => {
    const host = await load(createHost({ spawnError: "HTTP 503: provider is not ready." }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/Could not start the helper on claude-code: HTTP 503/);
  });

  it("does not write an empty answer", async () => {
    const host = await load(createHost({ answer: "  \n" }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/empty title/);
    expect(host.updates).toEqual([]);
  });

  it("does not name an archived thread as the helper's owner", async () => {
    const host = await load(createHost({ thread: { archivedAt: 1 } }));

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).not.toHaveProperty("lifecycleOwnerThreadId");
  });

  it("refuses a thread without messages", async () => {
    const host = await load(createHost({ messages: [] }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/no messages/);
    expect(host.spawns).toEqual([]);
  });
});

describe("helper reasoning", () => {
  it("uses the reasoning level from the settings when the model supports it", async () => {
    const host = await load(
      createHost({
        models: [{ model: "claude-haiku-4-5-20251001", efforts: ["low", "medium", "high"] }],
        settings: { reasoningLevel: "high" },
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      reasoningLevel: "high",
    });
  });

  it("uses the model's default level when the catalog does not list the setting", async () => {
    const host = await load(
      createHost({
        models: [
          {
            model: "claude-haiku-4-5-20251001",
            efforts: ["medium", "high"],
            defaultEffort: "medium",
          },
        ],
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({ reasoningLevel: "medium" });
    expect(host.updates).toHaveLength(1);
  });

  it("leaves the level to bb when the catalog names no default", async () => {
    const host = await load(
      createHost({
        models: [{ model: "claude-haiku-4-5-20251001", efforts: ["medium", "high"] }],
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).not.toHaveProperty("reasoningLevel");
  });

  it("checks the configured model against the catalog", async () => {
    const configured = await load(
      createHost({
        models: [{ model: "gpt-5.4-mini", efforts: ["medium"] }],
        settings: { providerId: "codex", model: "gpt-5.4-mini", reasoningLevel: "medium" },
      }),
    );
    await configured.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(configured.spawns[0]).toMatchObject({ model: "gpt-5.4-mini", reasoningLevel: "medium" });
  });

  it("keeps the configured level when bb chooses the model", async () => {
    // bb may run a remembered project model, so the catalog default's levels
    // say nothing about the model that will run.
    for (const models of [
      [
        { model: "big-model", efforts: ["high"], defaultEffort: "high", isDefault: true },
        { model: "other-model", efforts: ["medium"] },
      ],
      [{ model: "big-model", efforts: ["high"], defaultEffort: "high" }],
    ]) {
      const host = await load(createHost({ models, settings: { reasoningLevel: "medium" } }));
      await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
      expect(host.spawns[0]).not.toHaveProperty("model");
      expect(host.spawns[0]).toMatchObject({ reasoningLevel: "medium" });
    }
  });

  it("keeps the configured level when the catalog reports a load error", async () => {
    const host = await load(
      createHost({
        modelLoadError: { providerId: "codex", code: "timeout" },
        models: [{ model: "gpt-5.4-mini", efforts: ["high"], defaultEffort: "high" }],
        settings: { providerId: "codex", model: "gpt-5.4-mini", reasoningLevel: "medium" },
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.4-mini",
      reasoningLevel: "medium",
    });
    expect(
      host.harness.inspection.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("timeout"),
      ),
    ).toBe(true);
  });

  it("still picks a listed small model when the catalog reports a load error", async () => {
    const host = await load(
      createHost({
        modelLoadError: { providerId: "claude-code", code: "failed" },
        models: [{ model: "claude-haiku-4-5-20251001", efforts: ["high"], defaultEffort: "high" }],
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      reasoningLevel: "low",
    });
  });

  it("keeps the configured model and level when the catalog cannot be read", async () => {
    const host = await load(
      createHost({
        modelsError: "catalog offline",
        settings: { providerId: "codex", model: "gpt-5.4-mini", reasoningLevel: "medium" },
      }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({
      providerId: "codex",
      model: "gpt-5.4-mini",
      reasoningLevel: "medium",
    });
  });

  it("falls back to low for a stored value that is not an option", async () => {
    const host = await load(createHost({ settings: { reasoningLevel: "ultra" } }));
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]).toMatchObject({ reasoningLevel: "low" });
  });
});

describe("maximum title length", () => {
  const graphemes = (text: string) =>
    Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));
  const more = (host: ReturnType<typeof createHost>, count: number) =>
    host.state.messages.push(...Array.from({ length: count }, () => ({ role: "user" as const, preview: "more" })));
  const failed = (host: ReturnType<typeof createHost>) => host.bb.storage.kv.get(`failed:${THREAD_ID}`);
  const TOO_LONG = `${"a".repeat(31)}\n${"b".repeat(31)}\n${"c".repeat(31)}`;
  const ORIGINAL = { messageCount: 2, title: "What git rebase does", maxTitleLength: 30 };
  const tick = async (host: ReturnType<typeof createHost>) => {
    await idle(host);
    await settle();
  };

  it("below 40, asks one helper for three candidates and writes the first that fits", async () => {
    const host = await load(
      createHost({
        settings: { maxTitleLength: 30 },
        answer: "Editor plugin PR reviews and merges\nEditor plugin PRs\nPlugins",
      }),
    );
    const result = await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]?.prompt).toContain("write three candidate titles");
    expect(host.spawns[0]?.prompt).toContain("At most 30 characters each");
    expect(result).toEqual({ title: "Editor plugin PRs", previousTitle: "What git rebase does" });
    expect(await host.bb.storage.kv.get(`title:${THREAD_ID}`)).toEqual({ title: "Editor plugin PRs", messageCount: 2 });
    expect(host.deleted).toEqual([HELPER_ID]);
  });

  it.each([
    ["only titles that are too long", TOO_LONG, "no line fits"],
    ["an empty answer", "  \n", "0 lines, not 3"],
    ["one cut-off title", "Maintain editor plugin PRs an…", "1 lines, not 3"],
    ["a lead-in before three titles", "Here are three titles:\nKyoto trip in April\nKyoto trip\nKyoto", "4 lines, not 3"],
    ["titles that end with an ellipsis", "Kyoto trip..\nKyoto trip...\nKyoto…", "no line fits"],
    ["one fenced title", "~~~\nKyoto trip\n~~~", "code fence"],
  ])("keeps the title, and asks no second helper, for %s", async (_name, answer, problem) => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, answer }));

    await expect(host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID })).rejects.toThrow(
      `no usable title within 30 characters (${problem}), so the thread keeps its title`,
    );
    expect(host.spawns).toHaveLength(1);
    expect(host.updates).toEqual([]);
    expect(host.state.title).toBe("What git rebase does");
    expect(host.deleted).toEqual([HELPER_ID]);
    expect(await host.bb.storage.kv.get(`title:${THREAD_ID}`)).toBeUndefined();
    expect(await failed(host)).toEqual(ORIGINAL);
  });

  it("after a failed automatic rename, waits for new messages instead of trying at each idle", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, answer: TOO_LONG }));
    await tick(host);
    expect(host.spawns).toHaveLength(1);

    await tick(host);
    more(host, 9);
    await tick(host);
    expect(host.spawns).toHaveLength(1);

    // renameEveryMessages is 0, so it waits RETRY_AFTER_MESSAGES (10), not forever.
    more(host, 1);
    host.state.answer = "Kyoto trip in April\nKyoto trip\nKyoto";
    await tick(host);
    expect(host.spawns).toHaveLength(2);
    expect(host.updates).toEqual([{ threadId: THREAD_ID, title: "Kyoto trip in April" }]);
    expect(await failed(host)).toBeUndefined();
  });

  it("keeps the title of the first failure when a later one fails", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, answer: TOO_LONG }));
    await tick(host);
    more(host, 10);
    await tick(host);
    expect(host.spawns).toHaveLength(2);
    expect(await failed(host)).toEqual({ ...ORIGINAL, messageCount: 12 });
  });

  it("after a failed periodic rename, waits renameEveryMessages, and keeps the record", async () => {
    const host = await load(
      createHost({ settings: { maxTitleLength: 30, renameEveryMessages: 6 }, answer: "Kyoto trip plan\nKyoto trip\nKyoto" }),
    );
    await tick(host);
    host.state.answer = TOO_LONG;
    more(host, 6);
    await tick(host);
    expect(host.spawns).toHaveLength(2);
    expect(await host.bb.storage.kv.get(`title:${THREAD_ID}`)).toEqual({ title: "Kyoto trip plan", messageCount: 2 });
    expect(await failed(host)).toEqual({ messageCount: 8, title: "Kyoto trip plan", maxTitleLength: 30 });

    more(host, 5);
    await tick(host);
    expect(host.spawns).toHaveLength(2);
    more(host, 1);
    await tick(host);
    expect(host.spawns).toHaveLength(3);
  });

  it("after a failed first rename, does not replace a title typed later", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, answer: TOO_LONG }));
    await tick(host);
    host.state.title = "Typed by the user";
    host.state.answer = "Kyoto trip in April\nKyoto trip\nKyoto";
    more(host, 30);
    await tick(host);
    expect(host.spawns).toHaveLength(1);
    expect(host.state.title).toBe("Typed by the user");
    expect(await failed(host)).toEqual(ORIGINAL);
  });

  it("after a failed first rename, does not replace a title typed while the helper ran", async () => {
    const host = await load(
      createHost({
        settings: { maxTitleLength: 30 },
        answer: TOO_LONG,
        onOutput: (state) => {
          state.title = "Typed by the user";
        },
      }),
    );
    await tick(host);
    expect(await failed(host)).toEqual(ORIGINAL);

    host.state.answer = "Kyoto trip in April\nKyoto trip\nKyoto";
    more(host, 30);
    await tick(host);
    expect(host.spawns).toHaveLength(1);
    expect(host.state.title).toBe("Typed by the user");
  });

  it("still renames at once on demand after a failure, even after a typed title", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, answer: TOO_LONG }));
    await expect(host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID })).rejects.toThrow();
    host.state.title = "Typed by the user";
    host.state.answer = "Kyoto trip in April\nKyoto trip\nKyoto";
    await expect(host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID })).resolves.toMatchObject({
      title: "Kyoto trip in April",
    });
    expect(await failed(host)).toBeUndefined();
  });

  it.each([40, 80, 25])("does not wait for a failure at limit 30 after a change to %i", async (maxTitleLength) => {
    const host = await load(createHost({ settings: { maxTitleLength }, answer: "Kyoto trip in April\nKyoto trip\nKyoto" }));
    await host.bb.storage.kv.set(`failed:${THREAD_ID}`, { ...ORIGINAL, messageCount: 2 });
    await tick(host);
    expect(host.spawns).toHaveLength(1);
    expect(host.updates).toHaveLength(1);
    expect(await failed(host)).toBeUndefined();
  });

  it("does not record a failure when the helper itself fails", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 30 }, helperStatus: "error" }));
    await expect(host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID })).rejects.toThrow();
    expect(await failed(host)).toBeUndefined();
  });

  it("at 40, keeps the single-title prompt and the cut", async () => {
    const host = await load(
      createHost({ settings: { maxTitleLength: 40 }, answer: `🧑🏽‍💻 ${"b".repeat(60)}` }),
    );
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]?.prompt).toContain("Under about 40 characters");
    expect(host.spawns[0]?.prompt).not.toContain("candidate");
    const title = host.updates[0]?.title ?? "";
    expect(title.startsWith("🧑🏽‍💻 ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(graphemes(title)).toHaveLength(40);
  });

  it("at 40, keeps the single-title cleanup of periods", async () => {
    const host = await load(createHost({ settings: { maxTitleLength: 40 }, answer: "Kyoto trip..\nsecond line" }));
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.updates[0]?.title).toBe("Kyoto trip.");
  });

  it("keeps the original prompt and 80-character cut by default", async () => {
    const host = await load(createHost({ answer: "b".repeat(120) }));
    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(host.spawns[0]?.prompt).toContain("Under about 40 characters");
    expect(host.spawns[0]?.prompt).not.toContain("candidate");
    expect(graphemes(host.updates[0]?.title ?? "")).toHaveLength(80);
  });
});

describe("a title typed during the rename", () => {
  it.each([30, 80])("is kept at limit %i", async (maxTitleLength) => {
    const host = await load(
      createHost({
        settings: { maxTitleLength },
        answer: "Kyoto trip plan\nKyoto trip\nKyoto",
        onOutput: (state) => {
          state.title = "Typed by the user";
        },
      }),
    );

    await expect(host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID })).rejects.toThrow(
      /title changed during the rename/,
    );
    expect(host.updates).toEqual([]);
    expect(host.state.title).toBe("Typed by the user");
    expect(host.deleted).toEqual([HELPER_ID]);
  });
});

describe("renaming automatically", () => {
  it("renames a thread after its first reply by default", async () => {
    const host = await load(createHost());

    await idle(host);
    await settle();

    expect(host.updates).toEqual([{ threadId: THREAD_ID, title: "🔄 Git rebase explained" }]);
  });

  it("renames only one time by default", async () => {
    const host = await load(createHost());

    await idle(host);
    await settle();
    host.state.messages.push(...Array.from({ length: 20 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();

    expect(host.updates).toHaveLength(1);
  });

  it("does nothing when automatic renaming is off", async () => {
    const host = await load(
      createHost({ settings: { autoRename: "Off (only when you press ⌘⌥R)" } }),
    );

    await idle(host);
    await settle();

    expect(host.spawns).toEqual([]);
  });

  it("renames again after the set number of new messages", async () => {
    const host = await load(createHost({ settings: { renameEveryMessages: 6 } }));
    await idle(host);
    await settle();

    host.state.messages.push(...Array.from({ length: 5 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();
    expect(host.updates).toHaveLength(1);

    host.state.messages.push({ role: "user", preview: "one more" });
    await idle(host);
    await settle();
    expect(host.updates).toHaveLength(2);
  });

  it("stops after the user changes the title", async () => {
    const host = await load(createHost({ settings: { renameEveryMessages: 6 } }));
    await idle(host);
    await settle();

    host.state.title = "My own title";
    host.state.messages.push(...Array.from({ length: 10 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();

    expect(host.updates).toHaveLength(1);
  });

  it.each([
    ["hidden threads", { visibility: "hidden" as const }],
    ["threads that another thread started", { parentThreadId: "thr_parent" }],
    ["helper threads of this plugin", { originPluginId: PLUGIN_ID }],
  ])("skips %s", async (_name, thread) => {
    const host = await load(createHost());

    await idle(host, thread);
    await settle();

    expect(host.spawns).toEqual([]);
  });
});

describe("bb retitle", () => {
  it("renames the current thread", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([], { threadId: THREAD_ID } as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Renamed to "🔄 Git rebase explained"');
  });

  it("renames a thread by id and prints JSON", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([THREAD_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      threadId: THREAD_ID,
      title: "🔄 Git rebase explained",
      previousTitle: "What git rebase does",
    });
  });

  it("fails without a thread id", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/BB_THREAD_ID is not set/);
  });

  it("prints the usage for --help", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: bb retitle/);
  });

  it("reports a failed rename with exit code 1", async () => {
    const host = await load(createHost({ helperStatus: "error" }));

    const result = await host.harness.behavior.runCli([THREAD_ID]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/helper thread on claude-code failed/);
  });
});
