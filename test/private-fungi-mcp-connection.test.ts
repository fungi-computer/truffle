import { UnauthorizedError } from "@modelcontextprotocol/client";
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
        const remoteExecute = lease.catalog.describe({
          path: "fungiMcp.execute",
        });
        expect(remoteExecute.kind).toBe("operation");
        expect(remoteExecute.description).toContain(
          "The following discovery instructions apply inside that remote call, not the outer Local call. Inside execute, call forage.search, forage.list or forage.describe",
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
      expect(
        JSON.stringify(await invoke(runtime, "must not execute")),
      ).toContain("the code did not run");
      expect(calls).toHaveLength(2);
      expect(localCalls).toBe(3);
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

// pf-11 failure matrix. Each cell names the end state on both sides.
type Fixture = Readonly<{
  calls: string[];
  fetchBehavior: {
    current: (
      request: Request,
      method: string,
    ) => Promise<Response | undefined>;
  };
  source: ReturnType<typeof createPrivateFungiMcpConnection>;
}>;

function matrixFixture(): Fixture {
  const calls: string[] = [];
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
  const fetchBehavior: Fixture["fetchBehavior"] = {
    current: () => Promise.resolve(undefined),
  };
  const source = createPrivateFungiMcpConnection({
    endpoint: new URL("https://hub.test/api/teams/team-selected/mcp"),
    authProvider: { token: () => Promise.resolve("fixture") },
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      const text = await request.clone().text();
      const body = z
        .looseObject({ method: z.string().optional() })
        .safeParse(text === "" ? {} : JSON.parse(text));
      const method = body.success ? (body.data.method ?? "") : "";
      return (
        (await fetchBehavior.current(request, method)) ?? handler.fetch(request)
      );
    },
  });
  return { calls, fetchBehavior, source };
}

function matrixRuntime(source: Fixture["source"]) {
  return Mycelium.make({
    sources: [source],
    sandbox: {
      execute: async (request) => {
        const execute = request.bindings.fungiMcp?.execute;
        if (execute === undefined) throw new Error("Fungi MCP unavailable");
        return execute({ code: request.code });
      },
    },
  });
}

it("matrix: network drop while idle fails the next connect as unreachable, then a later connect succeeds without replay", async () => {
  const { calls, fetchBehavior, source } = matrixFixture();
  const runtime = await matrixRuntime(source);
  try {
    fetchBehavior.current = () => Promise.reject(new TypeError("network down"));
    await expect(
      source.acquire({
        signal: new AbortController().signal,
        invalidate: () => undefined,
      }),
    ).rejects.toThrow(/Can't reach https:\/\/hub\.test/);
    await expect(invoke(runtime, "while-down")).rejects.toThrow();
    expect(calls).toEqual([]);
    fetchBehavior.current = () => Promise.resolve(undefined);
    expect(JSON.stringify(await invoke(runtime, "after-recovery"))).toContain(
      "after-recovery",
    );
    expect(calls).toEqual(["after-recovery"]);
  } finally {
    await runtime.close();
  }
});

it("matrix: Hub killed mid-call (5xx after accept) is not replayed and the next call reconnects", async () => {
  const { calls, fetchBehavior, source } = matrixFixture();
  const runtime = await matrixRuntime(source);
  try {
    fetchBehavior.current = (_request, method) => {
      if (method !== "tools/call") return Promise.resolve(undefined);
      fetchBehavior.current = () => Promise.resolve(undefined);
      return Promise.resolve(new Response(null, { status: 503 }));
    };
    const interrupted = JSON.stringify(await invoke(runtime, "hub-died"));
    expect(interrupted).toContain("outcome unknown");
    expect(calls).toEqual([]);
    expect(
      JSON.stringify(await invoke(runtime, "after-hub-restart")),
    ).toContain("after-hub-restart");
    expect(calls).toEqual(["after-hub-restart"]);
  } finally {
    await runtime.close();
  }
});

it("matrix: Team membership revoked mid-session (403) is a refusal, and reconnecting stays refused", async () => {
  const { calls, fetchBehavior, source } = matrixFixture();
  const runtime = await matrixRuntime(source);
  try {
    fetchBehavior.current = (_request, method) =>
      Promise.resolve(
        method === "tools/call"
          ? new Response(null, { status: 403 })
          : undefined,
      );
    const refused = JSON.stringify(await invoke(runtime, "after-removal"));
    expect(refused).not.toContain("outcome unknown");
    expect(refused).toContain("did not run");
    expect(calls).toEqual([]);
    fetchBehavior.current = () =>
      Promise.resolve(new Response(null, { status: 403 }));
    await expect(
      source.acquire({
        signal: new AbortController().signal,
        invalidate: () => undefined,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  } finally {
    await runtime.close();
  }
});

it("matrix: credential revoked before reconnect refuses the connection with a sign-in instruction", async () => {
  const { calls, fetchBehavior, source } = matrixFixture();
  fetchBehavior.current = () =>
    Promise.resolve(new Response(null, { status: 401 }));
  await expect(
    source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    }),
  ).rejects.toBeInstanceOf(UnauthorizedError);
  expect(calls).toEqual([]);
});

it("matrix: Local side cancelled mid-call tells the Hub it cancelled, never replays, and the next call reconnects", async () => {
  const { calls, fetchBehavior, source } = matrixFixture();
  const entered = Promise.withResolvers<undefined>();
  const methods: string[] = [];
  fetchBehavior.current = (request, method) => {
    methods.push(method);
    if (method !== "tools/call") return Promise.resolve(undefined);
    entered.resolve(undefined);
    fetchBehavior.current = (_next, nextMethod) => {
      methods.push(nextMethod);
      return Promise.resolve(undefined);
    };
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  };
  const runtime = await matrixRuntime(source);
  try {
    const cancel = new AbortController();
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "local-cancel-proof",
          name: "execute",
          arguments: { code: "local-cancelled" },
        }),
      );
      const pending = expect(
        Effect.runPromise(Stream.runCollect(prepared.execute()), {
          signal: cancel.signal,
        }),
      ).rejects.toBeDefined();
      await entered.promise;
      cancel.abort();
      await pending;
    } finally {
      await lease.release();
    }
    // The maintained client states cancellation to the Hub as an MCP
    // notification; the Hub, not Local, owns whether the operation had begun.
    expect(methods).toContain("notifications/cancelled");
    expect(calls).toEqual([]);
    fetchBehavior.current = () => Promise.resolve(undefined);
    expect(JSON.stringify(await invoke(runtime, "after-cancel"))).toContain(
      "after-cancel",
    );
    expect(calls).toEqual(["after-cancel"]);
  } finally {
    await runtime.close();
  }
}, 5000);
