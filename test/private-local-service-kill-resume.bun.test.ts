import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "bun:test";
import { sleep, spawn, type Subprocess } from "bun";

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
