import { localFailureMetadata, logEvent } from "./log-event.js";
import { bodyLimit } from "hono/body-limit";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { toShiitakeErrorWire } from "@fungi.computer/shiitake/http";
import {
  localScheduleControlInputSchema,
  localScheduleListInputSchema,
} from "./private-local-schedules.js";
import {
  enrollPrivateLocalMesh,
  localMeshJoinSchema,
} from "./private-local-mesh-enrollment.js";
import {
  createLocalMachineEnrollmentAccount,
  registerFungiAccountOwner,
  signOutOwnedFungiAccount,
} from "./private-fungi-account.js";
import {
  createServiceLogLifecycle,
  type ServiceDrainPhase,
} from "./private-local-service-log.js";
import { stopAllRequestSchema } from "./private-local-stop-all.js";
import { FungiMcpSelectionConflict } from "./private-fungi-mcp-selection.js";
import { LocalSandboxUnavailable } from "./private-local-containment.js";
import {
  createNativePayloadStaging,
  type NativePayloadStaging,
} from "./private-local-native-staging.js";
import { nativePackageStartupError } from "./private-local-native-install-error.js";
import { LocalBwrapUnavailable } from "./private-local-bwrap.js";
import { writeFileSync } from "node:fs";
import { PrivateLocalAuthTarget } from "./private-local-auth-rpc.js";
import { runLocalAuthCli } from "./auth-cli.js";
import {
  capturePrivateLocalConfigRoot,
  type PrivateLocalConfigRoot,
} from "./private-local-config-root.js";
import { Hono } from "hono";
import { correlationKey } from "@fungi.computer/cairn";
import {
  createLocalUiAttachment,
  type LocalUiAttachment,
} from "./private-local-ui-attachment.js";
import { localServiceIds } from "./private-local-service-ids.js";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { privateLocalExecPathSchema } from "./private-local-exec-path.js";
import { listPrivateModels } from "./local-models.js";
import { privateSqliteFailureCode } from "./private-sqlite-owner.js";
import type { PrivateLocalEffectiveModel } from "./private-local-effective-model.js";
import { openPrivateLocalBunServer } from "./private-bun-shiitake-host.js";
import { readOwnProcessStart } from "./private-local-process-identity.js";
import {
  LocalStoreSchemaError,
  readPrivateLocalSessionDiscovery,
} from "./private-local-session-discovery.js";
import { AgentArchiveRefused } from "@fungi.computer/shiitake/agent-control";
import {
  createLocalServiceOwners,
  LocalAgentSelectionAmbiguous,
  LocalSessionPathConflict,
  type OpenLocalServiceRuntime,
} from "./private-local-service-owner.js";
import {
  acquireServiceLock,
  archiveRequestSchema,
  discoverRequestSchema,
  privateLocalServiceProtocol,
  privateLocalServiceVersion,
  recordPath,
  removeOwnedServiceRecord,
  selectionSchema,
  sessionCreationSchema,
  sessionInspectionSchema,
  sandboxStatusSchema,
  type ServiceRecord,
} from "./private-local-service-discovery.js";

type SelectionInput = z.infer<typeof selectionSchema>;

export function createPrivateLocalServiceShutdown(input: {
  closeOwners: () => Promise<void>;
  closeServer: () => Promise<void>;
  closeDiagnostics?: () => void;
  removeRecord: () => Promise<void>;
  releaseOwner: () => Promise<void>;
}) {
  let draining: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let phase: ServiceDrainPhase = "active";
  const finish = () => {
    finishing ??= (async () => {
      // Keep discovery and the lease until owners settle. The process owner
      // bounds this whole sequence, including a hung owner or listener.
      phase = "owners";
      draining ??= input.closeOwners();
      await draining;
      phase = "listener";
      await input.closeServer();
      // Stop diagnostics before releasing ownership. Its resource latches I/O
      // faults and disables writes; a diagnostic fault cannot strand a service
      // registration/lease or make normal shutdown reject.
      try {
        input.closeDiagnostics?.();
      } catch (cause) {
        // Diagnostics cannot strand registration/lease or fail a normal stop.
        // The owned resource latches its typed fault; this protects cleanup
        // against an unexpected disposal callback failure as well.
        logEvent("service-log.dispose", cause);
      }
      try {
        phase = "record";
        await input.removeRecord();
      } finally {
        phase = "lease";
        await input.releaseOwner();
      }
      phase = "closed";
    })();
    return finishing;
  };
  return {
    finish,
    isDraining: () => draining !== undefined,
    phase: () => phase,
  };
}

