import { FungiMcpSelectionConflict } from "./private-fungi-mcp-selection.js";
import { LocalSessionPathConflict } from "./private-local-service-owner.js";
export { LocalSessionPathConflict } from "./private-local-service-owner.js";
import { EventSource } from "eventsource";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import {
  runPrivateLocalAuthRemote,
  type PrivateLocalAuthTarget,
} from "./private-local-auth-rpc.js";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createShiitakeClient,
  parseSessionSnapshot,
} from "@fungi.computer/shiitake/client";
import type { ShiitakeEventSourceConstructor } from "@fungi.computer/shiitake/client";
import {
  acquireServiceLock,
  assertNoUntrackedServiceOwner,
  handshake,
  modelChoicesSchema,
  readLiveServiceStatus,
  readServiceRecord,
  removeOwnedServiceRecord,
  selectedSchema,
  sessionDiscoverySchema,
  sessionInspectionSchema,
  serviceDirectory,
  serviceOwnerIsLive,
  type ServiceRecord,
} from "./private-local-service-discovery.js";
import type { PrivateLocalServiceManager } from "./private-local-service-contract.js";
import { privateLocalEffectiveModelSchema } from "./private-local-effective-model.js";
import { projectPrivateLocalSessionDiscovery } from "./private-local-session-discovery.js";
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
  PrivateLocalServiceManager,
  PrivateLocalServiceRequestOptions,
  PrivateLocalSessionChoice,
  PrivateLocalSessionDiscovery,
  PrivateLocalSessionInspection,
  PrivateLocalSessionProblem,
} from "./private-local-service-contract.js";
export type { PrivateLocalModelChoice } from "./local-models.js";
export type { PrivateLocalEffectiveModel } from "./private-local-effective-model.js";
export {
  runPrivateLocalWorkerServer,
  type PrivateLocalWorkerServerIo,
} from "./private-local-worker-server.js";

type StartRequest = NonNullable<
  Parameters<PrivateLocalServiceManager["start"]>[0]
>;

