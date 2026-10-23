import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import type { ShiitakeSession } from "@fungi.computer/shiitake";

import {
  createLocalServiceOwners,
  type LocalServiceRuntime,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import type { PrivateLocalMailRouting } from "../src/private-local-delegation.js";
import { hasApi } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { writeFreshStore } from "./fixtures/fresh-store.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";
import {
  fixtureEffectiveModel,
  fixtureModelControls,
} from "./fixtures/effective-model.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Store = {
  opens: number;
  closes: number;
  /** What this store's idle read answers; an Error makes the read fail. */
  idle: boolean | Error;
  mail: BirdDogMail[];
  live: boolean;
  /** When set, this store's reload preparation waits for it. */
  reloadGate: PromiseWithResolvers<undefined> | undefined;
  reloadStarted: PromiseWithResolvers<undefined>;
};

/** N real project store paths and an opener whose runtimes count their lifetime. */
async function project(count: number) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-idle-owners-")),
  );
  roots.push(root);
  const service = join(root, "service");
  await mkdir(service);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = join(
      root,
      ".fungi",
      "agents",
      `local_store_idle${String(index)}`,
    );
    await mkdir(directory, { recursive: true });
    const path = join(directory, "agent.sqlite");
    writeFreshStore(path, `idle ${String(index)}`);
    paths.push(path);
  }
  const stores = new Map<string, Store>(
    paths.map((path) => [
      path,
      {
        opens: 0,
        closes: 0,
        idle: true,
        mail: [],
        live: false,
        reloadGate: undefined,
        reloadStarted: Promise.withResolvers<undefined>(),
      },
    ]),
  );
  let routing: PrivateLocalMailRouting | undefined;
  const open: OpenLocalServiceRuntime = (options) => {
    const path = options.databasePath;
    if (path === undefined) throw new Error("Expected an existing store");
    const store = stores.get(path);
    if (store === undefined) throw new Error(`Unexpected store ${path}`);
    // One process may own a store once; a reopen before close is a leak.
    if (store.live) throw new Error(`Store opened twice: ${path}`);
    store.live = true;
    store.opens += 1;
    routing ??= options.mail;
    const runtime: LocalServiceRuntime = {
      databasePath: path,
      agentId: path.split("/").at(-2) ?? "unknown",
      name: "idle fixture",
      getSession: (sessionId) =>
        // SAFETY: These owner tests observe only the Session address.
        ({ address: `session:${sessionId}` }) as ShiitakeSession,
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      createSession: () => Promise.resolve("main"),
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      prepareReload: async () => {
        store.reloadStarted.resolve(undefined);
        await store.reloadGate?.promise;
        if (!store.live) throw new Error("Reload prepared a closed Agent");
        return { commit: () => undefined, discard: () => Promise.resolve() };
      },
      bindSessionPath: () => true,
      pendingDelegation: () => Promise.resolve(undefined),
      readSettlement: () => Promise.resolve(undefined),
      acceptMail: (mail) => {
        if (!store.live) throw new Error("Mail reached a closed Agent");
        store.mail.push(mail);
        return Promise.resolve({
          status: "accepted",
          commandId: `command-${String(store.mail.length)}`,
        });
      },
      idle: () =>
        store.idle instanceof Error
          ? Promise.reject(store.idle)
          : Promise.resolve(store.idle),
      close: () => {
        store.live = false;
        store.closes += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(runtime);
  };
  const owners = createLocalServiceOwners(open, service);
  const listed = async () =>
    z
      .array(z.object({ databasePath: z.string() }))
      .parse(JSON.parse(await readFile(join(service, "owners.json"), "utf8")))
      .map(({ databasePath }) => databasePath);
  const mailRouting = () => {
    if (routing === undefined) throw new Error("No project mail routing");
    return routing;
  };
  return { root, service, paths, stores, owners, listed, mailRouting, open };
}

it("releases N distinct idle Agents after two idle sweeps and forgets them for restart", async () => {
  const fixture = await project(12);
  const { owners, paths, stores } = fixture;
  for (const databasePath of paths) {
    const selected = await owners.select({
      invocationRoot: fixture.root,
      databasePath,
      sessionId: "main",
    });
    selected.release();
  }
  expect(await fixture.listed()).toEqual(paths);
  expect([...stores.values()].filter((store) => store.live)).toHaveLength(12);

  // One idle observation never closes an Agent: a client may be reconnecting.
  await owners.sweepIdle();
  expect([...stores.values()].filter((store) => store.live)).toHaveLength(12);
  await owners.sweepIdle();
  expect([...stores.values()].filter((store) => store.live)).toHaveLength(0);
  expect([...stores.values()].map((store) => store.closes)).toEqual(
    paths.map(() => 1),
  );
  expect(await fixture.listed()).toEqual([]);

  // A later client reopens on demand.
  const again = await owners.select({
    invocationRoot: fixture.root,
    databasePath: paths[0],
    sessionId: "main",
  });
  again.release();
  expect(stores.get(paths[0] ?? "")?.opens).toBe(2);
  await owners.close();
});

it("keeps Agents with work open and listed, and restart reopens only those", async () => {
  const fixture = await project(4);
  const { owners, paths, stores } = fixture;
  const [busy, ...idle] = paths;
  if (busy === undefined) throw new Error("Missing busy store");
  const busyStore = stores.get(busy);
  if (busyStore === undefined) throw new Error("Missing busy fixture");
  busyStore.idle = false;
  for (const databasePath of paths)
    (
      await owners.select({
        invocationRoot: fixture.root,
        databasePath,
        sessionId: "main",
      })
    ).release();
  await owners.sweepIdle();
  await owners.sweepIdle();
  expect(busyStore.live).toBe(true);
  expect(await fixture.listed()).toEqual([busy]);

  // Work that started between sweeps is never closed underneath it.
  const late = idle[0];
  if (late === undefined) throw new Error("Missing late store");
  (
    await owners.select({
      invocationRoot: fixture.root,
      databasePath: late,
      sessionId: "main",
    })
  ).release();
  await owners.sweepIdle();
  const lateStore = stores.get(late);
  if (lateStore === undefined) throw new Error("Missing late fixture");
  lateStore.idle = false;
  await owners.sweepIdle();
  expect(lateStore.live).toBe(true);

  // Shutdown keeps only Agents with work for the next service to resume.
  await owners.close();
  expect(await fixture.listed()).toEqual([busy, late]);
  const restarted = createLocalServiceOwners(fixture.open, fixture.service);
  await restarted.restore();
  expect(
    paths.filter((path) => stores.get(path)?.live === true).sort(),
  ).toEqual([busy, late].sort());
  await restarted.close();
});

it("keeps an Agent open while a served response streams, and releases it after", async () => {
  const fixture = await project(1);
  const [databasePath] = fixture.paths;
  if (databasePath === undefined) throw new Error("Missing store");
  const store = fixture.stores.get(databasePath);
  if (store === undefined) throw new Error("Missing fixture");
  const selection = { invocationRoot: fixture.root, databasePath };
  const watching = await fixture.owners.serve(
    selection,
    new Request("http://local/sessions/main/events"),
  );
  const reader = watching.body?.getReader();
  await fixture.owners.sweepIdle();
  await fixture.owners.sweepIdle();
  expect(store.live).toBe(true);
  await reader?.cancel();
  await fixture.owners.sweepIdle();
  await fixture.owners.sweepIdle();
  expect(store.live).toBe(false);
  await fixture.owners.close();
});

it("reopens a released idle Agent on demand for mail and a send", async () => {
  const fixture = await project(2);
  const [sender, recipient] = fixture.paths;
  if (sender === undefined || recipient === undefined)
    throw new Error("Missing stores");
  for (const databasePath of [sender, recipient])
    (
      await fixture.owners.select({
        invocationRoot: fixture.root,
        databasePath,
        sessionId: "main",
      })
    ).release();
  await fixture.owners.sweepIdle();
  await fixture.owners.sweepIdle();
  const recipientStore = fixture.stores.get(recipient);
  if (recipientStore === undefined) throw new Error("Missing fixture");
  expect(recipientStore.live).toBe(false);

  const mail: BirdDogMail = {
    key: "mail-1",
    to: { kind: "agent", agentId: "local_store_idle1", sessionId: "main" },
    from: { kind: "agent", agentId: "local_store_idle0", sessionId: "main" },
    replyTo: [],
    content: "wake up",
    createdAt: 0,
  };
  await fixture.mailRouting().deliver(mail);
  expect(recipientStore.live).toBe(true);
  expect(recipientStore.opens).toBe(2);
  expect(recipientStore.mail).toEqual([mail]);

  // A client's next request on the old route reopens a released Agent too.
  await fixture.owners.sweepIdle();
  await fixture.owners.sweepIdle();
  expect(recipientStore.live).toBe(false);
  const served = await fixture.owners.serve(
    { invocationRoot: fixture.root, databasePath: recipient },
    new Request("http://local/sessions"),
  );
  await served.body?.cancel();
  expect(recipientStore.opens).toBe(3);
  await fixture.owners.close();
});

/** Select each store once and end that client's use, as a closed window does. */
async function selectAndLeave(
  fixture: Awaited<ReturnType<typeof project>>,
  paths: readonly string[] = fixture.paths,
) {
  for (const databasePath of paths)
    (
      await fixture.owners.select({
        invocationRoot: fixture.root,
        databasePath,
        sessionId: "main",
      })
    ).release();
}

function storeOf(
  fixture: Awaited<ReturnType<typeof project>>,
  databasePath: string | undefined,
) {
  const store =
    databasePath === undefined ? undefined : fixture.stores.get(databasePath);
  if (store === undefined) throw new Error("Missing fixture store");
  return store;
}

it("never releases an Agent beneath a configuration reload that snapshotted it", async () => {
  const fixture = await project(2);
  const [first, second] = fixture.paths;
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-idle-home-")),
  );
  roots.push(home);
  const execPath = join(fixture.root, "bin");
  await mkdir(execPath);
  vi.stubEnv("HOME", home);
  const firstStore = storeOf(fixture, first);
  firstStore.reloadGate = Promise.withResolvers<undefined>();
  let reloading: Promise<void> | undefined;
  try {
    await selectAndLeave(fixture);
    // Both Agents are idle candidates after one sweep.
    await fixture.owners.sweepIdle();
    reloading = fixture.owners.reload(fixture.root, execPath);
    await firstStore.reloadStarted.promise;
    // The reload holds the first Agent and has yet to reach the second.
    await fixture.owners.sweepIdle();
    expect(storeOf(fixture, second).live).toBe(true);
    firstStore.reloadGate.resolve(undefined);
    await expect(reloading).resolves.toBeUndefined();
    // After the reload, two idle sweeps release both as usual.
    await fixture.owners.sweepIdle();
    await fixture.owners.sweepIdle();
    expect([firstStore.live, storeOf(fixture, second).live]).toEqual([
      false,
      false,
    ]);
  } finally {
    vi.unstubAllEnvs();
    // A failed assertion must not leave the held reload blocking shutdown.
    firstStore.reloadGate.resolve(undefined);
    await Promise.allSettled(reloading === undefined ? [] : [reloading]);
    await fixture.owners.close();
  }
});

