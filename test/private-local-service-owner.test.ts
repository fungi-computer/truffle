import { describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ShiitakeAgent, ShiitakeSession } from "@fungi.computer/shiitake";

import type { AgentControlDirectory } from "@fungi.computer/shiitake/agent-control";

import {
  createLocalServiceOwners,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";

type LocalCreateDirectory = AgentControlDirectory &
  Readonly<{
    create: (
      input: Readonly<{ requestId: string }>,
      signal: AbortSignal,
    ) => Promise<Readonly<{ agentId: string; name: string }>>;
  }>;

describe("persistent Local service owners", () => {
  it("keeps owners usable after a failed recovery write and saves on the next open", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "fungi-service-recovery-failure-"),
    );
    const databasePath = join(root, "agent.sqlite");
    const recoveryDirectory = join(root, "not-a-directory");
    await writeFile(databasePath, "fixture");
    await writeFile(recoveryDirectory, "fixture");
    const closeFailure = new Error("Runtime has not drained");
    let opens = 0;
    const owners = createLocalServiceOwners((options) => {
      opens += 1;
      return Promise.resolve({
        databasePath: options.databasePath ?? databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("unused"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This fixture observes only the Session address.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        bindSessionPath: () => true,
        close: () => Promise.reject(closeFailure),
      });
    }, recoveryDirectory);
    try {
      const selection = {
        invocationRoot: root,
        databasePath,
        sessionId: "main",
      };
      expect((await owners.select(selection)).databasePath).toBe(databasePath);
      await rm(recoveryDirectory);
      await mkdir(recoveryDirectory);
      expect((await owners.select(selection)).databasePath).toBe(databasePath);
      expect(opens).toBe(1);
      const second = join(root, "second.sqlite");
      await writeFile(second, "fixture");
      await owners.select({ ...selection, databasePath: second });
      expect(opens).toBe(2);
      expect(
        JSON.parse(
          await readFile(join(recoveryDirectory, "owners.json"), "utf8"),
        ),
      ).toEqual([
        { invocationRoot: root, databasePath },
        { invocationRoot: root, databasePath: second },
      ]);
      // A failed reference write must not erase an undrained runtime from the
      // service's close responsibility or let it release the owner lock.
      await expect(owners.close()).rejects.toThrow(
        "Local service owners failed to close",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds different client PATHs to different sessions on one shared owner", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-paths-")),
    );
    const databasePath = join(root, "agent.sqlite");
    await writeFile(databasePath, "fixture");
    const paths = new Map<string, string>();
    let opens = 0;
    const owners = createLocalServiceOwners(() => {
      opens += 1;
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("fresh"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This fixture observes only the Session address.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        bindSessionPath: (sessionId: string, path: string) => {
          const previous = paths.get(sessionId);
          if (previous !== undefined && previous !== path) return false;
          paths.set(sessionId, path);
          return true;
        },
        close: () => Promise.resolve(),
      });
    });
    try {
      await owners.select({
        invocationRoot: root,
        databasePath,
        sessionId: "a",
        clientPath: "/toolchain/a:/usr/bin",
      });
      await owners.select({
        invocationRoot: root,
        databasePath,
        sessionId: "b",
        clientPath: "/toolchain/b:/usr/bin",
      });
      expect(opens).toBe(1);
      expect(paths).toEqual(
        new Map([
          ["a", "/toolchain/a:/usr/bin"],
          ["b", "/toolchain/b:/usr/bin"],
        ]),
      );
      await expect(
        owners.select({
          invocationRoot: root,
          databasePath,
          sessionId: "a",
          clientPath: "/toolchain/b:/usr/bin",
        }),
      ).rejects.toThrow(/PATH.*session/u);
    } finally {
      await owners.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not return or discover an Agent when owner creation fails", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-agent-create-failure-")),
    );
    const creator = join(root, "creator.sqlite");
    await writeFile(creator, "fixture");
    let directory: AgentControlDirectory | undefined;
    const owners = createLocalServiceOwners((options) => {
      if (options.agentControl !== undefined)
        directory ??= options.agentControl;
      if (options.createRequestId !== undefined)
        return Promise.reject(
          new Error("Local model configuration is invalid"),
        );
      return Promise.resolve({
        databasePath: options.databasePath ?? creator,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("unused"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This fixture observes only Session identity.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    try {
      await owners.select({
        invocationRoot: root,
        databasePath: creator,
        sessionId: "main",
      });
      if (directory === undefined) throw new Error("Local directory missing");
      const activeDirectory = directory;
      if (activeDirectory.create === undefined)
        throw new Error("Local Agent creation is unavailable");
      const signal = new AbortController().signal;
      await expect(
        activeDirectory.create({ requestId: "invalid-owner" }, signal),
      ).rejects.toThrow("Local model configuration is invalid");
      expect(await activeDirectory.list(signal)).toEqual([]);
    } finally {
      await owners.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares a concurrent project opener and closes its store only at service stop", async () => {
    const opening = Promise.withResolvers<
      typeof fixtureModelControls &
        typeof fixtureMailControls & {
          databasePath: string;
          agentId: string;
          getSession: (sessionId: string) => ShiitakeSession;
          bindSessionPath: (sessionId: string, path: string) => boolean;
          listSessions: ShiitakeAgent["listSessions"];
          createSession: ShiitakeAgent["createSession"];
          deleteSession: ShiitakeAgent["deleteSession"];
          extensions: ShiitakeAgent["extensions"];
          effectiveModel: typeof fixtureEffectiveModel;
          close: () => Promise<void>;
        }
    >();
    let opens = 0;
    let closes = 0;
    const owners = createLocalServiceOwners(() => {
      opens += 1;
      return opening.promise;
    });
    const selection = { invocationRoot: process.cwd(), sessionId: "main" };
    const first = owners.select(selection);
    const second = owners.select(selection);
    opening.resolve({
      databasePath: "/tmp/service-agent.sqlite",
      agentId: "service-agent",
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      createSession: () => Promise.resolve("fresh-session"),
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      bindSessionPath: () => true,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      getSession: (sessionId) =>
        // SAFETY: This owner fixture only returns Session identity; no Session methods are invoked.
        ({ address: `session:${sessionId}` }) as ShiitakeSession,
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    });

    const [firstSelected, secondSelected] = await Promise.all([first, second]);
    expect(opens).toBe(1);
    expect(firstSelected.session.address).toBe("session:main");
    expect(secondSelected.session.address).toBe("session:main");
    expect(closes).toBe(0);

    await Promise.all([owners.close(), owners.close()]);
    expect(closes).toBe(1);
    await expect(owners.select(selection)).rejects.toThrow("stopping");
  });

  it("captures one hosted connection across clients and rejects explicit retargeting", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-mcp-")),
    );
    const databasePath = join(root, "agent.sqlite");
    const otherDatabasePath = join(root, "other-agent.sqlite");
    await writeFile(databasePath, "fixture");
    await writeFile(otherDatabasePath, "fixture");
    const captured: Parameters<OpenLocalServiceRuntime>[0][] = [];
    const owners = createLocalServiceOwners((options) => {
      captured.push(options);
      return Promise.resolve({
        databasePath: options.databasePath ?? databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("new-session"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: The fixture observes only Session identity, never Session methods.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    const base = { invocationRoot: root, databasePath, sessionId: "main" };
    const fungiMcp = {
      endpoint: "https://hub.test/api/teams/selected/mcp",
    };
    try {
      await Promise.all([
        owners.select({ ...base, fungiMcp }),
        owners.select({ ...base, fungiMcp }),
      ]);
      await owners.select({ ...base, sessionId: "other" });
      await owners.createSession({ ...base, requestId: "mcp-new", fungiMcp });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.fungiMcp?.endpoint.href).toBe(fungiMcp.endpoint);
      expect(captured[0]?.fungiMcp?.authProvider).toBeDefined();
      await expect(
        owners.select({
          ...base,
          fungiMcp: {
            ...fungiMcp,
            endpoint: "https://hub.test/api/teams/other/mcp",
          },
        }),
      ).rejects.toThrow("different Fungi MCP connection");
      const sameEndpoint = await owners.select({ ...base, fungiMcp });
      expect(sameEndpoint.session.address).toBe("session:main");
      await owners.select(base);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.fungiMcp?.authProvider).toBeDefined();
      const other = await owners.select({
        invocationRoot: root,
        databasePath: otherDatabasePath,
        sessionId: "main",
      });
      expect(other.databasePath).toBe(await realpath(otherDatabasePath));
      expect(captured).toHaveLength(2);
      expect(captured[1]?.fungiMcp).toBeUndefined();
    } finally {
      await owners.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid connection inputs before opening an Agent", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-mcp-input-")),
    );
    let opens = 0;
    const owners = createLocalServiceOwners(() => {
      opens++;
      return Promise.reject(new Error("must not open"));
    });
    const select = (endpoint: string) =>
      owners.select({
        invocationRoot: root,
        sessionId: "main",
        fungiMcp: { endpoint },
      });
    try {
      await expect(select("https://secret@hub.test/mcp")).rejects.toThrow(
        "Invalid Fungi MCP connection selection",
      );
      await expect(select("http://hub.test/mcp")).rejects.toThrow(
        "Invalid Fungi MCP connection selection",
      );
      await expect(select("not-a-url")).rejects.toThrow(
        "Invalid Fungi MCP connection selection",
      );
      expect(opens).toBe(0);
    } finally {
      await owners.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("addresses another Session through the same opened store", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-owner-")),
    );
    const databasePath = join(root, "existing-agent.sqlite");
    await writeFile(databasePath, "fixture");
    let opens = 0;
    const owners = createLocalServiceOwners(() => {
      opens += 1;
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("fresh-session"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This owner fixture only returns Session identity; no Session methods are invoked.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    const base = {
      invocationRoot: process.cwd(),
      databasePath,
    };

    const first = await owners.select({ ...base, sessionId: "main" });
    const second = await owners.select({ ...base, sessionId: "other" });
    expect(opens).toBe(1);
    expect(first.session.address).toBe("session:main");
    expect(second.session.address).toBe("session:other");
    await owners.close();
  });

  it("shares an explicit store with later and concurrent project selection", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-alias-")),
    );
    const databasePath = join(root, "agent.sqlite");
    await writeFile(databasePath, "fixture");
    const opening = Promise.withResolvers<
      typeof fixtureModelControls &
        typeof fixtureMailControls & {
          databasePath: string;
          agentId: string;
          getSession: (sessionId: string) => ShiitakeSession;
          bindSessionPath: (sessionId: string, path: string) => boolean;
          listSessions: ShiitakeAgent["listSessions"];
          createSession: ShiitakeAgent["createSession"];
          deleteSession: ShiitakeAgent["deleteSession"];
          extensions: ShiitakeAgent["extensions"];
          effectiveModel: typeof fixtureEffectiveModel;
          close: () => Promise<void>;
        }
    >();
    let opens = 0;
    const owners = createLocalServiceOwners(() => {
      opens += 1;
      return opening.promise;
    });
    const explicit = owners.select({
      invocationRoot: root,
      databasePath,
      sessionId: "explicit",
    });
    const project = owners.select({
      invocationRoot: root,
      sessionId: "project",
    });
    opening.resolve({
      databasePath,
      agentId: "fixture-agent",
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      createSession: () => Promise.resolve("fresh-session"),
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      bindSessionPath: () => true,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      getSession: (sessionId) =>
        // SAFETY: This owner fixture only returns Session identity; no Session methods are invoked.
        ({ address: `session:${sessionId}` }) as ShiitakeSession,
      close: () => Promise.resolve(),
    });

    const [explicitSelection, projectSelection] = await Promise.all([
      explicit,
      project,
    ]);
    expect(opens).toBe(1);
    expect(explicitSelection.databasePath).toBe(databasePath);
    expect(projectSelection.databasePath).toBe(databasePath);
    expect(projectSelection.session.address).toBe("session:project");
    await owners.close();

    let reverseOpens = 0;
    const reverse = createLocalServiceOwners(() => {
      reverseOpens += 1;
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("fresh-session"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This owner fixture only returns Session identity; no Session methods are invoked.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    await reverse.select({ invocationRoot: root, sessionId: "project" });
    await reverse.select({
      invocationRoot: root,
      databasePath,
      sessionId: "explicit",
    });
    expect(reverseOpens).toBe(1);
    await reverse.close();
  });

  it("creates distinct Sessions in one pinned store and keeps prior Sessions selectable", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-create-")),
    );
    const databasePath = join(root, "agent.sqlite");
    await writeFile(databasePath, "fixture");
    let opens = 0;
    let creations = 0;
    const owners = createLocalServiceOwners(() => {
      opens += 1;
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () =>
          Promise.resolve(`owner-session-${String(++creations)}`),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This owner fixture only returns Session identity; no Session methods are invoked.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    const main = await owners.select({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    const fresh = await owners.createSession({
      invocationRoot: root,
      databasePath,
      requestId: "fresh-one",
    });
    expect(fresh.databasePath).toBe(main.databasePath);
    expect(fresh.sessionId).toBe("owner-session-1");
    expect(creations).toBe(1);
    expect(fresh.sessionId).not.toBe("main");
    const reopenedMain = await owners.select({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    expect(reopenedMain.session.address).toBe("session:main");
    expect(opens).toBe(1);
    await owners.close();
  });

  it("coalesces concurrent create retries and replays the identity after service restart", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-agent-create-")),
    );
    const creatorDatabasePath = join(root, "creator.sqlite");
    await writeFile(creatorDatabasePath, "fixture");
    const openedPaths: string[] = [];
    let directory: LocalCreateDirectory | undefined;
    const requireDirectory = (): LocalCreateDirectory => {
      const current = directory;
      if (current === undefined)
        throw new Error("Local directory not supplied");
      return current;
    };
    const openRuntime: OpenLocalServiceRuntime = async (options) => {
      if (options.agentControl !== undefined)
        // SAFETY: This fixture supplies the service's Agent-create directory and exercises its required create method.
        directory ??= options.agentControl as LocalCreateDirectory;
      const databasePath =
        options.createRequestId === undefined
          ? (options.databasePath ?? join(root, "default.sqlite"))
          : (
              await resolvePrivateLocalCreateStore(
                root,
                options.createRequestId,
              )
            ).databasePath;
      if (options.createRequestId !== undefined) {
        await mkdir(dirname(databasePath), { recursive: true });
        await writeFile(databasePath, "fixture");
      }
      openedPaths.push(databasePath);
      return {
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("unused"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) =>
          // SAFETY: This fixture observes only Session identity.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      };
    };
    const signal = new AbortController().signal;
    const owners = createLocalServiceOwners(openRuntime);
    let restarted: ReturnType<typeof createLocalServiceOwners> | undefined;
    try {
      await owners.select({
        invocationRoot: root,
        databasePath: creatorDatabasePath,
        sessionId: "main",
      });
      if (directory === undefined)
        throw new Error("Local directory not supplied");

      const [first, concurrentRetry] = await Promise.all([
        directory.create({ requestId: "request-one" }, signal),
        directory.create({ requestId: "request-one" }, signal),
      ]);
      expect(first).toEqual(concurrentRetry);
      expect(first.agentId).toBe(
        (await resolvePrivateLocalCreateStore(root, "request-one")).agentId,
      );
      await owners.close();

      directory = undefined;
      restarted = createLocalServiceOwners(openRuntime);
      await restarted.select({
        invocationRoot: root,
        databasePath: creatorDatabasePath,
        sessionId: "main",
      });
      const restartedDirectory = requireDirectory();
      const opened = await restartedDirectory.open(first.agentId, signal);
      await opened.release();
      await expect(
        restartedDirectory.create({ requestId: "request-one" }, signal),
      ).resolves.toEqual(first);
      expect(openedPaths).toHaveLength(4);
      await expect(
        restartedDirectory.create({ requestId: "request-two" }, signal),
      ).resolves.not.toEqual(first);
      expect(openedPaths).toHaveLength(5);
      expect(openedPaths[1]).toBe(openedPaths[3]);
      expect(openedPaths[4]).not.toBe(openedPaths[1]);
      expect(
        new Set(
          openedPaths
            .slice(1)
            .filter((path) => path.includes("/.fungi/agents/")),
        ),
      ).toHaveProperty("size", 2);
    } finally {
      await Promise.all([owners.close(), restarted?.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("scopes Agent control to project stores and retains service ownership", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-agent-control-")),
  );
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-agent-outside-")),
  );
  const stores = join(root, ".fungi", "agents");
  const own = join(stores, "local_store_owner", "agent.sqlite");
  const peer = join(stores, "local_store_peer", "agent.sqlite");
  const foreign = join(outside, "local_store_foreign");
  await Promise.all([
    mkdir(join(stores, "local_store_owner"), { recursive: true }),
    mkdir(join(stores, "local_store_peer"), { recursive: true }),
    mkdir(foreign),
  ]);
  await Promise.all([
    writeFile(own, "fixture"),
    writeFile(peer, "fixture"),
    writeFile(join(foreign, "agent.sqlite"), "fixture"),
  ]);
  await symlink(foreign, join(stores, "foreign"));
  let directory: AgentControlDirectory | undefined;
  let foreignHasControl = false;
  let opens = 0;
  let closes = 0;
  const owners = createLocalServiceOwners((options) => {
    directory ??= options.agentControl;
    if (options.databasePath === join(foreign, "agent.sqlite"))
      foreignHasControl = options.agentControl !== undefined;
    opens += 1;
    if (options.databasePath === undefined)
      throw new Error("Expected existing store");
    return Promise.resolve({
      databasePath: options.databasePath,
      agentId: "fixture-agent",
      getSession: () => {
        throw new Error("Session access is outside this directory test");
      },
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      createSession: () => Promise.resolve("unused"),
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      bindSessionPath: () => true,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    });
  });
  try {
    // Selection reaches the injected opener before addressing its Session.
    await expect(
      owners.select({
        invocationRoot: root,
        databasePath: own,
        sessionId: "existing",
      }),
    ).rejects.toThrow("outside this directory test");
    if (directory === undefined)
      throw new Error("Agent directory not supplied");
    const signal = new AbortController().signal;
    expect(
      (await directory.list(signal)).map((entry) => entry.agentId).sort(),
    ).toEqual(["local_store_owner", "local_store_peer"]);
    await expect(directory.open("local_store_foreign", signal)).rejects.toThrow(
      "outside this Local project",
    );
    const first = await directory.open("local_store_peer", signal);
    const second = await directory.open("local_store_peer", signal);
    expect(await first.agent.listSessions()).toEqual({
      sessions: [],
      next: undefined,
    });
    expect(opens).toBe(2);
    await first.release();
    await second.release();
    expect(closes).toBe(0);
    await expect(
      owners.select({
        invocationRoot: root,
        databasePath: join(foreign, "agent.sqlite"),
        sessionId: "recovery",
      }),
    ).rejects.toThrow("outside this directory test");
    expect(foreignHasControl).toBe(false);
    await rm(join(stores, "local_store_peer"), { recursive: true });
    await expect(directory.open("local_store_peer", signal)).rejects.toThrow(
      "outside this Local project",
    );
  } finally {
    await owners.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
  expect(closes).toBe(3);
});

it.each(["corrupt", "mixed"])(
  "restores usable owners and prunes %s recovery references",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-restore-"));
    const good = join(root, "good.sqlite");
    const busy = join(root, "busy.sqlite");
    const recoveryPath = join(root, "owners.json");
    await writeFile(good, "fixture");
    await writeFile(busy, "fixture");
    const reference = { invocationRoot: root, databasePath: good };
    await writeFile(
      recoveryPath,
      kind === "corrupt"
        ? "{invalid"
        : JSON.stringify([
            { invocationRoot: join(root, "deleted"), databasePath: good },
            {
              invocationRoot: root,
              databasePath: join(root, "deleted.sqlite"),
            },
            { invocationRoot: root, databasePath: busy },
            { databasePath: good },
            reference,
            {
              invocationRoot: join(root, "deleted-after-good"),
              databasePath: good,
            },
          ]),
    );
    const opened: string[] = [];
    const closed: string[] = [];
    const openRuntime: OpenLocalServiceRuntime = (options) => {
      const databasePath = options.databasePath;
      if (databasePath === undefined)
        return Promise.reject(new Error("Expected a saved store"));
      if (databasePath === busy)
        return Promise.reject(new Error("Store is in use"));
      opened.push(databasePath);
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("unused"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId) =>
          // SAFETY: This fixture observes only the Session address.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        bindSessionPath: () => true,
        close: () => {
          closed.push(databasePath);
          return Promise.resolve();
        },
      });
    };
    let owners = createLocalServiceOwners(openRuntime, root);
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await owners.restore();
      expect(opened).toEqual(kind === "corrupt" ? [] : [good]);
      expect(logged).toHaveBeenCalled();
      expect(JSON.parse(await readFile(recoveryPath, "utf8"))).toEqual(
        kind === "corrupt" ? [] : [reference],
      );
      // A later client can still select, and the next service startup is clean.
      expect(
        (await owners.select({ ...reference, sessionId: "main" })).databasePath,
      ).toBe(good);
      expect(opened).toEqual([good]);
      await owners.close();
      owners = createLocalServiceOwners(openRuntime, root);
      logged.mockClear();
      await owners.restore();
      expect(opened).toEqual([good, good]);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      await owners.close();
      logged.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
    expect(closed).toEqual([good, good]);
  },
);