/** Construction does not start a service or open a store. Call start/connect explicitly. */
export function createPrivateLocalServiceManager(
  options: {
    directory?: string;
    eventSource?: ShiitakeEventSourceConstructor;
    executable?: string;
    /** Test/client override; production captures the invoking client's PATH. */
    executionPath?: string;
    /** How long to wait for a live service that misses its handshake (default 60 s). */
    busyServiceWaitMs?: number;
  } = {},
): PrivateLocalServiceManager {
  const clientPath =
    options.executionPath === undefined
      ? capturePrivateLocalExecPath(
          process.env.PATH ?? "/usr/bin:/bin",
          process.cwd(),
        )
      : parsePrivateLocalExecPath(options.executionPath);
  const expectedBuildId = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .parse(process.env.FUNGI_BUNDLED_BUILD_ID);
  function acceptBuild(ready: NonNullable<Awaited<ReturnType<typeof status>>>) {
    if (ready.buildId !== expectedBuildId)
      throw new Error(
        "The running service belongs to a different Fungi build. Finish active turns, run fungi stop, then reopen Fungi. Saved Sessions are preserved.",
      );
    return ready;
  }
  const maximumInspectionResponseBytes = 2_097_152;
  async function readBoundedResponse(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const declaredBytes = Number(declared);
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 0 ||
        declaredBytes > maximumInspectionResponseBytes
      )
        throw new Error("Local Session inspection response is too large");
    }
    if (response.body === null)
      throw new Error("Local Session inspection returned no body");
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>(),
    );
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      size += bytes.byteLength;
      if (size > maximumInspectionResponseBytes) {
        await reader.cancel();
        throw new Error("Local Session inspection response is too large");
      }
      chunks.push(bytes);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }
  async function status(timeoutMs?: number) {
    const record = await readServiceRecord(
      await serviceDirectory(options.directory),
    );
    if (record === undefined) return undefined;
    const probe = await readLiveServiceStatus(record, timeoutMs);
    return probe.kind === "running" ? probe.service : undefined;
  }
  /**
   * A loaded machine can delay a live service past the short handshake. Its
   * lease proves it is alive, so wait for it outside the startup lock instead
   * of spawning a second service that can only fail on that lease.
   */
  async function awaitBusyService(
    request: StartRequest,
  ): Promise<ServiceRecord> {
    const waitMs = options.busyServiceWaitMs ?? 60_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      request.signal?.throwIfAborted();
      const ready = await status(Math.min(10_000, waitMs));
      if (ready) return acceptBuild(ready);
      await delay(250, undefined, { signal: request.signal });
    }
    throw new Error(
      `The Fungi service is running but has not answered for ${String(Math.round(waitMs / 1000))} seconds; the machine may be overloaded. Retry, or run fungi stop after its turns finish.`,
    );
  }
  async function ownerLockReleased(directory: string) {
    try {
      await stat(join(directory, "owner.lock"));
      return false;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return true;
      throw cause;
    }
  }
  async function start(request: StartRequest = {}): Promise<ServiceRecord> {
    const started = await startUnderLock(request);
    return started === "busy" ? awaitBusyService(request) : started;
  }
  async function startUnderLock(
    request: StartRequest,
  ): Promise<ServiceRecord | "busy"> {
    request.signal?.throwIfAborted();
    const directory = await serviceDirectory(options.directory);
    const release = await acquireServiceLock(directory, "startup");
    try {
      const existing = await status();
      request.signal?.throwIfAborted();
      if (existing) return acceptBuild(existing);
      await assertNoUntrackedServiceOwner(directory);
      if (serviceOwnerIsLive(directory)) return "busy";
      const bundledCli = process.env.FUNGI_BUNDLED_CLI;
      const child = spawn(
        options.executable ?? process.execPath,
        bundledCli === undefined
          ? [
              fileURLToPath(
                new URL("./private-local-service-process.js", import.meta.url),
              ),
              directory,
            ]
          : [bundledCli, "--internal-service", directory],
        { detached: true, stdio: "ignore" },
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
        if (ready) return acceptBuild(ready);
        if (hasExited())
          throw new Error("Local service exited before its handshake");
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
      await release();
    }
  }
  const openConnection = async (
    endpoint: "select" | "sessions",
    input:
      | Parameters<PrivateLocalServiceManager["connect"]>[0]
      | Parameters<PrivateLocalServiceManager["createSession"]>[0],
    request: Parameters<PrivateLocalServiceManager["connect"]>[1] = {},
  ) => {
    request.signal?.throwIfAborted();
    const service = await start(request);
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, clientPath }),
      redirect: "error",
    };
    if (request.signal !== undefined) init.signal = request.signal;
    const response = await fetch(
      `${service.baseUrl}/service/${service.serviceId}/${endpoint}`,
      init,
    );
    if (response.status === 409) {
      const conflict = z.object({ code: z.string() }).safeParse(
        await response.json().catch((cause: unknown) => {
          console.error("Local service response unavailable", cause);
          return undefined;
        }),
      );
      if (conflict.success && conflict.data.code === "session_path_conflict")
        throw new LocalSessionPathConflict();
      if (conflict.success && conflict.data.code === "store_in_use")
        throw new Error(
          "This Agent store is held by another Fungi service. Stop the older service process, then retry; keep the Agent store files.",
        );
      throw new FungiMcpSelectionConflict();
    }
    if (!response.ok)
      throw new Error(
        `Local service selection failed (${String(response.status)})`,
      );
    const selected = selectedSchema.parse(await response.json());
    const baseUrl = `${service.baseUrl}/service/${service.serviceId}${selected.routePath}`;
    const client = createShiitakeClient({
      baseUrl,
      eventSource: options.eventSource ?? EventSource,
    });
    return {
      service,
      agentId: selected.agentId,
      databasePath: selected.databasePath,
      sessionId: selected.sessionId,
      client,
      session: client.session(selected.sessionId),
      effectiveModel: async (
        request: Readonly<{ signal?: AbortSignal | undefined }> = {},
      ) => {
        request.signal?.throwIfAborted();
        const init: RequestInit = { redirect: "error" };
        if (request.signal !== undefined) init.signal = request.signal;
        const response = await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(selected.sessionId)}/effective-model`,
          init,
        );
        if (!response.ok)
          throw new Error(
            `Local effective model read failed (${String(response.status)})`,
          );
        return privateLocalEffectiveModelSchema.parse(await response.json());
      },
      close: () => client.close(),
    };
  };
  const connect: PrivateLocalServiceManager["connect"] = (selection, request) =>
    openConnection("select", selection, request);
  const inspectResponseSchema = z.strictObject({
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
        body: JSON.stringify({ invocationRoot }),
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
      if (!response.ok)
        throw new Error(
          `Local Session inspection failed (${String(response.status)})`,
        );
      const decoded = inspectResponseSchema.parse(
        JSON.parse(await readBoundedResponse(response)),
      );
      const baseUrl = `${service.baseUrl}/service/${service.serviceId}${decoded.selected.routePath}`;
      const client = createShiitakeClient({
        baseUrl,
        eventSource: options.eventSource ?? EventSource,
      });
      return {
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
        return await runPrivateLocalAuthRemote(remote, request, interaction);
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
    async stop(expectedServiceId) {
      const directory = await serviceDirectory(options.directory);
      const release = await acquireServiceLock(directory, "startup");
      try {
        const service = await readServiceRecord(directory);
        if (service === undefined)
          return { kind: "not-running", recordCleaned: false };
        if (
          expectedServiceId !== undefined &&
          service.serviceId !== expectedServiceId
        )
          return { kind: "replaced" };
        const probe = await readLiveServiceStatus(service);
        if (probe.kind === "not-running" && !serviceOwnerIsLive(directory)) {
          await removeOwnedServiceRecord(directory, service.serviceId);
          return { kind: "not-running", recordCleaned: true };
        }
        if (probe.kind !== "running")
          throw new Error(
            "Local service is not answering; retry after its active turns finish.",
          );
        const response = await fetch(
          `${service.baseUrl}/service/${service.serviceId}/stop`,
          {
            method: "POST",
            redirect: "error",
          },
        );
        if (!response.ok) throw new Error("Local service refused shutdown");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            !(await handshake(service)) &&
            (await ownerLockReleased(directory))
          )
            return { kind: "stopped" };
          await delay(100);
        }
        throw new Error(
          "Local service shutdown has not released its owner lock",
        );
      } finally {
        await release();
      }
    },
  };
}
