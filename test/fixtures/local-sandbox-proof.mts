// Explicit kernel qualification. This is not the Local caller/lifecycle gate.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
const outsideProofs = process.argv.includes("--outside-proofs");
const agentSocket = join(runtime, "proof-agent.sock");
for (const path of [folder, home, runtime, join(folder, ".fungi")])
  await mkdir(path, { recursive: true });
await mkdir(join(home, ".config", "fungi"), { recursive: true });
await mkdir(join(home, ".fungi", "service"), { recursive: true });
await writeFile(join(home, ".config", "fungi", "credentials.json"), "secret");
await writeFile(
  join(home, ".fungi", "service", "record.json"),
  "serviceId-secret",
);
await writeFile(join(root, "outside"), "outside sentinel");
await writeFile(join(folder, ".fungi", "state"), "state sentinel");
const db = new DatabaseSync(join(folder, ".fungi", "agent.sqlite"));
db.exec(
  "CREATE TABLE identity(mode TEXT); INSERT INTO identity VALUES ('workspace')",
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
let sshAgent: ReturnType<typeof spawn> | undefined;
let sshd: ReturnType<typeof spawn> | undefined;
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
    const result = establishLocalSandbox({
      project,
      folder,
      mode: "read-only",
      temporaryDirectory: environment.TMPDIR,
    });
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
  assert.equal(command.args.includes("--unshare-all"), !control);
  if (!control) {
    if (outsideProofs) {
      sshAgent = spawn("ssh-agent", ["-D", "-a", agentSocket], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let ready = false;
      for (let index = 0; index < 50; index += 1) {
        try {
          ready = (await stat(agentSocket)).isSocket();
          if (ready) break;
        } catch (cause) {
          // The socket may not exist yet; any other probe failure is fatal.
          if (!(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          ))
            throw cause;
        }
        await new Promise((accept) => setTimeout(accept, 100));
      }
      assert(ready, "Temporary ssh-agent did not open its socket");
      process.env.SSH_AUTH_SOCK = agentSocket;
    }
    const workspace = establishLocalSandbox({
      project,
      folder,
      mode: "workspace",
      temporaryDirectory: environment.TMPDIR,
    });
    assert.equal(workspace.state, "ready", JSON.stringify(workspace));
    const run = async (
      sandboxMode: typeof workspace.sandbox,
      script: string,
    ) => {
      const launch = sandboxMode.command(folder, ["sh", "-c", script]);
      const child = spawn(launch.executable, [...launch.args], {
        cwd: folder,
        env: { ...environment, ...launch.environment },
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      assert(child.stdout && child.stderr);
      child.stdout.on("data", (bytes: Buffer) => stdout.push(bytes));
      child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
      const filter = child.stdio[3];
      assert(filter instanceof Writable);
      assert(launch.seccompFilter, "Linux requires a verified filter");
      filter.end(launch.seccompFilter);
      const status = await new Promise<number | null>((accept, reject) => {
        child.once("error", reject);
        child.once("exit", accept);
      });
      return {
        status,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
    };
    try {
      // A writable cache grant must not let Workspace seed Fungi's native
      // patch receipts when the protected subdirectory does not exist yet.
      for (const cache of [join(home, ".cache"), join(root, "xdg-cache")]) {
        await mkdir(cache, { recursive: true });
        const previous = process.env.XDG_CACHE_HOME;
        if (cache === join(home, ".cache")) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = cache;
        try {
          const fungi = join(cache, "fungi");
          const seeded = join(fungi, "native-patch", "opus");
          await assert.rejects(stat(fungi), { code: "ENOENT" });
          const fresh = establishLocalSandbox({
            project,
            folder,
            mode: "workspace",
            temporaryDirectory: environment.TMPDIR,
          });
          assert.equal(fresh.state, "ready", JSON.stringify(fresh));
          try {
            const attempt = await run(fresh.sandbox, `mkdir -p ${seeded}`);
            assert.notEqual(
              attempt.status,
              0,
              `Workspace seeded an absent host Fungi cache (${cache})`,
            );
            assert.equal((await stat(fungi)).mode & 0o777, 0o700);
            await assert.rejects(stat(seeded), { code: "ENOENT" });
          } finally {
            fresh.sandbox.close();
          }
        } finally {
          if (previous === undefined) delete process.env.XDG_CACHE_HOME;
          else process.env.XDG_CACHE_HOME = previous;
        }
      }
      console.log("PASS: absent default and XDG Fungi caches cannot be seeded");
      assert.equal(
        (await run(workspace.sandbox, "printf persisted > /tmp/persisted"))
          .status,
        0,
      );
      assert.equal(
        (await run(workspace.sandbox, "cat /tmp/persisted")).stdout,
        "persisted",
      );
      assert.notEqual(
        (
          await run(
            workspace.sandbox,
            `cat ${join(home, ".config/fungi/credentials.json")}`,
          )
        ).status,
        0,
      );
      assert.notEqual(
        (
          await run(
            workspace.sandbox,
            `cat ${join(home, ".fungi/service/record.json")}`,
          )
        ).status,
        0,
      );
      await writeFile(join(folder, ".npmrc"), `store-dir=${home}\n`);
      assert.notEqual(
        (await run(workspace.sandbox, `touch ${join(home, "escape")}`)).status,
        0,
      );
      assert.equal(
        (
          await run(
            workspace.sandbox,
            `test -e ${join(home, ".config/fungi/credentials.json")}`,
          )
        ).status,
        1,
      );
      assert.equal(
        (
          await run(
            workspace.sandbox,
            `node -e 'require("node:net").connect({port:${String(address.port)},host:"127.0.0.1"}).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))'`,
          )
        ).status,
        0,
        "Workspace must share host loopback",
      );
      const readOnly = sandbox?.sandbox;
      assert(readOnly);
      assert.notEqual(
        (await run(readOnly, `touch ${join(folder, "forbidden")}`)).status,
        0,
      );
      assert.equal(
        spawnSync("curl", ["--version"]).status,
        0,
        "curl must be installed to prove network refusal",
      );
      assert.notEqual(
        (
          await run(
            readOnly,
            `curl -fsS --max-time 2 http://127.0.0.1:${String(address.port)}`,
          )
        ).status,
        0,
      );
      const unixSocket =
        "python3 -c 'import socket; socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close()'";
      assert.equal((await run(workspace.sandbox, unixSocket)).status, 0);
      const blockedSocket = await run(readOnly, unixSocket);
      assert.notEqual(blockedSocket.status, 0);
      assert.match(blockedSocket.stderr, /Operation not permitted/u);
      // The fallback temp base is below a host cache grant, not the masked
      // runtime directory. An Agent's /tmp bind must not reveal its siblings.
      const fallback = join(home, ".cache", "fungi", "tmp");
      const other = join(fallback, "agent-a");
      const own = join(fallback, "agent-b");
      await mkdir(other, { recursive: true });
      await mkdir(own, { recursive: true });
      await writeFile(join(other, "secret"), "another agent's temp");
      await writeFile(join(own, "own"), "this agent's temp");
      const runtimeOwn = join(root, "runtime-agent-b");
      await mkdir(runtimeOwn);
      for (const mode of ["workspace", "read-only"] as const) {
        for (const temporaryDirectory of [own, runtimeOwn]) {
          const second = establishLocalSandbox({
            project,
            folder,
            mode,
            temporaryDirectory,
          });
          assert.equal(second.state, "ready", JSON.stringify(second));
          try {
            if (temporaryDirectory === own)
              assert.equal(
                (await run(second.sandbox, "cat /tmp/own")).stdout,
                "this agent's temp",
              );
            assert.notEqual(
              (await run(second.sandbox, `cat ${join(other, "secret")}`))
                .status,
              0,
              `${mode} with ${temporaryDirectory} can read another Agent's fallback temp`,
            );
          } finally {
            second.sandbox.close();
          }
        }
      }
      console.log(
        "PASS: both Linux modes hide fallback temp with either own temp location",
      );
      if (outsideProofs) {
        const store = join(home, ".local/share/pnpm/store");
        await mkdir(store, { recursive: true });
        await rm(join(folder, ".npmrc"));
        await writeFile(join(folder, "pnpm-workspace.yaml"), "packages: []\n");
        await writeFile(
          join(folder, "package.json"),
          JSON.stringify({
            name: "kernel-proof",
            version: "1.0.0",
            private: true,
            dependencies: { "is-number": "7.0.0" },
          }),
        );
        // Cache roots are captured from HOST env at command time, not .npmrc.
        process.env.PNPM_HOME = join(home, ".local/share/pnpm");
        const install = await run(
          workspace.sandbox,
          `pnpm install --ignore-scripts --no-frozen-lockfile --store-dir ${store}`,
        );
        assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
        assert.equal(
          (
            await stat(join(folder, "node_modules/is-number/package.json"))
          ).isFile(),
          true,
        );
        console.log(
          "PASS: real registry pnpm install with external host-selected store",
        );

        const key = join(root, "client-key");
        const hostKey = join(root, "host-key");
        const authorized = join(root, "authorized_keys");
        for (const path of [key, hostKey]) {
          const generated = spawnSync("ssh-keygen", [
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            path,
          ]);
          assert.equal(generated.status, 0, generated.stderr.toString());
        }
        await copyFile(`${key}.pub`, authorized);
        const add = spawnSync("ssh-add", [key], {
          env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
          encoding: "utf8",
        });
        assert.equal(add.status, 0, add.stderr);
        const sshPort = createServer();
        await new Promise<void>((accept, reject) => {
          sshPort.once("error", reject);
          sshPort.listen(0, "127.0.0.1", accept);
        });
        const listener = z
          .object({ port: z.number() })
          .parse(sshPort.address());
        await new Promise<void>((accept) =>
          sshPort.close(() => {
            accept();
          }),
        );
        const config = join(root, "sshd_config");
        await writeFile(
          config,
          [
            `Port ${String(listener.port)}`,
            "ListenAddress 127.0.0.1",
            `HostKey ${hostKey}`,
            `AuthorizedKeysFile ${authorized}`,
            `PidFile ${join(root, "sshd.pid")}`,
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "UsePAM no",
            "StrictModes no",
            "AllowUsers levi",
            "LogLevel ERROR",
            "",
          ].join("\n"),
        );
        sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let sshReady = false;
        for (let index = 0; index < 50; index += 1) {
          sshReady = await new Promise<boolean>((accept) => {
            const socket = connect({ host: "127.0.0.1", port: listener.port });
            socket.once("connect", () => {
              socket.destroy();
              accept(true);
            });
            socket.once("error", () => {
              accept(false);
            });
          });
          if (sshReady) break;
          await new Promise((accept) => setTimeout(accept, 100));
        }
        assert(sshReady, "Temporary loopback sshd did not start");
        const bare = join(root, "remote.git");
        const init = spawnSync("git", ["init", "--bare", bare], {
          encoding: "utf8",
        });
        assert.equal(init.status, 0, init.stderr);
        const commit = spawnSync(
          "git",
          [
            "-C",
            folder,
            "-c",
            "user.name=Kernel Proof",
            "-c",
            "user.email=proof@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "proof",
          ],
          { encoding: "utf8", env: environment },
        );
        assert.equal(commit.status, 0, commit.stderr);
        const remote = `ssh://levi@localhost:${String(listener.port)}${bare}`;
        const origin = spawnSync(
          "git",
          ["-C", folder, "remote", "add", "origin", remote],
          { encoding: "utf8", env: environment },
        );
        assert.equal(origin.status, 0, origin.stderr);
        const pushed = await run(
          workspace.sandbox,
          `GIT_SSH_COMMAND='ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null' git push origin HEAD:refs/heads/proof`,
        );
        assert.equal(pushed.status, 0, pushed.stderr);
        const ref = spawnSync(
          "git",
          ["--git-dir", bare, "rev-parse", "refs/heads/proof"],
          { encoding: "utf8" },
        );
        assert.equal(ref.status, 0, ref.stderr);
        console.log(
          "PASS: git push origin HEAD over localhost SSH via private sshd and ssh-agent",
        );
      }
      console.log(
        "PASS: Workspace persistent tmp, hidden Fungi records, HOME refusal, loopback; Read-only folder and curl refused",
      );
    } finally {
      workspace.sandbox.close();
    }
  }
} finally {
  sandbox?.sandbox.close();
  sshd?.kill();
  sshAgent?.kill();
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
