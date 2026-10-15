import assert from "node:assert/strict";
import console from "node:console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { Mycelium } from "@fungi.computer/mycelium";
import { createPrivateWorkerdSandbox } from "../../dist/private-workerd-sandbox.js";

const runtime = await Mycelium.make({
  execution: { timeoutMs: 17_003 },
  modules: [
    Mycelium.module({
      id: "demo",
      name: "demo",
      operations: {
        read: Mycelium.operation({
          input: z.strictObject({}),
          output: z.string(),
          execute: async () => "sample",
        }),
      },
    }),
  ],
  sandbox: createPrivateWorkerdSandbox(),
});
const lease = await runtime.acquire();
try {
  const prepared = await Effect.runPromise(
    lease.executeTool.prepare({
      type: "toolCall",
      id: "local-forage-install-proof",
      name: "execute",
      arguments: { code: 'return await forage.search({query:"read"})' },
    }),
  );
  const parts = await Effect.runPromise(Stream.runCollect(prepared.execute()));
  const [part] = z
    .tuple([
      z.object({
        type: z.literal("result"),
        result: z.object({
          content: z.tuple([
            z.object({ type: z.literal("text"), text: z.string() }),
          ]),
        }),
      }),
    ])
    .parse(parts);
  const result = z
    .object({ results: z.array(z.object({ path: z.string() })) })
    .parse(JSON.parse(part.result.content[0].text));
  assert.ok(result.results.some(({ path }) => path === "demo.read"));
  console.log("forage.search passed");
} finally {
  await lease.release();
  await runtime.close();
}