it("keeps an Agent a draining request still uses listed for the next service", async () => {
  const fixture = await project(2);
  const [draining, unused] = fixture.paths;
  if (draining === undefined || unused === undefined)
    throw new Error("Missing stores");
  await selectAndLeave(fixture, [unused]);
  // A request from before shutdown still holds this Agent.
  const held = await fixture.owners.select({
    invocationRoot: fixture.root,
    databasePath: draining,
    sessionId: "main",
  });
  await fixture.owners.close();
  expect(await fixture.listed()).toEqual([draining]);
  held.release();
});

it("checks every other Agent when one Agent's idle read fails", async () => {
  const fixture = await project(3);
  const [broken, ...rest] = fixture.paths;
  storeOf(fixture, broken).idle = new Error("idle read failed");
  await selectAndLeave(fixture);
  await fixture.owners.sweepIdle();
  await fixture.owners.sweepIdle();
  expect(storeOf(fixture, broken).live).toBe(true);
  expect(rest.map((path) => storeOf(fixture, path).live)).toEqual([
    false,
    false,
  ]);
  await fixture.owners.close();
});

it("the real idle check reports a running and a queued Watchdog job as work", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-idle-real-")),
  );
  roots.push(root);
  vi.stubEnv("HOME", root);
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("Network forbidden in the idle-check test")),
  );
  const credentials = join(root, "credentials.json");
  const token = [
    "synthetic",
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
        },
      }),
    ).toString("base64url"),
    "synthetic",
  ].join(".");
  await createPrivateCredentialStore(credentials).modify("openai", () =>
    Promise.resolve({
      type: "oauth",
      access: token,
      refresh: "synthetic-refresh",
      expires: Date.now() + 24 * 60 * 60_000,
      accountId: "synthetic-account",
    }),
  );
  const models = createPrivateModels(credentials);
  const provider = openaiProvider();
  const requested = Promise.withResolvers<undefined>();
  const answer = Promise.withResolvers<undefined>();
  models.setProvider({
    ...provider,
    // The model request is held open offline until the test answers it.
    streamSimple: (model, context, options) => {
      if (!hasApi(model, "openai-responses"))
        throw new Error("Wrong test provider");
      return provider.streamSimple(model, context, {
        ...options,
        apiKey: token,
        transport: "sse",
        fetch: Object.assign(
          () => {
            requested.resolve(undefined);
            return answer.promise.then(
              () => new Response("Synthetic offline stop", { status: 400 }),
            );
          },
          {
            preconnect: () => {
              throw new Error("The offline provider must not preconnect");
            },
          },
        ),
      });
    },
  });
  const host = await openPrivateLocalRuntimeHost(
    { invocationRoot: root, providerId: "openai", modelId: "gpt-6-sol" },
    models,
  );
  try {
    expect(await host.idle()).toBe(true);
    for (const requestId of ["running", "queued"])
      await host.session.command({
        type: "prompt",
        delivery: "followUp",
        requestId,
        text: "Wait for the held model request",
      });
    await requested.promise;
    // One job runs while the next waits in its Watchdog queue.
    expect(await host.idle()).toBe(false);
  } finally {
    answer.resolve(undefined);
    await host.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
