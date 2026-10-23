// Explicit kernel qualification. This is not the Local caller/lifecycle gate.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { z } from "zod";
import {
  establishLocalSandbox,
  type SandboxCommand,
} from "../../src/private-local-containment.js";

assert.equal(
  process.platform,
  "linux",
  "Real bwrap proof needs Linux, not a simulated platform.",
);
const scratch = fileURLToPath(
  new URL("../../../../.botanical/tmp/", import.meta.url),
);
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "containment-"));
console.log(`Owned kernel-proof fixture: ${root}`);
// Keep host sentinels visible outside private /tmp so the exact same refusal
// assertions test both project locations, rather than accepting ENOENT instead.
const temporaryProject = process.argv.includes("--tmp-project")
  ? await mkdtemp(join(tmpdir(), "fungi-project-"))
  : undefined;
const project = temporaryProject ?? join(root, "project");
const folder = join(project, "agent");
const home = join(root, "home");
// sockaddr_un has a real 108-byte path bound. A worktree-rooted socket would
// fail before containment on long checkout paths; keep only this socket short.
const runtime = await mkdtemp(join(tmpdir(), "fungi-uds-"));
for (const path of [folder, home, runtime, join(folder, ".fungi")])
  await mkdir(path, { recursive: true });
await writeFile(join(root, "outside"), "outside sentinel");
await writeFile(join(folder, ".fungi", "state"), "state sentinel");
const db = new DatabaseSync(join(folder, ".fungi", "agent.sqlite"));
db.exec(
  "CREATE TABLE identity(require_sandbox INTEGER); INSERT INTO identity VALUES (1)",
);
db.close();
const environment = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  TMPDIR: join(root, "tmp"),
};
// The wrapper's known-path masks must inspect only this fixture's environment.
process.env.HOME = home;
delete process.env.SSH_AUTH_SOCK;
delete process.env.DBUS_SESSION_BUS_ADDRESS;
await mkdir(environment.TMPDIR);
const git = spawnSync("git", ["init", folder], {
  env: environment,
  encoding: "utf8",
});
assert.equal(git.status, 0, git.stderr);
const configPath = join(folder, ".git", "config");
const hookPath = join(folder, ".git", "hooks", "pre-commit");
await writeFile(hookPath, "#!/bin/sh\nexit 0\n");
const config = await readFile(configPath, "utf8");
const tcp = createServer((socket) => socket.end());
const unix = createServer((socket) => socket.end());
const pathname = createServer((socket) => socket.end());
let sandbox:
  | Extract<ReturnType<typeof establishLocalSandbox>, { state: "ready" }>
  | undefined;
try {
  await new Promise<void>((accept, reject) => {
    tcp.once("error", reject);
    tcp.listen(0, "127.0.0.1", accept);
  });
  await new Promise<void>((accept, reject) => {
    unix.once("error", reject);
    unix.listen(join(runtime, "host.sock"), accept);
  });
  if (process.argv.includes("--pathname-socket")) {
    // Use a relative sockaddr_un path to respect its 108-byte bound without
    // hiding a host socket merely because the checkout's absolute path is long.
    const previous = process.cwd();
    process.chdir(project);
    try {
      await new Promise<void>((accept, reject) => {
        pathname.once("error", reject);
        pathname.listen("host.sock", accept);
      });
    } finally {
      process.chdir(previous);
    }
  }
  const address = z.object({ port: z.number() }).parse(tcp.address());
  // Positive controls are our own listeners, never a service or live credential.
  for (const endpoint of [
    { port: address.port, host: "127.0.0.1" },
    { path: join(runtime, "host.sock") },
  ]) {
    await new Promise<void>((accept, reject) => {
      const socket = connect(endpoint, () => {
        socket.destroy();
        accept();
      });
      socket.once("error", reject);
    });
  }
  const argv: [string, ...string[]] = [
    process.execPath,
    "--experimental-strip-types",
    fileURLToPath(new URL("./local-sandbox-probe.mts", import.meta.url)),
    folder,
    join(root, "outside"),
    home,
    runtime,
    String(address.port),
    ...(process.argv.includes("--pathname-socket")
      ? ["--pathname-socket"]
      : []),
  ];
  // Run the exact assertions bare first to falsify the proof, in a separate
  // disposable fixture. A bypass must fail, not turn a missing backend green.
  const control = process.argv.includes("--uncontained-control");
  let command: Pick<SandboxCommand, "executable" | "args" | "seccompFilter"> = {
    executable: argv[0],
    args: argv.slice(1),
  };
  if (!control) {
    process.env.XDG_RUNTIME_DIR = runtime;
    const result = establishLocalSandbox({ project, folder });
    assert.equal(result.state, "ready", JSON.stringify(result));
    sandbox = result;
    command = result.sandbox.command(folder, argv);
  }
  const childEnvironment = { ...environment };
  if (!control) childEnvironment.TMPDIR = "/tmp";
  const child = spawn(command.executable, [...command.args], {
    cwd: folder,
    env: childEnvironment,
    stdio:
      command.seccompFilter === undefined
        ? ["ignore", "inherit", "inherit"]
        : ["ignore", "inherit", "inherit", "pipe"],
  });
  const code = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
    if (command.seccompFilter !== undefined) {
      const filter = child.stdio[3];
      assert(
        filter instanceof Writable,
        "The verified filter must have an explicit child fd3.",
      );
      filter.once("error", reject);
      filter.end(command.seccompFilter);
    }
  });
  assert.equal(
    code,
    0,
    "Kernel escape probe failed (the bare positive control MUST fail here).",
  );
  assert.equal(
    await readFile(join(root, "outside"), "utf8"),
    "outside sentinel",
  );
  assert.equal(
    await readFile(join(folder, ".fungi", "state"), "utf8"),
    "state sentinel",
  );
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.equal(await readFile(hookPath, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(
    await readFile(join(folder, "allowed"), "utf8"),
    "folder write\n",
  );
} finally {
  sandbox?.sandbox.close();
  for (const server of [tcp, unix, pathname]) {
    if (server.listening)
      await new Promise<void>((accept, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else accept();
        });
      });
  }
  await rm(runtime, { recursive: true });
  if (temporaryProject !== undefined)
    await rm(temporaryProject, { recursive: true });
}
