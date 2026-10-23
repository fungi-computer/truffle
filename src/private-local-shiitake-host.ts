import { logEvent } from "./log-event.js";
import { Hono } from "hono";
import * as Schema from "effect/Schema";
import { createShiitakeClient } from "@fungi.computer/shiitake/client";
import { createShiitakeHttpRoutes } from "@fungi.computer/shiitake/http";
import type { ShiitakeAgent, ShiitakeSession } from "@fungi.computer/shiitake";
import type { ShiitakeEventSourceConstructor } from "@fungi.computer/shiitake/client";

import {
  openPrivateLocalRuntimeHost,
  type PrivateLocalRuntimeHostOptions,
} from "./private-local-runtime-host.js";

export type PrivateLocalShiitakeServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

export type PrivateLocalShiitakeServerOpener = (
  fetch: (request: Request) => Response | Promise<Response>,
) => PrivateLocalShiitakeServer;

export type PrivateLocalShiitakeHostOpener = (
  input: PrivateLocalRuntimeHostOptions,
) => Promise<PrivateLocalShiitakeHost>;

type PrivateLocalRuntimeOwner = Awaited<
  ReturnType<typeof openPrivateLocalRuntimeHost>
>;

function asPrivateShiitakeFailure(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function aggregatePrivateShiitakeFailures(
  failures: readonly Error[],
  message: string,
): Error {
  if (failures.length === 1) {
    const [failure] = failures;
    if (failure === undefined)
      throw new Error("Missing private Shiitake failure");
    return failure;
  }
  return new AggregateError(failures, message);
}

async function capturePrivateShiitakeCloseFailure(
  failures: Error[],
  close: () => Promise<void>,
  message: string,
): Promise<void> {
  try {
    await close();
  } catch (cause) {
    logEvent(message, cause);
    failures.push(asPrivateShiitakeFailure(cause, message));
  }
}

async function closePrivateShiitakeResources(
  failures: Error[],
  client: ShiitakeAgent | undefined,
  server: PrivateLocalShiitakeServer | undefined,
  owner: PrivateLocalRuntimeOwner,
): Promise<void> {
  if (client !== undefined)
    await capturePrivateShiitakeCloseFailure(
      failures,
      client.close,
      "Private Shiitake client close failed",
    );
  if (server !== undefined)
    await capturePrivateShiitakeCloseFailure(
      failures,
      server.close,
      "Private Shiitake server close failed",
    );
  await capturePrivateShiitakeCloseFailure(
    failures,
    owner.close,
    "Private Shiitake owner close failed",
  );
}

/** One private loopback Hono owner plus a neutral client mounted on it. */
export type PrivateLocalShiitakeHost = Readonly<{
  /** Stable Local directory identity of this authorized Agent. */
  agentId: string;
  /** Canonical file path owned by the server-backed local host. */
  databasePath: string;
  /** Private loopback origin for another neutral Shiitake client. */
  baseUrl: string;
  /** Client-owned neutral Session; close only releases client watches. */
  client: ShiitakeAgent;
  session: ShiitakeSession;
  /** Stop the transport before releasing the RuntimeHost and database. */
  close: () => Promise<void>;
}>;

/** Open one bounded private local Hono host on a loopback-only ephemeral port. */
export async function openPrivateLocalShiitakeHost(
  input: PrivateLocalRuntimeHostOptions,
  openServer: PrivateLocalShiitakeServerOpener,
  openHost: typeof openPrivateLocalRuntimeHost = openPrivateLocalRuntimeHost,
  eventSource?: ShiitakeEventSourceConstructor,
): Promise<PrivateLocalShiitakeHost> {
  const owner = await openHost(input);
  const routes = createShiitakeHttpRoutes(
    (sessionId) => owner.getSession(sessionId),
    owner.listSessions,
    owner.createSession,
    owner.deleteSession,
    () => owner.extensions,
  );
  const fetch = (request: Request) => routes.fetch(request);
  let server: PrivateLocalShiitakeServer | undefined;
  let client: ShiitakeAgent | undefined;
  try {
    server = openServer(fetch);
    const mountedServer = server;
    const clientOptions =
      eventSource === undefined
        ? { baseUrl: mountedServer.baseUrl }
        : { baseUrl: mountedServer.baseUrl, eventSource };
    const mountedClient = createShiitakeClient(clientOptions);
    client = mountedClient;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      agentId: owner.agentId,
      databasePath: owner.databasePath,
      baseUrl: mountedServer.baseUrl,
      client: mountedClient,
      session: mountedClient.session("main"),
      close: () => {
        closing ??= (async () => {
          const failures: Error[] = [];
          await closePrivateShiitakeResources(
            failures,
            mountedClient,
            mountedServer,
            owner,
          );
          if (failures.length > 0)
            throw aggregatePrivateShiitakeFailures(
              failures,
              "Private Shiitake host close failed",
            );
        })();
        return closing;
      },
    });
  } catch (cause) {
    const failures = [
      asPrivateShiitakeFailure(
        cause,
        "Private Shiitake host initialization failed",
      ),
    ];
    await closePrivateShiitakeResources(failures, client, server, owner);
    throw aggregatePrivateShiitakeFailures(
      failures,
      "Private Shiitake host initialization failed",
    );
  }
}

const localWorkerNameSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)),
);
const decodeLocalWorkerName = Schema.decodeUnknownResult(localWorkerNameSchema);

type PrivateLocalWorkerOwner = Readonly<{
  name: string;
  owner: PrivateLocalRuntimeOwner;
}>;

/** Explicit static input for one independently owned local worker route. */
export type PrivateLocalShiitakeWorkerInput = Readonly<{
  name: string;
  owner: PrivateLocalRuntimeHostOptions;
}>;

/** One mounted route and its resolved durable Agent store. */
export type PrivateLocalShiitakeWorkerRoute = Readonly<{
  name: string;
  routePath: string;
  databasePath: string;
}>;

/** One physical server hosting a static batch of independent local owners. */
export type PrivateLocalShiitakeWorkerBatch = Readonly<{
  baseUrl: string;
  workers: readonly PrivateLocalShiitakeWorkerRoute[];
  close: () => Promise<void>;
}>;

function validateLocalWorkerInputs(
  inputs: readonly PrivateLocalShiitakeWorkerInput[],
): readonly PrivateLocalShiitakeWorkerInput[] {
  if (inputs.length === 0)
    throw new Error("Private local Shiitake worker batch cannot be empty");
  const names = new Set<string>();
  return inputs.map((input) => {
    const decoded = decodeLocalWorkerName(input.name);
    if (decoded._tag === "Failure")
      throw new Error(
        "Invalid private local Shiitake worker route identity: " + input.name,
      );
    if (names.has(decoded.success))
      throw new Error(
        "Duplicate private local Shiitake worker route identity: " +
          decoded.success,
      );
    names.add(decoded.success);
    return Object.freeze({ ...input, name: decoded.success });
  });
}

async function closePrivateLocalWorkerBatch(
  failures: Error[],
  server: PrivateLocalShiitakeServer | undefined,
  owners: readonly PrivateLocalWorkerOwner[],
): Promise<void> {
  if (server !== undefined)
    await capturePrivateShiitakeCloseFailure(
      failures,
      server.close,
      "Private Shiitake worker server close failed",
    );
  for (const { owner } of owners)
    await capturePrivateShiitakeCloseFailure(
      failures,
      owner.close,
      "Private Shiitake worker owner close failed",
    );
}

/** Mount a static batch of Local Agents behind exactly one maintained Hono server. */
export async function openPrivateLocalShiitakeWorkerBatch(
  inputs: readonly PrivateLocalShiitakeWorkerInput[],
  openServer: PrivateLocalShiitakeServerOpener,
  openHost: typeof openPrivateLocalRuntimeHost = openPrivateLocalRuntimeHost,
): Promise<PrivateLocalShiitakeWorkerBatch> {
  const validated = validateLocalWorkerInputs(inputs);
  const owners: PrivateLocalWorkerOwner[] = [];
  let server: PrivateLocalShiitakeServer | undefined;
  try {
    const app = new Hono();
    const workers: PrivateLocalShiitakeWorkerRoute[] = [];
    for (const input of validated) {
      const owner = await openHost(input.owner);
      owners.push({ name: input.name, owner });
      const routes = createShiitakeHttpRoutes(
        (sessionId) => owner.getSession(sessionId),
        owner.listSessions,
        owner.createSession,
        owner.deleteSession,
        () => owner.extensions,
      );
      const routePath = "/workers/" + input.name;
      app.route(routePath, routes);
      workers.push(
        Object.freeze({
          name: input.name,
          routePath,
          databasePath: owner.databasePath,
        }),
      );
    }
    server = openServer((request) => app.fetch(request));
    const mountedServer = server;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      baseUrl: mountedServer.baseUrl,
      workers: Object.freeze(workers),
      close: () => {
        closing ??= (async () => {
          const failures: Error[] = [];
          await closePrivateLocalWorkerBatch(failures, mountedServer, owners);
          if (failures.length > 0)
            throw aggregatePrivateShiitakeFailures(
              failures,
              "Private Shiitake worker batch close failed",
            );
        })();
        return closing;
      },
    });
  } catch (cause) {
    const failures = [
      asPrivateShiitakeFailure(
        cause,
        "Private Shiitake worker batch initialization failed",
      ),
    ];
    await closePrivateLocalWorkerBatch(failures, server, owners);
    throw aggregatePrivateShiitakeFailures(
      failures,
      "Private Shiitake worker batch initialization failed",
    );
  }
}
