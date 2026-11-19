import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fauxModel } from "@fungi.computer/mule/testing";
import { Shiitake } from "@fungi.computer/shiitake";
import { z } from "zod";
import {
  LocalExtensionError,
  localExtensions,
  type LocalExtensions,
} from "../src/local-extensions.js";
import { loginExtensionDirectory } from "./login-extension-fixture.js";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

/** The real workerd sandbox needs its built worker bundle. */
async function workerdSandbox() {
  const { createPrivateWorkerdSandbox } =
    await import("../dist/private-workerd-sandbox.js");
  return createPrivateWorkerdSandbox();
}

const installedRecord = z.object({
  extensions: z.record(
    z.string(),
    z.object({
      revisions: z.record(z.string(), z.object({ resolution: z.string() })),
    }),
  ),
});
const activationRecord = z.object({
  agents: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({ revision: z.string(), capabilities: z.array(z.string()) }),
    ),
  ),
});

const fixture = join(import.meta.dir, "fixtures", "extension-counter");
let scratch: string;
let home: string;
let project: string;
let agentA: string;
let agentB: string;
let owner: LocalExtensions;
let bare: string;
let work: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.email=fixture@fungi.test", "-c", "user.name=Fixture", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** A disposable Git source: commit the fixture and serve it from a bare repo. */
function publish(message: string) {
  git(work, "add", "-A");
  git(work, "commit", "-qm", message);
  git(work, "push", "-q", bare, "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fungi-ext-")));
  home = join(scratch, "home");
  project = join(scratch, "project");
  agentA = join(project, ".fungi", "agents", "local_store_a");
  agentB = join(project, ".fungi", "agents", "local_store_b");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agentA, { recursive: true }),
    mkdir(agentB, { recursive: true }),
  ]);
  owner = localExtensions({ home });
  work = join(scratch, "source");
  bare = join(scratch, "counter.git");
  await cp(fixture, work, { recursive: true });
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "init", "-q", "-b", "main");
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runCounter(
  cwd: string,
  env: Readonly<Record<string, string>>,
  command: readonly string[],
) {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
  });
  const decoder = new TextDecoder();
  let output = "";
  const reader = child.stdout.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      output += decoder.decode(value);
    }
  })();
  const shows = async (text: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (output.includes(text)) return;
      await Bun.sleep(10);
    }
    throw new Error(`Program never showed ${text}: ${output}`);
  };
  await shows("count: 0");
  return { child, shows };
}

/** One faux turn that calls execute with `code`; returns the tool result text. */
async function executeAs(storeDirectory: string, code: string) {
  const loaded = await owner.agent(storeDirectory, project);
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("execute", { code }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const database = new DatabaseSync(":memory:");
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: { roster: loaded.roster, grants: loaded.grants },
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: () => Promise.resolve({ revision: "counter", text: "Use tools." }),
    },
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          retryable: () => false,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
    tools: { sources: [], sandbox: await workerdSandbox() },
  });
  try {
    const session = agent.session("main");
    await session.send("Use the counter.", { requestId: "counter" });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const snapshot = await session.read();
      const result = snapshot.messages.find(
        ({ value }) => value.role === "toolResult",
      );
      if (result !== undefined && snapshot.terminals.length > 0) {
        const value = result.value;
        if (value.role !== "toolResult") throw new Error("Unreachable");
        return value.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
      }
      await Bun.sleep(20);
    }
    throw new Error("The faux turn did not settle");
  } finally {
    await agent.close();
    database.close();
  }
}

test("a Git source with a missing built entry is refused, never reported usable", async () => {
  await writeFile(
    join(work, "package.json"),
    (await readFile(join(fixture, "package.json"), "utf8")).replace(
      '"./host": "./host.mjs"',
      '"./host": "./dist/host.js"',
    ),
  );
  publish("source only");
  const refused = await owner
    .add(`git+file://${bare}#main`, project)
    .catch((cause: unknown) => cause);
  expect(refused).toBeInstanceOf(LocalExtensionError);
  expect(refused instanceof LocalExtensionError && refused.reason).toBe(
    "artifact",
  );
  expect(await owner.list()).toEqual([]);
});

