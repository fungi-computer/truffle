import { logEvent } from "./log-event.js";
import {
  readFungiMcpSelection,
  sameFungiMcpConnection,
  FungiMcpSelectionConflict,
} from "./private-fungi-mcp-selection.js";
import type { PrivateFungiMcpConnectionOptions } from "./private-fungi-mcp-connection.js";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentControlDirectory } from "@fungi.computer/shiitake/agent-control";
import { readFile, realpath } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import * as Schema from "effect/Schema";
import { selectionSchema } from "./private-local-service-discovery.js";
import { createShiitakeHttpRoutes } from "@fungi.computer/shiitake/http";
import {
  listPrivateLocalAgentStores,
  readPrivateLocalSessionSummaries,
} from "./private-local-session-discovery.js";
import type {
  PrivateLocalServiceSelection,
  PrivateLocalSessionCreation,
} from "./private-local-service-contract.js";
import {
  createPrivateLocalSessionRequestId,
  openPrivateLocalRuntimeHost,
  resolvePrivateLocalCreateStore,
  type PrivateLocalRuntimeHost,
} from "./private-local-runtime-host.js";
import type { PrivateLocalMailRouting } from "./private-local-delegation.js";

export type LocalServiceRuntime = Pick<
  PrivateLocalRuntimeHost,
  | "databasePath"
  | "agentId"
  | "getSession"
  | "effectiveModel"
  | "setModel"
  | "assertModelReady"
  | "listSessions"
  | "createSession"
  | "deleteSession"
  | "extensions"
  | "bindSessionPath"
  | "acceptMail"
  | "readSettlement"
  | "close"
>;

export class LocalSessionPathConflict extends Error {
  override readonly name = "LocalSessionPathConflict";
  constructor() {
    super(
      "PATH differs for this live session; close its clients and restart the Local service before reconnecting from another toolchain",
    );
  }
}
type LocalAgentControlDirectory = AgentControlDirectory &
  Readonly<{
    create: (
      input: Readonly<{
        requestId: string;
        model?: import("@fungi.computer/shiitake/model-preference").ModelPreference;
      }>,
      signal: AbortSignal,
    ) => Promise<Readonly<{ agentId: string; name: string }>>;
  }>;
export type OpenLocalServiceRuntime = (
  options: Parameters<typeof openPrivateLocalRuntimeHost>[0],
) => Promise<LocalServiceRuntime>;

type LocalServiceOwner = Readonly<{
  runtime: LocalServiceRuntime;
  fungiMcp: PrivateFungiMcpConnectionOptions | undefined;
}>;

// Reopen inputs only. Credentials remain with Local's account custodian.
const recoveryOwnerSchema = selectionSchema
  .omit({ clientPath: true, sessionId: true })
  .extend({ databasePath: z.string().min(1) });
const decodeRecoveryFile = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