/** Native Bun listener retained from TUI; service owns both listener and stores. */
export async function runPrivateLocalService(
  directory: string,
  openRuntime?: OpenLocalServiceRuntime,
  listModels: typeof listPrivateModels = listPrivateModels,
  runAuth: typeof runLocalAuthCli = runLocalAuthCli,
  /** How often the service releases Agents nothing uses. */
  idleSweepMs?: number,
  /** Narrow manifest I/O port, independent of the Agent-runtime opener. */
  readRecoveryManifest?: (path: string) => Promise<string>,
  root: PrivateLocalConfigRoot = capturePrivateLocalConfigRoot(),
) {
  // Publish the same discriminator in the pointer and the acquired owner row.
  const startedAt = await readOwnProcessStart();
  const release = await acquireServiceLock(directory, "owner");
  const serviceId = localServiceIds.service.generate();
  const version = privateLocalServiceVersion();
  const jsc = await import("bun:jsc");
  const diagnostics = createServiceLogLifecycle({
    directory,
    pid: process.pid,
    version,
    readMemory: () => ({
      rss: process.memoryUsage().rss,
      heap: jsc.heapStats(),
    }),
  });
  let native: NativePayloadStaging | undefined;
  const owners = createLocalServiceOwners(
    openRuntime,
    directory,
    undefined,
    idleSweepMs,
    readRecoveryManifest,
    diagnostics.recoveryDisabled,
    root,
    undefined,
    diagnostics.ruleMatch,
    () => {
      if (native === undefined)
        throw new Error("Local service native staging is not ready");
      return native;
    },
    diagnostics.approvalDecision,
  );
  const prefix = `/service/${serviceId}`;
  const releaseAccountOwner = registerFungiAccountOwner(
    root.credentialPath,
    () => owners.refreshMesh(),
  );
  const app = new Hono();
  app.onError((error, context) => {
    diagnostics.failure(localFailureMetadata("service.request", error));
    if (
      error instanceof ShiitakeError &&
      context.req.path.startsWith(`${prefix}/schedules/`)
    )
      return context.json(
        toShiitakeErrorWire(error),
        error.cause === "conflict" ? 409 : 400,
      );
    if (error instanceof LocalStoreSchemaError)
      return context.json(
        {
          code: "store_schema_incompatible",
          databasePath: error.databasePath,
          error: error.message,
        },
        409,
      );
    if (error instanceof LocalSandboxUnavailable)
      return context.json(
        { code: "sandbox_unavailable", reason: error.reason },
        409,
      );
    if (error instanceof z.ZodError)
      return context.json(
        {
          code: "invalid_selection",
          issues: error.issues.map((issue) => ({
            field: issue.path.join("."),
            reason: issue.message,
          })),
        },
        400,
      );
    if (error instanceof LocalSessionPathConflict)
      return context.json(
        { code: "session_path_conflict", error: error.message },
        409,
      );
    if (error instanceof LocalAgentSelectionAmbiguous)
      return context.json(
        { code: "agent_selection_ambiguous", agentIds: error.agentIds },
        409,
      );
    if (error instanceof FungiMcpSelectionConflict)
      return context.json({ error: error.message }, 409);
    if (error instanceof AgentArchiveRefused)
      return context.json(
        {
          code: "agent_archive_refused",
          reason: error.reason,
          error: error.message,
        },
        409,
      );
    const sqliteFailure = privateSqliteFailureCode(error);
    if (sqliteFailure === "busy" || sqliteFailure === "locked")
      return context.json({ code: "store_in_use" }, 409);
    logEvent("service-listener.request", error);
    return context.json(
      {
        code: "internal_error",
        error: error instanceof Error ? error.message : "Unknown failure",
      },
      500,
    );
  });
  const routes = new Map<
    string,
    {
      path: string;
      fetch: (request: Request) => Response | Promise<Response>;
      effectiveModel: (
        sessionId: string,
        signal: AbortSignal,
      ) => Promise<PrivateLocalEffectiveModel>;
      sandboxStatus: (
        signal: AbortSignal,
      ) => Promise<z.output<typeof sandboxStatusSchema>>;
    }
  >();
  const stopped = Promise.withResolvers<undefined>();
  let server: ReturnType<typeof openPrivateLocalBunServer> | undefined;
  /** Identity-only pointer; live routes add current diagnostics separately. */
  let record: ServiceRecord | undefined;
  let recordWritten = false;
  /**
   * Mount an Agent's route by store, not by its open runtime: a request on a
   * route reopens an Agent the service released while it was idle.
   */
  const mount = (
    selected: Awaited<ReturnType<typeof owners.select>>,
    fungiMcp: SelectionInput["fungiMcp"],
    attachment: LocalUiAttachment | undefined,
  ) => {
    // Inspectors share a read route; each UI gets a private host-issued route.
    let mounted =
      attachment === undefined ? routes.get(selected.databasePath) : undefined;
    if (!mounted) {
      const path = `/agents/${correlationKey()}`;
      const routePrefix = prefix + path;
      const target = {
        invocationRoot: selected.invocationRoot,
        databasePath: selected.databasePath,
        fungiMcp,
      };
      mounted = {
        path,
        fetch: (request) => {
          const url = new URL(request.url);
          url.pathname = url.pathname.slice(routePrefix.length) || "/";
          if (
            request.method === "DELETE" &&
            url.pathname === "/" &&
            attachment !== undefined
          ) {
            attachment.close();
            return new Response(null, { status: 204 });
          }
          return owners.serve(
            target,
            new Request(url.toString(), request),
            attachment,
          );
        },
        effectiveModel: (sessionId, signal) =>
          owners.effectiveModel(target, sessionId, signal),
        sandboxStatus: (signal) => owners.sandboxStatus(target, signal),
      };
      const key = attachment === undefined ? selected.databasePath : path;
      routes.set(key, mounted);
      attachment?.signal.addEventListener(
        "abort",
        () => {
          routes.delete(key);
        },
        { once: true },
      );
    }
    return {
      agentId: selected.agentId,
      databasePath: selected.databasePath,
      sessionId: selected.sessionId,
      routePath: mounted.path,
    };
  };
  const shutdown = createPrivateLocalServiceShutdown({
    closeOwners: async () => {
      await owners.close();
      // No Agent, including one reopened during recovery, still uses the copy.
      native?.close();
    },
    closeServer: async () => {
      await server?.close();
    },
    removeRecord: async () => {
      if (recordWritten) await removeOwnedServiceRecord(directory, serviceId);
    },
    releaseOwner: release,
    closeDiagnostics: diagnostics.close,
  });
  const drainDeadlineMs = 4_000;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    // Leave headroom before the maintained client's 5-second SIGKILL fallback.
    // Never reset the overall budget for another Agent or another signal.
    deadline ??= setTimeout(() => {
      // The background service has no stderr (spawned with stdio "ignore");
      // the private service log is its only durable diagnostic record.
      diagnostics.drainTimeout({
        deadlineMs: drainDeadlineMs,
        phase: shutdown.phase(),
        unfinishedOwners: owners.unfinishedOwners(),
      });
      // A Promise race cannot interrupt Agent.close's uninterruptible work.
      // Committed SQLite facts and recovery references remain for the next
      // owner; do not pretend those unfinished Agents closed successfully.
      process.exit(1);
    }, drainDeadlineMs);
    const finishing = shutdown.finish();
    void finishing.then(
      () => {
        clearTimeout(deadline);
        stopped.resolve(undefined);
      },
      (cause: unknown) => {
        stopped.reject(cause);
      },
    );
    return finishing;
  };
  const onSignal = (reason: "SIGINT" | "SIGTERM") => {
    diagnostics.stopping(reason);
    void finish();
  };
  const onInterrupt = () => {
    onSignal("SIGINT");
  };
  const onTerminate = () => {
    onSignal("SIGTERM");
  };
  const isLocalRequest = (request: Request) =>
    !request.headers.has("origin") &&
    new URL(request.url).hostname === "127.0.0.1";
  try {
    // Verify and stage before publishing discovery, even without a selected Agent.
    try {
      native = createNativePayloadStaging(directory);
    } catch (cause) {
      if (cause instanceof LocalBwrapUnavailable) {
        // A detached child has no stderr. Only this classified startup refusal
        // crosses to the starting client; never export arbitrary exception text.
        const marker = process.env.FUNGI_NATIVE_STARTUP_REFUSAL;
        if (marker !== undefined) {
          try {
            writeFileSync(marker, "native-package", {
              flag: "wx",
              mode: 0o600,
            });
          } catch (reportFailure) {
            // A broken report channel cannot replace the native refusal.
            logEvent("service-listener.native-refusal-report", reportFailure);
          }
        }
        throw nativePackageStartupError(cause);
      }
      throw cause;
    }
    app.use("*", async (context, next) => {
      const request = context.req.raw;
      // Local client only: no browser-origin admission or DNS rebinding authority.
      if (!isLocalRequest(request)) return context.body(null, 403);
      const path = new URL(request.url).pathname;
      // While SIGTERM drains its owners, only the handshake answers, so
      // `fungi stop` can still confirm the process it is waiting on.
      if (shutdown.isDraining() && path !== `${prefix}/status`)
        return context.body(null, 503);
      await next();
      return;
    });
    app.get(`${prefix}/status`, (context) =>
      record === undefined
        ? context.body(null, 503)
        : context.json({
            ...record,
            diagnostics: diagnostics.getStatus(),
          }),
    );
    app.get(`${prefix}/models`, async (context) =>
      context.json(await listModels(root.credentialPath)),
    );
    app.post(
      `${prefix}/mesh/join`,
      bodyLimit({ maxSize: 512 * 1024 }),
      async (context) => {
        const enrolled = await enrollPrivateLocalMesh(
          localMeshJoinSchema.parse(await context.req.json()),
          {
            credentialPath: root.credentialPath,
            signal: context.req.raw.signal,
            account: createLocalMachineEnrollmentAccount(root.credentialPath),
          },
        );
        await owners.refreshMesh();
        // Enrollment is not a confirmed shared connection or command receipt.
        return context.json(enrolled, 202);
      },
    );
    app.post(`${prefix}/discover`, async (context) => {
      const input = discoverRequestSchema.parse(await context.req.json());
      return context.json(
        await readPrivateLocalSessionDiscovery(input.invocationRoot, {
          signal: context.req.raw.signal,
          archived: input.archived,
        }),
      );
    });
    app.post(
      `${prefix}/schedules/list`,
      bodyLimit({ maxSize: 32 * 1024 }),
      async (context) =>
        context.json(
          await owners.schedules(
            localScheduleListInputSchema.parse(await context.req.json()),
            context.req.raw.signal,
          ),
        ),
    );
    app.post(
      `${prefix}/schedules/pause`,
      bodyLimit({ maxSize: 32 * 1024 }),
      async (context) =>
        context.json(
          await owners.pauseSchedule(
            localScheduleControlInputSchema.parse(await context.req.json()),
            context.req.raw.signal,
          ),
        ),
    );
    app.post(
      `${prefix}/schedules/delete`,
      bodyLimit({ maxSize: 32 * 1024 }),
      async (context) =>
        context.json(
          await owners.deleteSchedule(
            localScheduleControlInputSchema.parse(await context.req.json()),
            context.req.raw.signal,
          ),
        ),
    );
    app.post(`${prefix}/reload`, async (context) => {
      try {
        const input = z
          .strictObject({
            invocationRoot: z.string().min(1),
            clientPath: privateLocalExecPathSchema,
          })
          .parse(await context.req.json());
        await owners.reload(input.invocationRoot, input.clientPath);
        return context.json({
          message: "Configuration reloaded; applies from the next turn",
        });
      } catch (cause) {
        return context.json(
          {
            error: `${cause instanceof Error ? cause.message : String(cause)}\nOld configuration kept.`,
          },
          400,
        );
      }
    });
    app.post(`${prefix}/stop-all`, async (context) =>
      context.json(
        await owners.stopAll(
          stopAllRequestSchema.parse(await context.req.json()),
        ),
      ),
    );
    app.post(`${prefix}/archive`, async (context) => {
      await owners.archive(
        archiveRequestSchema.parse(await context.req.json()),
        context.req.raw.signal,
      );
      return context.body(null, 204);
    });
    app.get(
      `${prefix}/agents/:route/sessions/:sessionId/effective-model`,
      async (context) => {
        const route = [...routes.values()].find(
          (entry) => entry.path === `/agents/${context.req.param("route")}`,
        );
        if (route === undefined) return context.body(null, 404);
        return context.json(
          await route.effectiveModel(
            context.req.param("sessionId"),
            context.req.raw.signal,
          ),
        );
      },
    );
    app.get(`${prefix}/agents/:route/sandbox`, async (context) => {
      const route = [...routes.values()].find(
        (entry) => entry.path === `/agents/${context.req.param("route")}`,
      );
      if (route === undefined) return context.body(null, 404);
      return context.json(
        sandboxStatusSchema.parse(
          await route.sandboxStatus(context.req.raw.signal),
        ),
      );
    });
    app.post(`${prefix}/sessions`, async (context) => {
      const input = sessionCreationSchema.parse(await context.req.json());
      const selected = await owners.createSession(input);
      try {
        return context.json(
          mount(
            selected,
            input.fungiMcp,
            createLocalUiAttachment(
              selected.sessionId,
              input.uiAttachmentLifetime,
            ),
          ),
        );
      } finally {
        selected.release();
      }
    });
    app.post(`${prefix}/select`, async (context) => {
      const input = selectionSchema.parse(await context.req.json());
      const selected = await owners.select(input);
      try {
        return context.json(
          mount(
            selected,
            input.fungiMcp,
            createLocalUiAttachment(
              selected.sessionId,
              input.uiAttachmentLifetime,
            ),
          ),
        );
      } finally {
        selected.release();
      }
    });
    app.post(`${prefix}/inspect`, async (context) => {
      const input = sessionInspectionSchema.parse(await context.req.json());
      const selected = await owners.select(input);
      try {
        return context.json({
          diagnostics: diagnostics.getStatus(),
          selected: mount(selected, input.fungiMcp, undefined),
          snapshot: await selected.session.read({
            limit: input.limit,
            includeSandboxFailures: true,
          }),
        });
      } finally {
        selected.release();
      }
    });
    app.all(`${prefix}/agents/*`, (context) => {
      const path = new URL(context.req.url).pathname;
      for (const route of routes.values()) {
        if (path.startsWith(`${prefix}${route.path}/`))
          return route.fetch(context.req.raw);
      }
      return context.body(null, 404);
    });
    server = openPrivateLocalBunServer(
      (request) => app.fetch(request),
      undefined,
      {
        path: `${prefix}/auth`,
        admit: (request) => isLocalRequest(request) && !shutdown.isDraining(),
        createTarget: () =>
          new PrivateLocalAuthTarget(
            (argv, options) =>
              runAuth(argv, {
                ...options,
                credentialPath: root.credentialPath,
              }),
            async (request) => {
              if (request.credentialPath !== root.credentialPath)
                throw new Error("Fungi account belongs to another Local home");
              return await signOutOwnedFungiAccount(request.endpoint, {
                credentialPath: root.credentialPath,
              });
            },
          ),
      },
    );
    record = {
      protocol: privateLocalServiceProtocol,
      version,
      serviceId,
      pid: process.pid,
      startedAt,
      baseUrl: server.baseUrl,
    };
    await writeFileAtomic(recordPath(directory), JSON.stringify(record), {
      mode: 0o600,
    });
    recordWritten = true;
    diagnostics.ready(serviceId);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    // Health and shutdown must answer before any saved Agent is reopened.
    // Owner shutdown tracks this task; requests share its ordinary ownerFor.
    void owners.restore();
    void owners.refreshMesh().catch((cause: unknown) => {
      logEvent("service-listener.mesh-start", cause);
    });
    await stopped.promise;
  } catch (cause) {
    logEvent("service-listener.lifecycle", cause);
    diagnostics.failure(
      localFailureMetadata("service-listener.lifecycle", cause),
    );
    diagnostics.stopping(recordWritten ? "runtime-failure" : "startup-failure");
    throw cause;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    try {
      await finish();
    } finally {
      releaseAccountOwner();
    }
  }
}
