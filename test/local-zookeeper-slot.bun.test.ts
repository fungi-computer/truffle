import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { localExtensions } from "../src/local-extensions.js";

const fixture = join(import.meta.dir, "fixtures", "extension-compactor");
const probe = join(import.meta.dir, "fixtures", "zookeeper-slot-probe.ts");
const probed = z.strictObject({
  roster: z.array(z.string()),
  handoffHolders: z.array(z.string()),
  opened: z.literal(true),
});
let scratch: string;
let home: string;
let project: string;
let store: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.email=fixture@fungi.test", "-c", "user.name=Fixture", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fungi-zk-slot-")));
  home = join(scratch, "home");
  project = join(scratch, "project");
  store = join(project, ".fungi", "agents", "local_store_slot");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(store, { recursive: true }),
  ]);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("an installed extension holding compaction_handoff keeps it on the real Local path; Zookeeper is skipped, logged, and the Agent opens", async () => {
  const work = join(scratch, "source");
  const bare = join(scratch, "compactor.git");
  await cp(fixture, work, { recursive: true });
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "compactor 1.0.0");
  git(work, "push", "-q", bare, "HEAD:main");
  const owner = localExtensions({ home });
  await owner.add(`git+file://${bare}#main`, project);
  await owner.enableAgent(store, "installed-compactor");

  const child = Bun.spawn([process.execPath, probe, project, store], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const result = probed.parse(
    JSON.parse(stdout.trim().split("\n").at(-1) ?? ""),
  );
  expect(result.roster).toContain("installed-compactor");
  expect(result.roster).not.toContain("zookeeper-compaction");
  expect(result.handoffHolders).toEqual(["installed-compactor"]);
  expect(stderr).toContain("local-zookeeper-skipped");
});
