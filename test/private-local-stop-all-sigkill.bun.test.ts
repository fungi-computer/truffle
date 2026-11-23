import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "bun:test";
import { sleep, spawn } from "bun";
import { bindAgentExtension } from "@fungi.computer/shiitake/client";
import { almanacContract } from "@fungi.computer/shiitake-extensions/almanac";
import {
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { initFreshStore } from "./fixtures/fresh-store.js";
import { openScheduleAgent } from "./fixtures/schedule-owner.js";

const service = join(import.meta.dir, "fixtures/stop-all-kill-service.ts");

async function started(directory: string, previousId?: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const record = await readServiceRecord(directory);
    if (record !== undefined && record.serviceId !== previousId) return record;
    await sleep(25);
  }
  throw new Error("The service did not start");
}

test("a SIGKILL in the middle of Stop all leaves the stopped Agents stopped and every schedule paused after restart", async () => {
  await mkdir(".botanical", { recursive: true });
  const root = await realpath(
    await mkdtemp(join(process.cwd(), ".botanical/stop-sigkill-")),
  );
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const stores: Record<string, string> = {};
  for (const [id, createdBy] of [
    ["root", null],
    ["child", "root"],
    ["leaf", "child"],
  ] as const) {
    const databasePath = join(root, ".fungi", "agents", id, "agent.sqlite");
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    initFreshStore(database, id, id, createdBy);
    database.close();
    const seed = await openScheduleAgent(databasePath);
    try {
      await bindAgentExtension(seed.agent, almanacContract).call(
        "createOneShot",
        {
          requestId: `${id}-water`,
          sessionId: "main",
          prompt: `Water for ${id}`,
          dueAt: Date.now() + 86_400_000,
        },
      );
    } finally {
      await seed.close();
    }
    stores[id] = databasePath;
  }
  const directory = await serviceDirectory(join(home, "service"));
  const env = { ...process.env, HOME: home };
  const first = spawn(["bun", service, directory, "kill"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const manager = createPrivateLocalServiceManager({ directory, home });
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const firstRecord = await started(directory);
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof manager.connect>>
    >();
    for (const id of ["root", "child", "leaf"]) {
      const connection = await manager.connect({
        invocationRoot: root,
        databasePath: stores[id] ?? "",
        sessionId: "main",
      });
      connections.set(id, connection);
      // A running turn that only an abort can end.
      await connection.session.send(`Work for ${id}`);
    }
    const rootConnection = connections.get("root");
    if (rootConnection === undefined) throw new Error("Missing root");
    // The service kills itself after the middle Agent's cancellation is
    // accepted, so the request dies with it.
    const outcome = await rootConnection.stopAll().then(
      () => "answered",
      () => "died with the service",
    );
    expect(outcome).toBe("died with the service");
    await first.exited;
    expect(first.signalCode).toBe("SIGKILL");
    // Their service is gone, so closing may report it; only the restart matters.
    await Promise.allSettled(
      [...connections.values()].map((connection) => connection.close()),
    );

    // Restart over the same stores, with a model that answers at once.
    second = spawn(["bun", service, directory, "recover"], {
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    await started(directory, firstRecord.serviceId);
    const after = new Map<
      string,
      Awaited<ReturnType<typeof manager.connect>>
    >();
    for (const id of ["root", "child", "leaf"])
      after.set(
        id,
        await manager.connect({
          invocationRoot: root,
          databasePath: stores[id] ?? "",
          sessionId: "main",
        }),
      );
    // Recovery is live: the Agent the stop never reached resumes its turn.
    const recovered = (
      snapshot: { messages: readonly unknown[] } | undefined,
    ) =>
      JSON.stringify(snapshot?.messages ?? []).includes(
        "Recovered after restart",
      );
    let rootReply = false;
    for (let attempt = 0; attempt < 200 && !rootReply; attempt++) {
      rootReply = recovered(await after.get("root")?.session.read());
      if (!rootReply) await sleep(50);
    }
    expect(rootReply).toBe(true);
    // Cancellation wins over recovery: the stopped Agents stay stopped.
    await sleep(500);
    for (const id of ["child", "leaf"]) {
      const snapshot = await after.get(id)?.session.read();
      expect(snapshot?.activity.queue.state).not.toBe("running");
      expect(snapshot?.pending.total).toBe(0);
      expect(recovered(snapshot)).toBe(false);
    }
    // The schedules were paused before any Session stopped, so all three are
    // paused even though the cascade never finished.
    const page = await manager.schedules(root).list({ limit: 64 });
    expect(
      page.items.map((row) => `${row.agentId}:${row.schedule.state}`).sort(),
    ).toEqual(["child:paused", "leaf:paused", "root:paused"]);
    for (const connection of after.values()) await connection.close();
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
  }
}, 60_000);