/** One service owns each store, independently of how many clients select it. */
export function createLocalServiceOwners(
  openRuntime: OpenLocalServiceRuntime = openPrivateLocalRuntimeHost,
  recoveryDirectory?: string,
) {
  const recoveryPath =
    recoveryDirectory === undefined
      ? undefined
      : resolve(recoveryDirectory, "owners.json");
  const recovery = new Map<string, z.infer<typeof recoveryOwnerSchema>>();
  let saving = Promise.resolve();
  const emptySessions = new Map<string, Promise<string>>();
  const owners = new Map<string, Promise<LocalServiceOwner>>();
  const opening = new Set<Promise<LocalServiceOwner>>();
  const pendingOpenings = new Set<Promise<LocalServiceOwner>>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  function saveRecovery(): Promise<void> {
    if (recoveryPath === undefined) return Promise.resolve();
    const path = recoveryPath;
    const next = saving.then(() =>
      writeFileAtomic(path, JSON.stringify([...recovery.values()]), {
        mode: 0o600,
      }),
    );
    // A recovery hint write must not hide a live owner or poison later saves.
    saving = next.catch((cause: unknown) => {
      logEvent("service-owner.save-recovery", cause);
    });
    return saving;
  }

  function trackOpening(
    pending: Promise<LocalServiceOwner>,
    invocationRoot: string,
    key: string,
  ) {
    const opened = pending;
    // Runtime ownership survives a failed recovery-reference write. Shutdown
    // must still drain it before the service can release its owner lock.
    opening.add(opened);
    void opened.catch((cause: unknown) => {
      opening.delete(opened);
      logEvent("service-owner.open-runtime", cause);
    });
    pending = pending.then(async (owner) => {
      if (recoveryPath !== undefined) {
        const reference: z.infer<typeof recoveryOwnerSchema> = {
          invocationRoot,
          databasePath: owner.runtime.databasePath,
        };
        if (owner.fungiMcp !== undefined)
          reference.fungiMcp = { endpoint: owner.fungiMcp.endpoint.href };
        recovery.set(owner.runtime.databasePath, reference);
        await saveRecovery();
      }
      return owner;
    });
    owners.set(key, pending);
    pendingOpenings.add(pending);
    void pending.then(
      (owner) => {
        owners.set(`store:${owner.runtime.databasePath}`, pending);
        const projectKey = `project:${invocationRoot}`;
        if (!owners.has(projectKey)) owners.set(projectKey, pending);
        pendingOpenings.delete(pending);
      },
      () => {
        if (owners.get(key) === pending) owners.delete(key);
        pendingOpenings.delete(pending);
      },
    );
    return pending;
  }

  function ensureRunning() {
    if (stopping) throw new Error("Local service is stopping");
  }

  function selected(owner: LocalServiceRuntime, sessionId: string) {
    return {
      agentId: owner.agentId,
      databasePath: owner.databasePath,
      sessionId,
      session: owner.getSession(sessionId),
      effectiveModel: owner.effectiveModel,
      routes: createShiitakeHttpRoutes(
        owner.getSession,
        owner.listSessions,
        owner.createSession,
        owner.deleteSession,
        () => owner.extensions,
      ),
    };
  }

  async function createSession(creation: PrivateLocalSessionCreation) {
    return select(creation, creation.requestId);
  }

  function belongsToProject(invocationRoot: string, databasePath: string) {
    const within = relative(invocationRoot, databasePath);
    return !isAbsolute(within) && within !== ".." && !within.startsWith("../");
  }

  async function selectedDatabasePath(
    invocationRoot: string,
    requested: string | undefined,
  ) {
    const databasePath =
      requested === undefined
        ? undefined
        : await realpath(resolve(invocationRoot, requested));
    if (databasePath !== undefined || owners.has(`project:${invocationRoot}`))
      return databasePath;
    const stores = await listPrivateLocalAgentStores(invocationRoot);
    ensureRunning();
    if (stores.length > 1)
      throw new Error(
        "Multiple Agent stores in this folder; select a saved conversation with fungi resume or specify --database",
      );
    return stores[0];
  }

  async function ownerFor(selection: PrivateLocalServiceSelection) {
    ensureRunning();
    const invocationRoot = await realpath(selection.invocationRoot);
    const databasePath = await selectedDatabasePath(
      invocationRoot,
      selection.databasePath,
    );
    ensureRunning();
    const fungiMcp =
      selection.fungiMcp === undefined
        ? undefined
        : readFungiMcpSelection(selection.fungiMcp);
    ensureRunning();
    // A new project selection shares its in-flight owner; explicit resume keys the store.
    const key =
      databasePath === undefined
        ? `project:${invocationRoot}`
        : `store:${databasePath}`;
    let pending = owners.get(key);
    if (pending === undefined && pendingOpenings.size > 0) {
      // A fresh project does not reveal its canonical store path until opening.
      // Let current openings install both project and store aliases, then recheck.
      await Promise.allSettled(pendingOpenings);
      ensureRunning();
      pending = owners.get(key);
    }
    if (pending === undefined) {
      const projectControl =
        databasePath === undefined ||
        belongsToProject(invocationRoot, databasePath);
      let options: Parameters<OpenLocalServiceRuntime>[0] = {
        invocationRoot,
        databasePath,
        agentControl: projectControl ? directory(invocationRoot) : undefined,
        mail: projectControl ? mailRouting(invocationRoot) : undefined,
      };
      if (fungiMcp !== undefined) options = { ...options, fungiMcp };
      pending = trackOpening(
        openRuntime(options).then((runtime) => ({ runtime, fungiMcp })),
        invocationRoot,
        key,
      );
    }
    const owner = await pending;
    ensureRunning();
    if (
      fungiMcp !== undefined &&
      !sameFungiMcpConnection(owner.fungiMcp, fungiMcp)
    )
      throw new FungiMcpSelectionConflict();
    return owner.runtime;
  }

  async function select(
    selection: PrivateLocalServiceSelection,
    createRequestId?: string,
  ) {
    const owner = await ownerFor(selection);
    let sessionId = selection.sessionId;
    if (createRequestId !== undefined) {
      sessionId = await owner.createSession(createRequestId);
      ensureRunning();
    } else if (sessionId === undefined) {
      const summaries = await readPrivateLocalSessionSummaries(
        owner.databasePath,
      );
      sessionId = summaries[0]?.sessionId;
      if (sessionId === undefined) {
        let empty = emptySessions.get(owner.databasePath);
        if (empty === undefined) {
          empty = owner.createSession(createPrivateLocalSessionRequestId());
          emptySessions.set(owner.databasePath, empty);
        }
        sessionId = await empty;
      }
      ensureRunning();
    }
    if (
      selection.clientPath !== undefined &&
      !owner.bindSessionPath(sessionId, selection.clientPath)
    )
      throw new LocalSessionPathConflict();
    return selected(owner, sessionId);
  }

  /**
   * Project mail routing for every Agent this service owns in one project.
   * Delivery opens an idle addressed Agent, so its admitted mail wakes it; the
   * recipient's own ingress decides what it accepts.
   */
  function mailRouting(invocationRoot: string): PrivateLocalMailRouting {
    const control = directory(invocationRoot);
    return {
      deliver: async (mail) =>
        (
          await control.owner(mail.to.agentId, new AbortController().signal)
        ).acceptMail(mail),
      readSettlement: async (agentId, sessionId, commandId) =>
        (
          await control.owner(agentId, new AbortController().signal)
        ).readSettlement(sessionId, commandId),
    };
  }

  function directory(invocationRoot: string): LocalAgentControlDirectory &
    Readonly<{
      owner: (
        agentId: string,
        signal: AbortSignal,
      ) => Promise<LocalServiceRuntime>;
    }> {
    async function targets(signal: AbortSignal) {
      ensureRunning();
      signal.throwIfAborted();
      const paths = await listPrivateLocalAgentStores(invocationRoot);
      signal.throwIfAborted();
      const result = new Map<string, string>();
      for (const databasePath of paths) {
        // Discovery can follow symlinks for human resume; model control cannot
        // cross the canonical project boundary through one of those links.
        if (!belongsToProject(invocationRoot, databasePath)) continue;
        const agentId = basename(dirname(databasePath));
        if (result.has(agentId))
          throw new Error("Local Agent identity is ambiguous");
        result.set(agentId, databasePath);
      }
      return result;
    }
    async function admittedOwner(agentId: string, signal: AbortSignal) {
      const databasePath = (await targets(signal)).get(agentId);
      if (databasePath === undefined)
        throw new Error("Agent is outside this Local project");
      const owner = await ownerFor({ invocationRoot, databasePath });
      if ((await targets(signal)).get(agentId) !== databasePath)
        throw new Error("Agent is outside this Local project");
      signal.throwIfAborted();
      ensureRunning();
      return owner;
    }
    return {
      owner: admittedOwner,
      list: async (signal) =>
        [...(await targets(signal)).keys()].map((agentId) => ({
          agentId,
          name: agentId,
        })),
      create: async ({ requestId, model }, signal) => {
        ensureRunning();
        signal.throwIfAborted();
        const key = `create:${JSON.stringify([invocationRoot, requestId])}`;
        const createStore = await resolvePrivateLocalCreateStore(
          invocationRoot,
          requestId,
        );
        signal.throwIfAborted();
        ensureRunning();
        const databasePath = createStore.databasePath;
        let pending = owners.get(key);
        if (pending === undefined) {
          pending = owners.get(`store:${databasePath}`);
          if (pending === undefined) {
            let options: Parameters<OpenLocalServiceRuntime>[0] = {
              invocationRoot,
              createRequestId: requestId,
              agentControl: directory(invocationRoot),
              mail: mailRouting(invocationRoot),
            };
            if (model !== undefined)
              options = {
                ...options,
                providerId: model.providerId,
                modelId: model.modelId,
                reasoning: model.reasoning,
              };
            pending = trackOpening(
              openRuntime(options).then((runtime) => ({
                runtime,
                fungiMcp: undefined,
              })),
              invocationRoot,
              key,
            );
          }
        }
        const owner = await pending;
        signal.throwIfAborted();
        ensureRunning();
        if (owner.runtime.databasePath !== databasePath)
          throw new Error(
            "Local Agent create identity does not match its store",
          );
        owners.set(key, pending);
        await owner.runtime.assertModelReady("main", signal);
        const agentId = createStore.agentId;
        return Object.freeze({ agentId, name: agentId });
      },
      setModel: async ({ agentId, model }, signal) => {
        const owner = await admittedOwner(agentId, signal);
        await owner.setModel(model, signal);
      },
      checkModel: async ({ agentId, sessionId }, signal) => {
        const owner = await admittedOwner(agentId, signal);
        await owner.assertModelReady(sessionId, signal);
      },
      open: async (agentId, signal) => {
        const owner = await admittedOwner(agentId, signal);
        // The service retains runtime ownership; an operation leases access only.
        const release = () => Promise.resolve();
        return {
          agent: {
            session: owner.getSession,
            listSessions: owner.listSessions,
            createSession: owner.createSession,
            deleteSession: owner.deleteSession,
            extensions: owner.extensions,
            close: release,
          },
          release,
        };
      },
    };
  }

  function close(): Promise<void> {
    stopping = true;
    closing ??= (async () => {
      await Promise.allSettled(pendingOpenings);
      const settled = await Promise.allSettled(opening);
      const failures: unknown[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") {
          try {
            await result.value.runtime.close();
          } catch (cause) {
            logEvent("service-owner.close-runtime", cause);
            failures.push(cause);
          }
        }
      }
      owners.clear();
      opening.clear();
      pendingOpenings.clear();
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "Local service owners failed to close",
        );
    })();
    return closing;
  }
  async function restore() {
    if (recoveryPath === undefined) return;
    let content: string;
    try {
      content = await readFile(recoveryPath, "utf8");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return;
      logEvent("service-owner.read-recovery", cause);
      return;
    }
    const decoded = decodeRecoveryFile(content);
    if (decoded._tag === "Failure") {
      logEvent("service-owner.decode-recovery", decoded.failure);
      await saveRecovery();
      return;
    }
    const saved: z.infer<typeof recoveryOwnerSchema>[] = [];
    for (const entry of decoded.success) {
      const selection = recoveryOwnerSchema.safeParse(entry);
      if (!selection.success) {
        logEvent("service-owner.decode-recovery-entry", selection.error);
        continue;
      }
      saved.push(selection.data);
      recovery.set(selection.data.databasePath, selection.data);
    }
    // Preload valid references before opening, then isolate and prune each
    // failed owner so an unavailable project cannot prevent service startup.
    for (const selection of saved) {
      try {
        await ownerFor(selection);
      } catch (cause) {
        logEvent("service-owner.restore-entry", cause);
        // A good owner may already have replaced another stale reference to
        // this store. Prune only the failing reference, never that live owner.
        if (recovery.get(selection.databasePath) === selection)
          recovery.delete(selection.databasePath);
      }
    }
    await saveRecovery();
  }
  return { createSession, select, restore, close };
}
