// Light adapter proof, deliberately independent of the full runtime build.
// Local caller and Agent lifecycle acceptance need the joined gate.
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  seatbeltCommand,
  seatbeltReadiness,
} from "../src/private-local-seatbelt.ts";

if (process.platform !== "darwin") {
  console.log(
    "UNAVAILABLE: real Seatbelt proof requires macOS; Linux is not evidence.",
  );
  process.exit(77);
}
const scratch = realpathSync(process.argv[2]);
assert.equal(process.env.HOME, join(scratch, "home"));
const project = join(scratch, "project");
const folder = join(project, "agent");
const temporaryDirectory = join(scratch, "temp");
for (const path of [project, folder, temporaryDirectory, process.env.HOME])
  mkdirSync(path, { recursive: true });
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: process.env.HOME,
  TMPDIR: temporaryDirectory,
};
function bare(argv, cwd = folder) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}
// Keep this asynchronous for listener positive controls: the harness must serve
// the request while its one curl child runs. No detached/background jobs.
function request(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: folder, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
assert.equal(bare(["/usr/bin/git", "init", "-q"]).status, 0);
writeFileSync(join(folder, "readme"), "project read\n");
writeFileSync(join(folder, ".git", "hooks", "original"), "unchanged\n");
const config = readFileSync(join(folder, ".git", "config"), "utf8");
const policy = {
  writableRoot: folder,
  temporaryDirectory,
  readOnly: [
    join(folder, ".fungi"),
    join(folder, ".git", "hooks"),
    join(folder, ".git", "config"),
  ],
  immovable: [join(folder, ".git")],
};
function sandboxed(argv, override = policy) {
  const command = seatbeltCommand(override, argv);
  return bare([command.executable, ...command.args]);
}
let failures = 0;
function check(name, expected, run) {
  const result = run();
  const actual = result.status === 0 ? "allowed" : "refused";
  console.log(
    `${name}: expected=${expected} actual=${actual} status=${result.status} ${result.error?.message ?? result.stderr.trim()}`,
  );
  if (actual !== expected) failures += 1;
  return result;
}
const sh = (command) => sandboxed(["/bin/sh", "-c", command]);
console.log("ADAPTER PROOF ONLY: not joined Agent/spawn-path acceptance.");
console.log(bare(["/usr/bin/sw_vers"]).stdout.trim());
const man = bare(["/usr/bin/man", "sandbox-exec"]);
console.log(
  man.stdout
    .split("\n")
    .filter((line) => /deprecat/i.test(line))
    .join("\n"),
);
console.log("readiness:", JSON.stringify(seatbeltReadiness(policy)));
assert.equal(seatbeltReadiness(policy).ready, true);
check("inside direct argv", "allowed", () =>
  sandboxed(["/usr/bin/touch", join(folder, "ok")]),
);
check("project read", "allowed", () => sh("cat readme"));
check("private TMPDIR write", "allowed", () => sh('touch "$TMPDIR/ok"'));
check("project outside", "refused", () =>
  sandboxed(["/usr/bin/touch", join(project, "outside")]),
);
check("throwaway HOME outside", "refused", () => sh('touch "$HOME/x"'));
// Never place proof artefacts directly in /tmp, even on an accidental bypass.
check("system temp outside", "refused", () =>
  sandboxed([
    "/usr/bin/touch",
    `/private/tmp/${scratch.split("/").at(-1)}-refused`,
  ]),
);
check("create .fungi", "refused", () => sh("mkdir .fungi"));
mkdirSync(join(folder, ".fungi"));
check(".fungi write", "refused", () => sh("touch .fungi/x"));
check("hook write", "refused", () => sh("echo x > .git/hooks/pre-commit"));
check("hook directory create", "refused", () => sh("mkdir .git/hooks/x"));
check("config hooksPath", "refused", () =>
  sh("git config --local core.hooksPath /nonexistent/hooks"),
);
check("config alias", "refused", () =>
  sh("git config --local alias.x '!echo planted'"),
);
check("Git directory rename", "refused", () => sh("mv .git .git2"));
check("hooks remove", "refused", () => sh("rm -rf .git/hooks"));
assert.equal(readFileSync(join(folder, ".git", "config"), "utf8"), config);
assert.equal(
  readFileSync(join(folder, ".git", "hooks", "original"), "utf8"),
  "unchanged\n",
);
check("git add/commit", "allowed", () =>
  sh(
    "git add readme && git -c user.name=Proof -c user.email=proof@example.invalid -c commit.gpgsign=false commit -qm proof",
  ),
);
check("public network", "refused", () =>
  sh("curl --max-time 3 https://example.com"),
);
// "get name" can return the application specifier's name locally, without an
// event. Counting its windows instead requires resolving the remote object.
const appleEvents = check("AppleEvents remote operation", "refused", () =>
  sh(`osascript -e 'tell application "Finder" to count windows'`),
);
assert.equal(appleEvents.status, 1);
assert.equal(appleEvents.stdout, "");
assert.match(appleEvents.stderr, /execution error:/);
assert.doesNotMatch(appleEvents.stderr, /syntax error:/);

for (const transport of ["loopback", "unix"]) {
  let received = 0;
  const server = createServer((_incoming, response) => {
    received += 1;
    response.end("proof-control");
  });
  const socketPath = join(scratch, "proof.sock");
  if (transport === "loopback") server.listen(0, "127.0.0.1");
  else server.listen(socketPath);
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address !== null);
    const url =
      transport === "loopback"
        ? `http://127.0.0.1:${address.port}/`
        : "http://localhost/";
    const argv = [
      "/usr/bin/curl",
      "--silent",
      "--show-error",
      "--max-time",
      "3",
      ...(transport === "unix" ? ["--unix-socket", socketPath] : []),
      url,
    ];
    const control = await request(argv);
    assert.equal(control.status, 0, control.stderr);
    assert.equal(control.stdout, "proof-control");
    assert.equal(received, 1);
    const command = seatbeltCommand(policy, argv);
    const refused = await request([command.executable, ...command.args]);
    console.log(
      `${transport} live listener: expected=refused actual=${refused.status === 7 ? "refused" : "FAIL"} status=${refused.status} control=0 received=${received} ${refused.stderr.trim()}`,
    );
    assert.equal(refused.status, 7, refused.stderr);
    assert.equal(refused.stdout, "");
    assert.equal(received, 1, "sandboxed curl must not reach the listener");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// Launch only our own tiny app, never the person's TextEdit. A real bare open
// must launch it and produce a marker; sandboxed open must not do either.
const app = join(scratch, "LaunchProbe.app");
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
writeFileSync(
  join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>computer.fungi.seatbelt-proof</string>
<key>CFBundleName</key><string>LaunchProbe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
);
writeFileSync(
  join(app, "Contents", "MacOS", "probe"),
  '#!/bin/sh\ncd "$(dirname "$0")/../../.." || exit 1\n/usr/bin/touch launch-marker\n',
  { mode: 0o700 },
);
const openArgv = ["/usr/bin/open", "-n", "-W", "-a", app];
check("owned app launch control", "allowed", () => bare(openArgv));
const launchMarker = join(scratch, "launch-marker");
assert.equal(
  existsSync(launchMarker),
  true,
  "control must really launch the owned app",
);
unlinkSync(launchMarker);
const launched = check("app launch", "refused", () => sandboxed(openArgv));
assert.ok(launched.status !== null && launched.status !== 0);
assert.equal(
  existsSync(launchMarker),
  false,
  "sandbox must not launch the app",
);
const wrapped = seatbeltCommand(policy, [
  "/usr/bin/touch",
  join(folder, "failure-marker"),
]);
wrapped.args[1] = "(invalid-profile";
check("sandbox start failure, no bare retry", "refused", () =>
  bare([wrapped.executable, ...wrapped.args]),
);
assert.equal(existsSync(join(folder, "failure-marker")), false);
assert.equal(existsSync(join(project, "outside")), false);
assert.equal(existsSync(join(folder, ".fungi", "x")), false);
assert.equal(existsSync(join(process.env.HOME, "x")), false);
assert.equal(
  existsSync(`/private/tmp/${scratch.split("/").at(-1)}-refused`),
  false,
);
check("bare outside-folder positive control", "allowed", () =>
  bare(["/usr/bin/touch", join(project, "outside")]),
);
console.log(
  `${failures === 0 ? "PASS" : "FAIL"}: light Seatbelt adapter matrix (${failures} mismatches); scratch retained, no background children started.`,
);
process.exitCode = failures === 0 ? 0 : 1;
