import { expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { reapOrphanedProcessGroups } from "../src/private-local-process-groups.js";
import { readProcessStart } from "../src/private-local-process-identity.js";

const recordSchema = z.looseObject({ groupId: z.number().int() });

const fixture = new URL("./fixtures/process-group-owner.ts", import.meta.url)
  .pathname;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startOwner() {
  const area = await mkdtemp(join(tmpdir(), "fungi-groups-"));
  const root = join(area, "project");
  const home = join(area, "home");
  await mkdir(root);
  await mkdir(home);
  const child = spawn([process.execPath, fixture, root, home], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  // The command is the child's only process group; find it by its name.
  const groups = await readdir(join(home, ".fungi", "process-groups"));
  expect(groups).toHaveLength(1);
  const record = recordSchema.parse(
    JSON.parse(
      await Bun.file(
        join(home, ".fungi", "process-groups", groups[0] ?? ""),
      ).text(),
    ),
  );
  return { area, home, child, groupId: record.groupId, name: groups[0] ?? "" };
}

test.skipIf(process.platform !== "linux")(
  "a SIGKILLed service's command group is ended by the next sweep, and a live service's is not",
  async () => {
    const owner = await startOwner();
    try {
      expect(alive(owner.groupId)).toBe(true);
      // The owner is alive: nothing may be touched.
      expect(await reapOrphanedProcessGroups(owner.home)).toBe(0);
      expect(alive(owner.groupId)).toBe(true);
      owner.child.kill("SIGKILL");
      await owner.child.exited;
      // SIGKILL ran no cleanup: the detached command is still running.
      expect(alive(owner.groupId)).toBe(true);
      expect(await reapOrphanedProcessGroups(owner.home)).toBe(1);
      for (let attempt = 0; attempt < 100 && alive(owner.groupId); attempt++)
        await Bun.sleep(20);
      expect(alive(owner.groupId)).toBe(false);
      expect(
        await readdir(join(owner.home, ".fungi", "process-groups")),
      ).toEqual([]);
    } finally {
      if (alive(owner.groupId)) process.kill(-owner.groupId, "SIGKILL");
      await rm(owner.area, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "a recorded group whose leader PID was reused is left running",
  async () => {
    const owner = await startOwner();
    const path = join(owner.home, ".fungi", "process-groups", owner.name);
    try {
      const record = recordSchema.parse(
        JSON.parse(await Bun.file(path).text()),
      );
      const leader = await readProcessStart(owner.groupId);
      expect(leader.kind).toBe("running");
      await Bun.write(
        path,
        JSON.stringify({ ...record, leaderStart: "linux:1" }),
      );
      owner.child.kill("SIGKILL");
      await owner.child.exited;
      expect(await reapOrphanedProcessGroups(owner.home)).toBe(0);
      expect(alive(owner.groupId)).toBe(true);
    } finally {
      if (alive(owner.groupId)) process.kill(-owner.groupId, "SIGKILL");
      await rm(owner.area, { recursive: true, force: true });
    }
  },
  20_000,
);
