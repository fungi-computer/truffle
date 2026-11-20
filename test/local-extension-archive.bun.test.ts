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
import { z } from "zod";
import { localExtensions } from "../src/local-extensions.js";
import { loginExtensionDirectory } from "./login-extension-fixture.js";
import { incompatibleLocalExtensionActivations } from "../src/private-local-extension-records.js";
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

/**
 * An installed.json and activations.json as the owner wrote them before model
 * logins existed: no `logins` or `loginsEntry` on a revision, no `logins` map
 * in the activations. A reader that rejected either would archive the registry
 * and silently drop every installed extension.
 */
const beforeLoginsInstalled = {
  extensions: {
    counter: {
      current: "1.0.0",
      revisions: {
        "1.0.0": {
          name: "fungi-counter",
          version: "1.0.0",
          source: "./tools/counter",
          resolution: "file:tools/counter",
          commit: null,
          directory: "/home/example/.fungi/extensions/packages/counter/1.0.0",
          capabilities: ["run_tools"],
          terminals: [],
          host: "/home/example/.fungi/extensions/packages/counter/1.0.0/host.mjs",
          client: null,
          skills: null,
        },
      },
    },
  },
};
const beforeLoginsActivations = {
  projects: {},
  agents: {
    "/home/example/project/.fungi/agents/local_store_a": {
      counter: {
        revision: "1.0.0",
        capabilities: ["run_tools"],
        skills: false,
      },
    },
  },
};

test("an installed.json and activations.json from before model logins parse cleanly and are not archived", async () => {
  const home = join(scratch, "before-logins-home");
  const extensionRoot = join(home, ".fungi", "extensions");
  const installed = join(extensionRoot, "installed.json");
  const activations = join(extensionRoot, "activations.json");
  const installedText = `${JSON.stringify(beforeLoginsInstalled, null, 2)}\n`;
  const activationsText = `${JSON.stringify(beforeLoginsActivations, null, 2)}\n`;
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(installed, installedText);
  await writeFile(activations, activationsText);

  const { result, output } = await withCapturedStderr(async () => {
    const owner = localExtensions({ home });
    return {
      listed: await owner.list(),
      logins: await owner.logins(),
      project: await owner.project(project),
      incompatible: await incompatibleLocalExtensionActivations(home),
    };
  });

  expect(result.listed).toMatchObject([
    {
      id: "counter",
      version: "1.0.0",
      capabilities: ["run_tools"],
      logins: [],
    },
  ]);
  expect(result.logins).toEqual({ contributions: [], diagnostics: [] });
  expect(result.project.diagnostics).toEqual([]);
  expect(result.incompatible).toEqual([]);
  // Nothing was set aside, warned about or rewritten by reading.
  expect(output).toBe("");
  expect(await readFile(installed, "utf8")).toBe(installedText);
  expect(await readFile(activations, "utf8")).toBe(activationsText);
  // readdir order is the filesystem's, not alphabetical.
  expect((await readdir(extensionRoot)).sort()).toEqual([
    "activations.json",
    "installed.json",
  ]);
  expect(
    await readdir(join(home, ".fungi", "archive")).catch(
      (cause: unknown) => cause,
    ),
  ).toMatchObject({ code: "ENOENT" });
});

test("a write after model logins keeps the other records and omits unused new fields", async () => {
  const home = join(scratch, "before-logins-write");
  const extensionRoot = join(home, ".fungi", "extensions");
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(
    join(extensionRoot, "installed.json"),
    JSON.stringify(beforeLoginsInstalled),
  );
  await writeFile(
    join(extensionRoot, "activations.json"),
    JSON.stringify(beforeLoginsActivations),
  );
  const owner = localExtensions({ home });
  expect(
    await owner.enableLogins("counter").catch((cause: unknown) => cause),
  ).toMatchObject({ reason: "no-logins" });
  expect(await owner.remove("counter")).toBe(true);
  // Nothing uses logins, so the write leaves the new fields out.
  expect(
    JSON.parse(await readFile(join(extensionRoot, "activations.json"), "utf8")),
  ).toEqual({
    projects: {},
    agents: { "/home/example/project/.fungi/agents/local_store_a": {} },
  });
});

/** The strict schemas an Fungi from before model logins reads these files with. */
const olderRevision = z.strictObject({
  name: z.string(),
  version: z.string(),
  source: z.string(),
  resolution: z.string(),
  commit: z.string().nullable(),
  directory: z.string(),
  capabilities: z.array(z.string()),
  terminals: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      binding: z.string().optional(),
      command: z.array(z.string()),
    }),
  ),
  host: z.string().nullable(),
  client: z.string().nullable(),
  skills: z.string().nullable(),
});
const olderInstalled = z.strictObject({
  extensions: z.record(
    z.string(),
    z.strictObject({
      current: z.string(),
      revisions: z.record(z.string(), olderRevision),
    }),
  ),
});
const olderActivations = z.strictObject({
  projects: z.record(z.string(), z.record(z.string(), z.string())),
  agents: z.record(
    z.string(),
    z.record(
      z.string(),
      z.strictObject({
        revision: z.string(),
        capabilities: z.array(z.string()),
        skills: z.boolean(),
      }),
    ),
  ),
});

test("writes that use no model logins stay readable by an older Fungi's strict parser", async () => {
  const home = join(scratch, "downgrade-home");
  const store = join(project, ".fungi", "agents", "local_store_downgrade");
  await mkdir(store, { recursive: true });
  const root = join(home, ".fungi", "extensions");
  const owner = localExtensions({ home });
  const older = async (step: string) => {
    const installed = olderInstalled.safeParse(
      JSON.parse(await readFile(join(root, "installed.json"), "utf8")),
    );
    const activations = olderActivations.safeParse(
      JSON.parse(await readFile(join(root, "activations.json"), "utf8")),
    );
    expect([step, installed.success, activations.success]).toEqual([
      step,
      true,
      true,
    ]);
  };
  await owner.add(
    join(import.meta.dir, "fixtures", "extension-counter"),
    project,
  );
  await older("add");
  await owner.enableProject(project, "counter");
  await older("enable project");
  await owner.enableAgent(store, "counter");
  await older("enable agent");
  await owner.disableAgent(store, "counter");
  await older("disable agent");
  await owner.disableProject(project, "counter");
  await older("disable project");
  // Using logins does write the new fields, and reading them back works.
  await owner.add(loginExtensionDirectory, project);
  await owner.enableLogins("login-fixture");
  const used: unknown = JSON.parse(
    await readFile(join(root, "activations.json"), "utf8"),
  );
  expect(
    z.looseObject({ logins: z.record(z.string(), z.string()) }).parse(used)
      .logins,
  ).toHaveProperty("login-fixture");
  expect((await owner.logins()).diagnostics).toEqual([]);
  // Turning them off again, or removing the extension, leaves the old shape.
  await owner.disableLogins("login-fixture");
  expect(
    olderActivations.safeParse(
      JSON.parse(await readFile(join(root, "activations.json"), "utf8")),
    ).success,
  ).toBe(true);
  await owner.remove("login-fixture");
  await older("remove");
});
