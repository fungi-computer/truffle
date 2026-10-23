import { fauxModel } from "@fungi.computer/mule/testing";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Knapsack } from "@fungi.computer/knapsack";
import { Shiitake } from "@fungi.computer/shiitake";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createPrivateInvocationComputer } from "../src/private-invocation-computer.js";
import {
  backgroundExecInput,
  createPrivateLocalComputerProcesses,
} from "../src/private-local-computer-processes.js";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

it.each([false, true])(
  "cancels the run and queue during a long Computer wait (held cleanup: %s) without killing its background process",
  async (holdCleanup) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-responsive-session-")),
    );
    const processes = createPrivateLocalComputerProcesses(root);
    const database = new DatabaseSync(":memory:");
    const computer = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
      processes.scope("main"),
    );
    const started = z.object({ process: z.object({ id: z.string() }) }).parse(
      await computer.call(
        "exec",
        { operation: "start", command: "sleep 60" },
        {
          executionId: "fixture-start",
          deadlineAt: null,
          signal: new AbortController().signal,
        },
      ),
    );
    const waiting = Promise.withResolvers<undefined>();
    const cleanup = Promise.withResolvers<undefined>();
    let acquired = 0;
    let cleanupStarted = false;
    let waitingSignal: AbortSignal | undefined;
    const { createPrivateLocalTools } =
      await import("../dist/private-local-runtime-host.js");
    const localTools = await createPrivateLocalTools(root);
    const faux = fauxModel([]);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: `return await Local_Computer.exec(${JSON.stringify({
            operation: "wait",
            id: started.process.id,
            timeoutMs: 60_000,
          })})`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The queued prompt ran."),
    ]);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      runtime: createPrivateLocalRuntimeHost(),
      instructions: {
        load: () =>
          Promise.resolve({ revision: "control-proof", text: "Reply." }),
      },
      model: {
        acquire: () => {
          const first = acquired++ === 0;
          return Promise.resolve({
            model: faux.model,
            retryable: () => false,
            stream: faux.stream,
            release: () => {
              if (first && holdCleanup) {
                cleanupStarted = true;
                return cleanup.promise;
              }
              return Promise.resolve();
            },
          });
        },
      },
      tools: {
        sources: [
          Knapsack.computer({
            id: "local-computer",
            name: "Local Computer",
            role: "home",
            computer: {
              ...computer,
              call: (operation, input, context) => {
                if (
                  operation === "exec" &&
                  backgroundExecInput.parse(input).operation === "wait"
                ) {
                  waitingSignal = context.signal;
                  waiting.resolve(undefined);
                }
                return computer.call(operation, input, context);
              },
            },
          }),
        ],
        sandbox: localTools.tools.sandbox,
      },
    });
    const session = agent.session("main");
    try {
      const first = await session.send("Wait for my background process.", {
        requestId: "first",
      });
      await waiting.promise;
      const queued = await session.send("Keep this queued text.", {
        requestId: "queued",
        delivery: "followUp",
      });
      // A held finalizer makes waiting for cleanup fail regardless of machine speed.
      await Effect.runPromise(
        Effect.tryPromise({
          try: () => session.abort(),
          catch: (cause) => cause,
        }).pipe(Effect.timeout(1_000)),
      );
      await vi.waitFor(
        () => {
          expect(waitingSignal?.aborted).toBe(true);
        },
        { timeout: 1_000, interval: 5 },
      );
      if (holdCleanup) {
        await vi.waitFor(
          () => {
            expect(cleanupStarted).toBe(true);
          },
          {
            timeout: 2_000,
            interval: 10,
          },
        );
        const additional = await Promise.all(
          ["queued-2", "queued-3"].map((requestId) =>
            session.send(requestId, { requestId, delivery: "followUp" }),
          ),
        );
        for (const pending of [queued, ...additional]) {
          expect(
            await session.command({
              type: "cancel",
              commandId: pending.commandId,
              onlyIfPending: true,
            }),
          ).toMatchObject({ status: "accepted", commandId: pending.commandId });
        }
        expect((await session.read()).pending.prompts).toEqual([]);
        expect((await session.read()).activity.cancellationRequested).toBe(
          true,
        );
        const heldTerminals = (await session.read()).terminals;
        for (const pending of [queued, ...additional])
          expect(heldTerminals).not.toContainEqual(
            expect.objectContaining({ commandId: pending.commandId }),
          );
      }
      cleanup.resolve(undefined);
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
                outcome: "cancelled",
              }),
            ]),
          );
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(faux.state.callCount).toBe(1);
      expect(
        (await session.read()).messages.map(({ value }) => value.content),
      ).toContain("Keep this queued text.");
      await expect(
        computer.call(
          "exec",
          { operation: "poll", id: started.process.id },
          {
            executionId: "fixture-poll",
            deadlineAt: null,
            signal: new AbortController().signal,
          },
        ),
      ).resolves.toMatchObject({ process: { state: "running" } });
    } finally {
      // Only this disposable Session's process is stopped; cancellation of wait
      // must not perform this cleanup itself.
      cleanup.resolve(undefined);
      await processes.close();
      await agent.close();
      await localTools.processes.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
