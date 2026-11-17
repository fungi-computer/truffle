import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { scaledBudgetMs } from "../../../tooling/repository/scripts/proof-budget.mjs";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function printedPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch (cause) {
      // Not written yet; anything else is a real failure.
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ))
        throw cause;
    }
    await delay(50);
  }
  throw new Error(`No pid was written to ${path}`);
}

it("Stop ends a command that moved itself into another process group, and what it started", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-setpgid-")),
  );
  const processes = createPrivateLocalComputerProcesses(root);
  const survivors: number[] = [];
  cleanups.push(async () => {
    for (const pid of survivors) if (alive(pid)) process.kill(pid, "SIGKILL");
    await processes.close();
    await rm(root, { recursive: true, force: true });
  });
  const outer = join(root, "outer.pid");
  const inner = join(root, "inner.pid");
  // timeout(1) calls setpgid, so each level leaves the group Stop signals.
  const command = `timeout 300 sh -c 'echo $$ > ${outer}; timeout 300 sh -c "echo \\$\\$ > ${inner}; exec sleep 300"'`;
  const scope = processes.scope("setpgid");
  const started = await scope.start(
    { kind: "shell", command },
    root,
    "/usr/bin:/bin",
  );
  const outerPid = await printedPid(outer);
  const innerPid = await printedPid(inner);
  survivors.push(outerPid, innerPid);
  expect(alive(outerPid)).toBe(true);
  expect(alive(innerPid)).toBe(true);

  await scope.kill(started.id);

  await expect
    .poll(() => [alive(outerPid), alive(innerPid)], {
      message: "every process the command started is gone after Stop",
      timeout: scaledBudgetMs(3_000),
      interval: 100,
    })
    .toEqual([false, false]);
}, 15_000);

it("Stop ends a server a command started through timeout", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-setpgid-server-")),
  );
  const processes = createPrivateLocalComputerProcesses(root);
  const survivors: number[] = [];
  cleanups.push(async () => {
    for (const pid of survivors) if (alive(pid)) process.kill(pid, "SIGKILL");
    await processes.close();
    await rm(root, { recursive: true, force: true });
  });
  const pidFile = join(root, "server.pid");
  const scope = processes.scope("setpgid-server");
  const started = await scope.start(
    {
      kind: "shell",
      command: `timeout 300 python3 -c 'import os,http.server; open("${pidFile}","w").write(str(os.getpid())); http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=0, bind="127.0.0.1")'`,
    },
    root,
    "/usr/bin:/bin",
  );
  const serverPid = await printedPid(pidFile);
  survivors.push(serverPid);
  expect(alive(serverPid)).toBe(true);

  await scope.kill(started.id);

  await expect
    .poll(() => alive(serverPid), {
      message: "the server is gone after Stop",
      timeout: scaledBudgetMs(3_000),
      interval: 100,
    })
    .toBe(false);
}, 15_000);
