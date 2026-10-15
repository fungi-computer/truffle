import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runPrivateLocalAcpStdio } from "../src/private-local-acp-stdio.js";

describe("Local ACP stdio consumer", () => {
  it("uses the maintained ACP NDJSON stdio stream", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: acp.methods.agent.initialize,
              params: { protocolVersion: acp.PROTOCOL_VERSION },
            }) + "\n",
          ),
        );
        controller.close();
      },
    });
    const output: string[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        output.push(new TextDecoder().decode(chunk));
      },
    });

    await runPrivateLocalAcpStdio({ input, output: writable });

    expect(output.join("")).toContain('"protocolVersion":1');
  });
});

it("advertises terminal login and lists project Sessions through Local discovery", async () => {
  const { createPrivateLocalAcpAgent } =
    await import("../src/private-local-acp-stdio.js");
  const unused = (): Promise<never> =>
    Promise.reject(new Error("Unexpected service call"));
  const roots: string[] = [];
  const agent = createPrivateLocalAcpAgent({
    invocationRoot: "/workspace",
    manager: {
      status: unused,
      start: unused,
      createSession: unused,
      connect: unused,
      inspect: unused,
      auth: unused,
      models: unused,
      stop: unused,
      discover: (root) => {
        roots.push(root);
        return Promise.resolve({
          agentCount: 1,
          problems: [],
          sessions: [
            {
              databasePath: "/workspace/agent.sqlite",
              sessionId: "saved",
              title: "Saved conversation",
              createdAt: 0,
              updatedAt: 1,
              resume: unused,
            },
          ],
        });
      },
    },
  });
  await acp.client().connectWith(agent, async (ctx) => {
    const result = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } },
    });
    expect(result.authMethods).toEqual([
      {
        type: "terminal",
        id: "fungi-login",
        name: "Sign in to Fungi",
        args: ["login"],
      },
    ]);
    expect(result.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(await ctx.request(acp.methods.agent.session.list, {})).toEqual({
      sessions: [
        {
          cwd: "/workspace",
          sessionId: "saved",
          title: "Saved conversation",
          updatedAt: new Date(1).toISOString(),
        },
      ],
    });
    await expect(
      ctx.request(acp.methods.agent.session.list, { cursor: "foreign" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
  expect(roots).toEqual(["/workspace"]);
});
