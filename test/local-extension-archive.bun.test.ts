import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExtensions } from "../src/local-extensions.js";
import {
  deferExtensionArchiveNotices,
  takePendingExtensionArchiveNotices,
} from "../src/private-local-extension-archive-notice.js";

let scratch: string;
let project: string;

beforeAll(async () => {
  scratch = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-extension-archive-")),
  );
  project = join(scratch, "project");
  await mkdir(project, { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function withCapturedStderr<T>(run: () => Promise<T>) {
  const original = process.stderr.write.bind(process.stderr);
  let output = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    output += Buffer.from(chunk).toString();
    return true;
  };
  try {
    return { result: await run(), output };
  } finally {
    process.stderr.write = original;
  }
}

const legacyFixture = () =>
  readFile(join(import.meta.dir, "fixtures", "installed-0.2.x.json"), "utf8");

test("archives a real 0.2.x registry and warns once without loading its extensions", async () => {
  const home = join(scratch, "old-home");
  const extensionRoot = join(home, ".fungi", "extensions");
  const installed = join(extensionRoot, "installed.json");
  const archived = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "installed.json",
  );
  const original = await legacyFixture();
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(installed, original);

  const { result, output } = await withCapturedStderr(async () => {
    const loaded = await localExtensions({ home }).project(project);
    await localExtensions({ home }).project(project);
    return loaded;
  });

  expect(result.clients).toEqual([]);
  expect(result.terminals).toEqual([]);
  expect(result.diagnostics).toEqual([]);
  expect(await readFile(archived, "utf8")).toBe(original);
  expect(await readdir(extensionRoot)).not.toContain("installed.json");
  expect(output.trim().split("\n")).toEqual([
    "Extensions from an earlier version were set aside: @fungi.computer/counter. Re-add each with: fungi extension add <its source>. Archived registry: ~/.fungi/archive/unversioned/extensions/installed.json.",
  ]);
});

test("archive notices and sidecars contain names only, preserving all source forms in the archive", async () => {
  const cases = [
    {
      label: "credential-url",
      source:
        "git+https://x-access-token:NOTICE_TEST_TOKEN@github.com/example/private-extension.git",
    },
    {
      label: "sas-url",
      source:
        "https://account.blob.core.windows.net/extensions/private.zip?sv=2025&sig=NOTICE_TEST_SIGNATURE",
    },
    { label: "relative-file", source: "file:../x" },
  ] as const;

  for (const entry of cases) {
    const home = join(scratch, `names-only-${entry.label}`);
    const extensionRoot = join(home, ".fungi", "extensions");
    const installed = join(extensionRoot, "installed.json");
    const archived = join(
      home,
      ".fungi",
      "archive",
      "unversioned",
      "extensions",
      "installed.json",
    );
    const original = await legacyFixture();
    const registry = original.replace(
      '"source": "./tools/counter"',
      `"source": "${entry.source}"`,
    );
    expect(registry).not.toBe(original);
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(installed, registry);

    const { output } = await withCapturedStderr(() =>
      localExtensions({ home }).project(project),
    );
    const sidecar = await readFile(`${archived}.notice.json`, "utf8");

    expect(output).toBe(
      "Extensions from an earlier version were set aside: @fungi.computer/counter. Re-add each with: fungi extension add <its source>. Archived registry: ~/.fungi/archive/unversioned/extensions/installed.json.\n",
    );
    expect(sidecar).toBe(
      JSON.stringify({
        version: 3,
        slug: "unversioned",
        filename: "installed.json",
        names: ["@fungi.computer/counter"],
        additionalNameCount: 0,
        shown: true,
      }) + "\n",
    );
    expect(await readFile(archived, "utf8")).toBe(registry);
    expect(output).not.toContain(entry.source);
    expect(sidecar).not.toContain(entry.source);
  }
});

test("a deferred service notice is claimed by the foreground once", async () => {
  const home = join(scratch, "deferred-home");
  const extensionRoot = join(home, ".fungi", "extensions");
  const installed = join(extensionRoot, "installed.json");
  const archived = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "installed.json",
  );
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(installed, await legacyFixture());

  deferExtensionArchiveNotices(home);
  const { result, output } = await withCapturedStderr(() =>
    localExtensions({ home }).project(project),
  );

  expect(result.clients).toEqual([]);
  expect(result.terminals).toEqual([]);
  expect(output).toBe("");
  expect(await readFile(archived, "utf8")).toBe(await legacyFixture());
  expect(
    await readFile(
      join(
        home,
        ".fungi/archive/unversioned/extensions/installed.json.notice.json",
      ),
      "utf8",
    ),
  ).toContain('"shown":false');
  const [firstClaim, competingClaim] = await Promise.all([
    takePendingExtensionArchiveNotices(home),
    takePendingExtensionArchiveNotices(home),
  ]);
  expect([...firstClaim, ...competingClaim]).toEqual([
    "Extensions from an earlier version were set aside: @fungi.computer/counter. Re-add each with: fungi extension add <its source>. Archived registry: ~/.fungi/archive/unversioned/extensions/installed.json.",
  ]);
  expect(await takePendingExtensionArchiveNotices(home)).toEqual([]);
});

test("archives a corrupt registry with one generic warning and starts empty", async () => {
  const home = join(scratch, "corrupt-home");
  const extensionRoot = join(home, ".fungi", "extensions");
  const installed = join(extensionRoot, "installed.json");
  const archived = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "installed.json",
  );
  const corrupt = '{"extensions":';
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(installed, corrupt);

  const { result, output } = await withCapturedStderr(() =>
    localExtensions({ home }).project(project),
  );

  expect(result.clients).toEqual([]);
  expect(result.terminals).toEqual([]);
  expect(result.diagnostics).toEqual([]);
  expect(await readFile(archived, "utf8")).toBe(corrupt);
  expect(await readdir(extensionRoot)).not.toContain("installed.json");
  expect(output.trim().split("\n")).toEqual([
    "Extensions from an earlier version were set aside, but no extension names could be read. Re-add each with: fungi extension add <its source>. Archived registry: ~/.fungi/archive/unversioned/extensions/installed.json.",
  ]);
});

test("an existing archive is preserved and the old registry gets the next archive name", async () => {
  const home = join(scratch, "collision-home");
  const extensionRoot = join(home, ".fungi", "extensions");
  const archiveRoot = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
  );
  const installed = join(extensionRoot, "installed.json");
  const occupied = join(archiveRoot, "installed.json");
  const nextArchive = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "installed-2.json",
  );
  const original = await legacyFixture();
  await mkdir(extensionRoot, { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(occupied, "preserve this archive\n");
  await writeFile(installed, original);

  const { output } = await withCapturedStderr(() =>
    localExtensions({ home }).project(project),
  );

  expect(await readFile(occupied, "utf8")).toBe("preserve this archive\n");
  expect(await readFile(nextArchive, "utf8")).toBe(original);
  expect(output.trim().split("\n")).toEqual([
    "Extensions from an earlier version were set aside: @fungi.computer/counter. Re-add each with: fungi extension add <its source>. Archived registry: ~/.fungi/archive/unversioned/extensions/installed-2.json.",
  ]);
});
