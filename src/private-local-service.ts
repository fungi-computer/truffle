import { FungiMcpSelectionConflict } from "./private-fungi-mcp-selection.js";
import { logEvent } from "./log-event.js";
import { readBoundedResponse } from "./private-bounded-response.js";
import {
  LocalSandboxUnavailable,
  sandboxUnavailableReasonSchema,
} from "./private-local-containment.js";
export { LocalSandboxUnavailable } from "./private-local-containment.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import { takePendingExtensionArchiveNotices } from "./private-local-extension-archive-notice.js";
import { stopAllResultSchema } from "./private-local-stop-all.js";
export type { StopAllResult } from "./private-local-stop-all.js";
import {
  LocalAgentSelectionAmbiguous,
  LocalSessionPathConflict,
} from "./private-local-service-owner.js";
export {
  LocalAgentSelectionAmbiguous,
  LocalSessionPathConflict,
} from "./private-local-service-owner.js";
import { EventSource } from "eventsource";
import { AgentArchiveRefused } from "@fungi.computer/shiitake/agent-control";
export { AgentArchiveRefused } from "@fungi.computer/shiitake/agent-control";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import {
  runPrivateLocalAuthRemote,
  type PrivateLocalAuthTarget,
} from "./private-local-auth-rpc.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readInstalledLocalClientBuildId } from "./private-local-client-version.js";
import { nativePackageStartupError } from "./private-local-native-install-error.js";
export { readInstalledLocalClientBuildId } from "./private-local-client-version.js";
export { privateLocalServiceVersion } from "./private-local-service-discovery.js";
import {
  createShiitakeClient,
  parseSessionSnapshot,
} from "@fungi.computer/shiitake/client";
import type { ShiitakeEventSourceConstructor } from "@fungi.computer/shiitake/client";
import {
  acquireServiceLock,
  assertNoUntrackedServiceOwner,
  clearAbandonedServiceOwner,
  modelChoicesSchema,
  privateLocalServiceVersion,
  readLiveServiceStatus,
  readServiceRegistration,
  removeOwnedServiceRecord,
  removeUnidentifiedServiceRecord,
  selectedSchema,
  sandboxStatusSchema,
  sessionDiscoverySchema,
  archiveRefusalSchema,
  archiveRequestSchema,
  discoverRequestSchema,
  sessionInspectionSchema,
  serviceDirectory,
  serviceDirectoryPath,
  serviceOwnerIsLive,
  type ServiceRecord,
  type LiveServiceStatus,
  type ServiceRegistration,
} from "./private-local-service-discovery.js";
import type {
  PrivateLocalServiceConnection,
  PrivateLocalServiceManager,
  PrivateLocalServiceStopResult,
} from "./private-local-service-contract.js";
import { terminatePrivateLocalService } from "./private-local-service-termination.js";
import { readServiceLeaseOwner } from "./private-local-service-lease.js";
import { privateLocalEffectiveModelSchema } from "./private-local-effective-model.js";
import {
  LocalStoreSchemaError,
  projectPrivateLocalSessionDiscovery,
} from "./private-local-session-discovery.js";
export { LocalStoreSchemaError } from "./private-local-session-discovery.js";
import {
  capturePrivateLocalExecPath,
  parsePrivateLocalExecPath,
} from "./private-local-exec-path.js";
import { z } from "zod";
export type {
  PrivateLocalServiceStatus,
  PrivateLocalServiceStopResult,
  PrivateLocalServiceSelection,
  PrivateLocalSessionCreation,
  PrivateLocalServiceConnection,
  PrivateLocalServiceRebind,
  PrivateLocalServiceManager,
  PrivateLocalServiceRequestOptions,
  PrivateLocalDiscoveryOptions,
  PrivateLocalArchiveRequest,
  PrivateLocalAgentChoice,
  PrivateLocalSessionChoice,
  PrivateLocalSessionDiscovery,
  PrivateLocalSessionInspection,
  PrivateLocalSessionProblem,
} from "./private-local-service-contract.js";
export type { PrivateLocalModelChoice } from "./local-models.js";
export type {
  ServiceDiagnosticsStatus,
  ServiceDiagnosticsFailureCode,
} from "./private-local-service-log.js";
import { serviceDiagnosticsStatusSchema } from "./private-local-service-log.js";
export type { PrivateLocalEffectiveModel } from "./private-local-effective-model.js";
export {
  runPrivateLocalWorkerServer,
  type PrivateLocalWorkerServerIo,
} from "./private-local-worker-server.js";

