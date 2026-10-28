import { describe, expect, it, vi } from "vitest";
import { LocalExtensionError } from "../src/local-extensions.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ShiitakeAgent, ShiitakeSession } from "@fungi.computer/shiitake";
import type {
  ExtensionCommandCallerV0,
  Json,
} from "@fungi.computer/shiitake/extensions";

import type { LocalAgentControlDirectory } from "../src/private-local-agent-control.js";

import {
  createLocalServiceOwners,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import {
  LocalStoreSchemaError,
  readPrivateLocalAgentProfile,
} from "../src/private-local-session-discovery.js";
import { writeFreshStore } from "./fixtures/fresh-store.js";
import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";
import { LocalSandboxUnavailable } from "../src/private-local-containment.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";

describe("persistent Local service owners", () => {
  it("rejects a pre-mode Agent store with LocalStoreSchemaError rather than defaulting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-pre-mode-store-"));
    const path = join(root, "agent.sqlite");
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "CREATE TABLE private_local_identity (singleton INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT, created_by TEXT, archived INTEGER NOT NULL, folder TEXT NOT NULL, require_sandbox INTEGER NOT NULL)",
      );
      database.exec(
        "INSERT INTO private_local_identity VALUES (1, 'old', 'Old', NULL, 0, '.', 0)",
      );
    } finally {
      database.close();
    }
    try {
      expect(() => readPrivateLocalAgentProfile(path)).toThrow(
        LocalStoreSchemaError,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("passes the mode before opening can execute or recover affected work", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-required-open-")),
    );
    const databasePath = join(root, "agent.sqlite");
    writeFreshStore(databasePath, "owned opener fixture");
    let openedWithRequirement = false;
    let recoveredWithoutRequirement = false;
    const owners = createLocalServiceOwners((options) => {
      openedWithRequirement = options.mode === "workspace";
      // Model an opener that begins recovery before resolving. A setter on
      // the returned host would already be too late at this boundary.
      if (options.mode !== "workspace") recoveredWithoutRequirement = true;
      return Promise.reject(
        new LocalSandboxUnavailable({
          kind: "install",
          message: "Owned missing-backend fixture",
        }),
      );
    });
    try {
      await expect(
        owners.select({
          invocationRoot: root,
          databasePath,
          sessionId: "main",
          mode: "workspace",
        }),
      ).rejects.toBeInstanceOf(LocalSandboxUnavailable);
      expect(openedWithRequirement).toBe(true);
      expect(recoveredWithoutRequirement).toBe(false);
    } finally {
      await owners.close();
      await rm(root, { recursive: true });
    }
  });

  it("hands the invoking Agent Session to the child's question owner as the authenticated caller and returns its typed result", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-parent-answer-auth")),
    );
    const parentAgentId = "local_store_parent";
    const childAgentId = "local_store_child";
    const parentPath = join(
      root,
      ".fungi",
      "agents",
      parentAgentId,
      "agent.sqlite",
    );
    const childPath = join(
      root,
      ".fungi",
      "agents",
      childAgentId,
      "agent.sqlite",
    );
    await Promise.all(
      [parentPath, childPath].map((path) =>
        mkdir(dirname(path), { recursive: true }),
      ),
    );
    writeFreshStore(parentPath, "Parent");
    writeFreshStore(childPath, "Child", parentAgentId);
    const calls: unknown[] = [];
    let directory: LocalAgentControlDirectory | undefined;
    const owners = createLocalServiceOwners((options) => {
      directory ??= options.agentControl;
      const databasePath = options.databasePath ?? parentPath;
      const agentId = basename(dirname(databasePath));
      return Promise.resolve({
        databasePath,
        agentId,
        name: agentId,
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("unused"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        getSession: (sessionId: string) => {
          const unusedSessionOperation = (): never => {
            throw new Error("This answer-routing fixture operation is unused");
          };
          const session: ShiitakeSession = {
            address: `session:${sessionId}`,
            command: unusedSessionOperation,
            withdraw: unusedSessionOperation,
            abort: unusedSessionOperation,
            send: unusedSessionOperation,
            cancel: unusedSessionOperation,
            latestPending: unusedSessionOperation,
            extension: () => ({
              call: (
                command: string,
                input: Json,
                caller: ExtensionCommandCallerV0 | undefined,
              ) => {
                calls.push({ sessionId, command, input, caller });
                return Promise.resolve(
                  command === "escalateAgent"
                    ? { result: "escalated", to: "person" }
                    : {
                        result: {
                          result: "accepted",
                          via: "follow_up",
                          commandId: "follow-up-1",
                        },
                        answeredBy: { kind: "agent", agentId: parentAgentId },
                      },
                );
              },
            }),
            modelPreference: {
              read: unusedSessionOperation,
              set: unusedSessionOperation,
            },
            read: unusedSessionOperation,
            readSettlement: unusedSessionOperation,
            subscribe: unusedSessionOperation,
            watch: unusedSessionOperation,
          };
          return session;
        },
        bindSessionPath: () => true,
        close: () => Promise.resolve(),
      });
    });
    const signal = new AbortController().signal;
    try {
      await owners.select({
        invocationRoot: root,
        databasePath: parentPath,
        sessionId: "sender-session",
      });
      if (directory === undefined) throw new Error("Local directory missing");
      const input = {
        agentId: childAgentId,
        sessionId: "child-session",
        askId: "ask-1",
        requestId: "answer-1",
        answers: { storage: { selected: ["SQLite"] } },
      };
      await expect(
        directory.answer(input, parentAgentId, "sender-session", signal),
      ).resolves.toEqual({
        status: "answered",
        via: "follow_up",
        commandId: "follow-up-1",
      });
      await expect(
        directory.escalate(
          {
            agentId: childAgentId,
            sessionId: "child-session",
            itemId: "ask-1",
          },
          parentAgentId,
          "sender-session",
          signal,
        ),
      ).resolves.toEqual({ status: "escalated", to: "person" });
      const caller = { agentId: parentAgentId, sessionId: "sender-session" };
      expect(calls).toEqual([
        {
          sessionId: "child-session",
          command: "answerAgent",
          input: {
            askId: "ask-1",
            requestId: "answer-1",
            answers: { storage: { selected: ["SQLite"] } },
          },
          caller,
        },
        {
          sessionId: "child-session",
          command: "escalateAgent",
          input: { askId: "ask-1" },
          caller,
        },
      ]);
    } finally {
      await owners.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps owners usable after a failed recovery write and saves on the next open", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "fungi-service-recovery-failure-"),
    );
    const databasePath = join(root, "agent.sqlite");
    const recoveryDirectory = join(root, "not-a-directory");
    await writeFile(databasePath, "fixture");
    await mkdir(recoveryDirectory);
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
        name: "fake-agent",
        bindSessionPath: () => true,
        close: () => Promise.reject(closeFailure),
      });
    }, recoveryDirectory);
    try {
      // Confirm initial absence before obstructing writes. An initial read
      // failure instead disables persistence for this service's lifetime.
      await owners.restore();
      await rm(recoveryDirectory, { recursive: true });
      await writeFile(recoveryDirectory, "fixture");
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
        name: "fake-agent",
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
    const creator = join(
      root,
      ".fungi",
      "agents",
      "local_store_creator",
      "agent.sqlite",
    );
    await mkdir(dirname(creator), { recursive: true });
    writeFreshStore(creator, null);
    let directory: LocalAgentControlDirectory | undefined;
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
        name: "fake-agent",
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
      const signal = new AbortController().signal;
      await expect(
        activeDirectory.create(
          {
            requestId: "invalid-owner",
            createdBy: "local_store_creator",
            createdBySessionId: "creator-session",
          },
          signal,
        ),
      ).rejects.toThrow("Local model configuration is invalid");
      expect(
        (await activeDirectory.list(signal)).map(({ agentId }) => agentId),
      ).toEqual(["local_store_creator"]);
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
          name: string;
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
      name: "fake-agent",
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
        name: "fake-agent",
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
        name: "fake-agent",
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
          name: string;
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
      name: "fake-agent",
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
        name: "fake-agent",
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
        name: "fake-agent",
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
    const creatorDatabasePath = join(
      root,
      ".fungi",
      "agents",
      "local_store_creator",
      "agent.sqlite",
    );
    await mkdir(dirname(creatorDatabasePath), { recursive: true });
    writeFreshStore(creatorDatabasePath, null);
    const creator = "local_store_creator";
    const openedPaths: string[] = [];
    const enabledExtensionCalls: string[] = [];
    const extensionOwner = {
      assertHeldByAgent: () => Promise.resolve(),
      enableAgent: (storeDirectory: string, id: string) => {
        enabledExtensionCalls.push(`${storeDirectory}:${id}`);
        return Promise.resolve({
          revision: "test",
          capabilities: [],
          skills: false,
        });
      },
    };
    let directory: LocalAgentControlDirectory | undefined;
    const requireDirectory = (): LocalAgentControlDirectory => {
      const current = directory;
      if (current === undefined)
        throw new Error("Local directory not supplied");
      return current;
    };
    const openRuntime: OpenLocalServiceRuntime = async (options) => {
      if (options.agentControl !== undefined)
        directory ??= options.agentControl;
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
        name: "fake-agent",
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
    const owners = createLocalServiceOwners(
      openRuntime,
      undefined,
      extensionOwner,
    );
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
        directory.create(
          {
            requestId: "request-one",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          signal,
        ),
        directory.create(
          {
            requestId: "request-one",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          signal,
        ),
      ]);
      expect(first).toEqual(concurrentRetry);
      expect(enabledExtensionCalls).toHaveLength(2);
      await expect(
        directory.create(
          {
            requestId: "request-one",
            createdBy: creator,
            createdBySessionId: "sibling-session",
            extensions: ["counter"],
          },
          signal,
        ),
      ).rejects.toMatchObject({
        name: "AgentCreateRefused",
        reason: "request_conflict",
      });
      expect(enabledExtensionCalls).toHaveLength(2);
      await expect(
        directory.create(
          {
            requestId: "request-one",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          signal,
        ),
      ).resolves.toEqual(first);
      expect(first.agentId).toBe(
        (await resolvePrivateLocalCreateStore(root, "request-one")).agentId,
      );
      await owners.close();

      directory = undefined;
      restarted = createLocalServiceOwners(
        openRuntime,
        undefined,
        extensionOwner,
      );
      await restarted.select({
        invocationRoot: root,
        databasePath: creatorDatabasePath,
        sessionId: "main",
      });
      const restartedDirectory = requireDirectory();
      const opened = await restartedDirectory.open(first.agentId, signal);
      await opened.release();
      await expect(
        restartedDirectory.create(
          {
            requestId: "request-one",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          signal,
        ),
      ).resolves.toEqual(first);
      expect(openedPaths).toHaveLength(4);
      await expect(
        restartedDirectory.create(
          {
            requestId: "request-two",
            createdBy: creator,
            createdBySessionId: "parent-session",
          },
          signal,
        ),
      ).resolves.not.toEqual(first);
      expect(openedPaths).toHaveLength(5);
      expect(openedPaths[1]).toBe(openedPaths[3]);
      expect(openedPaths[4]).not.toBe(openedPaths[1]);
      expect(
        new Set(
          openedPaths
            .slice(1)
            .filter(
              (path) =>
                path.includes("/.fungi/agents/") &&
                path !== creatorDatabasePath,
            ),
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
  writeFreshStore(own, "owner agent");
  writeFreshStore(peer, null);
  await writeFile(join(foreign, "agent.sqlite"), "fixture");
  await symlink(foreign, join(stores, "foreign"));
  let directory: LocalAgentControlDirectory | undefined;
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
      name: "fake-agent",
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
    expect(
      (await directory.list(signal)).map(({ agentId, name }) => ({
        agentId,
        name,
      })),
    ).toEqual(
      expect.arrayContaining([
        { agentId: "local_store_owner", name: "owner agent" },
        { agentId: "local_store_peer", name: "local_store_peer" },
      ]),
    );
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
  "handles %s recovery input without blocking usable Agents",
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
        // It holds work, so shutdown keeps its reference for the next start.
        idle: () => Promise.resolve({ idle: false, wakeAt: null }),
        getSession: (sessionId) =>
          // SAFETY: This fixture observes only the Session address.
          ({ address: `session:${sessionId}` }) as ShiitakeSession,
        name: "fake-agent",
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
      if (kind === "corrupt")
        expect(await readFile(recoveryPath, "utf8")).toBe("{invalid");
      else
        expect(JSON.parse(await readFile(recoveryPath, "utf8"))).toEqual([
          reference,
        ]);
      // A later client can still select even when persistence is disabled.
      expect(
        (await owners.select({ ...reference, sessionId: "main" })).databasePath,
      ).toBe(good);
      expect(opened).toEqual([good]);
      await owners.close();
      if (kind === "corrupt")
        expect(await readFile(recoveryPath, "utf8")).toBe("{invalid");
      owners = createLocalServiceOwners(openRuntime, root);
      logged.mockClear();
      await owners.restore();
      expect(opened).toEqual(kind === "corrupt" ? [good] : [good, good]);
      if (kind === "corrupt") expect(logged).toHaveBeenCalled();
      else expect(logged).not.toHaveBeenCalled();
    } finally {
      await owners.close();
      logged.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
    expect(closed).toEqual(kind === "corrupt" ? [good] : [good, good]);
  },
);

it("names the incompatible store instead of listing it by id", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-agent-legacy-")),
  );
  const path = join(
    root,
    ".fungi",
    "agents",
    "local_store_old",
    "agent.sqlite",
  );
  try {
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    try {
      database.exec(
        "CREATE TABLE private_local_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), agent_id TEXT NOT NULL UNIQUE)",
      );
    } finally {
      database.close();
    }
    expect(() => readPrivateLocalAgentProfile(path)).toThrow(
      LocalStoreSchemaError,
    );
    expect(() => readPrivateLocalAgentProfile(path)).toThrow(
      `Agent store ${path} is incompatible with this version of Fungi.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A Session that answers only its address; these proofs never read it. */
function agentControlSession(sessionId: string): ShiitakeSession {
  const unused = (): Promise<never> =>
    Promise.reject(new Error("unused in the Agent-control proofs"));
  return {
    address: `session:${sessionId}`,
    readSettlement: unused,
    latestPending: unused,
    withdraw: unused,
    read: unused,
    command: unused,
    send: unused,
    cancel: unused,
    extension: () => ({ call: unused }),
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    },
    subscribe: () => {
      throw new Error("unused in the Agent-control proofs");
    },
    watch: unused,
    abort: () => Promise.resolve(),
  };
}

describe("an Agent creating an Agent", () => {
  const creator = "local_store_creator";

  /** A project with one existing creator Agent and a fake owner of what each Agent (by id) holds. */
  async function project(held: Readonly<Record<string, readonly string[]>>) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-service-agent-ceiling-")),
    );
    const creatorStore = join(root, ".fungi", "agents", creator);
    await mkdir(creatorStore, { recursive: true });
    writeFreshStore(join(creatorStore, "agent.sqlite"), "maker");
    const opened: Parameters<OpenLocalServiceRuntime>[0][] = [];
    const enabled: {
      store: string;
      id: string;
      requester: string | undefined;
    }[] = [];
    let directory: LocalAgentControlDirectory | undefined;
    const owners = createLocalServiceOwners(
      async (options) => {
        opened.push(options);
        if (options.agentControl !== undefined)
          directory ??= options.agentControl;
        return {
          databasePath:
            options.databasePath ??
            (
              await resolvePrivateLocalCreateStore(
                root,
                options.createRequestId ?? "unused",
              )
            ).databasePath,
          agentId: "fixture-agent",
          listSessions: () =>
            Promise.resolve({ sessions: [], next: undefined }),
          createSession: () => Promise.resolve("unused"),
          deleteSession: () => Promise.resolve(false),
          extensions: unusedExtensions,
          name: "fake-agent",
          bindSessionPath: () => true,
          effectiveModel: fixtureEffectiveModel,
          ...fixtureModelControls,
          ...fixtureMailControls,
          getSession: (sessionId: string): ShiitakeSession =>
            agentControlSession(sessionId),
          close: () => Promise.resolve(),
        };
      },
      undefined,
      {
        assertHeldByAgent: (store, ids) => {
          const holds = held[basename(store)] ?? [];
          const missing = ids.filter((id) => !holds.includes(id));
          return missing.length === 0
            ? Promise.resolve()
            : Promise.reject(
                new LocalExtensionError(
                  "not-held",
                  `does not hold ${missing.join(", ")}`,
                ),
              );
        },
        enableAgent: (store, id, requester) => {
          enabled.push({
            store,
            id,
            requester: requester?.agentStoreDirectory,
          });
          return Promise.resolve({
            revision: "r1",
            capabilities: [],
            skills: false,
          });
        },
      },
    );
    await owners.select({
      invocationRoot: root,
      databasePath: join(creatorStore, "agent.sqlite"),
      sessionId: "main",
    });
    if (directory === undefined) throw new Error("Local directory missing");
    return { root, creatorStore, opened, enabled, directory, owners };
  }

  it("passes a read-only creator's mode and folder to its child, never the new-Agent default", async () => {
    const local = await project({});
    const database = new DatabaseSync(join(local.creatorStore, "agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE private_local_identity SET mode = ? WHERE singleton = 1",
        )
        .run("read-only");
    } finally {
      database.close();
    }
    try {
      await local.directory.create(
        {
          requestId: "read-only-child",
          createdBy: creator,
          createdBySessionId: "parent-session",
        },
        new AbortController().signal,
      );
      expect(
        local.opened.find(
          ({ createRequestId }) => createRequestId === "read-only-child",
        ),
      ).toMatchObject({ mode: "read-only", folder: "." });
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("refuses widening a created Agent beyond its read-only creator", async () => {
    const local = await project({});
    const creatorDatabase = new DatabaseSync(
      join(local.creatorStore, "agent.sqlite"),
    );
    try {
      creatorDatabase
        .prepare(
          "UPDATE private_local_identity SET mode = ? WHERE singleton = 1",
        )
        .run("read-only");
    } finally {
      creatorDatabase.close();
    }
    const child = join(
      local.root,
      ".fungi",
      "agents",
      "local_store_child",
      "agent.sqlite",
    );
    await mkdir(dirname(child), { recursive: true });
    writeFreshStore(child, "child", creator);
    const childDatabase = new DatabaseSync(child);
    try {
      childDatabase
        .prepare(
          "UPDATE private_local_identity SET mode = ? WHERE singleton = 1",
        )
        .run("read-only");
    } finally {
      childDatabase.close();
    }
    try {
      await expect(
        local.owners.select({
          invocationRoot: local.root,
          databasePath: child,
          mode: "full-access",
        }),
      ).rejects.toMatchObject({
        name: "AgentCreateRefused",
        reason: "exceeds_creator",
      });
      expect(readPrivateLocalAgentProfile(child).mode).toBe("read-only");
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("gives an Agent no more permissions than its maker: asking for what the creator lacks is refused and creates nothing", async () => {
    const local = await project({});
    try {
      await expect(
        local.directory.create(
          {
            requestId: "too-much",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        name: "AgentCreateRefused",
        reason: "exceeds_creator",
      });
      await expect(
        local.directory.create(
          {
            requestId: "too-much",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["counter"],
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/does not hold counter/u);
      expect(local.enabled).toEqual([]);
      expect(
        local.opened.filter(({ createRequestId }) => createRequestId),
      ).toEqual([]);
      expect(await readdir(join(local.root, ".fungi", "agents"))).toEqual([
        creator,
      ]);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("refuses the whole request when only some of the extensions are held", async () => {
    const local = await project({ [creator]: ["held"] });
    try {
      await expect(
        local.directory.create(
          {
            requestId: "partial",
            createdBy: creator,
            createdBySessionId: "parent-session",
            extensions: ["held", "lacking"],
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ reason: "exceeds_creator" });
      expect(local.enabled).toEqual([]);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("lets an Agent pass down an extension it holds, records its creator, and copies nothing else", async () => {
    const local = await project({ [creator]: ["counter", "notes"] });
    try {
      const made = await local.directory.create(
        {
          requestId: "pass-down",
          createdBy: creator,
          createdBySessionId: "parent-session",
          extensions: ["counter"],
        },
        new AbortController().signal,
      );
      const childStore = dirname(
        (await resolvePrivateLocalCreateStore(local.root, "pass-down"))
          .databasePath,
      );
      expect(made.agentId).toBe(childStore.split("/").at(-1));
      expect(local.enabled).toEqual([
        {
          store: childStore,
          id: "counter",
          requester: local.creatorStore,
        },
      ]);
      expect(
        local.opened.find(({ createRequestId }) => createRequestId)?.createdBy,
      ).toBe(creator);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("starts a created Agent with the base roster only when no extensions are named", async () => {
    const local = await project({});
    try {
      await local.directory.create(
        {
          requestId: "floor",
          createdBy: creator,
          createdBySessionId: "parent-session",
        },
        new AbortController().signal,
      );
      expect(local.enabled).toEqual([]);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("refuses a create whose creating Agent is not in the project", async () => {
    const local = await project({});
    try {
      await expect(
        local.directory.create(
          {
            requestId: "orphan",
            createdBy: "local_store_stranger",
            createdBySessionId: "stranger-session",
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ reason: "no_creator" });
      expect(
        local.opened.filter(({ createRequestId }) => createRequestId),
      ).toEqual([]);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("lists who created an Agent, and nothing for an Agent a human made", async () => {
    const local = await project({});
    try {
      const madeStore = join(
        local.root,
        ".fungi",
        "agents",
        "local_store_fixer",
      );
      await mkdir(madeStore, { recursive: true });
      writeFreshStore(join(madeStore, "agent.sqlite"), "fixer", creator);
      const listed = await local.directory.list(new AbortController().signal);
      expect(
        listed
          .map(({ agentId, createdBy }) => ({ agentId, createdBy }))
          .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual([
        { agentId: creator, createdBy: null },
        { agentId: "local_store_fixer", createdBy: creator },
      ]);
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });

  it("fails only the row of a store written before the current schema; the other Agents still list", async () => {
    const local = await project({});
    try {
      const madeStore = join(
        local.root,
        ".fungi",
        "agents",
        "local_store_fixer",
      );
      await mkdir(madeStore, { recursive: true });
      writeFreshStore(join(madeStore, "agent.sqlite"), "fixer", creator);
      const oldStore = join(local.root, ".fungi", "agents", "local_store_old");
      await mkdir(oldStore, { recursive: true });
      new DatabaseSync(join(oldStore, "agent.sqlite")).close();
      const log = vi.spyOn(globalThis.console, "error").mockReturnValue();
      try {
        const listed = await local.directory.list(new AbortController().signal);
        expect(
          listed
            .map(({ agentId, unreadable }) => ({
              agentId,
              unreadable: unreadable !== undefined,
            }))
            .sort((a, b) => a.agentId.localeCompare(b.agentId)),
        ).toEqual([
          { agentId: creator, unreadable: false },
          { agentId: "local_store_fixer", unreadable: false },
          { agentId: "local_store_old", unreadable: true },
        ]);
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    } finally {
      await local.owners.close();
      await rm(local.root, { recursive: true, force: true });
    }
  });
});
