import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Mycelium, type Runtime } from "@fungi.computer/mycelium";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPrivateFungiMcpConnection } from "../src/private-fungi-mcp-connection.js";
import { createPrivateLocalTools } from "../src/private-local-runtime-host.js";

async function invoke(runtime: Runtime, code: string) {
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "local-connection-proof",
        name: "execute",
        arguments: { code },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    for (const part of parts) if (part.type === "result") return part.result;
    throw new Error("Missing Mycelium result");
  } finally {
    await lease.release();
  }
}

it.each([false, true])(
  "compiles the complete Local tool surface through Forage (Session PATH: %s) and invokes the MCP door",
  async (sessionPath) => {
    const calls: string[] = [];
    let localCalls = 0;
    let allowed = true;
    const endpoint = new URL("https://hub.test/api/teams/team-selected/mcp");
    const authProvider = {
      token: () => Promise.resolve("owner-selected-credential"),
    };
    const handler = createMcpHandler(() => {
      const server = new McpServer({
        name: "fungi-mcp-test",
        version: "0.0.0",
      });
      server.registerTool(
        "execute",
        { inputSchema: z.strictObject({ code: z.string() }) },
        ({ code }) => {
          calls.push(code);
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: "remote result",
                annotations: { audience: ["assistant"], priority: 0.8 },
              },
            ],
            structuredContent: { source: "selected-home" },
            isError: code === "remote operation fails",
          });
        },
      );
      return server;
    });
    const temporary = await mkdtemp(join(tmpdir(), "fungi-mcp-connection-"));
    const root = join(temporary, "nested-project-".repeat(12));
    await mkdir(root);
    await writeFile(join(root, "local.txt"), "local result");
    const localTools = await createPrivateLocalTools(
      root,
      {
        endpoint,
        authProvider,
        fetch: async (input, init) => {
          const request = new Request(input.toString(), init);
          expect(request.url).toBe(
            "https://hub.test/api/teams/team-selected/mcp",
          );
          expect(request.headers.get("authorization")).toBe(
            "Bearer owner-selected-credential",
          );
          expect(request.redirect).toBe("error");
          if (!allowed) return new Response(null, { status: 403 });
          return handler.fetch(request);
        },
      },
      {
        list: () => Promise.resolve([]),
        create: ({ requestId }) =>
          Promise.resolve({ agentId: requestId, name: "catalog-fixture" }),
        open: () =>
          Promise.reject(
            new Error("Catalog compilation must not open an Agent"),
          ),
      },
      sessionPath ? () => "/usr/bin:/bin" : undefined,
    );
    // Capturing a connection does not let later caller mutation retarget it.
    endpoint.pathname = "/api/teams/another-team/mcp";
    const runtime = await Mycelium.make({
      ...localTools.tools,
      session: { sessionId: "catalog-surface-proof" },
      // Dispatch through actual compiled operations, without claiming code-executor qualification.
      sandbox: {
        execute: async (request) => {
          const remote = request.bindings.fungiMcp?.execute;
          expect(request.namespacePaths?.local).toEqual(["computers", "local"]);
          const local = request.bindings.local?.["files.read"];
          if (!remote || !local)
            throw new Error("Connected capabilities missing");
          const result = await remote({ code: request.code });
          localCalls++;
          return {
            remote: result,
            local: await local({ path: "local.txt", offset: 0, limit: 128 }),
          };
        },
      },
    });
    try {
      const lease = await runtime.acquire();
      try {
        for (const path of [
          "computers.local.exec",
          "computers.local.files.read",
          "agents.list",
          "agents.create",
          "agents.createSession",
          "agents.sessions",
          "agents.read",
          "agents.cancel",
          "agents.wait",
          "fungiMcp.execute",
          "forage.search",
          "forage.describe",
        ])
          expect(lease.catalog.describe({ path }).kind).toBe("operation");
        for (const path of ["agents.send", "agents.recall"])
          expect(() => lease.catalog.describe({ path })).toThrow(
            `Unknown target: ${path}`,
          );
        expect(() => lease.catalog.describe({ path: "home.exec" })).toThrow(
          "Unknown target: home.exec",
        );
      } finally {
        await lease.release();
      }
      const first = await invoke(
        runtime,
        "return await env.computers.local.files.read({path:'hello.txt'})",
      );
      expect(JSON.stringify(first)).toContain("remote result");
      expect(JSON.stringify(first)).toContain("local result");
      expect(calls).toEqual([
        "return await env.computers.local.files.read({path:'hello.txt'})",
      ]);
      expect(localCalls).toBe(1);
      const failed = await invoke(runtime, "remote operation fails");
      const text = failed.content.find((part) => part.type === "text");
      if (!text) throw new Error("Missing result text");
      const decoded = z
        .object({ remote: z.json(), local: z.object({ content: z.string() }) })
        .parse(JSON.parse(text.text));
      expect(decoded.remote).toEqual({
        content: [
          {
            type: "text",
            text: "remote result",
            annotations: { audience: ["assistant"], priority: 0.8 },
          },
        ],
        structuredContent: { source: "selected-home" },
        isError: true,
      });
      expect(decoded.local).toMatchObject({ content: "local result" });
      expect(localCalls).toBe(2);
      allowed = false;
      await expect(invoke(runtime, "must not execute")).rejects.toThrow(
        "The sandbox failed for an unrecognized reason",
      );
      expect(calls).toHaveLength(2);
      expect(localCalls).toBe(2);
    } finally {
      await runtime.close();
      await localTools.processes.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it("closes the maintained transport when acquisition is cancelled", async () => {
  const abort = new AbortController();
  let transportClosed = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const connection = createPrivateFungiMcpConnection({
    endpoint: new URL("https://hub.test/api/teams/team-selected/mcp"),
    authProvider: { token: () => Promise.resolve("fixture") },
    fetch: async (_input, init) => {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const closed = () => {
          transportClosed = true;
          reject(new Error("Transport closed"));
        };
        if (init?.signal?.aborted) closed();
        else init?.signal?.addEventListener("abort", closed, { once: true });
      });
    },
  });
  const acquired = connection.acquire({
    signal: abort.signal,
    invalidate: () => undefined,
  });
  const rejected = expect(acquired).rejects.toThrow();
  await started;
  abort.abort();
  await rejected;
  expect(transportClosed).toBe(true);
});

