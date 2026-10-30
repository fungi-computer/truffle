import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  bindAgentExtension,
  bindSessionExtension,
} from "@fungi.computer/shiitake/client";
import { almanacContract } from "@fungi.computer/shiitake-extensions/almanac";
import {
  loopContract,
  type Loop,
} from "@fungi.computer/shiitake-extensions/loop";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import { listPrivateLocalAgentStores } from "../src/private-local-session-discovery.js";
import { initFreshStore } from "./fixtures/fresh-store.js";
import {
  openScheduleAgent,
  openScheduleRuntime,
} from "./fixtures/schedule-owner.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "local-schedule-directory-")),
  );
  await mkdir(join(root, ".git"));
  const opened: string[] = [];
  const unavailable = new Set<string>();
  const owners = createLocalServiceOwners(
    async (options) => {
      const databasePath = options.databasePath;
      if (databasePath === undefined)
        throw new Error("Expected retained store");
      opened.push(databasePath);
      if (unavailable.has(databasePath)) throw new Error("Owner unavailable");
      return openScheduleRuntime(options);
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      home: root,
      credentialPath: join(root, "credentials.json"),
      serviceDirectory: join(root, "service"),
    },
  );
  return { root, owners, opened, unavailable };
}

async function retainedStore(root: string, agentId: string) {
  const databasePath = join(root, ".fungi", "agents", agentId, "agent.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  initFreshStore(database, agentId, "Fern", null);
  database.close();
  return databasePath;
}

it("lists and controls unopened, unjoined Local Agents through the private schedule owner", async () => {
  const { root, owners, opened } = await fixture();
  try {
    const databasePath = await retainedStore(root, "local_store_fern");
    const seed = await openScheduleAgent(databasePath);
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
      retainedLoop = (
        await bindSessionExtension(
          seed.agent.session("garden"),
          loopContract,
        ).call("startFixedInterval", {
          requestId: "inspect",
          prompt: "Inspect the fern",
          expression: "0 * * * *",
          timeZone: "UTC",
        })
      ).loop;
    } finally {
      await seed.close();
    }
    expect(opened).toEqual([]);
    const page = await owners.schedules(
      { invocationRoot: root, limit: 1 },
      new AbortController().signal,
    );
    expect(page.items).toMatchObject([
      {
        agentId: "local_store_fern",
        kind: "almanac",
        schedule: {
          id: "water",
          prompt: "Water the fern",
          state: "active",
        },
      },
    ]);
    expect(page.unavailable).toEqual([]);
    expect(page.next).not.toBeNull();
    expect(opened).toEqual([databasePath]);
    if (page.next === null) throw new Error("Expected schedule continuation");
    const second = await owners.schedules(
      { invocationRoot: root, after: page.next, limit: 2 },
      new AbortController().signal,
    );
    expect(second.items).toMatchObject([
      {
        agentId: "local_store_fern",
        kind: "loop",
        schedule: {
          loopId: retainedLoop.loopId,
          sessionId: "garden",
          prompt: "Inspect the fern",
          state: "active",
        },
      },
    ]);
    expect(second.unavailable).toEqual([]);
    expect(second.next).toBeNull();
    const targets = [
      {
        kind: "almanac",
        agentId: "local_store_fern",
        scheduleId: "water",
      },
      {
        kind: "loop",
        agentId: "local_store_fern",
        sessionId: "garden",
        loopId: retainedLoop.loopId,
      },
    ] as const;
    for (const target of targets) {
      const paused = await owners.pauseSchedule(
        { invocationRoot: root, target },
        new AbortController().signal,
      );
      expect(paused).toMatchObject({
        kind: target.kind,
        schedule: { state: "paused" },
      });
      const deleted = await owners.deleteSchedule(
        { invocationRoot: root, target },
        new AbortController().signal,
      );
      expect(deleted).toMatchObject({
        kind: target.kind,
        schedule: { state: "cancelled" },
      });
    }
    const retained = await owners.schedules(
      { invocationRoot: root, limit: 64 },
      new AbortController().signal,
    );
    expect(retained.unavailable).toEqual([]);
    expect(retained.items).toMatchObject([
      {
        kind: "almanac",
        schedule: {
          id: "water",
          prompt: "Water the fern",
          state: "cancelled",
        },
      },
      {
        kind: "loop",
        schedule: {
          loopId: retainedLoop.loopId,
          prompt: "Inspect the fern",
          state: "cancelled",
        },
      },
    ]);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds sparse retained owner fan-out and continues into the next owner", async () => {
  const { root, owners, opened } = await fixture();
  try {
    const stores: string[] = [];
    for (let index = 0; index < 9; index++)
      stores.push(
        await retainedStore(root, `local_store_fern${String(index)}`),
      );
    const signal = new AbortController().signal;
    const first = await owners.schedules({ invocationRoot: root }, signal);
    expect(first).toEqual({
      items: [],
      unavailable: [],
      next: { agentId: "local_store_fern8", kind: "almanac" },
    });
    expect(opened).toEqual(stores.slice(0, 8));
    if (first.next === null) throw new Error("Missing owner continuation");
    expect(
      await owners.schedules(
        { invocationRoot: root, after: first.next },
        signal,
      ),
    ).toEqual({ items: [], unavailable: [], next: null });
    expect(opened).toEqual(stores);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a failed owner rather than a successful empty directory", async () => {
  const { root, owners, unavailable } = await fixture();
  try {
    const path = await retainedStore(root, "local_store_fern");
    unavailable.add(path);
    expect(
      await owners.schedules(
        { invocationRoot: root },
        new AbortController().signal,
      ),
    ).toEqual({
      items: [],
      unavailable: [
        { agentId: "local_store_fern", reason: "owner_unavailable" },
      ],
      next: null,
    });
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects ambiguous retained Agent identities before borrowing a runtime", async () => {
  const { root, owners, opened } = await fixture();
  try {
    await retainedStore(root, "local_store_fern");
    const otherRoot = join(root, "other");
    const otherStore = await retainedStore(otherRoot, "local_store_fern");
    await symlink(
      dirname(otherStore),
      join(root, ".fungi", "agents", "local_store_alias"),
      "dir",
    );
    await expect(
      owners.schedules({ invocationRoot: root }, new AbortController().signal),
    ).rejects.toThrow("Local Agent identity is ambiguous");
    expect(opened).toEqual([]);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects invalid owner cursors and limits before borrowing a runtime", async () => {
  const { root, owners, opened } = await fixture();
  try {
    await retainedStore(root, "local_store_fern");
    const signal = new AbortController().signal;
    await expect(
      owners.schedules({ invocationRoot: root, limit: 65 }, signal),
    ).rejects.toThrow();
    await expect(
      owners.schedules(
        {
          invocationRoot: root,
          after: {
            agentId: "local_store_fern",
            kind: "almanac",
            after: "invalid/schedule",
          },
        },
        signal,
      ),
    ).rejects.toThrow();
    expect(opened).toEqual([]);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not turn cancellation during empty retained discovery into a complete empty page", async () => {
  const { root, owners, opened } = await fixture();
  try {
    const abort = new AbortController();
    const request = owners.schedules({ invocationRoot: root }, abort.signal);
    const reason = new Error("Schedule discovery cancelled");
    abort.abort(reason);
    await expect(request).rejects.toBe(reason);
    expect(opened).toEqual([]);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a schedule target outside the bound project before opening its owner", async () => {
  const { root, owners, opened } = await fixture();
  const foreign = await fixture();
  try {
    await retainedStore(foreign.root, "local_store_foreign");
    const request = {
      invocationRoot: root,
      target: {
        kind: "almanac",
        agentId: "local_store_foreign",
        scheduleId: "water",
      },
    } as const;
    const signal = new AbortController().signal;
    await expect(owners.pauseSchedule(request, signal)).rejects.toThrow(
      "Agent is outside this Local project",
    );
    await expect(owners.deleteSchedule(request, signal)).rejects.toThrow(
      "Agent is outside this Local project",
    );
    expect(opened).toEqual([]);
  } finally {
    await owners.close();
    await foreign.owners.close();
    await rm(root, { recursive: true, force: true });
    await rm(foreign.root, { recursive: true, force: true });
  }
});

it("reads and controls archived retained owners without restoring their directory visibility", async () => {
  const { root, owners } = await fixture();
  try {
    const databasePath = await retainedStore(root, "local_store_fern");
    const seed = await openScheduleAgent(databasePath);
    try {
      await bindAgentExtension(seed.agent, almanacContract).call(
        "createOneShot",
        {
          requestId: "water",
          sessionId: "garden",
          prompt: "Water the archived fern",
          dueAt: Date.now() + 86_400_000,
        },
      );
    } finally {
      await seed.close();
    }
    const signal = new AbortController().signal;
    await owners.archive(
      { invocationRoot: root, agentId: "local_store_fern", archived: true },
      signal,
    );
    const page = await owners.schedules({ invocationRoot: root }, signal);
    expect(page.items).toMatchObject([
      {
        agentId: "local_store_fern",
        kind: "almanac",
        schedule: { id: "water", prompt: "Water the archived fern" },
      },
    ]);
    expect(page.unavailable).toEqual([]);
    const request = {
      invocationRoot: root,
      target: {
        kind: "almanac",
        agentId: "local_store_fern",
        scheduleId: "water",
      },
    } as const;
    expect(await owners.pauseSchedule(request, signal)).toMatchObject({
      schedule: { state: "paused" },
    });
    expect(await owners.deleteSchedule(request, signal)).toMatchObject({
      schedule: { state: "cancelled" },
    });
    expect(await listPrivateLocalAgentStores(root, "active")).toEqual([]);
    expect(await listPrivateLocalAgentStores(root, "archived")).toEqual([
      databasePath,
    ]);
  } finally {
    await owners.close();
    await rm(root, { recursive: true, force: true });
  }
});
