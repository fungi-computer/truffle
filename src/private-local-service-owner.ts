import * as Effect from "effect/Effect";
import { parseDelegationReceipt } from "@fungi.computer/shiitake/client";
import type {
  Accepted,
  AbortCommand,
  BranchCommand,
  CancelCommand,
  CancelResult,
  CompactCommand,
  ForkCommand,
  ForkedSession,
  OperatorCommand,
  PromptCommand,
  SessionCommand,
  ShiitakeSession,
  TitleCommand,
} from "@fungi.computer/shiitake";
import { logEvent } from "./log-event.js";
import { modeWithinCeiling } from "./private-local-permission-mode.js";
import { createPrivateModels } from "./local-models.js";
import {
  capturePrivateLocalConfigRoot,
  type PrivateLocalConfigRoot,
} from "./private-local-config-root.js";
import type { ServiceLogLifecycle } from "./private-local-service-log.js";
import type { StopAllResult } from "./private-local-stop-all.js";
import { AdmissionGate } from "./private-local-admission-gate.js";
import {
  readFungiMcpSelection,
  readProjectFungiMcpSelection,
  sameFungiMcpConnection,
  FungiMcpSelectionConflict,
} from "./private-fungi-mcp-selection.js";
import type { PrivateFungiMcpConnectionOptions } from "./private-fungi-mcp-connection.js";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentCreateRefused,
  AgentArchiveRefused,
  type AgentControlAgent,
} from "@fungi.computer/shiitake/agent-control";
import {
  localExtensions,
  LocalExtensionError,
  type LocalExtensions,
} from "./local-extensions.js";
import type {
  LocalAgentControlAgent,
  LocalAgentControlDirectory,
  LocalArchiveRequest,
} from "./private-local-agent-control.js";
import { readFile, realpath } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import * as Schema from "effect/Schema";
import { selectionSchema } from "./private-local-service-discovery.js";
import { createShiitakeHttpRoutes } from "@fungi.computer/shiitake/http";
import {
  listPrivateLocalAgentStores,
  LocalStoreSchemaError,
  readPrivateLocalAgentProfile,
  readPrivateLocalSessionSummaries,
  isArchivedStore,
  unreadableStoreReason,
  type LocalStoreVisibility,
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
import { parsePrivateLocalExecPath } from "./private-local-exec-path.js";
import type { PrivateLocalMailRouting } from "./private-local-delegation.js";
import type { LocalUiAttachment } from "./private-local-ui-attachment.js";
import {
  createLocalMeshLinks,
  localMeshLinkKey,
  type EnrolledLocalMachine,
} from "./private-local-mesh-links.js";
import {
  agentMailAddressSchema,
  machineAgentRequestSchema,
  machineDirectorySchema,
} from "@fungi.computer/seam/machine-link-protocol";
import { commandSettlementSchema } from "@fungi.computer/shiitake/fleet";
import { BirdDogMailSchema } from "@fungi.computer/bird-dog/effect";

export type LocalServiceRuntime = Pick<
  PrivateLocalRuntimeHost,
  | "databasePath"
  | "agentId"
  | "name"
  | "getSession"
  | "effectiveModel"
  | "setModel"
  | "setArchived"
  | "setMode"
  | "sandboxStatus"
  | "pendingDelegation"
  | "assertModelReady"
  | "listSessions"
  | "createSession"
  | "deleteSession"
  | "extensions"
  | "prepareReload"
  | "bindSessionPath"
  | "acceptMail"
  | "readSettlement"
  | "idle"
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
/**
 * A folder holds several Agent stores and the request chose none of them.
 * The service never picks one for the caller; --agent, --db or the
 * landing screen does.
 */
export class LocalAgentSelectionAmbiguous extends Error {
  override readonly name = "LocalAgentSelectionAmbiguous";
  readonly agentIds: readonly string[];
  constructor(agentIds: readonly string[]) {
    super(
      `Several Agents in this folder (${agentIds.join(", ")}); choose one with --agent <id> or --db <path>`,
    );
    this.agentIds = agentIds;
  }
}
export type OpenLocalServiceRuntime = (
  /** Selected by the service, never by a client selection or Agent Files root. */
  options: Parameters<typeof openPrivateLocalRuntimeHost>[0] &
    Readonly<{ configRoot: PrivateLocalConfigRoot }>,
) => Promise<LocalServiceRuntime>;

type LocalServiceOwner = Readonly<{
  runtime: LocalServiceRuntime;
  fungiMcp: PrivateFungiMcpConnectionOptions | undefined;
}>;

/** An open Agent runtime and the release of this one use of it. */
type HeldRuntime = Readonly<{
  owner: LocalServiceRuntime;
  release: () => void;
}>;

// Reopen inputs only. Credentials remain with Local's account custodian.
const recoveryOwnerSchema = selectionSchema
  .omit({ clientPath: true, sessionId: true, uiAttachmentLifetime: true })
  .extend({
    databasePath: z.string().min(1),
    wakeAt: z.number().optional(),
  });
const decodeRecoveryFile = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

class LocalRecoveryPersistenceDisabled extends Error {
  override readonly name = "LocalRecoveryPersistenceDisabled";
  constructor(
    readonly reason: "read" | "decode",
    cause: unknown,
  ) {
    super(
      "Recovery persistence is disabled: the manifest could not be loaded",
      {
        cause,
      },
    );
  }
}

type RecoveryLoad =
  | Readonly<{
      kind: "loaded";
      references: readonly z.infer<typeof recoveryOwnerSchema>[];
    }>
  | Readonly<{
      kind: "disabled";
      error: LocalRecoveryPersistenceDisabled;
    }>;

/** One service owns each store, independently of how many clients select it. */
export function createLocalServiceOwners(
  openRuntime: OpenLocalServiceRuntime = (input) =>
    openPrivateLocalRuntimeHost(
      input,
      createPrivateModels(input.configRoot.credentialPath),
    ),
  recoveryDirectory?: string,
  /** The installed-extension owner that decides what each Agent holds. */
  suppliedExtensions?: Pick<
    LocalExtensions,
    "assertHeldByAgent" | "enableAgent"
  >,
  /** How often idle Agents are checked; one is released on its second idle check. */
  idleSweepMs = 60_000,
  /** Read the recovery manifest; tests can hold this I/O independently of opens. */
  readRecoveryManifest: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
  /** Report only the classification, never the manifest or exception text. */
  onRecoveryDisabled: ServiceLogLifecycle["recoveryDisabled"] = () => undefined,
  configRoot: PrivateLocalConfigRoot = capturePrivateLocalConfigRoot(),
  meshLinksFactory: typeof createLocalMeshLinks = createLocalMeshLinks,
  onExecRuleMatch: NonNullable<
    Parameters<typeof openPrivateLocalRuntimeHost>[0]["onExecRuleMatch"]
  > = () => undefined,
  /** Supplied by the listener after startup; individual Agents never close it. */
  serviceNative?: () => NonNullable<
    Parameters<typeof openPrivateLocalRuntimeHost>[0]["native"]
  >,
) {
  const extensions =
    suppliedExtensions ?? localExtensions({ home: configRoot.home });
  const recoveryPath =
    recoveryDirectory === undefined
      ? undefined
      : resolve(recoveryDirectory, "owners.json");
  const recovery = new Map<string, z.infer<typeof recoveryOwnerSchema>>();
  const wakes = new Map<string, z.infer<typeof recoveryOwnerSchema>>();
  let wakeTimer: NodeJS.Timeout | undefined;
  function scheduleWakes() {
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    if (stopping || wakes.size === 0) return;
    let earliest = Infinity;
    for (const entry of wakes.values())
      earliest = Math.min(earliest, entry.wakeAt ?? Infinity);
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined;
        if (stopping) return;
        const due = [...wakes.values()].filter(
          (entry) => entry.wakeAt !== undefined && entry.wakeAt <= Date.now(),
        );
        for (const entry of due) {
          wakes.delete(entry.databasePath);
          void ownerFor(entry).catch((cause: unknown) => {
            logEvent("service-owner.wake", cause);
          });
        }
        scheduleWakes();
      },
      Math.min(2_147_483_647, Math.max(0, earliest - Date.now())),
    );
    wakeTimer.unref();
  }
  let loadingRecovery: Promise<RecoveryLoad> | undefined;
  let saving = Promise.resolve();
  const emptySessions = new Map<string, Promise<string>>();
  const owners = new Map<string, Promise<LocalServiceOwner>>();
  const roots = new Map<string, string>();
  const meshDirectories = new Map<
    string,
    {
      record: EnrolledLocalMachine;
      agents: readonly { agentId: string; name: string }[];
    }
  >();
  async function meshAdmission(localAgentId: string, recipientAgentId: string) {
    for (const { record, agents } of meshDirectories.values()) {
      const binding = record.bindings.find(
        (candidate) => candidate.agentId === recipientAgentId,
      );
      if (
        binding !== undefined &&
        record.agents[binding.selection]?.localAgentId === localAgentId &&
        (await mesh.isCurrent(record))
      )
        return agents;
    }
    return undefined;
  }
  const mesh = meshLinksFactory({
    credentialPath: configRoot.credentialPath,
    receive: async (record, envelope) => {
      if (envelope.kind === "machineDirectory") {
        const address = z
          .strictObject({ teamId: z.string(), deviceId: z.string() })
          .parse(envelope.address);
        if (
          address.teamId !== record.scopeId ||
          address.deviceId !== record.deviceId
        )
          return "refused";
        const projection = Schema.decodeUnknownSync(machineDirectorySchema, {
          onExcessProperty: "error",
        })(envelope.event);
        meshDirectories.set(localMeshLinkKey(record), {
          record,
          agents: projection.agents,
        });
        return "accepted";
      }
      const address = Schema.decodeUnknownSync(agentMailAddressSchema, {
        onExcessProperty: "error",
      })(envelope.address);
      const binding = record.bindings.find(
        (candidate) => candidate.agentId === address.agentId,
      );
      const selected =
        binding === undefined ? undefined : record.agents[binding.selection];
      if (address.scopeId !== record.scopeId || selected === undefined)
        return "refused";
      const { owner, release } = await directory(record.invocationRoot).owner(
        selected.localAgentId,
        new AbortController().signal,
      );
      try {
        if (owner.databasePath !== selected.databasePath) return "refused";
        if (envelope.kind === "machineAgent") {
          const { actorAgentId, operation } = Schema.decodeUnknownSync(
            machineAgentRequestSchema,
            {
              onExcessProperty: "error",
            },
          )(envelope.event);
          if (operation.type === "createSession") {
            const sessionId = await admitted(owner, () =>
              owner.createSession(operation.requestId),
            );
            return { status: "accepted", receipt: { sessionId } };
          }
          const facts = await admitted(owner, () =>
            owner.readSettlement(operation.sessionId, operation.commandId),
          );
          if (facts !== undefined && facts.acceptedSender !== actorAgentId)
            return "refused";
          return {
            status: "accepted",
            receipt: {
              settlement:
                facts === undefined
                  ? null
                  : Schema.encodeSync(
                      Schema.fromJsonString(commandSettlementSchema),
                    )(facts),
            },
          };
        }
        const mail = Schema.decodeUnknownSync(BirdDogMailSchema, {
          onExcessProperty: "error",
        })(envelope.event);
        if (
          envelope.kind !== "agentMail" ||
          envelope.key !== mail.key ||
          mail.to.agentId !== address.agentId
        )
          return "refused";
        if (
          mail.from.sessionId === undefined &&
          !(
            mail.replyTo.length === 0 && mail.reply?.outcome === "undeliverable"
          )
        )
          return "refused";
        const sessionlessAcceptance = mail.to.sessionId === undefined;
        // Only select the physical store here. Never bypass that runtime's
        // recipient/sender admission; request keys make acceptance replay-safe.
        const command = await admitted(owner, () => owner.acceptMail(mail));
        if (sessionlessAcceptance && command.sessionId === undefined)
          throw new Error("Sessionless mail acceptance returned no Session");
        return { status: "accepted", receipt: command };
      } finally {
        release();
      }
    },
  });
  type Configuration = Readonly<{
    load: Awaited<ReturnType<LocalExtensions["captureAgent"]>>;
    mcp: ReadonlyMap<
      string,
      Awaited<ReturnType<typeof readProjectFungiMcpSelection>>
    >;
    clientPath: string;
  }>;
  let configuration: Configuration | undefined;
  let reloading: Promise<void> | undefined;
  const pendingReload = () => reloading;

  async function loadConfiguration(
    captured: Configuration,
    invocationRoot: string,
    storeDirectory: string,
  ) {
    const installed = await captured.load(storeDirectory, invocationRoot);
    if (installed.diagnostics.length > 0)
      throw new Error(
        installed.diagnostics
          .map(({ extensionId, error }) => `${extensionId}: ${error.message}`)
          .join("\n"),
      );
    const selected = captured.mcp.has(invocationRoot)
      ? captured.mcp.get(invocationRoot)
      : await readProjectFungiMcpSelection(invocationRoot);
    return {
      installed,
      fungiMcp:
        selected === undefined
          ? undefined
          : readFungiMcpSelection(selected, {
              credentialPath: configRoot.credentialPath,
            }),
      clientPath: captured.clientPath,
    };
  }

  function reload(invocationRoot: string, clientPath: string) {
    if (reloading !== undefined)
      return Promise.reject(
        new Error("A configuration reload is already in progress"),
      );
    const operation = (async () => {
      ensureRunning();
      const path = parsePrivateLocalExecPath(clientPath);
      await Promise.all(pendingOpenings);
      const projects = new Set([
        ...roots.values(),
        await realpath(invocationRoot),
      ]);
      const selections = new Map<
        string,
        Awaited<ReturnType<typeof readProjectFungiMcpSelection>>
      >();
      for (const project of projects)
        selections.set(project, await readProjectFungiMcpSelection(project));
      const candidate: Configuration = {
        load: await localExtensions({ home: configRoot.home }).captureAgent(),
        mcp: selections,
        clientPath: path,
      };
      const prepared: Awaited<
        ReturnType<LocalServiceRuntime["prepareReload"]>
      >[] = [];
      const releases: (() => void)[] = [];
      try {
        for (const pending of new Set(owners.values())) {
          const { runtime } = await pending;
          releases.push(await gateFor(runtime.databasePath).lease());
          const root = roots.get(runtime.databasePath);
          if (root === undefined)
            throw new Error("Agent configuration root is unavailable");
          prepared.push(
            await runtime.prepareReload(
              await loadConfiguration(
                candidate,
                root,
                dirname(runtime.databasePath),
              ),
            ),
          );
        }
        ensureRunning();
        for (const staged of prepared) staged.commit();
        configuration = candidate;
      } catch (cause) {
        const discarded = await Promise.allSettled(
          prepared.map((staged) => staged.discard()),
        );
        const failures: unknown[] = [];
        for (const result of discarded)
          if (result.status === "rejected") failures.push(result.reason);
        if (failures.length > 0)
          throw new AggregateError(
            [cause, ...failures],
            "Configuration reload failed; candidate cleanup also failed",
            { cause },
          );
        throw cause;
      } finally {
        for (const release of releases) release();
        // A reload's leases end here; an unused gate must not pin its Agent.
        for (const databasePath of gates.keys()) pruneGate(databasePath);
      }
    })();
    reloading = operation;
    return operation.finally(() => {
      reloading = undefined;
    });
  }
  const gates = new Map<string, AdmissionGate>();
  const opening = new Map<Promise<LocalServiceOwner>, string>();
  const pendingOpenings = new Set<Promise<LocalServiceOwner>>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  let restoring: Promise<void> | undefined;
  /** Requests, streams and operations currently using each open store. */
  const uses = new Map<string, number>();
  /** Live event responses are observers, not work that survives orderly stop. */
  const eventResponses = new Set<() => Promise<void>>();
  /** Stores found idle by the previous sweep. */
  const idleCandidates = new Set<string>();
  /** Released stores whose runtime is still closing; a reopen waits for it. */
  const releasing = new Map<string, Promise<void>>();
  const released = new WeakSet<LocalServiceRuntime>();
  const openedByStore = new Map<string, Promise<LocalServiceOwner>>();
  const routesByRuntime = new WeakMap<
    LocalServiceRuntime,
    ReturnType<typeof createShiitakeHttpRoutes>
  >();
  let sweeping: Promise<void> | undefined;
  const sweepTimer = setInterval(() => {
    void sweepIdle().catch((cause: unknown) => {
      logEvent("service-owner.sweep-idle", cause);
    });
  }, idleSweepMs);
  sweepTimer.unref();

  function saveRecovery(): Promise<void> {
    if (recoveryPath === undefined) return Promise.resolve();
    const path = recoveryPath;
    const next = saving.then(async () => {
      // A ready listener may admit a new Agent during the initial read. Merge
      // saved references before capturing any replacement list.
      const loaded = await loadRecovery();
      if (loaded.kind === "disabled") {
        logEvent("service-owner.save-recovery-disabled", loaded.error);
        return;
      }
      await writeFileAtomic(path, JSON.stringify([...recovery.values()]), {
        mode: 0o600,
      });
    });
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
    opening.set(opened, key);
    void opened.then(
      (owner) => {
        opening.set(opened, owner.runtime.agentId);
        openedByStore.set(owner.runtime.databasePath, opened);
      },
      (cause: unknown) => {
        opening.delete(opened);
        logEvent("service-owner.open-runtime", cause);
      },
    );
    pending = pending.then(async (owner) => {
      roots.set(owner.runtime.databasePath, invocationRoot);
      if (wakes.delete(owner.runtime.databasePath)) scheduleWakes();
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

  function gateFor(databasePath: string) {
    let gate = gates.get(databasePath);
    if (gate === undefined) {
      gate = new AdmissionGate();
      gates.set(databasePath, gate);
    }
    return gate;
  }

  /** Admit one piece of work to an Agent, refusing it if the Agent is archived by then. */
  async function admitted<Value>(
    owner: LocalServiceRuntime,
    admit: () => Promise<Value>,
  ): Promise<Value> {
    const release = await gateFor(owner.databasePath).lease();
    try {
      if (isArchivedStore(owner.databasePath))
        throw new AgentArchiveRefused(
          "archived",
          `Agent ${owner.agentId} is archived; unarchive it to work with it`,
        );
      return await admit();
    } finally {
      release();
      pruneGate(owner.databasePath);
    }
  }

  /** The gate of an Agent whose last admission just ended is forgotten. */
  function pruneGate(databasePath: string) {
    if (gates.get(databasePath)?.idle === true) gates.delete(databasePath);
  }

  /**
   * One Session as a client may use it: work starts (a prompt, a compaction, a
   * send) only through an admission that finds the Agent in use.
   */
  function gatedSession(
    owner: LocalServiceRuntime,
    sessionId: string,
    attachment?: LocalUiAttachment,
  ): ShiitakeSession {
    const session = owner.getSession(sessionId, attachment);
    function command(input: PromptCommand | CompactCommand): Promise<Accepted>;
    function command(input: CancelCommand): Promise<CancelResult>;
    function command(
      input: AbortCommand | BranchCommand | OperatorCommand | TitleCommand,
    ): Promise<undefined>;
    function command(input: ForkCommand): Promise<ForkedSession>;
    function command(
      input: SessionCommand,
    ): Promise<Accepted | CancelResult | ForkedSession | undefined>;
    function command(input: SessionCommand) {
      return input.type === "prompt" || input.type === "compact"
        ? admitted(owner, () => session.command(input))
        : session.command(input);
    }
    return {
      ...session,
      command,
      send: (...args) => admitted(owner, () => session.send(...args)),
    };
  }

  function ensureRunning() {
    if (stopping) throw new Error("Local service is stopping");
  }

  /** Count one use of an open store until its release; any use resets idleness. */
  function hold(databasePath: string) {
    uses.set(databasePath, (uses.get(databasePath) ?? 0) + 1);
    idleCandidates.delete(databasePath);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (uses.get(databasePath) ?? 1) - 1;
      if (remaining > 0) uses.set(databasePath, remaining);
      else uses.delete(databasePath);
    };
  }

  /** An open runtime held for one use; a store released meanwhile is reopened. */
  async function acquire(selection: PrivateLocalServiceSelection) {
    for (;;) {
      const runtime = await ownerFor(selection);
      if (!released.has(runtime))
        return { runtime, release: hold(runtime.databasePath) };
    }
  }

  function routesFor(
    owner: LocalServiceRuntime,
    attachment?: LocalUiAttachment,
  ) {
    const createRoutes = () =>
      createShiitakeHttpRoutes(
        (id) => gatedSession(owner, id, attachment),
        owner.listSessions,
        (requestId) => admitted(owner, () => owner.createSession(requestId)),
        owner.deleteSession,
        () => owner.extensions,
      );
    if (attachment !== undefined) return createRoutes();
    let routes = routesByRuntime.get(owner);
    if (routes === undefined) {
      routes = createRoutes();
      routesByRuntime.set(owner, routes);
    }
    return routes;
  }

  /**
   * Serve one client request on an Agent's mounted route, reopening a released
   * Agent. A streamed body (a Session watch) keeps the Agent in use until it
   * ends or the client disconnects.
   */
  async function serve(
    selection: Pick<
      PrivateLocalServiceSelection,
      "invocationRoot" | "databasePath" | "fungiMcp"
    >,
    request: Request,
    attachment?: LocalUiAttachment,
  ): Promise<Response> {
    const { runtime, release } = await acquire(selection);
    const streamAbort = new AbortController();
    let response: Response;
    try {
      response = await routesFor(runtime, attachment).fetch(
        new Request(request, {
          signal: AbortSignal.any([request.signal, streamAbort.signal]),
        }),
      );
    } catch (cause) {
      release();
      throw cause;
    }
    const body = response.body;
    if (body === null) {
      release();
      return response;
    }
    const reader = body.getReader();
    let finish = release;
    let cancelling: Promise<void> | undefined;
    const cancelBody: typeof reader.cancel = (reason) => {
      cancelling ??= reader.cancel(reason).finally(() => {
        finish();
      });
      return cancelling;
    };
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
      const stop = (): Promise<void> => {
        streamAbort.abort();
        // Hono on current Bun observes response cancellation, not just the
        // Request signal. Join cancellation before releasing this stream's use.
        return cancelBody(streamAbort.signal.reason);
      };
      finish = () => {
        eventResponses.delete(stop);
        release();
      };
      eventResponses.add(stop);
      // An already-admitted route may finish opening its response during stop.
      if (stopping) await stop();
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              finish();
              controller.close();
            } else if (chunk.value instanceof Uint8Array)
              controller.enqueue(chunk.value);
            else throw new TypeError("A Local route streamed a non-byte chunk");
          } catch (cause) {
            finish();
            controller.error(cause);
          }
        },
        cancel(reason) {
          return cancelBody(reason);
        },
      }),
      response,
    );
  }

  async function effectiveModel(
    selection: Pick<
      PrivateLocalServiceSelection,
      "invocationRoot" | "databasePath" | "fungiMcp"
    >,
    sessionId: string,
    signal: AbortSignal,
  ) {
    const { runtime, release } = await acquire(selection);
    try {
      return await runtime.effectiveModel(sessionId, signal);
    } finally {
      release();
    }
  }

  async function sandboxStatus(
    selection: Pick<
      PrivateLocalServiceSelection,
      "invocationRoot" | "databasePath" | "fungiMcp"
    >,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { runtime, release } = await acquire(selection);
    try {
      signal.throwIfAborted();
      return runtime.sandboxStatus();
    } finally {
      release();
    }
  }

  /**
   * Close Agents nothing uses that hold no work a reopen could not resume,
   * on their second consecutive idle check, and forget them for restart.
   */
  function sweepIdle(): Promise<void> {
    sweeping ??= (async () => {
      const closed: Promise<void>[] = [];
      const stores = new Map<string, Promise<LocalServiceOwner>>();
      for (const [key, pending] of owners)
        if (key.startsWith("store:")) stores.set(key.slice(6), pending);
      for (const databasePath of idleCandidates)
        if (!stores.has(databasePath)) idleCandidates.delete(databasePath);
      for (const [databasePath, pending] of stores) {
        // A configuration reload holds every open Agent it snapshotted until
        // it commits; releasing one beneath it would strand that reload.
        const busy = () =>
          stopping ||
          reloading !== undefined ||
          uses.has(databasePath) ||
          gates.has(databasePath) ||
          owners.get(`store:${databasePath}`) !== pending;
        if (busy()) {
          idleCandidates.delete(databasePath);
          continue;
        }
        let runtime: LocalServiceRuntime;
        let idle: boolean;
        let wakeAt: number | null;
        try {
          ({ runtime } = await pending);
          const state = await runtime.idle();
          idle = state.idle;
          wakeAt = state.wakeAt;
        } catch (cause) {
          // One unreadable Agent stays open; the sweep still checks the rest.
          logEvent("service-owner.read-idle", cause);
          idleCandidates.delete(databasePath);
          continue;
        }
        // Anything that started while idleness was read keeps the Agent open.
        if (!idle || busy()) {
          idleCandidates.delete(databasePath);
          continue;
        }
        if (!idleCandidates.has(databasePath)) {
          idleCandidates.add(databasePath);
          continue;
        }
        closed.push(releaseStore(databasePath, pending, runtime, wakeAt));
      }
      await Promise.all(closed);
    })().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  }

  /** Forget empty Agents; retain a future wake for the next service owner. */
  function rememberIdleWake(databasePath: string, wakeAt: number | null) {
    const reference = recovery.get(databasePath);
    if (wakeAt === null || reference === undefined) {
      recovery.delete(databasePath);
      return undefined;
    }
    const scheduled = { ...reference, wakeAt };
    recovery.set(databasePath, scheduled);
    return scheduled;
  }

  function releaseStore(
    databasePath: string,
    pending: Promise<LocalServiceOwner>,
    runtime: LocalServiceRuntime,
    wakeAt: number | null,
  ) {
    idleCandidates.delete(databasePath);
    released.add(runtime);
    for (const [key, value] of owners)
      if (value === pending) owners.delete(key);
    emptySessions.delete(databasePath);
    roots.delete(databasePath);
    const scheduled = rememberIdleWake(databasePath, wakeAt);
    const opened = openedByStore.get(databasePath);
    openedByStore.delete(databasePath);
    if (opened !== undefined) opening.delete(opened);
    const closed = (async () => {
      try {
        await runtime.close();
      } catch (cause) {
        logEvent("service-owner.release-runtime", cause);
      }
      if (scheduled !== undefined && !stopping) {
        wakes.set(databasePath, scheduled);
        scheduleWakes();
      }
      await saveRecovery();
    })();
    releasing.set(databasePath, closed);
    return closed.finally(() => {
      if (releasing.get(databasePath) === closed)
        releasing.delete(databasePath);
    });
  }

  /** Settle every pending release of this store, then continue synchronously. */
  async function releasedClosed(databasePath: string) {
    for (
      let closed = releasing.get(databasePath);
      closed !== undefined;
      closed = releasing.get(databasePath)
    ) {
      await closed;
      ensureRunning();
    }
  }

  function selected(
    owner: LocalServiceRuntime,
    sessionId: string,
    invocationRoot: string,
    release: () => void,
  ) {
    return {
      agentId: owner.agentId,
      databasePath: owner.databasePath,
      invocationRoot,
      sessionId,
      session: gatedSession(owner, sessionId),
      /** End this selection's use; the mounted route reopens the Agent later. */
      release,
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
    if (databasePath !== undefined) return databasePath;
    // Name the project's open Agent by its store, so a reopen after an idle
    // release waits for that close like any other store selection.
    const projectOwner = owners.get(`project:${invocationRoot}`);
    if (projectOwner !== undefined)
      return (await projectOwner).runtime.databasePath;
    const stores = await listPrivateLocalAgentStores(invocationRoot);
    ensureRunning();
    if (stores.length > 1)
      throw new LocalAgentSelectionAmbiguous(
        stores.map((store) => basename(dirname(store))),
      );
    return stores[0];
  }

  async function ownerFor(selection: PrivateLocalServiceSelection) {
    while (pendingReload() !== undefined) await pendingReload();
    ensureRunning();
    const invocationRoot = await realpath(selection.invocationRoot);
    const databasePath = await selectedDatabasePath(
      invocationRoot,
      selection.databasePath,
    );
    ensureRunning();
    if (selection.mode !== undefined && databasePath !== undefined) {
      const child = readPrivateLocalAgentProfile(databasePath);
      if (child.createdBy !== null) {
        const stores = await listPrivateLocalAgentStores(invocationRoot);
        const creatorPath = stores.find(
          (path) => basename(dirname(path)) === child.createdBy,
        );
        if (
          creatorPath === undefined ||
          !modeWithinCeiling(
            selection.mode,
            readPrivateLocalAgentProfile(creatorPath).mode,
          )
        )
          throw new AgentCreateRefused(
            "exceeds_creator",
            "a created Agent cannot exceed its creator's permission mode",
          );
      }
    }
    const fungiMcp =
      selection.fungiMcp === undefined
        ? undefined
        : readFungiMcpSelection(selection.fungiMcp, {
            credentialPath: configRoot.credentialPath,
          });
    ensureRunning();
    // A new project selection shares its in-flight owner; explicit resume keys the store.
    const key =
      databasePath === undefined
        ? `project:${invocationRoot}`
        : `store:${databasePath}`;
    while (pendingReload() !== undefined) await pendingReload();
    ensureRunning();
    // One process owns a store once: a reopen waits for its released close.
    if (databasePath !== undefined) await releasedClosed(databasePath);
    let pending = owners.get(key);
    if (pending === undefined && pendingOpenings.size > 0) {
      // A fresh project does not reveal its canonical store path until opening.
      // Let current openings install both project and store aliases, then recheck.
      await Promise.allSettled(pendingOpenings);
      while (pendingReload() !== undefined) await pendingReload();
      ensureRunning();
      pending = owners.get(key);
    }
    const openingHere = pending === undefined;
    if (pending === undefined) {
      const projectControl =
        databasePath === undefined ||
        belongsToProject(invocationRoot, databasePath);
      let options: Parameters<OpenLocalServiceRuntime>[0] = {
        configRoot,
        invocationRoot,
        databasePath,
        // The host must persist/admit this BEFORE Shiitake can recover work.
        mode: selection.mode,
        agentControl: projectControl ? directory(invocationRoot) : undefined,
        mail: projectControl ? mailRouting(invocationRoot) : undefined,
        meshAdmission,
        onExecRuleMatch,
      };
      if (serviceNative !== undefined)
        options = { ...options, native: serviceNative() };
      if (fungiMcp !== undefined) options = { ...options, fungiMcp };
      const captured = configuration;
      if (captured !== undefined)
        options = {
          ...options,
          configuration: (store) =>
            loadConfiguration(captured, invocationRoot, store),
        };
      pending = trackOpening(
        openRuntime(options).then((runtime) => ({ runtime, fungiMcp })),
        invocationRoot,
        key,
      );
    }
    const owner = await pending;
    ensureRunning();
    if (
      configuration === undefined &&
      fungiMcp !== undefined &&
      !sameFungiMcpConnection(owner.fungiMcp, fungiMcp)
    )
      throw new FungiMcpSelectionConflict();
    if (!openingHere && selection.mode !== undefined)
      owner.runtime.setMode(selection.mode);
    return owner.runtime;
  }

  async function select(
    selection: PrivateLocalServiceSelection,
    createRequestId?: string,
  ) {
    const { runtime: owner, release } = await acquire(selection);
    try {
      return selected(
        owner,
        await selectedSession(owner, selection, createRequestId),
        await realpath(selection.invocationRoot),
        release,
      );
    } catch (cause) {
      release();
      throw cause;
    }
  }

  async function selectedSession(
    owner: LocalServiceRuntime,
    selection: PrivateLocalServiceSelection,
    createRequestId: string | undefined,
  ) {
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
    return sessionId;
  }

  /**
   * Project mail routing for every Agent this service owns in one project.
   * Delivery opens an idle addressed Agent, so its admitted mail wakes it; the
   * recipient's own ingress decides what it accepts.
   */
  function mailRouting(invocationRoot: string): PrivateLocalMailRouting {
    const control = directory(invocationRoot);
    return {
      deliver: async (mail) => {
        const remote = [...meshDirectories.values()].find(
          ({ record }) =>
            record.invocationRoot === invocationRoot &&
            record.bindings.some(
              (binding) => binding.agentId === mail.from.agentId,
            ),
        );
        if (remote !== undefined) {
          if (!remote.agents.some((agent) => agent.agentId === mail.to.agentId))
            throw new Error("Mesh mail recipient is outside this Team");
          const result = await mesh.deliver(remote.record, {
            key: mail.key,
            kind: "agentMail",
            address: {
              scopeId: remote.record.scopeId,
              agentId: mail.to.agentId,
            },
            event: mail,
          });
          if (
            result === "accepted" ||
            result === "duplicate" ||
            result === "refused" ||
            !("receipt" in result) ||
            result.status === "refused"
          )
            throw new Error("Mesh recipient did not return command acceptance");
          return parseDelegationReceipt(JSON.stringify(result.receipt));
        }
        const { owner, release } = await control.owner(
          mail.to.agentId,
          new AbortController().signal,
        );
        try {
          const receipt = await admitted(owner, () => owner.acceptMail(mail));
          if (
            mail.to.sessionId === undefined &&
            receipt.sessionId === undefined
          )
            throw new Error("Sessionless mail acceptance returned no Session");
          return receipt;
        } finally {
          release();
        }
      },
      // A settled command stays readable once its Agent is archived.
      readSettlement: async (agentId, sessionId, commandId) => {
        const { owner, release } = await control.owner(
          agentId,
          new AbortController().signal,
          true,
        );
        try {
          return await owner.readSettlement(sessionId, commandId);
        } finally {
          release();
        }
      },
    };
  }

  function directory(invocationRoot: string): LocalAgentControlDirectory &
    Readonly<{
      owner: (
        agentId: string,
        signal: AbortSignal,
        /** Read an archived Agent too; for reads that start no work. */
        includeArchived?: boolean,
      ) => Promise<HeldRuntime>;
    }> {
    async function targets(
      signal: AbortSignal,
      visibility: LocalStoreVisibility = "active",
    ) {
      ensureRunning();
      signal.throwIfAborted();
      const paths = await listPrivateLocalAgentStores(
        invocationRoot,
        visibility,
      );
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
    async function admittedOwner(
      agentId: string,
      signal: AbortSignal,
      includeArchived = false,
    ) {
      const visibility = includeArchived ? "all" : "active";
      const databasePath = (await targets(signal, visibility)).get(agentId);
      if (databasePath === undefined) return outsideOrArchived(agentId, signal);
      const { runtime, release } = await acquire({
        invocationRoot,
        databasePath,
      });
      try {
        // Archived while the owner opened: the Agent is no longer in use.
        if ((await targets(signal, visibility)).get(agentId) !== databasePath)
          return await outsideOrArchived(agentId, signal);
        signal.throwIfAborted();
        ensureRunning();
        return { owner: runtime, release };
      } catch (cause) {
        release();
        throw cause;
      }
    }
    async function outsideOrArchived(
      agentId: string,
      signal: AbortSignal,
    ): Promise<never> {
      if ((await targets(signal, "archived")).has(agentId))
        throw new AgentArchiveRefused(
          "archived",
          `Agent ${agentId} is archived; unarchive it to work with it`,
        );
      throw new Error("Agent is outside this Local project");
    }
    /**
     * The first command still queued or running on any of an Agent's Sessions,
     * so an archive can name it rather than cancel it.
     */
    async function runningCommand(owner: LocalServiceRuntime) {
      let after: string | undefined;
      do {
        const page = await owner.listSessions(after);
        for (const row of page.sessions) {
          if (row.state !== "running" && row.state !== "needs_you") continue;
          const { activity } = await owner
            .getSession(row.sessionId)
            .read({ limit: 1 });
          if (activity.queue.state !== "idle")
            return {
              sessionId: row.sessionId,
              commandId: activity.queue.commandId,
            };
        }
        after = page.next;
      } while (after !== undefined);
      return undefined;
    }
    /**
     * Archive or restore one Agent by flipping the flag its store owns. A
     * person may do it to any Agent; an Agent only to one it created, never
     * itself. Archiving never cancels work, so it refuses while a command runs.
     */
    async function setArchived(
      { agentId, by }: LocalArchiveRequest,
      archived: boolean,
      signal: AbortSignal,
    ) {
      const databasePath = (await targets(signal, "all")).get(agentId);
      if (databasePath === undefined)
        throw new Error("Agent is outside this Local project");
      let createdBy: string | null;
      try {
        ({ createdBy } = readPrivateLocalAgentProfile(databasePath));
      } catch (error) {
        if (!(error instanceof LocalStoreSchemaError)) throw error;
        throw new AgentArchiveRefused(
          "unreadable",
          `Agent ${agentId}'s store ${unreadableStoreReason(agentId)}`,
        );
      }
      if (by.kind === "agent") {
        if (by.agentId === agentId)
          throw new AgentArchiveRefused(
            "self",
            "an Agent cannot archive or restore itself",
          );
        if (createdBy !== by.agentId)
          throw new AgentArchiveRefused(
            "not_creator",
            "an Agent can archive or restore only an Agent it created",
          );
      }
      const { runtime: owner, release } = await acquire({
        invocationRoot,
        databasePath,
      });
      // Alone with the Agent: no work is admitted between the checks and the flag.
      try {
        await gateFor(databasePath).exclusive(async () => {
          if (archived) {
            const running = await runningCommand(owner);
            if (running !== undefined)
              throw new AgentArchiveRefused(
                "running",
                `command ${running.commandId} is running in Session ${running.sessionId}; cancel it first`,
              );
            const waiting = await owner.pendingDelegation();
            if (waiting !== undefined)
              throw new AgentArchiveRefused(
                "pending",
                waiting.unreadable === undefined
                  ? `it still waits for command ${waiting.commandId} it delegated to Agent ${waiting.agentId} (Session ${waiting.sessionId}); wait for it or cancel it first`
                  : `it delegated command ${waiting.commandId} to Agent ${waiting.agentId} (Session ${waiting.sessionId}) and that work cannot be read (${waiting.unreadable}); wait for it or cancel it first`,
              );
          }
          signal.throwIfAborted();
          owner.setArchived(archived);
        });
      } finally {
        release();
        pruneGate(databasePath);
      }
    }
    return {
      owner: admittedOwner,
      archive: (request, signal) => setArchived(request, true, signal),
      unarchive: (request, signal) => setArchived(request, false, signal),
      list: async (signal, options) => {
        const stores = await targets(
          signal,
          options?.archived === true ? "archived" : "active",
        );
        return [...stores].map(([agentId, databasePath]) => {
          let profile: ReturnType<typeof readPrivateLocalAgentProfile>;
          try {
            profile = readPrivateLocalAgentProfile(databasePath);
          } catch (error) {
            // One store written before the current schema fails its own row,
            // loudly; the other Agents still list.
            if (!(error instanceof LocalStoreSchemaError)) throw error;
            logEvent("list-agent-store", error);
            return {
              agentId,
              name: agentId,
              workingDirectory: invocationRoot,
              unreadable: unreadableStoreReason(agentId),
            } satisfies LocalAgentControlAgent;
          }
          const { name, model, createdBy } = profile;
          let agent: LocalAgentControlAgent = {
            agentId,
            name: name ?? agentId,
            workingDirectory: invocationRoot,
          };
          agent = { ...agent, createdBy };
          return model === null ? agent : { ...agent, model };
        });
      },
      create: async (
        { requestId, name, model, extensions: requested = [], createdBy },
        signal,
      ) => {
        ensureRunning();
        signal.throwIfAborted();
        // An Agent creating an Agent cannot give it more than it holds. Refuse
        // before anything exists; never trim the request.
        const creatorDatabase = (await targets(signal)).get(createdBy);
        if (creatorDatabase === undefined)
          throw new AgentCreateRefused(
            "no_creator",
            "the creating Agent is not in this Local project",
          );
        const creatorStore = dirname(creatorDatabase);
        const creatorProfile = readPrivateLocalAgentProfile(creatorDatabase);
        try {
          await extensions.assertHeldByAgent(creatorStore, requested);
        } catch (error) {
          if (
            error instanceof LocalExtensionError &&
            error.reason === "not-held"
          )
            throw new AgentCreateRefused("exceeds_creator", error.message);
          throw error;
        }
        const key = `create:${JSON.stringify([invocationRoot, requestId])}`;
        const createStore = await resolvePrivateLocalCreateStore(
          invocationRoot,
          requestId,
        );
        signal.throwIfAborted();
        ensureRunning();
        const databasePath = createStore.databasePath;
        for (const id of requested)
          await extensions.enableAgent(dirname(databasePath), id, {
            agentStoreDirectory: creatorStore,
          });
        signal.throwIfAborted();
        while (pendingReload() !== undefined) await pendingReload();
        ensureRunning();
        await releasedClosed(databasePath);
        ensureRunning();
        let pending = owners.get(key);
        if (pending === undefined) {
          pending = owners.get(`store:${databasePath}`);
          if (pending === undefined) {
            let options: Parameters<OpenLocalServiceRuntime>[0] = {
              configRoot,
              invocationRoot,
              createRequestId: requestId,
              name,
              createdBy,
              mode: creatorProfile.mode,
              folder: creatorProfile.folder,
              agentControl: directory(invocationRoot),
              mail: mailRouting(invocationRoot),
              onExecRuleMatch,
            };
            if (serviceNative !== undefined)
              options = { ...options, native: serviceNative() };
            if (model !== undefined)
              options = {
                ...options,
                providerId: model.providerId,
                modelId: model.modelId,
                reasoning: model.reasoning,
              };
            const captured = configuration;
            if (captured !== undefined)
              options = {
                ...options,
                configuration: (store) =>
                  loadConfiguration(captured, invocationRoot, store),
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
        const release = hold(databasePath);
        try {
          await owner.runtime.assertModelReady("main", signal);
        } finally {
          release();
        }
        const agentId = createStore.agentId;
        const created: AgentControlAgent = {
          agentId,
          name: owner.runtime.name,
          createdBy,
          workingDirectory: invocationRoot,
        };
        return Object.freeze(
          model === undefined ? created : { ...created, model },
        );
      },
      setModel: async ({ agentId, model }, signal) => {
        const { owner, release } = await admittedOwner(agentId, signal);
        try {
          await owner.setModel(model, signal);
        } finally {
          release();
        }
      },
      checkModel: async ({ agentId, sessionId }, signal) => {
        const { owner, release } = await admittedOwner(agentId, signal);
        try {
          if (sessionId !== undefined)
            await owner.assertModelReady(sessionId, signal);
        } finally {
          release();
        }
      },
      open: async (agentId, signal) => {
        const held = await admittedOwner(agentId, signal);
        const owner = held.owner;
        // The service retains runtime ownership; an operation holds a use of it.
        const release = () => {
          held.release();
          return Promise.resolve();
        };
        return {
          agent: {
            // Work starts only through an admission that finds the Agent in use.
            session: (sessionId) => gatedSession(owner, sessionId),
            listSessions: owner.listSessions,
            createSession: (requestId) =>
              admitted(owner, () => owner.createSession(requestId)),
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
    clearInterval(sweepTimer);
    if (wakeTimer !== undefined) clearTimeout(wakeTimer);
    closing ??= (async () => {
      const meshResults = await Promise.allSettled([mesh.close()]);
      // End our observers before deciding which Agents have work to resume.
      // Their client disconnect may not have reached the server yet.
      await Promise.all([...eventResponses].map((stop) => stop()));
      // Restoration may still be reading references or opening one Agent.
      // It stops scheduling at shutdown; join it before saving or closing.
      await restoring;
      // Reload owns staged activation scopes until it publishes or discards.
      // Its caller receives validation failures; shutdown waits for cleanup.
      await Promise.allSettled(reloading === undefined ? [] : [reloading]);
      await Promise.allSettled(pendingOpenings);
      await Promise.allSettled([
        ...(sweeping === undefined ? [] : [sweeping]),
        ...releasing.values(),
      ]);
      // Close up to four independent stores concurrently within the listener's
      // single overall budget. One hung close must not block every other Agent.
      const settled = await Promise.allSettled(
        [...opening.keys()].map(async (pending) => ({
          pending,
          owner: await pending,
        })),
      );
      const failures: unknown[] = [];
      for (const result of meshResults)
        if (result.status === "rejected") failures.push(result.reason);
      // The next service reopens only Agents with work to resume. Decide and
      // save that list before closing anything: if the listener's overall
      // drain budget ends a slow close, the saved list is already right.
      await Effect.runPromise(
        Effect.forEach(
          settled,
          (result) =>
            Effect.promise(async () => {
              if (result.status !== "fulfilled") return;
              const { owner } = result.value;
              // A request still draining may yet commit work, so an Agent in
              // use or admitting work keeps its entry, before or after the read.
              const databasePath = owner.runtime.databasePath;
              const unused = () =>
                !uses.has(databasePath) && !gates.has(databasePath);
              try {
                if (unused()) {
                  const state = await owner.runtime.idle();
                  if (state.idle && unused())
                    rememberIdleWake(databasePath, state.wakeAt);
                }
              } catch (cause) {
                logEvent("service-owner.read-idle", cause);
              }
            }),
          { concurrency: 4, discard: true },
        ),
      );
      await saveRecovery();
      await Effect.runPromise(
        Effect.forEach(
          settled,
          (result) =>
            Effect.promise(async () => {
              if (result.status !== "fulfilled") return;
              const { pending, owner } = result.value;
              try {
                await owner.runtime.close();
              } catch (cause) {
                logEvent("service-owner.close-runtime", cause);
                failures.push(cause);
              } finally {
                opening.delete(pending);
              }
            }),
          { concurrency: 4, discard: true },
        ),
      );
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
  function restore(): Promise<void> {
    restoring ??= restoreSaved();
    return restoring;
  }

  function loadRecovery() {
    loadingRecovery ??= readRecovery();
    return loadingRecovery;
  }

  function disableRecovery(
    reason: LocalRecoveryPersistenceDisabled["reason"],
    cause: unknown,
  ): RecoveryLoad {
    const error = new LocalRecoveryPersistenceDisabled(reason, cause);
    onRecoveryDisabled(reason === "read" ? "read-failed" : "decode-failed");
    logEvent(`service-owner.recovery-disabled.${error.reason}`, error);
    return { kind: "disabled", error };
  }

  async function readRecovery(): Promise<RecoveryLoad> {
    if (recoveryPath === undefined) return { kind: "loaded", references: [] };
    let content: string;
    try {
      content = await readRecoveryManifest(recoveryPath);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return { kind: "loaded", references: [] };
      // Unknown contents are not an empty manifest. Keep the file untouched
      // for this service lifetime while still admitting on-demand Agents.
      return disableRecovery("read", cause);
    }
    const decoded = decodeRecoveryFile(content);
    if (decoded._tag === "Failure") {
      return disableRecovery("decode", decoded.failure);
    }
    const saved: z.infer<typeof recoveryOwnerSchema>[] = [];
    for (const entry of decoded.success) {
      const selection = recoveryOwnerSchema.safeParse(entry);
      if (!selection.success) {
        logEvent("service-owner.decode-recovery-entry", selection.error);
        continue;
      }
      saved.push(selection.data);
      // A concurrent client may already have installed the current reference.
      if (!recovery.has(selection.data.databasePath))
        recovery.set(selection.data.databasePath, selection.data);
    }
    return { kind: "loaded", references: saved };
  }

  async function restoreSaved() {
    const loaded = await loadRecovery();
    if (loaded.kind === "disabled") return;
    // Preload valid references before opening, then isolate and prune each
    // failed owner so an unavailable project cannot prevent service startup.
    for (const selection of loaded.references) {
      if (stopping) break;
      if (selection.wakeAt !== undefined && selection.wakeAt > Date.now()) {
        // A client may already have opened this store while the manifest was
        // loading. Its runtime now owns the wake; do not arm a second one.
        await Promise.allSettled(pendingOpenings);
        if (!owners.has(`store:${selection.databasePath}`))
          wakes.set(selection.databasePath, selection);
        continue;
      }
      try {
        await ownerFor(selection);
      } catch (cause) {
        // A completed open remains owned and is drained by close(). Keep its
        // recovery reference, and all not-yet-opened references, for next time.
        if (closing !== undefined) break;
        logEvent("service-owner.restore-entry", cause);
        // A good owner may already have replaced another stale reference to
        // this store. Prune only the failing reference, never that live owner.
        if (recovery.get(selection.databasePath) === selection)
          recovery.delete(selection.databasePath);
      }
    }
    scheduleWakes();
    await saveRecovery();
  }
  /** A person archives or restores any Agent of one project folder. */
  async function archive(
    request: Readonly<{
      invocationRoot: string;
      agentId: string;
      archived: boolean;
    }>,
    signal: AbortSignal,
  ) {
    const control = directory(await realpath(request.invocationRoot));
    const target: LocalArchiveRequest = {
      agentId: request.agentId,
      by: { kind: "human" },
    };
    await (request.archived
      ? control.archive(target, signal)
      : control.unarchive(target, signal));
  }
  /**
   * This is Agent lifetime ancestry, not turn ancestry: a stopped parent still
   * owns its helpers. Snapshot once, visit descendants before their creator,
   * and never delete or archive their conversations.
   */
  async function stopAll(
    request: Readonly<{ invocationRoot: string; agentId: string }>,
  ): Promise<StopAllResult> {
    ensureRunning();
    const invocationRoot = await realpath(request.invocationRoot);
    const paths = await listPrivateLocalAgentStores(invocationRoot, "all");
    if (paths.length > 4_096)
      throw new Error(
        "Too many Agent stores to stop safely in one request; no cascade was started",
      );
    const result: StopAllResult = {
      rootAgentId: request.agentId,
      agents: [],
      discoveryFailures: [],
    };
    const agents = new Map<
      string,
      { databasePath: string; name: string; createdBy: string | null }
    >();
    for (const databasePath of paths) {
      const agentId = basename(dirname(databasePath));
      try {
        if (!belongsToProject(invocationRoot, databasePath))
          throw new Error(
            "Agent is outside this Local project; it was not stopped",
          );
        const profile = readPrivateLocalAgentProfile(databasePath);
        agents.set(agentId, {
          databasePath,
          name: profile.name ?? agentId,
          createdBy: profile.createdBy,
        });
      } catch (cause) {
        result.discoveryFailures.push({
          agentId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (!agents.has(request.agentId))
      throw new Error(
        "The selected Agent could not be read; no cascade was started",
      );
    // Iterative postorder is bounded by the discovered stores, including cycles.
    const seen = new Set<string>();
    const stack = [{ agentId: request.agentId, visited: false }];
    const ordered: string[] = [];
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) break;
      if (entry.visited) {
        ordered.push(entry.agentId);
        continue;
      }
      if (seen.has(entry.agentId)) continue;
      seen.add(entry.agentId);
      stack.push({ ...entry, visited: true });
      const children = [...agents].filter(
        ([, agent]) => agent.createdBy === entry.agentId,
      );
      for (const [agentId] of children.reverse())
        stack.push({ agentId, visited: false });
    }
    for (const agentId of ordered) {
      const agent = agents.get(agentId);
      if (agent === undefined) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new AbortController();
      try {
        const stopped = await Promise.race([
          (async () => {
            const { runtime: owner, release } = await acquire({
              invocationRoot,
              databasePath: agent.databasePath,
            });
            try {
              deadline.signal.throwIfAborted();
              let after: string | undefined;
              let stopped = false;
              do {
                const page = await owner.listSessions(after);
                deadline.signal.throwIfAborted();
                for (const row of page.sessions) {
                  const session = owner.getSession(row.sessionId);
                  const snapshot = await session.read({ limit: 1 });
                  deadline.signal.throwIfAborted();
                  if (
                    snapshot.activity.queue.state !== "running" &&
                    snapshot.pending.total === 0
                  )
                    continue;
                  if (
                    !snapshot.activity.cancellationRequested ||
                    snapshot.pending.total > 0
                  )
                    await session.abort();
                  // An accepted cancellation is not a completed stop. In particular,
                  // first Esc may already have requested cancellation of this turn.
                  // Keep the existing per-Agent deadline while awaiting durable idle.
                  let settled = await session.read({ limit: 1 });
                  while (
                    settled.activity.queue.state === "running" ||
                    settled.pending.total > 0
                  ) {
                    await delay(20, undefined, { signal: deadline.signal });
                    settled = await session.read({ limit: 1 });
                  }
                  deadline.signal.throwIfAborted();
                  stopped = true;
                }
                after = page.next;
              } while (after !== undefined);
              return stopped;
            } finally {
              release();
            }
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new Error(
                "Agent did not answer within 5 seconds; stop is unconfirmed",
              );
              deadline.abort(error);
              reject(error);
            }, 5_000);
          }),
        ]);
        result.agents.push({
          agentId,
          name: agent.name,
          outcome: stopped ? "stopped" : "idle",
        });
      } catch (cause) {
        result.agents.push({
          agentId,
          name: agent.name,
          outcome: "failed",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return result;
  }
  return {
    refreshMesh: mesh.refresh,
    createSession,
    select,
    serve,
    effectiveModel,
    sandboxStatus,
    sweepIdle,
    archive,
    stopAll,
    restore,
    close,
    reload,
    unfinishedOwners: () => [
      ...(reloading === undefined ? [] : ["configuration reload"]),
      ...opening.values(),
    ],
  };
}
