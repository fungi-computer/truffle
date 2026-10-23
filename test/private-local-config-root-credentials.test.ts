import { EventEmitter } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  createFungiAccountCredentialStore,
  privateFungiAccountOAuthProvider,
} from "../src/private-fungi-account.js";
import { activateSubscriptionCredential } from "../src/subscription-activation.js";
import { runPrivateLocalWorkerServer } from "../src/private-local-worker-server.js";
import { runLocalAuthCli, type LocalAuthCliOptions } from "../src/auth-cli.js";
import { createPrivateModels } from "../src/local-models.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function homes() {
  const temporary = await mkdtemp(join(tmpdir(), "fungi-root-credentials-"));
  const previous = process.env.HOME;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(temporary, { recursive: true, force: true });
  });
  const a = capturePrivateLocalConfigRoot(join(temporary, "a"));
  const b = capturePrivateLocalConfigRoot(join(temporary, "b"));
  await Promise.all([a.home, b.home].map((home) => mkdir(home)));
  process.env.HOME = a.home;
  return { a, b, store: createPrivateCredentialStore(a.credentialPath) };
}

it("keeps lazy Fungi credential deletion with the path selected for read/list", async () => {
  const { b, store } = await homes();
  const saved = {
    type: "oauth",
    access: "synthetic-access",
    refresh: "",
    expires: Date.now() + 3_600_000,
    issuer: "https://example.invalid",
    team: { teamId: "synthetic-team", handle: "synthetic", name: "Synthetic" },
  } satisfies NonNullable<Awaited<ReturnType<typeof store.read>>>;
  await store.modify("fungi", () => Promise.resolve(saved));
  const credentials = createFungiAccountCredentialStore({
    fetch: () =>
      Promise.reject(new Error("This proof must not contact a provider")),
  });
  process.env.HOME = b.home;
  expect(await credentials.read("fungi")).toEqual(saved);
  expect((await credentials.list()).map((entry) => entry.providerId)).toContain(
    "fungi",
  );
  await credentials.delete("fungi");
  expect(await store.read("fungi")).toBeUndefined();
  await expect(access(b.credentialPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps delayed OAuth writes and reads in the provider's selected home", async () => {
  const { b, store } = await homes();
  const provider = privateFungiAccountOAuthProvider();
  process.env.HOME = b.home;
  await provider.saveCodeVerifier("synthetic-verifier");
  expect(await provider.codeVerifier()).toBe("synthetic-verifier");
  expect(await store.read("fungi")).toMatchObject({
    codeVerifier: "synthetic-verifier",
  });
  await expect(access(b.credentialPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("selects the activation path before awaiting input that changes ambient HOME", async () => {
  const { b, store } = await homes();
  const credential = {
    type: "oauth",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
  };
  function* input() {
    process.env.HOME = b.home;
    yield Buffer.from(JSON.stringify({ expected: null, credential }));
  }
  await activateSubscriptionCredential("anthropic", Readable.from(input()));
  expect(await store.read("anthropic")).toEqual(credential);
  await expect(access(b.credentialPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps worker MCP credentials in A across the workers-file read", async () => {
  const { a, b, store } = await homes();
  const credential = {
    type: "oauth",
    access: "synthetic-a",
    refresh: "",
    expires: Date.now() + 3_600_000,
    issuer: "https://example.invalid",
  } satisfies NonNullable<Awaited<ReturnType<typeof store.read>>>;
  await store.modify("fungi", () => Promise.resolve(credential));
  await createPrivateCredentialStore(b.credentialPath).modify("fungi", () =>
    Promise.resolve({ ...credential, access: "synthetic-b" }),
  );
  const beforeB = await readFile(b.credentialPath, "utf8");
  await writeFile(
    join(a.home, "workers.json"),
    JSON.stringify([
      {
        name: "fixture",
        owner: {
          invocationRoot: ".",
          fungiMcp: { endpoint: `${credential.issuer}/api/teams/fixture/mcp` },
        },
      },
    ]),
  );
  const signals = new EventEmitter();
  const running = runPrivateLocalWorkerServer(
    "workers.json",
    "http://127.0.0.1:43123",
    { cwd: a.home, signals },
    async (workers, listen) => {
      expect(workers[0]?.owner).toMatchObject({ configRoot: a });
      const provider = workers[0]?.owner.fungiMcp?.authProvider;
      if (provider === undefined || !("token" in provider))
        throw new Error("Expected the Fungi account auth provider");
      expect(await provider.token()).toBe(credential.access);
      signals.emit("SIGTERM");
      return {
        baseUrl: listen,
        workers: [],
        close: () => Promise.resolve(),
      };
    },
  );
  // readWorkers has yielded to real file I/O, but the outer owner chose A.
  process.env.HOME = b.home;
  await running;
  expect(await readFile(b.credentialPath, "utf8")).toBe(beforeB);
});

it("keeps the auth CLI's delayed installation identity with its selected root", async () => {
  const { a, b, store } = await homes();
  const expectedDeviceId = await store.getDeviceId();
  const catalog = createPrivateModels(a.credentialPath);
  let loggedIn = false;
  const models: NonNullable<LocalAuthCliOptions["models"]> = {
    getProviders: () => catalog.getProviders(),
    checkAuth: () => Promise.resolve(undefined),
    logout: () => Promise.resolve(),
    login: (_provider, _authType, _interaction, options) => {
      expect(options?.getDeviceId?.()).toBe(expectedDeviceId);
      loggedIn = true;
      return Promise.resolve({
        type: "oauth",
        access: "synthetic-access",
        refresh: "",
        expires: Date.now() + 3_600_000,
      });
    },
  };
  const output = new PassThrough();
  output.resume();
  const running = runLocalAuthCli(
    ["login", "--provider", "openai", "--auth-type", "oauth"],
    { models, output },
  );
  // Provider/method selection yields before the device-ID closure runs.
  process.env.HOME = b.home;
  await running;
  expect(loggedIn).toBe(true);
  await expect(access(`${b.credentialPath}.device-id`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps service opens, MCP reload and extension capture with the owner's root", async () => {
  const { a, b, store } = await homes();
  const credential = {
    type: "oauth",
    access: "synthetic-a",
    refresh: "",
    expires: Date.now() + 3_600_000,
    issuer: "https://example.invalid",
  } satisfies NonNullable<Awaited<ReturnType<typeof store.read>>>;
  await store.modify("fungi", () => Promise.resolve(credential));
  await createPrivateCredentialStore(b.credentialPath).modify("fungi", () =>
    Promise.resolve({ ...credential, access: "synthetic-b" }),
  );
  const selection = {
    endpoint: `${credential.issuer}/api/teams/fixture/mcp`,
  };
  await mkdir(join(a.home, "project", ".fungi"), { recursive: true });
  const project = await realpath(join(a.home, "project"));
  await writeFile(
    join(project, ".fungi", "team-mcp.json"),
    JSON.stringify(selection),
  );
  const otherExtensions = join(b.home, ".fungi", "extensions");
  await mkdir(otherExtensions, { recursive: true });
  const invalid = "{not valid JSON";
  await writeFile(join(otherExtensions, "installed.json"), invalid);
  const stopped = new Error("Fixture stops before opening a runtime");
  let opens = 0;
  // A fake opener observes the real owner's inputs and MCP provider. It does
  // not claim that the still-held runtime-host consumes configRoot yet.
  const owners = createLocalServiceOwners(async (options) => {
    expect(options.configRoot).toEqual(a);
    expect(options.invocationRoot).toBe(project);
    const configured = await options.configuration?.(project);
    const provider = (configured?.fungiMcp ?? options.fungiMcp)?.authProvider;
    if (provider === undefined || !("token" in provider))
      throw new Error("Expected the Fungi account auth provider");
    expect(await provider.token()).toBe(credential.access);
    opens += 1;
    throw stopped;
  });
  process.env.HOME = b.home;
  try {
    const request = { invocationRoot: project, fungiMcp: selection };
    await expect(owners.select(request)).rejects.toBe(stopped);
    await owners.reload(project, "/usr/bin:/bin");
    await expect(owners.select(request)).rejects.toBe(stopped);
    expect(opens).toBe(2);
    expect(
      await readFile(join(otherExtensions, "installed.json"), "utf8"),
    ).toBe(invalid);
  } finally {
    await owners.close();
  }
});
