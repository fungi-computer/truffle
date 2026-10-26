import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [folder, outside, home, runtime, port] = process.argv.slice(2);
if (!folder || !outside || !home || !runtime || !port)
  throw new Error(
    "Probe requires folder, outside, fixture HOME, runtime and TCP port.",
  );

for (const path of [
  outside,
  join(home, "escape"),
  join(folder, ".fungi", "state"),
  join(folder, ".git", "config"),
  join(folder, ".git", "hooks", "pre-commit"),
]) {
  assert.throws(
    () => {
      writeFileSync(path, "escape");
    },
    { code: "EROFS" },
  );
}
assert.throws(
  () => {
    renameSync(join(folder, ".git"), join(folder, ".git2"));
  },
  {
    code: "EROFS",
  },
);
const database = new DatabaseSync(join(folder, ".fungi", "agent.sqlite"));
assert.throws(() => {
  database.exec("UPDATE identity SET mode = 'full-access'");
});
assert.equal(
  database.prepare("SELECT mode FROM identity").get()?.mode,
  "workspace",
);
database.close();
assert.equal(process.env.XDG_RUNTIME_DIR, undefined);
assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
assert.deepEqual(readdirSync("/run"), []);
assert.deepEqual(readdirSync(runtime), []);

async function refusesSocket(
  options: { port: number; host: string } | { path: string },
) {
  await new Promise<void>((accept, reject) => {
    const socket = connect(options);
    socket.setTimeout(1_000, () =>
      socket.destroy(new Error("Probe connection timed out")),
    );
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Sandbox reached the controlled host socket"));
    });
    socket.once("error", () => {
      accept();
    });
  });
}
await refusesSocket({ port: Number(port), host: "127.0.0.1" });
await refusesSocket({ path: join(runtime, "host.sock") });
if (process.argv.includes("--pathname-socket"))
  await refusesSocket({ path: "../host.sock" });

const config = readFileSync(join(folder, ".git", "config"), "utf8");
for (const argv of [
  ["config", "--local", "core.hooksPath", "/tmp/planted-hooks"],
  ["config", "--local", "alias.escape", "!touch /tmp/planted-alias"],
]) {
  const result: SpawnSyncReturns<string> = spawnSync("git", argv, {
    cwd: folder,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stderr);
}
assert.equal(readFileSync(join(folder, ".git", "config"), "utf8"), config);
assert.throws(
  () => {
    writeFileSync(join(folder, "allowed"), "folder write\n");
  },
  { code: "EROFS" },
);
for (const argv of [
  ["add", "allowed"],
  [
    "-c",
    "user.name=Sandbox fixture",
    "-c",
    "user.email=sandbox@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "folder fixture",
  ],
]) {
  const result: SpawnSyncReturns<string> = spawnSync("git", argv, {
    cwd: folder,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /read-only file system|permission denied|operation not permitted/iu,
  );
}
console.log(
  "PASS: real Linux folder/state/Git/home/network/runtime focused probes; not hostile-program isolation or joined Local lifecycle qualification",
);
