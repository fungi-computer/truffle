import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ShiitakeError } from "@fungi.computer/shiitake";

import { createPrivateModels } from "../src/local-models.js";
import { listOfferedLocalModels } from "../src/private-local-default-model.js";
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
