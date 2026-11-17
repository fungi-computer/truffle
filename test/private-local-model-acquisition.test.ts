import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, type CredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Shiitake, ShiitakeError } from "@fungi.computer/shiitake";
import { waitForAgentSettlement } from "@fungi.computer/shiitake/agent-control";
import { nodeRuntimeHost } from "@fungi.computer/shiitake/node";
import { expect, it, vi } from "vitest";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import {
  acquireSubscriptionTurn,
  registerSubscriptionTurnOwner,
} from "../src/subscription-turn.js";

it.each([
  {
    kind: "reasoning",
    sentence:
      "Offline model doesn't support high reasoning; pick another level with /model.",
  },
  {
    kind: "provider",
    sentence:
      "Turn provider is not registered; pick another model with /model.",
  },
  {
    kind: "credentials",
    sentence: "Couldn't read your saved sign-in; retry, or run fungi doctor.",
  },
] as const)(
  "keeps the known $kind acquisition refusal in the durable transcript",
  async ({ kind, sentence }) => {
    const directory = await mkdtemp(join(tmpdir(), "local-acquisition-"));
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    const host = nodeRuntimeHost(() => undefined);
    const models = createModels();
    models.setProvider(
      fauxProvider({
        provider: "anthropic",
        models: [
          { id: "offline-model", name: "Offline model", reasoning: false },
        ],
      }).provider,
    );
    vi.spyOn(models, "checkAuth").mockResolvedValue({ type: "oauth" });
    const privateCause = new Error("private-credential-marker");
    const store: CredentialStore = {
      read: () => Promise.reject(privateCause),
      list: () => Promise.resolve([]),
      modify: () => Promise.reject(new Error("Unexpected fixture modify")),
      delete: () => Promise.reject(new Error("Unexpected fixture delete")),
    };
    registerSubscriptionTurnOwner(models, store);
    const source = createPrivateLocalModelSource(
      models,
      "anthropic",
      "offline-model",
      "acquisition-test",
    );
    if (kind === "provider")
      vi.spyOn(models, "getProvider").mockReturnValue(undefined);
    const selected = {
      providerId: "anthropic",
      modelId: "offline-model",
    };
    const preference =
      kind === "reasoning"
        ? { ...selected, reasoning: "high" as const }
        : selected;
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      runtime: host.runtime,
      extensions: { roster: [], grants: [] },
      instructions: {
        load: () => Promise.resolve({ revision: "test", text: "Reply." }),
      },
      model: source,
    });
    try {
      const refused = source.acquire({
        sessionId: "main",
        preference,
        signal: new AbortController().signal,
      });
      await expect(refused).rejects.toMatchObject({
        _tag: "ShiitakeError",
        boundary: "model",
        cause: "rejected",
        message: sentence,
      });
      if (kind === "credentials")
        await expect(refused).rejects.toHaveProperty(
          "underlying",
          privateCause,
        );
      if (kind === "reasoning")
        await expect(refused).rejects.toHaveProperty(
          "underlying",
          expect.any(Error),
        );
      const session = agent.session("main");
      await session.modelPreference.set(preference);
      const accepted = await session.send("Start the model");
      const { terminal } = await waitForAgentSettlement(
        session,
        accepted.commandId,
        5_000,
        new AbortController().signal,
      );
      expect(terminal).toMatchObject({
        outcome: "failed",
        diagnostic: `model:rejected: ${sentence}`,
      });
      expect((await session.read()).terminals).toEqual([terminal]);
      expect(JSON.stringify((await session.read()).terminals)).not.toContain(
        "private-credential-marker",
      );
    } finally {
      await agent.close();
      await host.close();
      database.close();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("does not turn cancellation during credential pinning into a sign-in failure", async () => {
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "anthropic" }).provider);
  const controller = new AbortController();
  const cancellation = new Error("Cancelled fixture credential read");
  const store: CredentialStore = {
    read: () => {
      controller.abort(cancellation);
      return Promise.reject(cancellation);
    },
    list: () => Promise.resolve([]),
    modify: () => Promise.reject(new Error("Unexpected fixture modify")),
    delete: () => Promise.reject(new Error("Unexpected fixture delete")),
  };
  registerSubscriptionTurnOwner(models, store);
  await expect(
    acquireSubscriptionTurn(models, "anthropic", controller.signal),
  ).rejects.not.toBeInstanceOf(ShiitakeError);
  await expect(
    acquireSubscriptionTurn(models, "anthropic", controller.signal),
  ).rejects.toBe(controller.signal.reason);
});
