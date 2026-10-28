import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createLocalShippingSources,
  execShipping,
  gitSource,
  npmSource,
  type ShippingExec,
} from "../src/local-board-shipping.js";

const hour = 3_600_000;
/** A fixed "local midnight" for the reads; commits are dated around it. */
const midnight = Date.UTC(2026, 9, 27, 0, 0, 0);

const scratch = mkdtempSync(join(tmpdir(), "board-shipping-"));
const repository = join(scratch, "repository");
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run git in the fixture repository, committing as of `at`. */
function git(at: number | undefined, ...args: string[]): string {
  const dated =
    at === undefined
      ? {}
      : {
          GIT_AUTHOR_DATE: new Date(at).toISOString(),
          GIT_COMMITTER_DATE: new Date(at).toISOString(),
        };
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      GIT_AUTHOR_NAME: "Board Test",
      GIT_AUTHOR_EMAIL: "board@example.test",
      GIT_COMMITTER_NAME: "Board Test",
      GIT_COMMITTER_EMAIL: "board@example.test",
      ...dated,
    },
  });
}

beforeAll(() => {
  mkdirSync(repository);
  git(undefined, "init", "-q", "-b", "main");
  git(undefined, "config", "commit.gpgsign", "false");
  // Yesterday, before the day under test.
  git(
    midnight - hour,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "chore: yesterday",
  );
  // A feature branch with two commits, merged today with a merge commit.
  git(undefined, "checkout", "-q", "-b", "feat/widget");
  git(
    midnight + hour,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "feat: widget part one",
  );
  git(
    midnight + 2 * hour,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "feat: widget lands",
  );
  git(undefined, "checkout", "-q", "main");
  git(
    midnight + 3 * hour,
    "merge",
    "-q",
    "--no-ff",
    "feat/widget",
    "-m",
    "Merge branch 'feat/widget' into main",
  );
  // A direct commit, later.
  git(
    midnight + 4 * hour,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fix: direct to main",
  );
});

it("git source lists first-parent commits since local midnight by the merged tip's subject", async () => {
  const source = gitSource(
    { kind: "git", ref: "main", shows: "landed" },
    { cwd: repository, exec: execShipping },
  );
  const read = await source.read(midnight, new AbortController().signal);
  expect(read.state).toBe("ok");
  // Newest first; the merge reads as the work it merged; neither the feature
  // branch's own commits nor yesterday's commit appear.
  expect(read.items.map(({ title, kind }) => [title, kind])).toEqual([
    ["fix: direct to main", "landed"],
    ["feat: widget lands", "landed"],
  ]);
  expect(read.items.map(({ at }) => at)).toEqual([
    midnight + 4 * hour,
    midnight + 3 * hour,
  ]);
  expect(read.items[0]?.ref).toBe("main");
});

it("a released ref reads as released", async () => {
  const source = gitSource(
    { kind: "git", ref: "main", shows: "released" },
    { cwd: repository, exec: execShipping },
  );
  const read = await source.read(midnight, new AbortController().signal);
  expect(new Set(read.items.map(({ kind }) => kind))).toEqual(
    new Set(["released"]),
  );
  expect(read.items).toHaveLength(2);
});

it("a ref that does not exist or a missing program rejects with a reason, not an empty list", async () => {
  const missingRef = gitSource(
    { kind: "git", ref: "no-such-branch", shows: "landed" },
    { cwd: repository, exec: execShipping },
  );
  await expect(
    missingRef.read(midnight, new AbortController().signal),
  ).rejects.toThrow(/^git failed: fatal:/u);
  await expect(
    execShipping("definitely-not-a-program", [], {
      cwd: repository,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("definitely-not-a-program is not installed");
});

it("npm source keeps only versions published today", async () => {
  const asked: string[][] = [];
  const exec: ShippingExec = (file, args) => {
    asked.push([file, ...args]);
    return Promise.resolve(
      JSON.stringify({
        created: new Date(midnight - 90 * 24 * hour).toISOString(),
        modified: new Date(midnight + 5 * hour).toISOString(),
        "0.4.0": new Date(midnight - 30 * hour).toISOString(),
        "0.5.0": new Date(midnight + 2 * hour).toISOString(),
        "0.5.1": new Date(midnight + 6 * hour).toISOString(),
      }),
    );
  };
  const source = npmSource(
    { kind: "npm", packages: ["@fungi.computer/cli"] },
    { cwd: repository, exec },
  );
  const read = await source.read(midnight, new AbortController().signal);
  expect(asked).toEqual([
    ["npm", "view", "@fungi.computer/cli", "time", "--json"],
  ]);
  expect(read.items.map(({ title, kind }) => [title, kind])).toEqual([
    ["@fungi.computer/cli 0.5.1", "released"],
    ["@fungi.computer/cli 0.5.0", "released"],
  ]);
});

it("an unknown source kind in settings is one failed source naming its file and path", async () => {
  const folder = join(scratch, "refused");
  mkdirSync(join(folder, ".fungi"), { recursive: true });
  writeFileSync(
    join(folder, ".fungi/settings.json"),
    JSON.stringify({
      skills: ["./skills"],
      board: { shipping: [{ kind: "svn", path: "." }] },
    }),
  );
  const sources = await createLocalShippingSources({
    cwd: folder,
    home: join(scratch, "no-home"),
  })(new AbortController().signal);
  expect(sources).toHaveLength(1);
  await expect(
    sources[0]?.read(midnight, new AbortController().signal),
  ).rejects.toThrow(/settings\.json: board\.shipping\[0\]: /u);
});

it("settings name the sources, and an untouched folder defaults to its branch only inside a work tree", async () => {
  const configured = join(scratch, "configured");
  mkdirSync(join(configured, ".fungi"), { recursive: true });
  writeFileSync(
    join(configured, ".fungi/settings.json"),
    JSON.stringify({
      board: {
        shipping: [
          { kind: "git", ref: "main", shows: "released" },
          { kind: "npm", packages: ["a", "b"] },
        ],
      },
    }),
  );
  const none = join(scratch, "no-home");
  const named = await createLocalShippingSources({
    cwd: configured,
    home: none,
  })(new AbortController().signal);
  expect(named.map(({ id, label }) => [id, label])).toEqual([
    ["git:main:released", "main"],
    ["npm:a,b", "npm: a, b"],
  ]);
  const inside = await createLocalShippingSources({
    cwd: repository,
    home: none,
  })(new AbortController().signal);
  expect(inside.map(({ id, label }) => [id, label])).toEqual([
    ["git:HEAD:landed", "main"],
  ]);
  const outside = await createLocalShippingSources({
    cwd: join(scratch, "no-home"),
    home: none,
  })(new AbortController().signal);
  expect(outside).toEqual([]);
});
