import { it, expect } from "bun:test";
import assert from "node:assert/strict";
import { serve, sleep } from "bun";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import type { ShiitakeSession } from "@fungi.computer/shiitake";

async function completed(session: ShiitakeSession, count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const snapshot = await session.read();
    if (snapshot.terminals.length >= count) {
      expect(snapshot.terminals.map(({ outcome }) => outcome)).toEqual(
        Array.from({ length: count }, () => "completed"),
      );
      return snapshot;
    }
    await sleep(20);
  }
  throw new Error("Reload fixture turn did not settle");
}

it("reload preserves PID and Session, captures PATH per turn, adds MCP, and keeps both on invalid config", async () => {
  const area = resolve(import.meta.dir, "../../../.botanical");
  await mkdir(area, { recursive: true });
  const root = await mkdtemp(join(area, "reload-acceptance-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const directory = join(root, "service");
  await mkdir(join(home, ".config/fungi"), { recursive: true });
  await mkdir(join(project, ".fungi"), { recursive: true });
  const inFlight = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const remoteCalls: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "reload-fixture", version: "1.0.0" });
    server.registerTool(
      "execute",
      { inputSchema: z.object({ code: z.string() }) },
      ({ code }) => {
        remoteCalls.push(code);
        return { content: [{ type: "text", text: "remote reload success" }] };
      },
    );
    return server;
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/gate") {
        inFlight.resolve(undefined);
        await release.promise;
        return new Response("released");
      }
      return handler.fetch(request);
    },
  });
  await writeFile(
    join(home, ".config/fungi/credentials.json"),
    JSON.stringify({
      fungi: {
        type: "oauth",
        access: "fixture-token",
        refresh: "fixture-refresh",
        expires: Date.now() + 3_600_000,
        issuer: server.url.origin,
      },
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/reload-service.ts"),
      directory,
      new URL("/gate", server.url).href,
    ],
    { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const manager = createPrivateLocalServiceManager({
    directory,
    executionPath: "/usr/bin:/bin",
  });
  const nextPath = `${join(root, "next-bin")}:/usr/bin:/bin`;
  const reloader = createPrivateLocalServiceManager({
    directory,
    executionPath: nextPath,
  });
  let connection: Awaited<ReturnType<typeof manager.connect>> | undefined;
  try {
    let status = await manager.status();
    for (let attempt = 0; status === undefined && attempt < 300; attempt++) {
      if (child.exitCode !== null) throw new Error(await errors);
      await sleep(20);
      status = await manager.status();
    }
    if (status === undefined) throw new Error("Fixture service did not start");
    connection = await manager.connect({ invocationRoot: project });
    await connection.session.send("first", { requestId: "first" });
    await inFlight.promise;
    const configFile = join(project, ".fungi/team-mcp.json");
    await writeFile(
      configFile,
      JSON.stringify({
        endpoint: new URL("/api/teams/reload/mcp", server.url).href,
      }),
    );
    expect(await reloader.reload(project)).toBe(
      "Configuration reloaded; applies from the next turn",
    );
    expect(await manager.status()).toEqual(status);
    release.resolve(undefined);
    const first = await completed(connection.session, 1);
    expect(JSON.stringify(first)).toContain("/usr/bin:/bin");
    expect(JSON.stringify(first)).not.toContain(nextPath);
    expect(remoteCalls).toEqual([]);
    await connection.session.send("second", { requestId: "second" });
    const second = await completed(connection.session, 2);
    expect(JSON.stringify(second)).toContain(nextPath);
    expect(remoteCalls).toEqual(["reload probe"]);
    const reconnected = await reloader.connect({
      invocationRoot: project,
      databasePath: connection.databasePath,
      sessionId: connection.sessionId,
    });
    expect(reconnected.sessionId).toBe(connection.sessionId);
    await reconnected.close();
    await writeFile(configFile, JSON.stringify({ endpoint: "not-a-url" }));
    await assert.rejects(
      reloader.reload(project),
      /endpoint[\s\S]*Old configuration kept\./u,
    );
    await connection.session.send("third", { requestId: "third" });
    const third = await completed(connection.session, 3);
    expect(JSON.stringify(third)).toContain(nextPath);
    expect(remoteCalls).toEqual(["reload probe", "reload probe"]);
    expect(await manager.status()).toEqual(status);
  } finally {
    release.resolve(undefined);
    await connection?.close();
    child.kill("SIGTERM");
    await child.exited;
    await server.stop(true);
    const stdout = await output;
    const stderr = await errors;
    if (child.exitCode !== 0) console.error({ stdout, stderr });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