test("the extension owner retains its selected home after ambient HOME changes", async () => {
  const previous = process.env.HOME;
  try {
    process.env.HOME = join(scratch, "other-home");
    expect(owner.root).toBe(join(home, ".fungi", "extensions"));
    expect(await owner.list()).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test("installs the Git package pinned to its resolved commit; enables the project and one Agent", async () => {
  await cp(join(fixture, "package.json"), join(work, "package.json"));
  const commit = publish("counter 1.0.0");
  const installed = await owner.add(`git+file://${bare}#main`, project);
  expect(installed).toMatchObject({
    id: "counter",
    commit,
    revision: commit,
    capabilities: ["run_tools"],
    terminals: ["counter"],
  });
  const record = installedRecord.parse(
    JSON.parse(
      await readFile(
        join(home, ".fungi", "extensions", "installed.json"),
        "utf8",
      ),
    ),
  );
  expect(record.extensions.counter?.revisions[commit]?.resolution).toContain(
    `#${commit}`,
  );
  await owner.enableProject(project, "counter");
  await owner.enableAgent(agentA, "counter");
});

test("an Agent enabling an extension on another Agent must hold it; a human enabling need not", async () => {
  const target = join(project, ".fungi", "agents", "local_store_c");
  await mkdir(target, { recursive: true });
  // agentB holds nothing, so it cannot give counter away.
  const refused = await owner
    .enableAgent(target, "counter", { agentStoreDirectory: agentB })
    .catch((cause: unknown) => cause);
  expect(refused instanceof LocalExtensionError && refused.reason).toBe(
    "not-held",
  );
  const lacking = await owner
    .assertHeldByAgent(target, ["counter"])
    .catch((cause: unknown) => cause);
  expect(lacking instanceof LocalExtensionError && lacking.reason).toBe(
    "not-held",
  );
  // agentA holds counter, so it can.
  await owner.enableAgent(target, "counter", { agentStoreDirectory: agentA });
  await owner.assertHeldByAgent(target, ["counter"]);
  await owner.disableAgent(target, "counter");
  // A human (the CLI) names no requester and holds nothing itself.
  await owner.enableAgent(target, "counter");
  await owner.assertHeldByAgent(target, ["counter"]);
  await owner.disableAgent(target, "counter");
});

test("the project launcher runs the program; only the enabled Agent's execute calls reach it", async () => {
  const enabled = await owner.project(project);
  expect(enabled.diagnostics).toEqual([]);
  const [terminal] = enabled.terminals;
  if (terminal === undefined) throw new Error("Counter launcher missing");
  expect(terminal).toMatchObject({
    extensionId: "counter",
    name: "Counter",
    cwd: project,
  });
  const program = await runCounter(
    terminal.cwd,
    terminal.env,
    terminal.command,
  );
  try {
    const first = await executeAs(agentA, "return await counter.increment({})");
    expect(JSON.parse(first)).toEqual({ running: true, count: 1 });
    await program.shows("count: 1");
    expect(
      JSON.parse(await executeAs(agentA, "return await counter.read({})")),
    ).toEqual({ running: true, count: 1 });
    const denied = await executeAs(agentB, "return typeof counter");
    expect(denied).toBe('"undefined"');
    expect((await owner.agent(agentB, project)).roster).toEqual([]);
  } finally {
    program.child.kill("SIGTERM");
    await program.child.exited;
  }
  expect(
    JSON.parse(await executeAs(agentA, "return await counter.increment({})")),
  ).toEqual({ running: false });
});

test("a copied folder with hand-placed activations enables nothing", async () => {
  const copy = join(scratch, "copied-project");
  await cp(project, copy, { recursive: true });
  await mkdir(join(copy, ".fungi", "extensions"), { recursive: true });
  await cp(
    join(home, ".fungi", "extensions", "activations.json"),
    join(copy, ".fungi", "extensions", "activations.json"),
  );
  expect(await owner.project(copy)).toEqual({
    clients: [],
    terminals: [],
    diagnostics: [],
  });
  const copiedAgent = await owner.agent(
    join(copy, ".fungi", "agents", "local_store_a"),
    copy,
  );
  expect(copiedAgent.roster).toEqual([]);
});

test("an upgrade keeps the accepted revision until re-enabled; disable and remove withdraw", async () => {
  const before = await owner.agent(agentA, project);
  const [accepted] = before.grants;
  expect(accepted?.capabilities).toEqual(["run_tools"]);
  const manifest = z
    .looseObject({ fungi: z.looseObject({}) })
    .parse(JSON.parse(await readFile(join(work, "package.json"), "utf8")));
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify(
      {
        ...manifest,
        version: "1.1.0",
        fungi: { ...manifest.fungi, capabilities: ["run_tools", "prompt"] },
      },
      null,
      2,
    )}\n`,
  );
  const upgraded = publish("counter 1.1.0 asks for prompt");
  const next = await owner.add(`git+file://${bare}#main`, project);
  expect(next.revision).toBe(upgraded);
  const pinned = activationRecord.parse(
    JSON.parse(
      await readFile(
        join(home, ".fungi", "extensions", "activations.json"),
        "utf8",
      ),
    ),
  ).agents[await realpath(agentA)]?.counter;
  expect(pinned?.revision).not.toBe(upgraded);
  expect(pinned?.capabilities).toEqual(["run_tools"]);
  // The wider revision is installed, but the Agent keeps what it accepted.
  expect(
    (await owner.agent(agentA, project)).grants.map(({ id, capabilities }) => ({
      id: String(id),
      capabilities,
    })),
  ).toEqual([{ id: "counter", capabilities: ["run_tools"] }]);
  expect(await owner.enableAgent(agentA, "counter")).toEqual({
    revision: upgraded,
    capabilities: ["run_tools", "prompt"],
    skills: false,
  });
  expect(await owner.disableAgent(agentA, "counter")).toBe(true);
  expect((await owner.agent(agentA, project)).roster).toEqual([]);
  expect(await owner.remove("counter")).toBe(true);
  expect(await owner.list()).toEqual([]);
  expect((await owner.project(project)).terminals).toEqual([]);
});

const loginRecords = z.object({
  extensions: z.record(
    z.string(),
    z.object({
      current: z.string(),
      revisions: z.record(
        z.string(),
        z.object({
          logins: z.array(z.object({ providerId: z.string() })),
          loginsEntry: z.string().nullable(),
        }),
      ),
    }),
  ),
});

async function loginHome(name: string) {
  const directory = join(scratch, name);
  await mkdir(directory, { recursive: true });
  return { directory, owner: localExtensions({ home: directory }) };
}

async function refusal(promise: Promise<unknown>) {
  const cause = await promise.catch((error: unknown) => error);
  expect(cause).toBeInstanceOf(LocalExtensionError);
  return cause instanceof LocalExtensionError ? cause.reason : undefined;
}

test("a package declaring model logins without a built ./logins entry is refused", async () => {
  const { owner: logins } = await loginHome("login-refusals");
  const missingFile = join(scratch, "logins-missing-file");
  await cp(loginExtensionDirectory, missingFile, { recursive: true });
  await rm(join(missingFile, "logins.mjs"));
  expect(await refusal(logins.add(missingFile, project))).toBe("artifact");
  const noExport = join(scratch, "logins-no-export");
  await cp(loginExtensionDirectory, noExport, { recursive: true });
  const manifest = z
    .looseObject({ exports: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(noExport, "package.json"), "utf8")));
  await writeFile(
    join(noExport, "package.json"),
    JSON.stringify({ ...manifest, exports: {} }),
  );
  expect(await refusal(logins.add(noExport, project))).toBe("artifact");
  expect(await logins.list()).toEqual([]);
});

test("model logins are installed, enabled user-wide, loaded, disabled and removed", async () => {
  const { directory, owner: logins } = await loginHome("login-lifecycle");
  const installed = await logins.add(loginExtensionDirectory, project);
  expect(installed).toMatchObject({
    id: "login-fixture",
    capabilities: [],
    logins: ["fixture subscription"],
  });
  const record = loginRecords.parse(
    JSON.parse(
      await readFile(
        join(directory, ".fungi", "extensions", "installed.json"),
        "utf8",
      ),
    ),
  );
  const revision = record.extensions["login-fixture"]?.current ?? "";
  expect(
    record.extensions["login-fixture"]?.revisions[revision]?.loginsEntry,
  ).toContain("logins.mjs");
  expect(await logins.list()).toMatchObject([
    { id: "login-fixture", logins: ["fixture subscription"] },
  ]);
  // Installed is not enabled: nothing contributes yet.
  expect(await logins.logins()).toEqual({ contributions: [], diagnostics: [] });
  expect(await logins.enableLogins("login-fixture")).toEqual({
    revision,
    logins: ["fixture subscription"],
  });
  const enabled = await logins.logins();
  expect(enabled.diagnostics).toEqual([]);
  expect(
    enabled.contributions.map(({ extensionId, contribution }) => [
      extensionId,
      contribution.providerId,
      contribution.method,
    ]),
  ).toEqual([["login-fixture", "fixture", "subscription"]]);
  expect(await logins.disableLogins("login-fixture")).toBe(true);
  expect(await logins.disableLogins("login-fixture")).toBe(false);
  expect((await logins.logins()).contributions).toEqual([]);
  await logins.enableLogins("login-fixture");
  expect(await logins.remove("login-fixture")).toBe(true);
  expect(await logins.logins()).toEqual({ contributions: [], diagnostics: [] });
  expect(
    z
      .object({ logins: z.record(z.string(), z.string()).optional() })
      .parse(
        JSON.parse(
          await readFile(
            join(directory, ".fungi", "extensions", "activations.json"),
            "utf8",
          ),
        ),
      ).logins,
    // Nothing uses logins now, so the write leaves the map out.
  ).toBeUndefined();
});

test("an extension that declares no model logins cannot enable them", async () => {
  const { owner: logins } = await loginHome("login-none");
  await logins.add(fixture, project);
  expect(await refusal(logins.enableLogins("counter"))).toBe("no-logins");
  expect(await refusal(logins.enableLogins("absent"))).toBe("not-installed");
});

test("an enabled extension whose entry file is gone yields a diagnostic, not a login", async () => {
  const { owner: logins } = await loginHome("login-gone");
  await logins.add(loginExtensionDirectory, project);
  await logins.enableLogins("login-fixture");
  await rm(join(logins.root, "packages", "login-fixture"), {
    recursive: true,
    force: true,
  });
  const result = await logins.logins();
  expect(result.contributions).toEqual([]);
  expect(result.diagnostics.map(({ extensionId }) => extensionId)).toEqual([
    "login-fixture",
  ]);
  expect(result.diagnostics[0]?.error.message).toBe(
    "Extension login-fixture logins could not load",
  );
});
