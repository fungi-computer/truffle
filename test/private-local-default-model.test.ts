import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  resolveAgentStartupModel,
  resolveLocalStartupChoice,
} from "../src/private-local-startup-model.js";

import { ShiitakeError } from "@fungi.computer/shiitake";

import { createPrivateModels } from "../src/local-models.js";
import {
  defaultLocalModel,
  listOfferedLocalModels,
} from "../src/private-local-default-model.js";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("lists models only from signed-in providers as provider/model addresses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-offered-"));
  temporaryDirectories.push(directory);
  const models = createPrivateModels(join(directory, "credentials.json"));
  expect(models.getModels("anthropic").length).toBeGreaterThan(0);
  vi.spyOn(models, "checkAuth").mockImplementation((provider) =>
    Promise.resolve(
      provider === "openai"
        ? { type: "api_key", source: "OPENAI_API_KEY" }
        : undefined,
    ),
  );

  const offered = await listOfferedLocalModels(
    models,
    new AbortController().signal,
  );

  expect(offered.map(({ address }) => address)).toContain("openai/gpt-6-luna");
  expect(offered.every(({ address }) => address.startsWith("openai/"))).toBe(
    true,
  );
});

it.each(["anthropic", "openai"])(
  "defaults an API-key %s login to a mid-priced model, not the first or dearest",
  async (providerId) => {
    const directory = await mkdtemp(join(tmpdir(), "fungi-local-default-"));
    temporaryDirectories.push(directory);
    const models = createPrivateModels(join(directory, "credentials.json"));
    vi.spyOn(models, "checkAuth").mockImplementation((provider) =>
      Promise.resolve(
        provider === providerId
          ? { type: "api_key", source: "API_KEY" }
          : undefined,
      ),
    );

    const chosen = await defaultLocalModel(
      models,
      new AbortController().signal,
    );

    const catalog = models.getModels(providerId);
    const outputPrices = catalog.map(({ cost }) => cost.output);
    const price = catalog.find(({ id }) => id === chosen?.modelId)?.cost.output;
    expect(chosen?.providerId).toBe(providerId);
    expect(chosen?.modelId).not.toBe(catalog[0]?.id);
    expect(price).toBeLessThan(Math.max(...outputPrices));
    expect(price).toBeGreaterThan(Math.min(...outputPrices));
  },
);

it("refuses an unregistered model with a typed model refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-offered-"));
  temporaryDirectories.push(directory);
  const models = createPrivateModels(join(directory, "credentials.json"));
  const opening = Promise.resolve().then(() =>
    createPrivateLocalModelSource(models, "openai", "luna", "cache"),
  );
  await expect(opening).rejects.toBeInstanceOf(ShiitakeError);
  await expect(opening).rejects.toMatchObject({
    boundary: "model",
    cause: "rejected",
  });
});

async function signedIn(
  providers: readonly string[],
  type: "api_key" | "oauth" = "api_key",
) {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-default-"));
  temporaryDirectories.push(directory);
  const models = createPrivateModels(join(directory, "credentials.json"));
  const [openai] = models.getModels("openai");
  if (openai === undefined) throw new Error("Missing the OpenAI catalog");
  // The Fungi catalog arrives from the Hub; its default row is Luna.
  const fungi = [
    { ...openai, id: "@fungi/sol", provider: "fungi" },
    { ...openai, id: "@fungi/luna", provider: "fungi", default: true },
  ];
  const getModels = models.getModels.bind(models);
  vi.spyOn(models, "getModels").mockImplementation((provider) =>
    provider === "fungi" ? fungi : getModels(provider),
  );
  vi.spyOn(models, "checkAuth").mockImplementation((provider) =>
    Promise.resolve(
      providers.includes(provider) ? { type, source: "fixture" } : undefined,
    ),
  );
  return models;
}

it("starts a fresh Agent on Fungi Luna when the member is signed in to Fungi", async () => {
  const models = await signedIn(["anthropic", "fungi"]);
  expect(await defaultLocalModel(models, new AbortController().signal)).toEqual(
    { providerId: "fungi", modelId: "@fungi/luna" },
  );
});

it("falls back to another signed-in provider without a Fungi account", async () => {
  const models = await signedIn(["openai"]);
  expect(
    await defaultLocalModel(models, new AbortController().signal),
  ).toMatchObject({ providerId: "openai" });
});

for (const [providerId, modelId] of [
  ["openai", "gpt-6.1-sol"],
  ["anthropic", "claude-opus-5-5"],
] as const) {
  it(`starts fresh ${providerId} subscription chats on ${modelId} with medium thinking`, async () => {
    const models = await signedIn([providerId], "oauth");
    expect(
      await resolveAgentStartupModel({
        models,
        databasePath: undefined,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      providerId,
      modelId,
      reasoning: "medium",
      source: "available",
    });
  });
}

it("preserves explicit session and agent choices ahead of subscription defaults", async () => {
  const models = await signedIn(["openai"], "oauth");
  const agent = {
    providerId: "openai",
    modelId: "gpt-6-luna",
    reasoning: "low",
  } as const;
  const session = {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    reasoning: "high",
  } as const;
  const checkAuth = vi.spyOn(models, "checkAuth");
  const signal = new AbortController().signal;
  expect(
    await resolveLocalStartupChoice({ models, session, agent, signal }),
  ).toEqual({ preference: session, source: "session" });
  expect(
    await resolveLocalStartupChoice({ models, session: null, agent, signal }),
  ).toEqual({ preference: agent, source: "agent" });
  expect(checkAuth).not.toHaveBeenCalled();
});
