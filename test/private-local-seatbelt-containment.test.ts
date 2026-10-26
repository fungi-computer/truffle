import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { establishLocalSandbox } from "../src/private-local-containment.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("passes Read-only through the darwin admission path, never Workspace roots", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungi-mac-mode-")));
  roots.push(root);
  const project = join(root, "project");
  const folder = join(project, "agent");
  const temporaryDirectory = join(root, "temp");
  const home = join(root, "home");
  for (const path of [folder, temporaryDirectory, home])
    mkdirSync(path, { recursive: true });
  vi.stubEnv("HOME", home);
  const admission = establishLocalSandbox(
    {
      project,
      folder,
      mode: "read-only",
      temporaryDirectory,
      platform: "darwin",
    },
    undefined,
    // Linux cannot run sandbox-exec. Exercise the real product construction
    // and a real process success, not macOS kernel enforcement.
    () => spawnSync("/usr/bin/true", [], { encoding: "utf8" }),
  );
  expect(admission.state).toBe("ready");
  if (admission.state !== "ready") return;
  try {
    const command = admission.sandbox.command(folder, ["/usr/bin/true"]);
    expect(
      command.args.filter((arg) => /^WRITABLE_ROOT_\d+=/u.test(arg)),
    ).toEqual([`WRITABLE_ROOT_0=${temporaryDirectory}`]);
    expect(command.args.filter((arg) => /^HIDDEN_\d+=/u.test(arg))).toEqual([
      `HIDDEN_0=${join(home, ".config", "fungi")}`,
      `HIDDEN_1=${join(home, ".fungi", "service")}`,
    ]);
  } finally {
    admission.sandbox.close();
  }
});

it("refuses macOS Workspace folders that can rename hidden HOME records", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungi-mac-home-")));
  roots.push(root);
  const home = join(root, "home");
  const temporaryDirectory = join(root, "temp");
  const config = join(home, ".config");
  for (const path of [join(config, "fungi"), temporaryDirectory])
    mkdirSync(path, { recursive: true });
  vi.stubEnv("HOME", home);
  for (const folder of [home, config]) {
    const admission = establishLocalSandbox({
      project: home,
      folder,
      mode: "workspace",
      temporaryDirectory,
      platform: "darwin",
    });
    expect(admission.state).toBe("unavailable");
    if (admission.state === "unavailable") {
      expect(admission.reason.kind).toBe("folder");
      expect(admission.reason.message).toMatch(/hidden record or its parent/u);
    }
  }
});
