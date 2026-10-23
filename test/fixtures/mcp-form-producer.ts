import { Mycelium } from "@fungi.computer/mycelium";
import { createMcp, createMcpCatalog } from "@fungi.computer/mycelium/mcp";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { z } from "zod";
import type { PrivateFungiMcpConnectionOptions } from "../../src/private-fungi-mcp-connection.js";

/** Explicit author-confirmation protocol fixture, not a ledger-policy producer. */
export function mcpFormProducer(afterWrite?: () => Promise<void>) {
  let writes = 0;
  const module = Mycelium.module({
    id: "app",
    name: "app",
    operations: {
      write: Mycelium.operation({
        confirm: true,
        input: z.strictObject({}),
        execute: () => {
          writes++;
          return Promise.resolve("saved");
        },
      }),
    },
  });
  const remote = createMcp({
    authenticate: () =>
      Promise.resolve({
        kind: "admitted",
        principal: { actor: { kind: "team-key", keyId: "fixture" } },
      }),
    catalog: createMcpCatalog({
      load: () =>
        Promise.resolve({
          instructions: "",
          grants: { app: "write" },
          sources: [
            {
              id: "app",
              acquire: () =>
                Promise.resolve({
                  snapshot: { version: "1", modules: [module] },
                  release: () => Promise.resolve(),
                }),
            },
          ],
        }),
      sandbox: directSandbox(async (bindings) => {
        const write = bindings.app?.write;
        if (write === undefined) throw new Error("Missing fixture write");
        const result = await write({});
        await afterWrite?.();
        return result;
      }),
    }),
  });
  const connection: PrivateFungiMcpConnectionOptions = {
    endpoint: new URL("https://mcp.test/mcp"),
    authProvider: { token: () => Promise.resolve("fixture") },
    fetch: (input, init) =>
      remote.handleRequest(
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init),
      ),
  };
  return { connection, writes: () => writes, close: () => remote.close() };
}
