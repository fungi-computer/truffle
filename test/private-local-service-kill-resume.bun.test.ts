import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "bun:test";
import { sleep, spawn, type Subprocess } from "bun";

import { openPrivateReadOnlySqliteDatabase } from "../src/private-sqlite-owner.js";
import { privateSqliteFailureCode } from "../src/private-sqlite-failure.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import {
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

const fixture = join(import.meta.dir, "fixtures", "turn-service.ts");

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

it("a turn interrupted by SIGKILL mid-model-call finishes when the service next starts", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-kill-resume-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const root = join(home, "project");
  await mkdir(root);
  const databasePath = join(root, "agent.sqlite");
  new DatabaseSync(databasePath).close();
  const marker = join(home, "model-started");
  const children: Subprocess[] = [];
  const startService = async (mode: "hang" | "answer") => {
    const child = spawn(
      [process.execPath, fixture, directory, databasePath, mode, marker],
      {
        env: { ...process.env, HOME: home },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    children.push(child);
    // A killed service leaves its record behind; wait for this one's.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await readServiceRecord(directory))?.pid === child.pid) return child;
      await sleep(25);
    }
    throw new Error(`The ${mode} service did not start`);
  };
  try {
    const first = await startService("hang");
    const manager = createPrivateLocalServiceManager({ directory });
    const connection = await manager.connect({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    await connection.session.command({
      type: "prompt",
      delivery: "followUp",
      requestId: "before-the-kill",
      text: "Answer after the service is killed",
    });
    await connection.close();
    for (let attempt = 0; attempt < 400 && !(await exists(marker)); attempt++)
      await sleep(25);
    expect(await exists(marker)).toBe(true);

    first.kill("SIGKILL");
    await first.exited;
    expect(first.signalCode).toBe("SIGKILL");

    // The restarted service answers; reading the Session shows the turn ending.
    await startService("answer");
    let snapshot;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const inspection = await manager.inspect({
        invocationRoot: root,
        databasePath,
        sessionId: "main",
      });
      snapshot = inspection.snapshot;
      await inspection.close();
      if (snapshot.terminals.length > 0) break;
      await sleep(25);
    }
    expect(snapshot?.terminals).toMatchObject([{ outcome: "completed" }]);
    expect(snapshot?.messages.map(({ value }) => value.role)).toEqual([
      "user",
      "assistant",
    ]);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

const childCount = 3;

it("every child interrupted by SIGKILL resumes when the service next starts, with no client selecting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-kill-resume-children-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const root = join(home, "project");
  await mkdir(root);
  const databasePaths: string[] = [];
  for (let index = 0; index < childCount; index += 1) {
    const folder = join(root, `child-${String(index)}`);
    await mkdir(folder);
    const path = join(folder, "agent.sqlite");
    new DatabaseSync(path).close();
    databasePaths.push(path);
  }
  const marker = join(home, "model-started");
  const children: Subprocess[] = [];
  const startService = async (mode: "hang" | "answer") => {
    const child = spawn(
      [
        process.execPath,
        fixture,
        directory,
        databasePaths[0] ?? "",
        mode,
        marker,
      ],
      {
        env: { ...process.env, HOME: home },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    children.push(child);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await readServiceRecord(directory))?.pid === child.pid) return child;
      await sleep(25);
    }
    throw new Error(`The ${mode} service did not start`);
  };
  /**
   * Job states by store, read from the stores' own files the way the service's
   * other readers do (its read-only opener and busy timeout). undefined while
   * the running service holds a write lock, so a poll simply tries again.
   */
  const jobStates = (path: string): string[] | undefined => {
    const database = openPrivateReadOnlySqliteDatabase(path);
    try {
      return database
        .prepare("SELECT state FROM watchdog_jobs")
        .all()
        .map((row) => String(row.state));
    } catch (cause) {
      if (privateSqliteFailureCode(cause) === "busy") return undefined;
      throw cause;
    } finally {
      database.close();
    }
  };
  const jobOutcomes = (path: string): string[] => {
    const database = openPrivateReadOnlySqliteDatabase(path, 5_000);
    try {
      return database
        .prepare("SELECT outcome FROM watchdog_jobs")
        .all()
        .map((row) => String(row.outcome));
    } finally {
      database.close();
    }
  };
  /** A recovered turn that hit a failed pass retries after five seconds. */
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 800 && !ready(); attempt += 1)
      await sleep(25);
    return ready();
  };
  try {
    const first = await startService("hang");
    const manager = createPrivateLocalServiceManager({ directory });
    for (const databasePath of databasePaths) {
      const connection = await manager.connect({
        invocationRoot: root,
        databasePath,
        sessionId: "main",
      });
      await connection.session.command({
        type: "prompt",
        delivery: "followUp",
        requestId: `before-the-kill-${basename(dirname(databasePath))}`,
        text: "Answer after the service is killed",
      });
      await connection.close();
    }
    for (const databasePath of databasePaths) {
      for (
        let attempt = 0;
        attempt < 400 && !(await exists(`${databasePath}.model-started`));
        attempt++
      )
        await sleep(25);
      expect(await exists(`${databasePath}.model-started`)).toBe(true);
      // Every child is mid-turn: its job is recorded as running, not settled.
      expect(
        await until(
          () => jobStates(databasePath)?.includes("running") === true,
        ),
      ).toBe(true);
    }

    first.kill("SIGKILL");
    await first.exited;
    expect(first.signalCode).toBe("SIGKILL");

    // Nothing selects a child now. The restarted service reopens each saved
    // store itself, and every turn settles rather than staying "running".
    await startService("answer");
    const settled = () =>
      databasePaths.every((path) => {
        const states = jobStates(path);
        return (
          states !== undefined &&
          states.length > 0 &&
          states.every((state) => state === "settled")
        );
      });
    expect(await until(settled)).toBe(true);
    // Settled by the answer, not by a failure: no child ended as failed.
    expect(databasePaths.map((path) => jobOutcomes(path))).toEqual(
      databasePaths.map(() => ["completed"]),
    );
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
