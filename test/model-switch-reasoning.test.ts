import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fauxModel } from "@fungi.computer/mule/testing";
import {
  createModels,
  normalizeContext,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  createPrivateLocalModelSource,
  openPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalModelSettings } from "../src/private-local-model-settings.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import type { AgentControlDirectory } from "@fungi.computer/shiitake/agent-control";

it("Agent creation refuses a missing login and setModel uses only project-authorized offered models", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-create-model-"));
  const models = createModels();
  models.setProvider(openaiProvider());
  const auth = vi.spyOn(models, "checkAuth").mockResolvedValue(undefined);
  let directory: AgentControlDirectory | undefined;
  const owners = createLocalServiceOwners((options) => {
    directory ??= options.agentControl;
    return openPrivateLocalRuntimeHost(
      { ...options, modelSettingsPath: join(root, "shiitake.json") },
      models,
    );
  });
  const signal = new AbortController().signal;
  try {
    await owners.select({ invocationRoot: root });
    if (directory?.create === undefined)
      throw new Error("Missing Agent creation");
    await expect(
      directory.create({ requestId: "no-login" }, signal),
    ).rejects.toThrow(/\/login/u);
    auth.mockResolvedValue({ type: "oauth", source: "OpenAI login" });
    const astra = { providerId: "openai", modelId: "gpt-6-astra" };
    const created = await directory.create(
      { requestId: "explicit", model: astra },
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

it("reads a remembered model and applies it below an explicit Agent choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-model-choice-"));
  try {
    const path = join(root, "shiitake.json");
    expect(await createLocalModelSettings(path).read()).toBeNull();
    const manual = { providerId: "openai", modelId: "gpt-6-astra" };
    await writeFile(path, JSON.stringify({ lastManualModel: manual }));
    const reopened = createLocalModelSettings(path);
    expect(await reopened.read()).toEqual(manual);
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
      "manual-model",
      undefined,
      { manual: reopened.read },
    );
    expect(
      (await source.effective(null, new AbortController().signal)).modelId,
    ).toBe("gpt-6-astra");
    const explicit = createPrivateLocalModelSource(
      models,
      "openai",
      "gpt-6-sol",
      "explicit-model",
      undefined,
      { manual: reopened.read },
    );
    expect(
      (await explicit.effective(null, new AbortController().signal)).modelId,
    ).toBe("gpt-6-sol");
    expect(
      (
        await explicit.effective(
          { providerId: "openai", modelId: "gpt-6-luna" },
          new AbortController().signal,
        )
      ).modelId,
    ).toBe("gpt-6-luna");
    // The footer's window is the registry entry a run would acquire.
    const luna = { providerId: "openai", modelId: "gpt-6-luna" };
    await expect(
      explicit.describe?.({
        sessionId: "footer",
        preference: luna,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      contextWindow: models.getModel("openai", "gpt-6-luna")?.contextWindow,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

it("an explicit model remains usable when lower-priority personal settings cannot be read", async () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({ type: "oauth" });
  const source = createPrivateLocalModelSource(
    models,
    "openai",
    "gpt-6-astra",
    "explicit-precedence",
    undefined,
    { manual: () => Promise.reject(new Error("Settings unavailable")) },
  );
  await expect(
    source.effective(null, new AbortController().signal),
  ).resolves.toMatchObject({
    providerId: "openai",
    modelId: "gpt-6-astra",
  });
});

it.each(["agent", "manual"] as const)(
  "preserves reasoning from the selected %s model layer",
  async (layer) => {
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
      {
        agent: () => (layer === "agent" ? model : null),
        manual: () => Promise.resolve(model),
      },
    );
    expect(
      (await source.effective(null, new AbortController().signal)).label,
    ).toContain("(high)");
  },
);

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
        "No signed-in model provider is available. Run /login, then choose a model with /model.",
    });
  } finally {
    report.mockRestore();
  }
});

it("a Session /model stays that Session's override; Agent defaults and new Agents keep their own", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-agent-default-"));
  const models = createModels();
  models.setProvider(openaiProvider());
  vi.spyOn(models, "checkAuth").mockResolvedValue({
    type: "oauth",
    source: "OpenAI login",
  });
  const modelSettingsPath = join(root, "shiitake.json");
  const signal = new AbortController().signal;
  const astra = { providerId: "openai", modelId: "gpt-6-astra" };
  const sol = { providerId: "openai", modelId: "gpt-6-sol" };
  const open = (input: { createRequestId?: string; databasePath?: string }) =>
    openPrivateLocalRuntimeHost(
      { invocationRoot: root, modelSettingsPath, ...input },
      models,
    );
  try {
    const agentB = await open({ createRequestId: "agent-b" });
    const agentBPath = agentB.databasePath;
    let defaultModel: string;
    try {
      defaultModel = (await agentB.effectiveModel("main", signal)).modelId;
      expect(defaultModel).not.toBe("gpt-6-astra");
    } finally {
      await agentB.close();
    }
    const agentA = await open({ createRequestId: "agent-a" });
    try {
      await agentA.session.modelPreference.set(astra);
      expect((await agentA.effectiveModel("main", signal)).modelId).toBe(
        "gpt-6-astra",
      );
      expect(
        (await agentA.effectiveModel("another-session", signal)).modelId,
      ).toBe(defaultModel);
    } finally {
      await agentA.close();
    }
    await expect(readFile(modelSettingsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const reopenedB = await open({ databasePath: agentBPath });
    try {
      expect(
        (await reopenedB.effectiveModel("new-session", signal)).modelId,
      ).toBe(defaultModel);
      await reopenedB.setModel(sol, signal);
    } finally {
      await reopenedB.close();
    }
    const agentC = await open({ createRequestId: "agent-c" });
    try {
      expect((await agentC.effectiveModel("main", signal)).modelId).toBe(
        defaultModel,
      );
    } finally {
      await agentC.close();
    }
    const finalB = await open({ databasePath: agentBPath });
    try {
      expect((await finalB.effectiveModel("main", signal)).modelId).toBe(
        "gpt-6-sol",
      );
    } finally {
      await finalB.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    const faux = fauxModel([]);
    faux.setResponses([fauxAssistantMessage("offline")]);
    const observed: (ThinkingLevel | undefined)[] = [];
    vi.spyOn(models, "streamSimple").mockImplementation(
      (_model, context, options) => {
        observed.push(options?.reasoning);
        return faux.stream(faux.model, normalizeContext(context), options);
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
      "openai rejected the model request. Check /login or choose another model with /model.",
    retry: false,
    overflow: false,
  },
  {
    raw: "429 rate limit synthetic-private-provider-detail",
    message: "openai service unavailable. Try again shortly.",
    retry: true,
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
  "replaces a provider rejection with safe copy while preserving retry=$retry overflow=$overflow",
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
    expect(isRetryableAssistantError(result)).toBe(retry);
    expect(isContextOverflow(result)).toBe(overflow);
    expect(JSON.stringify(result)).not.toContain(
      "synthetic-private-provider-detail",
    );
  },
);