type StartRequest = NonNullable<
  Parameters<PrivateLocalServiceManager["start"]>[0]
>;

/** The 409 answers a select can give; each is one case of a closed union. */
const selectionConflictSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("sandbox_unavailable"),
    reason: sandboxUnavailableReasonSchema,
  }),
  z.object({ code: z.literal("session_path_conflict") }),
  z.object({ code: z.literal("store_in_use") }),
  z.object({
    code: z.literal("store_schema_incompatible"),
    databasePath: z.string().min(1),
    error: z.string().min(1),
  }),
  z.object({
    code: z.literal("agent_selection_ambiguous"),
    agentIds: z.array(z.string()),
  }),
]);

/** Selection, creation and inspection share the listener's typed refusals. */
async function rejectSelectionConflict(response: Response): Promise<never> {
  const body: unknown = await response.json().catch((cause: unknown) => {
    console.error("Local service response unavailable", cause);
    return undefined;
  });
  const conflict = selectionConflictSchema.safeParse(body);
  if (conflict.success) {
    if (conflict.data.code === "store_schema_incompatible")
      throw new LocalStoreSchemaError(conflict.data.databasePath);
    if (conflict.data.code === "sandbox_unavailable")
      throw new LocalSandboxUnavailable(conflict.data.reason);
    if (conflict.data.code === "session_path_conflict")
      throw new LocalSessionPathConflict();
    if (conflict.data.code === "agent_selection_ambiguous")
      throw new LocalAgentSelectionAmbiguous(conflict.data.agentIds);
    throw new Error(
      "This Agent store is held by another Fungi service. Stop the older service process, then retry; keep the Agent store files.",
    );
  }
  // An Agent-selection answer without its Agents is a broken service, not
  // an MCP connection conflict.
  if (
    z.object({ code: z.literal("agent_selection_ambiguous") }).safeParse(body)
      .success
  )
    throw new Error("Local service sent an unreadable Agent selection");
  throw new FungiMcpSelectionConflict();
}
/** The listener's body for a failure it did not expect. */
const serviceFailureSchema = z.object({
  code: z.literal("internal_error"),
  error: z.string(),
});

/** The service answered a selection with a failure status and no readable failure body. */
export class LocalServiceUnreadableResponse extends Error {
  override readonly name = "LocalServiceUnreadableResponse";
  readonly status: number;
  constructor(status: number, cause: unknown) {
    super(
      `Local service selection failed (${String(status)}) without a readable failure body`,
      { cause },
    );
    this.status = status;
  }
}

/**
 * A newer client replaced the service this running client reached with one
 * that speaks another protocol. Only restarting the window can reconnect it.
 */
export class LocalServiceUpdated extends Error {
  override readonly name = "LocalServiceUpdated";
  constructor() {
    super("The Fungi service was updated. Restart this window.");
  }
}