it("reconnects after a lost response without replaying the accepted request", async () => {
  const calls: string[] = [];
  let loseNextResponse = true;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fungi-mcp-test", version: "0.0.0" });
    server.registerTool(
      "execute",
      { inputSchema: z.strictObject({ code: z.string() }) },
      ({ code }) => {
        calls.push(code);
        return Promise.resolve({ content: [{ type: "text", text: code }] });
      },
    );
    return server;
  });
  const source = createPrivateFungiMcpConnection({
    endpoint: new URL("https://hub.test/api/teams/team-selected/mcp"),
    authProvider: { token: () => Promise.resolve("fixture") },
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      const body = z
        .looseObject({ method: z.string().optional() })
        .parse(await request.clone().json());
      const response = await handler.fetch(request);
      if (body.method === "tools/call" && loseNextResponse) {
        loseNextResponse = false;
        throw new Error("response connection dropped");
      }
      return response;
    },
  });
  const runtime = await Mycelium.make({
    sources: [source],
    sandbox: {
      execute: async (request) => {
        const execute = request.bindings.fungiMcp?.execute;
        if (execute === undefined) throw new Error("Fungi MCP unavailable");
        return execute({ code: request.code });
      },
    },
  });
  try {
    const interrupted = await invoke(runtime, "operation-accepted-once");
    expect(JSON.stringify(interrupted)).toContain(
      "outcome unknown. Reconnect and inspect Computer state before retrying",
    );
    const interruptedText = interrupted.content.find(
      (part) => part.type === "text",
    );
    if (!interruptedText) throw new Error("Missing interrupted result");
    const execution = z
      .object({ isError: z.boolean() })
      .parse(JSON.parse(interruptedText.text));
    expect(execution.isError).toBe(true);
    expect(calls).toEqual(["operation-accepted-once"]);

    const reconnected = await invoke(runtime, "operation-after-reconnect");
    expect(JSON.stringify(reconnected)).toContain("operation-after-reconnect");
    expect(calls).toEqual([
      "operation-accepted-once",
      "operation-after-reconnect",
    ]);
  } finally {
    await runtime.close();
  }
});

it("reports a key revoked mid-session as a refused call, not an unknown outcome", async () => {
  // Auth gate O9: a revoked key's 401 read as an interrupted connection whose
  // outcome was unknown, although the Hub refused the call before it ran.
  const calls: string[] = [];
  let revoked = false;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fungi-mcp-test", version: "0.0.0" });
    server.registerTool(
      "execute",
      { inputSchema: z.strictObject({ code: z.string() }) },
      ({ code }) => {
        calls.push(code);
        return Promise.resolve({ content: [{ type: "text", text: code }] });
      },
    );
    return server;
  });
  const source = createPrivateFungiMcpConnection({
    endpoint: new URL("https://hub.test/api/teams/team-selected/mcp"),
    authProvider: { token: () => Promise.resolve("fungi_fixture") },
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      const body = z
        .looseObject({ method: z.string().optional() })
        .parse(await request.clone().json());
      if (revoked && body.method === "tools/call")
        return new Response(null, { status: 401 });
      return handler.fetch(request);
    },
  });
  const runtime = await Mycelium.make({
    sources: [source],
    sandbox: {
      execute: async (request) => {
        const execute = request.bindings.fungiMcp?.execute;
        if (execute === undefined) throw new Error("Fungi MCP unavailable");
        return execute({ code: request.code });
      },
    },
  });
  try {
    revoked = true;
    const refused = JSON.stringify(await invoke(runtime, "after-revocation"));
    expect(refused).not.toContain("outcome unknown");
    expect(refused).toContain("missing, expired or revoked");
    expect(refused).toContain("did not run");
    expect(calls).toEqual([]);
  } finally {
    await runtime.close();
  }
});
