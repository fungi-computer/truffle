import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runPrivateLocalService } from "../src/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import {
  serviceDirectory,
  readServiceRecord,
} from "../src/private-local-service-discovery.js";
import { writeFreshStore } from "./fixtures/fresh-store.js";
import { stopAllRuntime } from "./fixtures/stop-all-runtime.js";

test("the real service stops descendants after the parent stops and keeps their chats resumable", async () => {
  await mkdir(".botanical", { recursive: true });
  const root = await mkdtemp(
    join(process.cwd(), ".botanical/stop-all-service-"),
  );
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const directory = await serviceDirectory(join(root, "service"));
  const order: string[] = [];
  const running = runPrivateLocalService(
    directory,
    stopAllRuntime((id) => {
      order.push(id);
    }),
  );
  const manager = createPrivateLocalServiceManager({ directory });
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await readServiceRecord(directory)) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    const connections = [];
    try {
      for (const [id, creator] of [
        ["root", null],
        ["child", "root"],
        ["leaf", "child"],
      ]) {
        if (id === undefined || id === null || creator === undefined)
          throw new Error("Bad fixture");
        const folder = join(root, ".fungi", "agents", id);
        await mkdir(folder, { recursive: true });
        const databasePath = join(folder, "agent.sqlite");
        writeFreshStore(databasePath, id, creator);
        const connection = await manager.connect({
          invocationRoot: root,
          databasePath,
          sessionId: "main",
        });
        connections.push(connection);
        await connection.session.send(`Work for ${id}`);
      }
      const [parent, child] = connections;
      if (parent === undefined || child === undefined)
        throw new Error("Missing connections");
      await parent.session.abort();
      order.length = 0;
      const result = await parent.stopAll();
      expect(order).toEqual(["leaf", "child"]);
      expect(result.agents.map(({ outcome }) => outcome)).toEqual([
        "stopped",
        "stopped",
        "idle",
      ]);
      expect((await manager.discover(root)).agents).toHaveLength(3);
      expect((await child.session.read()).messages).toHaveLength(1);
      await child.session.send("Resume the same chat");
      expect((await child.session.read()).pending.total).toBe(1);
    } finally {
      await Promise.all(connections.map((connection) => connection.close()));
    }
  } finally {
    try {
      // The listener is embedded in this test process. The current manager
      // correctly refuses to terminate its own process; use its signal handler.
      process.emit("SIGTERM", "SIGTERM");
      await running;
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }
});
