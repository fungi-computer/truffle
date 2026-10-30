import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "bun:test";
import { sleep } from "bun";
import {
  bindAgentExtension,
  bindSessionExtension,
} from "@fungi.computer/shiitake/client";
import { almanacContract } from "@fungi.computer/shiitake-extensions/almanac";
import {
  loopContract,
  type Loop,
} from "@fungi.computer/shiitake-extensions/loop";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import {
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";
import { runPrivateLocalService } from "../src/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { initFreshStore } from "./fixtures/fresh-store.js";
import {
  openScheduleAgent,
  openScheduleRuntime,
} from "./fixtures/schedule-owner.js";

it("admits schedule controls only through the private Local owner capability", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "private-schedules-")),
  );
  const project = join(root, "project");
  const config = capturePrivateLocalConfigRoot(join(root, "home"));
  await mkdir(join(project, ".git"), { recursive: true });
  const databasePath = join(
    project,
    ".fungi",
    "agents",
    "local_store_fern",
    "agent.sqlite",
  );
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  initFreshStore(database, "local_store_fern", "Fern", null);
  database.close();
  const seed = await openScheduleAgent(databasePath);
  let originalLoop: Loop;
  let retainedLoop: Loop;
  try {
    await bindAgentExtension(seed.agent, almanacContract).call(
      "createOneShot",
      {
        requestId: "water",
        sessionId: "garden",
        prompt: "Water the fern",
        dueAt: Date.now() + 86_400_000,
      },
    );
    const loops = bindSessionExtension(
      seed.agent.session("garden"),
      loopContract,
    );
    const input = {
      prompt: "Inspect the fern",
      expression: "0 * * * *",
      timeZone: "UTC",
    };
    originalLoop = (
      await loops.call("startFixedInterval", { ...input, requestId: "inspect" })
    ).loop;
    await loops.call("stop", {});
    retainedLoop = (
      await loops.call("startFixedInterval", {
        ...input,
        requestId: "inspect-again",
      })
    ).loop;
  } finally {
    await seed.close();
  }
  const directory = await serviceDirectory(config.serviceDirectory);
  const running = runPrivateLocalService(
    directory,
    openScheduleRuntime,
    undefined,
    undefined,
    undefined,
    undefined,
    config,
  );
  let prefix: string | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await readServiceRecord(directory);
      if (record !== undefined) {
        prefix = `${record.baseUrl}/service/${record.serviceId}`;
        break;
      }
      await sleep(10);
    }
    if (prefix === undefined) throw new Error("Private service did not start");
    const manager = createPrivateLocalServiceManager({
      home: config.home,
      directory,
    });
    const schedules = manager.schedules(project);
    const page = await schedules.list({ limit: 1 });
    expect(page.items).toMatchObject([
      {
        agentId: "local_store_fern",
        kind: "almanac",
        schedule: { id: "water", state: "active" },
      },
    ]);
    if (page.next === null) throw new Error("Missing schedule continuation");
    const loopPage = await schedules.list({ after: page.next, limit: 2 });
    expect(loopPage.items).toMatchObject([
      {
        kind: "loop",
        schedule: { sessionId: "garden", loopId: retainedLoop.loopId },
      },
    ]);
    expect(loopPage.next).toBeNull();
    const target = {
      kind: "almanac",
      agentId: "local_store_fern",
      scheduleId: "water",
    } as const;
    expect(await schedules.pause(target)).toMatchObject({
      kind: "almanac",
      schedule: { id: "water", state: "paused" },
    });
    expect(await schedules.delete(target)).toMatchObject({
      kind: "almanac",
      schedule: { id: "water", state: "cancelled" },
    });
    const loopTarget = {
      kind: "loop",
      agentId: "local_store_fern",
      sessionId: "garden",
      loopId: retainedLoop.loopId,
    } as const;
    const conflict = await schedules
      .pause({ ...loopTarget, loopId: originalLoop.loopId })
      .then(
        () => {
          throw new Error("A replaced Loop must not accept a stale target");
        },
        (cause: unknown) => cause,
      );
    expect(conflict).toMatchObject({ boundary: "store", cause: "conflict" });
    expect(await schedules.pause(loopTarget)).toMatchObject({
      kind: "loop",
      schedule: { loopId: retainedLoop.loopId, state: "paused" },
    });
    expect(await schedules.delete(loopTarget)).toMatchObject({
      kind: "loop",
      schedule: { loopId: retainedLoop.loopId, state: "cancelled" },
    });
    for (const path of ["list", "pause", "delete"]) {
      const response = await fetch(`${prefix}/schedules/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.fungi.run",
        },
        body: JSON.stringify({ invocationRoot: project, target }),
      });
      expect(response.status).toBe(403);
    }
    const rebound = await fetch(`${prefix}/schedules/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "attacker.invalid" },
      body: JSON.stringify({ invocationRoot: project }),
    });
    expect(rebound.status).toBe(403);
    expect((await schedules.list()).items).toMatchObject([
      {
        schedule: { id: "water", state: "cancelled" },
      },
      {
        schedule: { loopId: retainedLoop.loopId, state: "cancelled" },
      },
    ]);
  } finally {
    // Like the retained listener tests, invoke this in-process service's handler.
    // manager.stop() would signal the test process; there is no HTTP stop route.
    process.emit("SIGTERM", "SIGTERM");
    await running;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
