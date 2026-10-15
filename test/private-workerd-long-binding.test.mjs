import {
  execute,
  openRuntime,
  closeRuntime,
  ownedWorkerdProcesses,
} from "./fixtures/private-workerd.fixture.mjs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { Mycelium } from "@fungi.computer/mycelium";
import { createPrivateWorkerdSandbox } from "../dist/index.js";
it("completes a binding beyond 60 seconds under the selected larger budget", async () => {
  const events = [];
  const runtime = await openRuntime({
    execution: { timeoutMs: 120_007 },
    modules: [
      Mycelium.module({
        id: "slow",
        operations: {
          wait: Mycelium.operation({
            input: z.strictObject({}),
            output: z.strictObject({ done: z.literal(true) }),
            execute: async (_input, context) => {
              await delay(62_000, undefined, { signal: context.signal });
              events.push({
                event: "binding-drained",
                aborted: context.signal.aborted,
              });
              return { done: true };
            },
          }),
        },
      }),
    ],
    sandbox: createPrivateWorkerdSandbox(),
  });
  const lease = await runtime.acquire();

  try {
    await expect(
      execute(lease, "async () => await slow.wait({})"),
    ).resolves.toEqual({ done: true });
    expect(events).toEqual([{ event: "binding-drained", aborted: false }]);
  } finally {
    await closeRuntime(runtime, lease);
  }
  if (process.platform === "linux")
    expect(await ownedWorkerdProcesses()).toEqual([]);
}, 75_000);
