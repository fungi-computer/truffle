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
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { seatbeltCommand } from "../src/private-local-seatbelt.ts";
import { establishLocalSandbox } from "../src/private-local-containment.ts";
import {
  linuxSandboxProfile,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.ts";

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
const policy = sandboxPolicy(project, folder);
assert.ok(policy.readOnly.includes(join(folder, ".git")));
const admissions = new Map();
for (const mode of ["read-only", "workspace"]) {
  const admission = establishLocalSandbox({
    project,
    folder,
    mode,
    temporaryDirectory,
  });
  assert.equal(
    admission.state,
    "ready",
    `${mode} product admission: ${admission.reason?.message ?? "no sandbox"}`,
  );
  admissions.set(mode, admission.sandbox);
}
process.once("exit", () => {
  for (const sandbox of admissions.values()) sandbox.close();
});
function sandboxCommand(argv, mode = "workspace") {
  const command = admissions.get(mode).command(folder, argv);
  assert.equal(command.executable, "/usr/bin/sandbox-exec");
  return command;
}
function sandboxed(argv, mode = "workspace") {
  const command = sandboxCommand(argv, mode);
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
console.log(
  "PRODUCT ADMISSION AND COMMAND PROOF: not full Agent/Files acceptance.",
);
console.log(bare(["/usr/bin/sw_vers"]).stdout.trim());
const man = bare(["/usr/bin/man", "sandbox-exec"]);
console.log(
  man.stdout
    .split("\n")
    .filter((line) => /deprecat/i.test(line))
    .join("\n"),
);
for (const mode of ["read-only", "workspace"])
  check(`${mode} real startup`, "allowed", () =>
    sandboxed(["/usr/bin/true"], mode),
  );
const unavailable = establishLocalSandbox({
  project,
  folder,
  mode: "workspace",
  temporaryDirectory,
  platform: "unsupported",
});
assert.equal(unavailable.state, "unavailable");
assert.equal(unavailable.reason.kind, "unsupported");
console.log("unsupported mode: refused", unavailable.reason.message);
check("Read-only folder write", "refused", () =>
  sandboxed(["/usr/bin/touch", join(folder, "read-only-denied")], "read-only"),
);
check("Read-only temp write", "allowed", () =>
  sandboxed(
    ["/usr/bin/touch", join(temporaryDirectory, "read-only-ok")],
    "read-only",
  ),
);
// With no XDG_RUNTIME_DIR the host selects this HOME-based Agent temp. Keep
// the proof in our disposable HOME while passing that exact path to admission.
const fallbackTemp = join(process.env.HOME, ".cache", "fungi", "tmp", "agent");
mkdirSync(fallbackTemp, { recursive: true, mode: 0o700 });
for (const mode of ["read-only", "workspace"]) {
  check(`${mode} fallback temp write`, "allowed", () => {
    const admission = establishLocalSandbox({
      project,
      folder,
      mode,
      temporaryDirectory: fallbackTemp,
    });
    assert.equal(
      admission.state,
      "ready",
      admission.reason?.message ?? "fallback temp admission failed",
    );
    try {
      const command = admission.sandbox.command(folder, [
        "/usr/bin/touch",
        join(fallbackTemp, `allowed-${mode}`),
      ]);
      return bare([command.executable, ...command.args]);
    } finally {
      admission.sandbox.close();
    }
  });
}
mkdirSync(join(process.env.HOME, ".config", "fungi"), { recursive: true });
writeFileSync(join(process.env.HOME, ".config", "fungi", "secret"), "hidden");
check("Workspace Fungi credentials read", "refused", () =>
  sandboxed(["/bin/cat", join(process.env.HOME, ".config", "fungi", "secret")]),
);
const hidden = join(process.env.HOME, ".config", "fungi");
for (const unsafeFolder of [
  process.env.HOME,
  join(process.env.HOME, ".config"),
  join(process.env.HOME, ".fungi"),
]) {
  mkdirSync(unsafeFolder, { recursive: true });
  const refused = establishLocalSandbox({
    project: process.env.HOME,
    folder: unsafeFolder,
    mode: "workspace",
    temporaryDirectory,
  });
  assert.equal(refused.state, "unavailable", unsafeFolder);
  assert.equal(refused.reason.kind, "folder", unsafeFolder);
  assert.match(
    refused.reason.message,
    /hidden record or its parent|protected/u,
  );
}
check("hidden directory rename", "refused", () =>
  sandboxed(["/bin/mv", hidden, join(process.env.HOME, ".config", "exposed")]),
);
check("hidden secret unlink", "refused", () =>
  sandboxed(["/bin/rm", join(hidden, "secret")]),
);
assert.equal(readFileSync(join(hidden, "secret"), "utf8"), "hidden");
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
check("Git config hard link", "refused", () =>
  sandboxed([
    "/bin/ln",
    join(folder, ".git", "config"),
    join(folder, "git-hardlink"),
  ]),
);
check("hidden secret hard link", "refused", () =>
  sandboxed([
    "/bin/ln",
    join(hidden, "secret"),
    join(folder, "hidden-hardlink"),
  ]),
);
symlinkSync(join(folder, ".git", "config"), join(folder, "git-symlink"));
check("symlink into .git write", "refused", () =>
  sh("echo planted > git-symlink"),
);
assert.equal(readFileSync(join(folder, ".git", "config"), "utf8"), config);
assert.equal(readFileSync(join(hidden, "secret"), "utf8"), "hidden");
assert.equal(
  readFileSync(join(folder, ".git", "hooks", "original"), "utf8"),
  "unchanged\n",
);
check("git add", "refused", () => sh("git add readme"));
check("git commit", "refused", () =>
  sh(
    "git -c user.name=Proof -c user.email=proof@example.invalid -c commit.gpgsign=false commit --allow-empty -qm proof",
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
    if (transport === "loopback") {
      const readOnly = sandboxCommand(argv, "read-only");
      const denied = await request([readOnly.executable, ...readOnly.args]);
      console.log(
        `Read-only live network: status=${denied.status} received=${received}`,
      );
      assert.notEqual(denied.status, 0, "Read-only must refuse live loopback");
      assert.equal(received, 1, "Read-only must not reach the listener");
    }
    const command = sandboxCommand(argv, "workspace");
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
const wrapped = seatbeltCommand(
  linuxSandboxProfile(policy, "workspace", temporaryDirectory, {
    HOME: process.env.HOME,
  }),
  ["/usr/bin/touch", join(folder, "failure-marker")],
);
wrapped.args[1] = "(invalid-profile";
check("sandbox start failure, no bare retry", "refused", () =>
  bare([wrapped.executable, ...wrapped.args]),
);
assert.equal(existsSync(join(folder, "failure-marker")), false);
assert.equal(existsSync(join(project, "outside")), false);
assert.equal(existsSync(join(folder, "read-only-denied")), false);
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
  `${failures === 0 ? "PASS" : "FAIL"}: Seatbelt product-path matrix (${failures} mismatches); scratch removed on exit, no background children started.`,
);
process.exitCode = failures === 0 ? 0 : 1;
