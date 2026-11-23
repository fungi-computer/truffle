import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  bindAgentExtension,
  bindSessionExtension,
} from "@fungi.computer/shiitake/client";
import { almanacContract } from "@fungi.computer/shiitake-extensions/almanac";
import { loopContract } from "@fungi.computer/shiitake-extensions/loop";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import { initFreshStore } from "./fixtures/fresh-store.js";
import {
  openScheduleAgent,
  openScheduleRuntime,
} from "./fixtures/schedule-owner.js";

const day = 86_400_000;

async function seed(root: string, id: string, createdBy: string | null) {
  const databasePath = join(root, ".fungi", "agents", id, "agent.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  initFreshStore(database, id, id, createdBy);
  database.close();
  const agent = await openScheduleAgent(databasePath);
  try {
    await bindAgentExtension(agent.agent, almanacContract).call(
      "createOneShot",
      {
        requestId: `${id}-water`,
        sessionId: "main",
        prompt: `Water for ${id}`,
        dueAt: Date.now() + day,
      },
    );
    await bindSessionExtension(agent.agent.session("main"), loopContract).call(
      "startFixedInterval",
      {
        requestId: `${id}-inspect`,
        prompt: `Inspect for ${id}`,
        expression: "0 * * * *",
        timeZone: "UTC",
      },
    );
  } finally {
    await agent.close();
  }
}

it("Stop all pauses, never deletes, the stopped subtree's schedules and leaves other Agents' alone", async () => {
  await mkdir(".botanical", { recursive: true });
  const root = await realpath(
    await mkdtemp(join(process.cwd(), ".botanical/stop-schedules-")),
  );
  for (const [id, createdBy] of [
    ["parent", null],
    ["child", "parent"],
    ["leaf", "child"],
    ["unrelated", null],
  ] as const)
    await seed(root, id, createdBy);
  const owners = createLocalServiceOwners(openScheduleRuntime);
  try {
    const first = await owners.stopAll({
      invocationRoot: root,
      agentId: "parent",
    });
    // Each of the three Agents owned one Almanac schedule and one Loop.
    expect(
      first.schedules.filter(({ outcome }) => outcome === "paused"),
    ).toHaveLength(6);
    expect(
      first.schedules.filter(({ outcome }) => outcome === "failed"),
    ).toEqual([]);
    const page = await owners.schedules(
      { invocationRoot: root, limit: 64 },
      new AbortController().signal,
    );
    const states = Object.fromEntries(
      page.items.map((row) => [
        `${row.agentId}:${row.kind}`,
        row.schedule.state,
      ]),
    );
    expect(states).toEqual({
      "child:almanac": "paused",
      "child:loop": "paused",
      "leaf:almanac": "paused",
      "leaf:loop": "paused",
      "parent:almanac": "paused",
      "parent:loop": "paused",
      "unrelated:almanac": "active",
      "unrelated:loop": "active",
    });
    // A second stop has nothing active left to pause and deletes nothing.
    const second = await owners.stopAll({
      invocationRoot: root,
      agentId: "parent",
    });
    expect(second.schedules).toEqual([]);
  } finally {
    await owners.close();
  }
}, 30_000);
