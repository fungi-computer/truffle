import { fauxModel } from "@fungi.computer/mule/testing";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Shiitake } from "@fungi.computer/shiitake";
import { expect, it, vi } from "vitest";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["followUp", "steer"] as const)(
  "runs a queued %s after cancelling only the active command without another submission or manual wake",
  async (delivery) => {
    const database = new DatabaseSync(":memory:");
    const started = deferred();
    const cancelled = deferred();
    const cleanup = deferred();
    const faux = fauxModel([]);
    faux.setResponses([
      async (_context, options) => {
        started.resolve();
        if (options?.signal?.aborted) cancelled.resolve();
        else
          options?.signal?.addEventListener("abort", cancelled.resolve, {
            once: true,
          });
        await cancelled.promise;
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
      fauxAssistantMessage("The queued message ran."),
      fauxAssistantMessage("The first fresh prompt ran."),
    ]);
    let acquisitions = 0;
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      runtime: createPrivateLocalRuntimeHost(),
      instructions: {
        load: () =>
          Promise.resolve({ revision: "queued-cancel", text: "Reply." }),
      },
      model: {
        acquire: () => {
          const first = acquisitions++ === 0;
          return Promise.resolve({
            model: faux.model,
            retryable: () => false,
            stream: faux.stream,
            release: () => (first ? cleanup.promise : Promise.resolve()),
          });
        },
      },
    });
    const session = agent.session("queued-cancel");
    try {
      const first = await session.send("Wait for cancellation.", {
        requestId: "first",
        delivery: "followUp",
      });
      await started.promise;
      const queued = await session.send("Run the queued message.", {
        requestId: "queued",
        delivery,
      });
      const abort = session.command({
        type: "cancel",
        commandId: first.commandId,
      });
      await cancelled.promise;
      // Repeated cancellation during cleanup still addresses the original run.
      const repeatedAbort = session.command({
        type: "cancel",
        commandId: first.commandId,
      });
      cleanup.resolve();
      await Promise.all([abort, repeatedAbort]);
      await vi.waitFor(
        async () => {
          expect((await session.read()).terminals).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                commandId: first.commandId,
                outcome: "cancelled",
              }),
              expect.objectContaining({
                commandId: queued.commandId,
                outcome: "completed",
              }),
            ]),
          );
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(faux.state.callCount).toBe(2);
      const next = await session.send("First fresh prompt.", {
        requestId: "next",
        delivery: "steer",
      });
      await vi.waitFor(
        async () => {
          expect((await session.read()).terminals).toContainEqual(
            expect.objectContaining({
              commandId: next.commandId,
              outcome: "completed",
            }),
          );
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(faux.state.callCount).toBe(3);
      // The Session terminal is durable before Watchdog finishes settling its
      // running claim; observe the eventual idle state without another wake.
      await vi.waitFor(async () => {
        expect((await session.read()).activity.queue.state).toBe("idle");
      });
    } finally {
      cancelled.resolve();
      cleanup.resolve();
      await agent.close();
      database.close();
    }
  },
);
