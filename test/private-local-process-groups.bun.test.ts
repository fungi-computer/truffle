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

async function startOwner(command?: string) {
  const area = await mkdtemp(join(tmpdir(), "fungi-groups-"));
  const root = join(area, "project");
  const home = join(area, "home");
  await mkdir(root);
  await mkdir(home);
  const child = spawn(
    [
      process.execPath,
      fixture,
      root,
      home,
      ...(command === undefined ? [] : [command]),
    ],
    {
      // The pipe is the fixture's lifeline: it exits when its parent drops it.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
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
  return {
    area,
    home,
    child,
    groupId: record.groupId,
    name: groups[0] ?? "",
  };
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
      owner.child.kill("SIGKILL");
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
      owner.child.kill("SIGKILL");
      if (alive(owner.groupId)) process.kill(-owner.groupId, "SIGKILL");
      await rm(owner.area, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "the fixture and its command group are gone shortly after its parent is SIGKILLed",
  async () => {
    const area = await mkdtemp(join(tmpdir(), "fungi-groups-"));
    const root = join(area, "project");
    const home = join(area, "home");
    await mkdir(root);
    await mkdir(home);
    // A throwaway parent that owns the fixture through its stdin pipe.
    const parent = spawn(
      [
        process.execPath,
        "-e",
        `const c = Bun.spawn([process.execPath, ${JSON.stringify(fixture)}, ${JSON.stringify(root)}, ${JSON.stringify(home)}], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
console.log(JSON.stringify({ pid: c.pid }));
await new Promise(() => undefined);`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    let fixturePid: number | undefined;
    let groupId: number | undefined;
    try {
      // Line one is the fixture's pid; line two is the fixture reporting that
      // it started its command, by which time the group record is written.
      const reader = parent.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (seen.split("\n").length < 3) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        seen += decoder.decode(chunk.value);
      }
      const { pid } = z
        .looseObject({ pid: z.number().int() })
        .parse(JSON.parse(seen.split("\n")[0] ?? ""));
      fixturePid = pid;
      const groupsDir = join(home, ".fungi", "process-groups");
      const names = await readdir(groupsDir);
      expect(names).toHaveLength(1);
      groupId = recordSchema.parse(
        JSON.parse(await Bun.file(join(groupsDir, names[0] ?? "")).text()),
      ).groupId;
      expect(groupId).toBeDefined();
      expect(alive(pid)).toBe(true);
      parent.kill("SIGKILL");
      await parent.exited;
      for (let i = 0; i < 250 && (alive(pid) || alive(groupId)); i++)
        await Bun.sleep(20);
      expect(alive(pid)).toBe(false);
      expect(alive(groupId)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      if (fixturePid !== undefined && alive(fixturePid))
        process.kill(fixturePid, "SIGKILL");
      if (groupId !== undefined && alive(groupId))
        process.kill(-groupId, "SIGKILL");
      await rm(area, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "the sweep also ends a command's processes that moved to another process group",
  async () => {
    // timeout(1) calls setpgid, so its child leaves the recorded group.
    const area = await mkdtemp(join(tmpdir(), "fungi-groups-pid-"));
    const pidFile = join(area, "moved.pid");
    const owner = await startOwner(
      `timeout 600 sh -c 'echo $$ > ${pidFile}; exec sleep 600'; true`,
    );
    let moved = 0;
    try {
      for (let i = 0; i < 100 && moved === 0; i++) {
        const file = Bun.file(pidFile);
        if (await file.exists()) moved = Number(await file.text());
        if (moved === 0) await Bun.sleep(50);
      }
      expect(moved).toBeGreaterThan(1);
      owner.child.kill("SIGKILL");
      await owner.child.exited;
      expect(alive(moved)).toBe(true);
      expect(await reapOrphanedProcessGroups(owner.home)).toBe(1);
      for (let attempt = 0; attempt < 100 && alive(moved); attempt++)
        await Bun.sleep(20);
      expect(alive(moved)).toBe(false);
    } finally {
      owner.child.kill("SIGKILL");
      if (moved > 1 && alive(moved)) process.kill(moved, "SIGKILL");
      if (alive(owner.groupId)) process.kill(-owner.groupId, "SIGKILL");
      await rm(owner.area, { recursive: true, force: true });
      await rm(area, { recursive: true, force: true });
    }
  },
  20_000,
);
