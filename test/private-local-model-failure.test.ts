import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Shiitake, type ModelAcquisition } from "@fungi.computer/shiitake";
import { waitForAgentSettlement } from "@fungi.computer/shiitake/agent-control";
import { nodeRuntimeHost } from "@fungi.computer/shiitake/node";
import { expect, it, vi } from "vitest";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

it("keeps upstream failure prose out of a Local compaction notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-summary-failure-"));
  const database = new DatabaseSync(join(directory, "agent.sqlite"));
  const host = nodeRuntimeHost(() => undefined);
  const models = createModels();
  const provider = fauxProvider({
    provider: "faux-safe",
    models: [
      { id: "owned-model", contextWindow: 1_000_000, maxTokens: 100_000 },
    ],
    tokenSize: { min: 100, max: 100 },
  });
  models.setProvider(provider.provider);
  const source = createPrivateLocalModelSource(
    models,
    "faux-safe",
    "owned-model",
    "summary-failure",
  );
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
    const session = agent.session("main");
    for (let index = 0; index < 2; index++) {
      provider.setResponses([fauxAssistantMessage("history".repeat(15_000))]);
      const accepted = await session.send(`Build history ${String(index)}`);
      expect(
        await waitForAgentSettlement(
          session,
          accepted.commandId,
          10_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
      ).toMatchObject({ outcome: "completed" });
    }
    const secret =
      "provider_error: 401 Authorization: Bearer sk-live-fake-secret";
    provider.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: secret,
      }),
    ]);
    const accepted = await session.command({
      type: "compact",
      requestId: "failed-summary",
    });
    expect(
      await waitForAgentSettlement(
        session,
        accepted.commandId,
        10_000,
        new AbortController().signal,
      ).then(({ terminal }) => terminal),
    ).toMatchObject({ outcome: "failed" });
    const notice = z.object({
      kind: z.literal("compaction_notice"),
      result: z.literal("failed"),
      trigger: z.literal("manual"),
      diagnostic: z.string(),
    });
    const rows = database
      .prepare(
        "SELECT data_json FROM session_entries WHERE type = 'compaction_notice'",
      )
      .all()
      .map((row) =>
        notice.parse(
          JSON.parse(z.object({ data_json: z.string() }).parse(row).data_json),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diagnostic).toContain("Summarization failed:");
    expect(rows[0]?.diagnostic).not.toContain(secret);
  } finally {
    await agent.close();
    await host.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("keeps the Local door's reason on the first terminal before cleanup, settlement and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-owned-failure-"));
  const databasePath = join(directory, "agent.sqlite");
  const failureAllowed = Promise.withResolvers<undefined>();
  const releaseStarted = Promise.withResolvers<undefined>();
  const releaseAllowed = Promise.withResolvers<undefined>();
  const models = createModels();
  const provider = fauxProvider({
    provider: "faux-safe",
    models: [{ id: "owned-model", name: "Owned model" }],
  });
  const privateMarker = "provider-private-marker";
  provider.setResponses([
    async () => {
      await failureAllowed.promise;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `provider_error: 401 ${privateMarker}`,
      });
    },
  ]);
  models.setProvider(provider.provider);
  const source = createPrivateLocalModelSource(
    models,
    "faux-safe",
    "owned-model",
    "owned-failure",
  );
  let acquisition: ModelAcquisition | undefined;
  const failures: unknown[] = [];
  const open = async () => {
    const database = new DatabaseSync(databasePath);
    const host = nodeRuntimeHost((cause) => failures.push(cause));
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      runtime: host.runtime,
      extensions: { roster: [], grants: [] },
      instructions: {
        load: () => Promise.resolve({ revision: "test", text: "Reply." }),
      },
      model: {
        acquire: async (input) => {
          const owned = await source.acquire(input);
          acquisition = owned;
          return {
            ...owned,
            release: async () => {
              releaseStarted.resolve(undefined);
              await releaseAllowed.promise;
              await owned.release();
            },
          };
        },
      },
    });
    return { database, host, agent };
  };
  let current = await open();
  try {
    const session = current.agent.session("main");
    const accepted = await session.send("Fail safely");
    const waiting = waitForAgentSettlement(
      session,
      accepted.commandId,
      1000,
      new AbortController().signal,
    ).then(({ terminal }) => terminal);
    failureAllowed.resolve(undefined);
    await releaseStarted.promise;
    const first = await waiting;
    const reason =
      "faux-safe model request failed without a provider rejection. Retry the request.";
    expect(first).toMatchObject({ outcome: "failed", diagnostic: reason });
    expect((await session.read()).terminals).toEqual([first]);
    expect(
      current.database
        .prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?")
        .get(accepted.commandId)?.state,
    ).toBe("running");
    const projected = (await session.read()).messages.find(
      ({ value }) => value.role === "assistant",
    )?.value;
    if (projected?.role !== "assistant")
      throw new Error("Expected the Local door's assistant failure");
    expect(projected.errorMessage).toBe(reason);
    expect(projected.providerError).toBe(
      `provider_error: 401 ${privateMarker}`,
    );
    // Even an identical decoded Pi message is not this acquisition's producer.
    if (acquisition?.failureReason === undefined)
      throw new Error("Expected the Local door's failure provenance");
    expect(acquisition.failureReason(projected)).toBeUndefined();
    releaseAllowed.resolve(undefined);
    await vi.waitFor(() => {
      expect(
        current.database
          .prepare("SELECT failure_reason FROM watchdog_jobs WHERE job_id = ?")
          .get(accepted.commandId)?.failure_reason,
      ).toBe(reason);
    });
    expect((await session.read()).terminals).toEqual([first]);
    expect(JSON.stringify((await session.read()).terminals)).not.toContain(
      privateMarker,
    );
    expect(
      current.database
        .prepare("SELECT failure_reason FROM watchdog_jobs WHERE job_id = ?")
        .get(accepted.commandId)?.failure_reason,
    ).not.toContain(privateMarker);
    await current.agent.close();
    await current.host.close();
    current.database.close();
    current = await open();
    expect((await current.agent.session("main").read()).terminals).toEqual([
      first,
    ]);
    const reopened = (await current.agent.session("main").read()).messages.find(
      ({ value }) => value.role === "assistant",
    )?.value;
    expect(reopened?.role === "assistant" && reopened.errorMessage).toBe(
      reason,
    );
    expect(reopened?.role === "assistant" && reopened.providerError).toBe(
      `provider_error: 401 ${privateMarker}`,
    );
    expect(
      await waitForAgentSettlement(
        current.agent.session("main"),
        accepted.commandId,
        1000,
        new AbortController().signal,
      ).then(({ terminal }) => terminal),
    ).toEqual(first);
    expect(failures).toEqual([]);
  } finally {
    failureAllowed.resolve(undefined);
    releaseAllowed.resolve(undefined);
    await current.agent.close();
    await current.host.close();
    current.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