/** Construction does not start a service or open a store. Call start/connect explicitly. */
export function createPrivateLocalServiceManager(
  options: {
    /** Selected host home, independent of an explicit service directory. */
    home?: string;
    directory?: string;
    eventSource?: ShiitakeEventSourceConstructor;
    executable?: string;
    /** Test/client override; production captures the invoking client's PATH. */
    executionPath?: string;
    /** How long to wait for a live service that misses its handshake (default 60 s). */
    busyServiceWaitMs?: number;
    /**
     * Where a failed cleanup (for example an auth cancel the service could not
     * take) is recorded with its cause. Clients with an operator log pass it;
     * the default writes one bounded line to stderr.
     */
    reportCleanupFailure?: (cause: unknown) => void;
  } = {},
): PrivateLocalServiceManager {
  const root = capturePrivateLocalConfigRoot(options.home);
  const selectedDirectory = serviceDirectoryPath(
    options.directory ?? root.serviceDirectory,
  );
  const reportCleanupFailure =
    options.reportCleanupFailure ??
    ((cause: unknown) => {
      process.stderr.write(
        `Local service cleanup failed (${cause instanceof Error ? cause.name : "NonError"}).\n`,
      );
    });
  const clientPath =
    options.executionPath === undefined
      ? capturePrivateLocalExecPath(
          process.env.PATH ?? "/usr/bin:/bin",
          process.cwd(),
        )
      : parsePrivateLocalExecPath(options.executionPath);
  const expectedVersion = privateLocalServiceVersion();
  async function reportPendingExtensionArchiveNotices() {
    try {
      const notices = await takePendingExtensionArchiveNotices(root.home);
      for (const notice of notices) process.stderr.write(`${notice}\n`);
    } catch (cause) {
      logEvent("extension.archive-notice", cause);
    }
  }
  /**
   * Set once this client has reached a service. Only a starting client
   * replaces a service speaking another protocol. Same-protocol build changes
   * still require the installed-client check; reaching a service is not proof
   * that this window remains the installed client.
   */
  let reachedService = false;
  function accept(service: LiveServiceStatus) {
    reachedService = true;
    return service;
  }
  const maximumInspectionResponseBytes = 2_097_152;
  async function status(timeoutMs?: number) {
    const directory = selectedDirectory;
    const registration = await readServiceRegistration(directory);
    if (
      registration?.kind === "other-protocol" &&
      (await serviceOwnerIsLive(directory))
    )
      throw new LocalServiceUpdated();
    if (registration?.kind !== "current") return undefined;
    const probe = await readLiveServiceStatus(registration.record, timeoutMs);
    return probe.kind === "running" ? probe.service : undefined;
  }
  /**
   * A loaded machine can delay a live service past the short handshake. Its
   * lease proves it is alive, so wait for it outside the startup lock instead
   * of spawning a second service that can only fail on that lease.
   */
  async function awaitBusyService(
    request: StartRequest,
  ): Promise<LiveServiceStatus> {
    const waitMs = options.busyServiceWaitMs ?? 60_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      request.signal?.throwIfAborted();
      const ready = await status(Math.min(10_000, waitMs));
      if (ready) {
        if (ready.version === expectedVersion) return accept(ready);
        // It answered at last, as another version: replace it under the lock.
        const started = await startUnderLock(request);
        if (started !== "busy") return started;
      }
      await delay(250, undefined, { signal: request.signal });
    }
    throw new Error(
      `The Fungi service is running but has not answered for ${String(Math.round(waitMs / 1000))} seconds; the machine may be overloaded. Retry, or run fungi stop after its turns finish.`,
    );
  }
  async function start(request: StartRequest = {}): Promise<LiveServiceStatus> {
    const started = await startUnderLock(request);
    return started === "busy" ? awaitBusyService(request) : started;
  }
  /** `fungi stop`'s work, under the startup lock that serializes it with starts. */
  async function stopUnderLock(
    directory: string,
    expectedServiceId?: string,
  ): Promise<PrivateLocalServiceStopResult> {
    const registration = await readServiceRegistration(directory);
    if (registration === undefined)
      return { kind: "not-running", recordCleaned: false };
    if (registration.kind === "unidentified") {
      if (await serviceOwnerIsLive(directory))
        throw new Error(
          `A Fungi service this client cannot identify owns ${directory}. End that Fungi service process, then retry; saved Sessions are kept.`,
        );
      await removeUnidentifiedServiceRecord(directory);
      return { kind: "not-running", recordCleaned: true };
    }
    const lifecycle =
      registration.kind === "current"
        ? registration.record
        : registration.lifecycle;
    if (
      expectedServiceId !== undefined &&
      lifecycle.serviceId !== expectedServiceId
    )
      return { kind: "replaced" };
    const owner = await readServiceLeaseOwner(directory);
    if (owner === undefined) {
      await removeOwnedServiceRecord(directory, lifecycle.serviceId);
      return { kind: "not-running", recordCleaned: true };
    }
    // The file points at a claim; it cannot supply signal authority itself.
    if (owner.pid !== lifecycle.pid || owner.startedAt !== lifecycle.startedAt)
      throw new Error(
        `The Fungi lease owner in ${directory} does not match service.json; retry after the owner registers itself. No process was signalled.`,
      );
    const outcome = await terminatePrivateLocalService(directory, owner);
    // A killed process cannot remove its own record or lifetime lock.
    await removeOwnedServiceRecord(directory, lifecycle.serviceId);
    await clearAbandonedServiceOwner(directory);
    return { kind: outcome };
  }
  /**
   * Reuse the registered service when this client can, otherwise stop it so a
   * service of this version can start; undefined means start one.
   */
  async function reuseOrReplace(
    directory: string,
    registration: ServiceRegistration,
  ): Promise<LiveServiceStatus | undefined> {
    if (registration.kind === "current") {
      const probe = await readLiveServiceStatus(registration.record);
      // Not answering: the lifetime lease decides between busy and gone.
      if (probe.kind !== "running") return undefined;
      if (probe.service.version === expectedVersion) return probe.service;
      // Replace only for the installed client. A stale window (or an
      // uninstalled source run) must not stop the service; it restarts.
      if (expectedVersion !== (await readInstalledLocalClientBuildId()))
        throw new LocalServiceUpdated();
    } else if (registration.kind === "other-protocol" && reachedService) {
      if (await serviceOwnerIsLive(directory)) throw new LocalServiceUpdated();
    }
    if (
      registration.kind === "other-protocol" &&
      expectedVersion !== (await readInstalledLocalClientBuildId())
    )
      throw new LocalServiceUpdated();
    await stopUnderLock(directory);
    return undefined;
  }
  async function startUnderLock(
    request: StartRequest,
  ): Promise<LiveServiceStatus | "busy"> {
    request.signal?.throwIfAborted();
    const directory = await serviceDirectory(selectedDirectory);
    const release = await acquireServiceLock(directory, "startup");
    let nativeRefusalDirectory: string | undefined;
    try {
      const registration = await readServiceRegistration(directory);
      const existing =
        registration === undefined
          ? undefined
          : await reuseOrReplace(directory, registration);
      request.signal?.throwIfAborted();
      if (existing) return accept(existing);
      await assertNoUntrackedServiceOwner(directory);
      if (await serviceOwnerIsLive(directory)) return "busy";
      const bundledCli = process.env.FUNGI_BUNDLED_CLI;
      // A detached Bun service also starts in the invoking project's cwd.
      // Keep the host process from importing Agent-authored bunfig or .env.
      const bunFlags =
        options.executable === undefined && "bun" in process.versions
          ? ["--config=/dev/null", "--no-env-file"]
          : [];
      const serviceEntry =
        bundledCli ??
        fileURLToPath(
          new URL("./private-local-service-process.js", import.meta.url),
        );
      nativeRefusalDirectory = await mkdtemp(
        join(directory, ".native-startup-refusal-"),
      );
      const nativeRefusal = join(nativeRefusalDirectory, "native-package");
      const child = spawn(
        options.executable ?? process.execPath,
        [
          ...bunFlags,
          serviceEntry,
          ...(bundledCli === undefined ? [] : ["--internal-service"]),
          directory,
        ],
        {
          detached: true,
          stdio: "ignore",
          // Service startup retains its existing inherited inputs. This is
          // not a Computer exec child: only its selected host HOME is pinned.
          env: {
            ...process.env,
            HOME: root.home,
            FUNGI_NATIVE_STARTUP_REFUSAL: nativeRefusal,
          },
        },
      );
      let failure: Error | undefined;
      let exited = false;
      const readFailure = () => failure;
      const hasExited = () => exited;
      child.once("error", (cause) => {
        failure = cause;
      });
      child.once("exit", () => {
        exited = true;
      });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const childFailure = readFailure();
        if (childFailure !== undefined) throw childFailure;
        const ready = await status();
        if (ready) {
          if (ready.version !== expectedVersion)
            throw new Error(
              `The started Local service reports version ${ready.version}, not this client's ${expectedVersion}`,
            );
          return accept(ready);
        }
        if (hasExited()) {
          const refusal = await readFile(nativeRefusal, "utf8").catch(
            (cause: unknown) => {
              if (
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
                return undefined;
              throw cause;
            },
          );
          if (refusal === "native-package") throw nativePackageStartupError();
          throw new Error("Local service exited before its handshake");
        }
        await delay(100, undefined, { signal: request.signal });
      }
      child.kill("SIGTERM");
      for (let attempt = 0; attempt < 20 && !hasExited(); attempt += 1)
        await delay(100);
      throw new Error(
        hasExited()
          ? "Local service did not become ready and its owned child was stopped"
          : `Local service did not become ready; child ${String(child.pid)} is still running`,
      );
    } finally {
      // The token is per spawn and cannot survive a failed or successful start.
      try {
        if (nativeRefusalDirectory !== undefined)
          await rm(nativeRefusalDirectory, { recursive: true, force: true });
      } finally {
        await release();
      }
    }
  }
  type SelectionInput =
    | Parameters<PrivateLocalServiceManager["connect"]>[0]
    | Parameters<PrivateLocalServiceManager["createSession"]>[0];
  /** POST one selection to `service`; every refusal is a typed failure. */
  const postSelection = async (
    endpoint: "select" | "sessions",
    input: SelectionInput,
    service: ServiceRecord,
    signal: AbortSignal | undefined,
  ) => {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, clientPath }),
      redirect: "error",
    };
    if (signal !== undefined) init.signal = signal;
    const response = await fetch(
      `${service.baseUrl}/service/${service.serviceId}/${endpoint}`,
      init,
    );
    if (response.status === 409) await rejectSelectionConflict(response);
    if (!response.ok) {
      // The service names its own failure in a JSON body; one without it is
      // a broken response, not a status to guess from.
      const failure = serviceFailureSchema.safeParse(
        await response.json().catch((cause: unknown) => {
          throw new LocalServiceUnreadableResponse(response.status, cause);
        }),
      );
      if (!failure.success)
        throw new LocalServiceUnreadableResponse(
          response.status,
          failure.error,
        );
      throw new Error(
        `Local service selection failed (${String(response.status)}): ${failure.data.error}`,
      );
    }
    return selectedSchema.parse(await response.json());
  };
  const routeBase = (
    service: ServiceRecord,
    selected: Readonly<{ routePath: string }>,
  ) => `${service.baseUrl}/service/${service.serviceId}${selected.routePath}`;
  const openConnection = async (
    endpoint: "select" | "sessions",
    input: SelectionInput,
    request: Parameters<PrivateLocalServiceManager["connect"]>[1] = {},
  ): Promise<PrivateLocalServiceConnection> => {
    request.signal?.throwIfAborted();
    const service = await start(request);
    const selected = await postSelection(
      endpoint,
      input,
      service,
      request.signal,
    );
    await reportPendingExtensionArchiveNotices();
    const firstBase = routeBase(service, selected);
    /**
     * Where this connection's client currently talks. A restarted service
     * comes back on a new port with a new id, so the client's requests are
     * redirected here rather than the client rebuilt: its Session address
     * and everything the TUI keyed on it stay the same.
     */
    let route = { service, base: firstBase };
    let closing: Promise<void> | undefined;
    const isClosing = () => closing !== undefined;
    const reroute = (url: string) =>
      url === firstBase || url.startsWith(`${firstBase}/`)
        ? route.base + url.slice(firstBase.length)
        : url;
    const transport = globalThis.fetch;
    const releaseRoute = async (base: string) => {
      try {
        const response = await transport(`${base}/`, {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok && response.status !== 404)
          throw new Error(
            `Local client release failed (${String(response.status)})`,
          );
      } catch (error) {
        if (options.reportCleanupFailure === undefined)
          logEvent("service-client.release", error);
        else options.reportCleanupFailure(error);
      }
    };
    const reroutedFetch = Object.assign(
      (target: string | URL | Request, init?: RequestInit) => {
        if (target instanceof Request)
          throw new TypeError("A Local service connection fetches by URL");
        return transport(reroute(String(target)), init);
      },
      { preconnect: transport.preconnect },
    );
    const Source: ShiitakeEventSourceConstructor =
      options.eventSource ?? EventSource;
    class ReroutedEventSource extends Source {
      constructor(url: string) {
        super(reroute(url));
        // The library would retry the address it was built with, forever and
        // silently. A dropped stream is surfaced instead, so the owner of the
        // connection can rebind it and reopen the observation.
        this.addEventListener("error", () => {
          this.close();
        });
      }
    }
    const client = createShiitakeClient({
      baseUrl: firstBase,
      fetch: reroutedFetch,
      eventSource: ReroutedEventSource,
    });
    return {
      get service() {
        return route.service;
      },
      agentId: selected.agentId,
      databasePath: selected.databasePath,
      sessionId: selected.sessionId,
      client,
      session: client.session(selected.sessionId),
      sandboxStatus: async (
        request: Readonly<{ signal?: AbortSignal | undefined }> = {},
      ) => {
        request.signal?.throwIfAborted();
        const init: RequestInit = { redirect: "error" };
        if (request.signal !== undefined) init.signal = request.signal;
        const response = await transport(`${route.base}/sandbox`, init);
        if (!response.ok)
          throw new Error(
            `Local sandbox status read failed (${String(response.status)})`,
          );
        return sandboxStatusSchema.parse(await response.json());
      },
      stopAll: async () => {
        const response = await fetch(
          `${route.service.baseUrl}/service/${route.service.serviceId}/stop-all`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              invocationRoot: input.invocationRoot,
              agentId: selected.agentId,
            }),
            redirect: "error",
          },
        );
        if (!response.ok)
          throw new Error(`Stop all failed (${String(response.status)})`);
        return stopAllResultSchema.parse(await response.json());
      },
      effectiveModel: async (
        request: Readonly<{ signal?: AbortSignal | undefined }> = {},
      ) => {
        request.signal?.throwIfAborted();
        const init: RequestInit = { redirect: "error" };
        if (request.signal !== undefined) init.signal = request.signal;
        const response = await transport(
          `${route.base}/sessions/${encodeURIComponent(selected.sessionId)}/effective-model`,
          init,
        );
        if (!response.ok)
          throw new Error(
            `Local effective model read failed (${String(response.status)})`,
          );
        return privateLocalEffectiveModelSchema.parse(await response.json());
      },
      rebind: async (
        rebindRequest: Parameters<
          PrivateLocalServiceConnection["rebind"]
        >[0] = {},
      ) => {
        if (isClosing()) throw new Error("Local service connection is closed");
        rebindRequest.signal?.throwIfAborted();
        // A healthy probe does not guarantee that selection will answer.
        // Bound each attempt independently of the pane's lifetime.
        const deadline = AbortSignal.timeout(5_000);
        const signal =
          rebindRequest.signal === undefined
            ? deadline
            : AbortSignal.any([rebindRequest.signal, deadline]);
        // Read service.json again, and never start a service: whoever
        // stopped it decides when it returns.
        const ready = await status();
        if (ready === undefined) return { kind: "unavailable" };
        accept(ready);
        const again = await postSelection(
          "select",
          {
            invocationRoot: input.invocationRoot,
            databasePath: selected.databasePath,
            sessionId: selected.sessionId,
            fungiMcp: input.fungiMcp,
            uiAttachmentLifetime: input.uiAttachmentLifetime,
          },
          ready,
          signal,
        );
        if (
          again.agentId !== selected.agentId ||
          again.sessionId !== selected.sessionId
        )
          throw new Error(
            "The restarted Local service selected a different Session",
          );
        const nextBase = routeBase(ready, again);
        if (isClosing()) {
          await releaseRoute(nextBase);
          throw new Error("Local service connection is closed");
        }
        const previous = route;
        route = { service: ready, base: nextBase };
        if (previous.service.serviceId === ready.serviceId)
          await releaseRoute(previous.base);
        return { kind: "rebound", service: ready };
      },
      close: () => {
        closing ??= (async () => {
          const base = route.base;
          // Stop local observations first, including when the service is gone.
          await client.close();
          await releaseRoute(base);
        })();
        return closing;
      },
    };
  };
  const connect: PrivateLocalServiceManager["connect"] = (selection, request) =>
    openConnection("select", selection, request);
  const inspectResponseSchema = z.strictObject({
    diagnostics: serviceDiagnosticsStatusSchema,
    selected: selectedSchema,
    snapshot: z.unknown(),
  });
  return {
    status,
    start,
    createSession: (creation, request) =>
      openConnection("sessions", creation, request),
    connect,
    async discover(invocationRoot, request = {}) {
      request.signal?.throwIfAborted();
      const service = await start(request);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          discoverRequestSchema.parse({
            invocationRoot,
            archived: request.archived,
          }),
        ),
        redirect: "error",
      };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetch(
        `${service.baseUrl}/service/${service.serviceId}/discover`,
        init,
      );
      if (!response.ok)
        throw new Error(
          `Local session discovery failed (${String(response.status)})`,
        );
      return projectPrivateLocalSessionDiscovery(
        sessionDiscoverySchema.parse(await response.json()),
        connect,
      );
    },
    async archive(archival, request = {}) {
      request.signal?.throwIfAborted();
      const service = await start(request);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(archiveRequestSchema.parse(archival)),
        redirect: "error",
      };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetch(
        `${service.baseUrl}/service/${service.serviceId}/archive`,
        init,
      );
      if (response.status === 409) {
        const refusal = archiveRefusalSchema.safeParse(
          await response.json().catch((cause: unknown) => {
            throw new LocalServiceUnreadableResponse(response.status, cause);
          }),
        );
        if (refusal.success)
          throw new AgentArchiveRefused(
            refusal.data.reason,
            refusal.data.error,
          );
      }
      if (!response.ok) {
        const failure = serviceFailureSchema.safeParse(
          await response.json().catch((cause: unknown) => {
            throw new LocalServiceUnreadableResponse(response.status, cause);
          }),
        );
        throw new Error(
          `Local Agent archive failed (${String(response.status)})${failure.success ? `: ${failure.data.error}` : ""}`,
        );
      }
    },
    async inspect(selection, request = {}) {
      request.signal?.throwIfAborted();
      const service = await start(request);
      const input = sessionInspectionSchema.parse({
        ...selection,
        limit: request.limit ?? 100,
      });
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
      };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetch(
        `${service.baseUrl}/service/${service.serviceId}/inspect`,
        init,
      );
      if (response.status === 409) await rejectSelectionConflict(response);
      if (!response.ok)
        throw new Error(
          `Local Session inspection failed (${String(response.status)})`,
        );
      const decoded = inspectResponseSchema.parse(
        JSON.parse(
          await readBoundedResponse(
            response,
            maximumInspectionResponseBytes,
            "Local Session inspection",
          ),
        ),
      );
      const baseUrl = `${service.baseUrl}/service/${service.serviceId}${decoded.selected.routePath}`;
      const client = createShiitakeClient({
        baseUrl,
        eventSource: options.eventSource ?? EventSource,
      });
      return {
        diagnostics: decoded.diagnostics,
        session: client.session(decoded.selected.sessionId),
        snapshot: parseSessionSnapshot(JSON.stringify(decoded.snapshot)),
        close: () => client.close(),
      };
    },
    async auth(request, interaction) {
      interaction.signal?.throwIfAborted();
      const service = await start(
        interaction.signal === undefined ? {} : { signal: interaction.signal },
      );
      interaction.signal?.throwIfAborted();
      const url = new URL(
        `${service.baseUrl}/service/${service.serviceId}/auth`,
      );
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      const remote = newWebSocketRpcSession<PrivateLocalAuthTarget>(socket);
      try {
        return await runPrivateLocalAuthRemote(
          remote,
          request,
          interaction,
          reportCleanupFailure,
        );
      } finally {
        socket.close();
      }
    },
    async models(request = {}) {
      request.signal?.throwIfAborted();
      const service = await start(request);
      const init: RequestInit = { redirect: "error" };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetch(
        `${service.baseUrl}/service/${service.serviceId}/models`,
        init,
      );
      if (!response.ok)
        throw new Error(
          `Local service model catalogue failed (${String(response.status)})`,
        );
      return modelChoicesSchema.parse(await response.json());
    },
    async reload(invocationRoot) {
      const service = await status();
      if (service === undefined)
        throw new Error("Local service is not running");
      const response = await fetch(
        `${service.baseUrl}/service/${service.serviceId}/reload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invocationRoot, clientPath }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      const result = z
        .union([
          z.strictObject({ message: z.string() }),
          z.strictObject({ error: z.string() }),
        ])
        .parse(await response.json());
      if ("error" in result) throw new Error(result.error);
      if (!response.ok)
        throw new Error(
          `Configuration reload failed (${String(response.status)})`,
        );
      return result.message;
    },
    async stop(expectedServiceId) {
      const directory = await serviceDirectory(selectedDirectory);
      const release = await acquireServiceLock(directory, "startup");
      try {
        return await stopUnderLock(directory, expectedServiceId);
      } finally {
        await release();
      }
    },
  };
}
