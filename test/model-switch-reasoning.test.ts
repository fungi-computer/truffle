import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createModels,
  normalizeContext,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivateLocalModelSource,
  openPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LocalStoreSchemaError } from "../src/private-local-session-discovery.js";
import { resolveAgentStartupModel } from "../src/private-local-startup-model.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import type { LocalAgentControlDirectory } from "../src/private-local-agent-control.js";

it("Agent creation refuses a missing login and setModel uses only project-authorized offered models", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-create-model-"));
  const models = createModels();
  models.setProvider(openaiProvider());
  const auth = vi.spyOn(models, "checkAuth").mockResolvedValue(undefined);
  let directory: LocalAgentControlDirectory | undefined;
  const owners = createLocalServiceOwners((options) => {
    directory ??= options.agentControl;
    return openPrivateLocalRuntimeHost(options, models);
  });
  const signal = new AbortController().signal;
  try {
    const { agentId: creator } = await owners.select({
      invocationRoot: root,
    });
    if (directory?.create === undefined)
      throw new Error("Missing Agent creation");
    await expect(
      directory.create({ requestId: "no-login", createdBy: creator }, signal),
    ).rejects.toThrow(/\/login/u);
    auth.mockResolvedValue({ type: "oauth", source: "OpenAI login" });
    const astra = { providerId: "openai", modelId: "gpt-6-astra" };
    const created = await directory.create(
      { requestId: "explicit", model: astra, createdBy: creator },
      signal,
    );
    if (directory.setModel === undefined) throw new Error("Missing setModel");
    await expect(
      directory.setModel({ agentId: "outside-project", model: astra }, signal),
    ).rejects.toThrow(/outside/u);
    await expect(
      directory.setModel(
        {
          agentId: created.agentId,
          model: { providerId: "openai", modelId: "not-offered" },
        },
        signal,
      ),
    ).rejects.toThrow(/not registered/u);
    await directory.setModel(
      {
        agentId: created.agentId,
        model: { providerId: "openai", modelId: "gpt-6-sol" },
      },
      signal,
    );
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("an Agent's stored model beats availability, and a Session override beats it", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const signal = new AbortController().signal;
  const astra = { providerId: "openai", modelId: "gpt-6-astra" };
  const agentDefault = createPrivateLocalModelSource(
    models,
    undefined,
    undefined,
    "agent-model",
    undefined,
    { agent: () => astra },
  );
  expect((await agentDefault.effective(null, signal)).modelId).toBe(
    "gpt-6-astra",
  );
  expect(
    (
      await agentDefault.effective(
        { providerId: "openai", modelId: "gpt-6-luna" },
        signal,
      )
    ).modelId,
  ).toBe("gpt-6-luna");
  // The footer's window is the registry entry a run would acquire.
  const luna = { providerId: "openai", modelId: "gpt-6-luna" };
  await expect(
    agentDefault.describe?.({ sessionId: "footer", preference: luna, signal }),
  ).resolves.toEqual({
    contextWindow: models.getModel("openai", "gpt-6-luna")?.contextWindow,
  });
});

it("defaults to an offered model from a logged-in provider instead of signed-out Fungi", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const source = createPrivateLocalModelSource(
    models,
    undefined,
    undefined,
    "available-login",
  );
  const effective = await source.effective(null, new AbortController().signal);
  expect(effective.providerId).toBe("openai");
  expect(models.getModel("openai", effective.modelId)).toBeDefined();
});

it("preserves reasoning from the Agent's stored model", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({ type: "oauth" });
  const model = {
    providerId: "openai",
    modelId: "gpt-6-astra",
    reasoning: "high" as const,
  };
  const source = createPrivateLocalModelSource(
    models,
    undefined,
    undefined,
    "reasoning-layer",
    undefined,
    { agent: () => model },
  );
  expect(
    (await source.effective(null, new AbortController().signal)).label,
  ).toContain("(high)");
});

it("refuses an explicit signed-out provider with an actionable error before acquiring a run", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue(undefined);
  const source = createPrivateLocalModelSource(
    models,
    "openai",
    "gpt-6-astra",
    "signed-out-model",
  );
  await expect(
    source.acquire({
      sessionId: "main",
      preference: null,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    boundary: "model",
    cause: "rejected",
    message:
      "openai is not signed in. Run /login or choose another model with /model.",
  });
});

