import { FungiMcpSelectionConflict } from "./private-fungi-mcp-selection.js";
import { PrivateLocalAuthTarget } from "./private-local-auth-rpc.js";
import { runLocalAuthCli } from "./auth-cli.js";
import { Hono } from "hono";
import { localServiceIds } from "./private-local-service-ids.js";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { listPrivateModels } from "./local-models.js";
import { privateSqliteFailureCode } from "./private-sqlite-owner.js";
import type { PrivateLocalEffectiveModel } from "./private-local-effective-model.js";
import { openPrivateLocalBunServer } from "./private-bun-shiitake-host.js";
import { readPrivateLocalSessionDiscovery } from "./private-local-session-discovery.js";
import {
  createLocalServiceOwners,
  LocalSessionPathConflict,
  type OpenLocalServiceRuntime,
} from "./private-local-service-owner.js";
import {
  acquireServiceLock,
  recordPath,
  removeOwnedServiceRecord,
  selectionSchema,
  sessionCreationSchema,
  sessionInspectionSchema,
} from "./private-local-service-discovery.js";

export function createPrivateLocalServiceShutdown(input: {
  closeOwners: () => Promise<void>;
  closeServer: () => Promise<void>;
  removeRecord: () => Promise<void>;
  releaseOwner: () => Promise<void>;
}) {
  let draining: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  const drain = () => {
    draining ??= input.closeOwners();
    return draining;
  };
  const finish = () => {
    finishing ??= (async () => {
      // Failed owner drain leaves the live listener, discovery, and owner lock
      // intact. A caller must never observe this service as stopped.
      await drain();
      await input.closeServer();
      try {
        await input.removeRecord();
      } finally {
        await input.releaseOwner();
      }
    })();
    return finishing;
  };
  return { drain, finish, isDraining: () => draining !== undefined };
}

/** Native Bun listener retained from TUI; service owns both listener and stores. */
export async function runPrivateLocalService(
  directory: string,
  openRuntime?: OpenLocalServiceRuntime,
  listModels: typeof listPrivateModels = listPrivateModels,
  runAuth: typeof runLocalAuthCli = runLocalAuthCli,
) {
  const release = await acquireServiceLock(directory, "owner");
  const owners = createLocalServiceOwners(openRuntime, directory);
  const serviceId = localServiceIds.service.generate();
  const buildId = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .parse(process.env.FUNGI_BUNDLED_BUILD_ID);
  const prefix = `/service/${serviceId}`;
  const app = new Hono();
  app.onError((error, context) => {
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
    if (error instanceof FungiMcpSelectionConflict)
      return context.json({ error: error.message }, 409);
    const sqliteFailure = privateSqliteFailureCode(error);
    if (sqliteFailure === "busy" || sqliteFailure === "locked")
      return context.json({ code: "store_in_use" }, 409);
    console.error(error);
    return context.text("Internal Server Error", 500);
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
    }
  >();
  const stopped = Promise.withResolvers<undefined>();
  let server: ReturnType<typeof openPrivateLocalBunServer> | undefined;
  let recordWritten = false;
  const mount = (
    selected: Awaited<ReturnType<typeof owners.select>>,
    sessionId: string,
  ) => {
    let mounted = routes.get(selected.databasePath);
    if (!mounted) {
      const path = `/agents/${String(routes.size)}`;
      const routePrefix = prefix + path;
      mounted = {
        path,
        fetch: (request) => {
          const url = new URL(request.url);
          url.pathname = url.pathname.slice(routePrefix.length) || "/";
          return selected.routes.fetch(new Request(url.toString(), request));
        },
        effectiveModel: selected.effectiveModel,
      };
      routes.set(selected.databasePath, mounted);
    }
    return {
      agentId: selected.agentId,
      databasePath: selected.databasePath,
      sessionId,
      routePath: mounted.path,
    };
  };
  const shutdown = createPrivateLocalServiceShutdown({
    closeOwners: owners.close,
    closeServer: async () => {
      await server?.close();
    },
    removeRecord: async () => {
      if (recordWritten) await removeOwnedServiceRecord(directory, serviceId);
    },
    releaseOwner: release,
  });
  const finish = () => {
    const finishing = shutdown.finish();
    void finishing.then(
      () => {
        stopped.resolve(undefined);
      },
      (cause: unknown) => {
        stopped.reject(cause);
      },
    );
    return finishing;
  };
  const onSignal = () => {
    void finish();
  };
  const isLocalRequest = (request: Request) =>
    !request.headers.has("origin") &&
    new URL(request.url).hostname === "127.0.0.1";
  try {
    await owners.restore();
    app.use("*", async (context, next) => {
      const request = context.req.raw;
      // Local client only: no browser-origin admission or DNS rebinding authority.
      if (!isLocalRequest(request)) return context.body(null, 403);
      const path = new URL(request.url).pathname;
      if (
        shutdown.isDraining() &&
        path !== `${prefix}/status` &&
        path !== `${prefix}/stop`
      )
        return context.body(null, 503);
      await next();
      return;
    });
    app.get(`${prefix}/status`, (context) =>
      context.json({ serviceId, baseUrl: server?.baseUrl, buildId }),
    );
    app.get(`${prefix}/models`, async (context) =>
      context.json(await listModels()),
    );
    app.post(`${prefix}/discover`, async (context) => {
      const input = selectionSchema
        .pick({ invocationRoot: true })
        .parse(await context.req.json());
      return context.json(
        await readPrivateLocalSessionDiscovery(input.invocationRoot, {
          signal: context.req.raw.signal,
        }),
      );
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
    app.post(`${prefix}/sessions`, async (context) => {
      const input = sessionCreationSchema.parse(await context.req.json());
      const selected = await owners.createSession(input);
      return context.json(mount(selected, selected.sessionId));
    });
    app.post(`${prefix}/select`, async (context) => {
      const input = selectionSchema.parse(await context.req.json());
      const selected = await owners.select(input);
      return context.json(mount(selected, selected.sessionId));
    });
    app.post(`${prefix}/inspect`, async (context) => {
      const input = sessionInspectionSchema.parse(await context.req.json());
      const selected = await owners.select(input);
      return context.json({
        selected: mount(selected, selected.sessionId),
        snapshot: await selected.session.read({
          limit: input.limit,
          includeSandboxFailures: true,
        }),
      });
    });
    app.post(`${prefix}/stop`, async (context) => {
      try {
        await shutdown.drain();
      } catch {
        // Preserve failed owner drain as an observable service failure. The
        // listener remains discoverable for explicit diagnosis.
        return context.json(
          { error: "Local service resources failed to close" },
          500,
        );
      }
      setTimeout(() => {
        void finish();
      }, 0);
      return context.body(null, 202);
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
        createTarget: () => new PrivateLocalAuthTarget(runAuth),
      },
    );
    await writeFileAtomic(
      recordPath(directory),
      JSON.stringify({ serviceId, baseUrl: server.baseUrl }),
      { mode: 0o600 },
    );
    recordWritten = true;
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    await stopped.promise;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await finish();
  }
}