it("uses another logged-in provider when an earlier login check fails, without exposing its error", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const models = createModels();
    models.setProvider(anthropicProvider());
    models.setProvider(openaiProvider());
    const auth = vi
      .spyOn(models, "checkAuth")
      .mockImplementation((provider) =>
        provider === "openai"
          ? Promise.resolve({ type: "oauth" as const })
          : Promise.reject(new Error("synthetic-private-auth-detail")),
      );
    const source = createPrivateLocalModelSource(
      models,
      undefined,
      undefined,
      "auth-fallback",
    );
    expect(
      (await source.effective(null, new AbortController().signal)).providerId,
    ).toBe("openai");
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toBe(
      JSON.stringify({
        source: "local-runtime",
        operation: "model-default.check-auth",
        failureKind: "Error",
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "synthetic-private-auth-detail",
    );
    auth.mockRejectedValue(new Error("synthetic-private-auth-detail"));
    await expect(
      source.acquire({
        sessionId: "main",
        preference: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      boundary: "model",
      cause: "rejected",
      message:
        "No signed-in model provider is available. Use your own Claude or ChatGPT subscription: /login in a Session, or fungi login --provider anthropic --auth-type oauth (Claude) or fungi login --provider openai --auth-type oauth (ChatGPT) in the CLI. For hosted Fungi: fungi login --provider fungi.",
    });
  } finally {
    report.mockRestore();
  }
});

describe("/model sets the Agent's default", () => {
  const astraHigh = {
    providerId: "openai",
    modelId: "gpt-6-astra",
    reasoning: "high",
  } as const;
  const signal = new AbortController().signal;

  async function withAgents(
    body: (
      open: (input: {
        createRequestId?: string;
        databasePath?: string;
      }) => ReturnType<typeof openPrivateLocalRuntimeHost>,
      models: ReturnType<typeof createModels>,
    ) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "local-agent-default-"));
    vi.stubEnv("HOME", root);
    const models = createModels();
    models.setProvider(openaiProvider());
    vi.spyOn(models, "checkAuth").mockResolvedValue({
      type: "oauth",
      source: "OpenAI login",
    });
    try {
      await body(
        (input) =>
          openPrivateLocalRuntimeHost(
            { invocationRoot: root, ...input },
            models,
          ),
        models,
      );
      // No path reads or writes the retired per-person model file.
      await expect(
        access(join(root, ".config", "fungi", "shiitake.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }

  it("for the agent: a new chat with Agent A runs the model and level /model chose", async () => {
    await withAgents(async (open) => {
      const first = await open({ createRequestId: "agent-a" });
      const databasePath = first.databasePath;
      let defaultModel: string;
      try {
        defaultModel = (await first.effectiveModel("main", signal)).modelId;
        expect(defaultModel).not.toBe("gpt-6-astra");
        await first.session.modelPreference.set(astraHigh);
        // The running chat switches at once.
        const running = await first.effectiveModel("main", signal);
        expect(running.modelId).toBe("gpt-6-astra");
        expect(running.label).toContain("(high)");
        expect(await first.session.modelPreference.read()).toEqual(astraHigh);
      } finally {
        await first.close();
      }
      const reopened = await open({ databasePath });
      try {
        const fresh = await reopened.effectiveModel("a-new-chat", signal);
        expect(fresh.modelId).toBe("gpt-6-astra");
        expect(fresh.label).toContain("(high)");
      } finally {
        await reopened.close();
      }
    });
  });

  it("not globally: a chat with Agent B is unaffected by /model in Agent A", async () => {
    await withAgents(async (open) => {
      const agentB = await open({ createRequestId: "agent-b" });
      const agentBPath = agentB.databasePath;
      let defaultModel: string;
      try {
        defaultModel = (await agentB.effectiveModel("main", signal)).modelId;
      } finally {
        await agentB.close();
      }
      const agentA = await open({ createRequestId: "agent-a" });
      try {
        await agentA.session.modelPreference.set(astraHigh);
      } finally {
        await agentA.close();
      }
      const agentC = await open({ createRequestId: "agent-c" });
      try {
        expect((await agentC.effectiveModel("main", signal)).modelId).toBe(
          defaultModel,
        );
      } finally {
        await agentC.close();
      }
      const reopenedB = await open({ databasePath: agentBPath });
      try {
        expect(
          (await reopenedB.effectiveModel("new-chat", signal)).modelId,
        ).toBe(defaultModel);
      } finally {
        await reopenedB.close();
      }
    });
  });

  it("a store that predates the schema fails loudly instead of resolving to the available login", async () => {
    await withAgents(async (_open, models) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "old-store-")));
      const path = join(root, "agent.sqlite");
      await mkdir(root, { recursive: true });
      const database = new DatabaseSync(path);
      database.exec(
        "CREATE TABLE private_local_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), agent_id TEXT NOT NULL UNIQUE)",
      );
      database.close();
      try {
        await expect(
          resolveAgentStartupModel({ models, databasePath: path, signal }),
        ).rejects.toThrow(LocalStoreSchemaError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("the landing shows the same model a fresh chat resolves, with an Agent default and without one", async () => {
    await withAgents(async (open, models) => {
      const withDefault = await open({ createRequestId: "agent-a" });
      const withoutDefault = await open({ createRequestId: "agent-b" });
      try {
        const available = await resolveAgentStartupModel({
          models,
          databasePath: withoutDefault.databasePath,
          signal,
        });
        const fresh = await withoutDefault.effectiveModel("fresh", signal);
        expect(available).toMatchObject({
          providerId: fresh.providerId,
          modelId: fresh.modelId,
          source: "available",
        });
        expect(fresh.label).toContain(
          `(${available?.reasoning ?? "no reasoning"})`,
        );
        // A new Agent has no store yet and starts from the same fallback.
        await expect(
          resolveAgentStartupModel({ models, databasePath: undefined, signal }),
        ).resolves.toEqual(available);

        await withDefault.session.modelPreference.set(astraHigh);
        const landing = await resolveAgentStartupModel({
          models,
          databasePath: withDefault.databasePath,
          signal,
        });
        const freshChat = await withDefault.effectiveModel("fresh", signal);
        expect(landing).toEqual({ ...astraHigh, source: "agent" });
        expect(freshChat.modelId).toBe(landing?.modelId);
        expect(freshChat.label).toContain("(high)");
      } finally {
        await withDefault.close();
        await withoutDefault.close();
      }
    });
  });
});

it.each([
  {
    name: "carries Claude high to Sol",
    owner: "high",
    explicit: undefined,
    limited: false,
    expected: "high",
  },
  {
    name: "uses medium when the new model cannot support high",
    owner: "high",
    explicit: undefined,
    limited: true,
    expected: "medium",
  },
  {
    name: "honors an explicit thinking choice over the owner",
    owner: "high",
    explicit: "low",
    limited: false,
    expected: "low",
  },
] as const)(
  "$name in provider options and the effective footer",
  async ({ owner, explicit, limited, expected }) => {
    const models = createModels();
    models.setProvider(anthropicProvider());
    const openai = openaiProvider();
    models.setProvider({
      ...openai,
      getModels: () =>
        openai.getModels().map((model) =>
          limited
            ? {
                ...model,
                thinkingLevelMap: { ...model.thinkingLevelMap, high: null },
              }
            : model,
        ),
    });
    const claude = models
      .getModels("anthropic")
      .find((model) => model.reasoning);
    if (claude === undefined) throw new Error("Missing Claude fixture");
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("offline")]);
    const observed: (ThinkingLevel | undefined)[] = [];
    vi.spyOn(models, "streamSimple").mockImplementation(
      (_model, context, options) => {
        observed.push(options?.reasoning);
        return faux.provider.streamSimple(
          faux.getModel(),
          normalizeContext(context),
          options,
        );
      },
    );
    vi.spyOn(models, "checkAuth").mockResolvedValue({
      type: "oauth",
      source: "Offline fixture login",
    });
    const source = createPrivateLocalModelSource(
      models,
      claude.provider,
      claude.id,
      "offline-switch",
      owner,
    );
    const selected = {
      providerId: "openai",
      modelId: "gpt-6-sol",
    };
    const preference =
      explicit === undefined ? selected : { ...selected, reasoning: explicit };
    const signal = new AbortController().signal;
    const acquired = await source.acquire({
      sessionId: "main",
      signal,
      preference,
    });
    try {
      if (acquired.stream === undefined) throw new Error("Missing stream");
      const response = await acquired.stream(
        acquired.model,
        normalizeContext({ messages: [] }),
        {},
      );
      await response.result();
      expect(observed).toEqual([expected]);
      expect((await source.effective(preference, signal)).label).toContain(
        `(${expected})`,
      );
    } finally {
      await acquired.release();
    }
  },
);

it.each([
  {
    raw: "synthetic-private-provider-detail",
    message:
      "openai model request failed without a provider rejection. Retry the request.",
    retry: false,
    overflow: false,
  },
  {
    raw: "429 rate limit synthetic-private-provider-detail",
    message:
      "openai model request failed without a provider rejection. Retry the request.",
    retry: false,
    overflow: false,
  },
  {
    raw: "request exceeds the context window synthetic-private-provider-detail",
    message:
      "openai request exceeds the context window. Compact the Session or choose another model.",
    retry: false,
    overflow: true,
  },
])(
  "replaces prose-only provider failures with safe terminal copy (overflow=$overflow)",
  async ({ raw, message, retry, overflow }) => {
    const models = createModels();
    models.setProvider(openaiProvider());
    vi.spyOn(models, "checkAuth").mockResolvedValue({
      type: "oauth",
      source: "OpenAI login",
    });
    vi.spyOn(models, "streamSimple").mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const failure = {
        ...fauxAssistantMessage(""),
        stopReason: "error" as const,
        errorMessage: raw,
      };
      stream.push({ type: "error", reason: "error", error: failure });
      stream.end(failure);
      return stream;
    });
    const source = createPrivateLocalModelSource(
      models,
      "openai",
      "gpt-6-astra",
      "rejected",
    );
    const acquired = await source.acquire({
      sessionId: "one",
      preference: null,
      signal: new AbortController().signal,
    });
    if (acquired.stream === undefined) throw new Error("Missing stream");
    const stream = await acquired.stream(
      acquired.model,
      normalizeContext({ messages: [] }),
    );
    const result = await stream.result();
    expect(result.errorMessage).toBe(message);
    expect(acquired.retryable(result)).toBe(retry);
    expect(isContextOverflow(result)).toBe(overflow);
    expect(JSON.stringify(result)).not.toContain(
      "synthetic-private-provider-detail",
    );
  },
);

it("retains the provider's partial content and usage on error", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const partial = {
    ...fauxAssistantMessage("saved partial"),
    usage: { ...fauxAssistantMessage("").usage, output: 73 },
  };
  vi.spyOn(models, "streamSimple").mockImplementation(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial });
    const error = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "upstream connection lost",
    });
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
    return stream;
  });
  const source = createPrivateLocalModelSource(
    models,
    "openai",
    "gpt-6-astra",
    "partial",
  );
  const acquired = await source.acquire({
    sessionId: "one",
    preference: null,
    signal: new AbortController().signal,
  });
  try {
    if (acquired.stream === undefined) throw new Error("Missing stream");
    const result = await (
      await acquired.stream(acquired.model, normalizeContext({ messages: [] }))
    ).result();
    expect(result.content).toEqual(partial.content);
    expect(result.usage.output).toBe(73);
    expect(result.errorMessage).toMatch(/failed without a provider rejection/u);
  } finally {
    await acquired.release();
  }
});

it("Agent creation stores its name and reports the requested model, thinking level and working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-create-profile-"));
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  let directory: LocalAgentControlDirectory | undefined;
  const owners = createLocalServiceOwners((options) => {
    directory ??= options.agentControl;
    return openPrivateLocalRuntimeHost(options, models);
  });
  const signal = new AbortController().signal;
  try {
    const { agentId: creator } = await owners.select({
      invocationRoot: root,
    });
    if (directory?.create === undefined)
      throw new Error("Missing Agent creation");
    const astra = {
      providerId: "openai",
      modelId: "gpt-6-astra",
      reasoning: "high" as const,
    };
    const created = await directory.create(
      { requestId: "named", name: "scout", model: astra, createdBy: creator },
      signal,
    );
    const working = await realpath(root);
    expect(created).toMatchObject({
      name: "scout",
      model: astra,
      workingDirectory: working,
    });
    const listed = (await directory.list(signal)).find(
      (agent) => agent.agentId === created.agentId,
    );
    expect(listed).toMatchObject({
      name: "scout",
      model: astra,
      workingDirectory: working,
    });
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});
