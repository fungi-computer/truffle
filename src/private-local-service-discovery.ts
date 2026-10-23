import { fungiMcpSelectionSchema } from "./private-fungi-mcp-selection-schema.js";
import { localUiAttachmentLifetimeSchema } from "./private-local-ui-attachment.js";
import { privateLocalExecPathSchema } from "./private-local-exec-path.js";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { localServiceIds } from "./private-local-service-ids.js";
import {
  acquireServiceOwnerLease,
  readServiceLeaseOwner,
} from "./private-local-service-lease.js";
import { modelReasoningLevels } from "@fungi.computer/shiitake/model-preference";
import { archiveRefusalReasons } from "@fungi.computer/shiitake/agent-control";
import { serviceDiagnosticsStatusSchema } from "./private-local-service-log.js";
export { sandboxStatusSchema } from "./private-local-sandbox.js";

/**
 * The client-service wire contract. Bump it with any change an older client
 * cannot read; a running client then asks its window to restart.
 */
export const privateLocalServiceProtocol = 3;

/** This build's identity: the packed CLI's content hash, or `source` for a source run. */
export function privateLocalServiceVersion(): string {
  return (
    z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional()
      .parse(process.env.FUNGI_BUNDLED_BUILD_ID) ?? "source"
  );
}

/**
 * The fields every protocol keeps in `service.json`, so any client can
 * identify, replace or stop a service whatever protocol it speaks.
 */
const serviceLifecycleSchema = z.looseObject({
  protocol: z.number().int().positive(),
  version: z.string().min(1),
  serviceId: z.string().refine((value) => localServiceIds.service.is(value)),
  /** The listener process. */
  pid: z.number().int().positive(),
  /**
   * Pointer to the owner identity; signal authority comes from the lease row,
   * not these file fields.
   */
  startedAt: z.string().min(1),
});
const serviceRecordSchema = z.strictObject({
  ...serviceLifecycleSchema.shape,
  protocol: z.literal(privateLocalServiceProtocol),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  }),
});
export type ServiceRecord = z.infer<typeof serviceRecordSchema>;
/** Mandatory live diagnostics; never written into the registration pointer. */
export const liveServiceStatusSchema = serviceRecordSchema.extend({
  diagnostics: serviceDiagnosticsStatusSchema,
});
export type LiveServiceStatus = z.infer<typeof liveServiceStatusSchema>;
/**
 * What `service.json` names: a service of this protocol, a service of another
 * protocol (identified only by its lifecycle fields), or a file no protocol
 * wrote.
 */
export type ServiceRegistration =
  | Readonly<{ kind: "current"; record: ServiceRecord }>
  | Readonly<{
      kind: "other-protocol";
      lifecycle: z.infer<typeof serviceLifecycleSchema>;
    }>
  | Readonly<{ kind: "unidentified" }>;
export const selectionSchema = z.strictObject({
  uiAttachmentLifetime: localUiAttachmentLifetimeSchema.optional(),
  invocationRoot: z.string().min(1),
  clientPath: privateLocalExecPathSchema,
  requireSandbox: z.boolean().optional(),
  databasePath: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  fungiMcp: fungiMcpSelectionSchema.optional(),
});
export const sessionCreationSchema = z.strictObject({
  uiAttachmentLifetime: localUiAttachmentLifetimeSchema.optional(),
  invocationRoot: z.string().min(1),
  clientPath: privateLocalExecPathSchema,
  requireSandbox: z.boolean().optional(),
  databasePath: z.string().min(1),
  requestId: z.string().min(1),
  fungiMcp: fungiMcpSelectionSchema.optional(),
});
export const sessionInspectionSchema = selectionSchema
  .omit({ clientPath: true, uiAttachmentLifetime: true })
  .extend({
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(200),
  });
export const selectedSchema = z.strictObject({
  agentId: z.string().min(1),
  databasePath: z.string().min(1),
  sessionId: z.string().min(1),
  routePath: z.templateLiteral(["/agents/", z.uuid({ version: "v4" })]),
});
export const discoverRequestSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  archived: z.boolean().default(false),
});
export const archiveRequestSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  agentId: z.string().min(1),
  archived: z.boolean(),
});
/** The 409 answer to an archive the Local service refuses. */
export const archiveRefusalSchema = z.strictObject({
  code: z.literal("agent_archive_refused"),
  reason: z.enum(archiveRefusalReasons),
  error: z.string(),
});
export const sessionDiscoverySchema = z.strictObject({
  root: z.string().min(1),
  agents: z.array(
    z.strictObject({
      agentId: z.string().min(1),
      name: z.string().optional(),
      createdBy: z.string().nullable().optional(),
      unreadable: z.string().optional(),
      databasePath: z.string().min(1),
      sessionCount: z.number().int().nonnegative(),
      updatedAt: z.number().optional(),
    }),
  ),
  sessions: z.array(
    z.strictObject({
      databasePath: z.string().min(1),
      sessionId: z.string().min(1),
      title: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
  problems: z.array(
    z.strictObject({ kind: z.enum(["corrupt", "in_use", "unreadable"]) }),
  ),
});
export const modelChoicesSchema = z.array(
  z.strictObject({
    providerId: z.string().min(1),
    providerName: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    reasoning: z.array(z.enum(modelReasoningLevels)),
  }),
);

/** Resolve a read target without creating/chmodding a directory. */
export function serviceDirectoryPath(directory?: string): string {
  return resolve(directory ?? join(homedir(), ".fungi", "service"));
}
export async function serviceDirectory(directory?: string): Promise<string> {
  const path = serviceDirectoryPath(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return realpath(path);
}
export const recordPath = (directory: string) =>
  join(directory, "service.json");

/** Read `service.json` by its lifecycle fields first, so any protocol's record is named. */
export async function readServiceRegistration(
  directory: string,
): Promise<ServiceRegistration | undefined> {
  let text: string;
  try {
    text = await readFile(recordPath(directory), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof SyntaxError) return { kind: "unidentified" };
    throw cause;
  }
  const lifecycle = serviceLifecycleSchema.safeParse(json);
  if (!lifecycle.success) {
    // A service from before the PID was recorded cannot be signalled; name it
    // and its own stop route instead of treating it as unidentified.
    const older = serviceRecordSchema
      .pick({ serviceId: true, baseUrl: true })
      .safeParse(json);
    if (older.success)
      throw new LocalServiceRecordWithoutPid(directory, older.data);
    return { kind: "unidentified" };
  }
  if (lifecycle.data.protocol !== privateLocalServiceProtocol)
    return { kind: "other-protocol", lifecycle: lifecycle.data };
  return { kind: "current", record: serviceRecordSchema.parse(json) };
}

/** `service.json` was written by a service too old to record its PID. */
class LocalServiceRecordWithoutPid extends Error {
  override readonly name = "LocalServiceRecordWithoutPid";
  constructor(
    directory: string,
    service: Readonly<{ serviceId: string; baseUrl: string }>,
  ) {
    const stopUrl = new URL(
      `/service/${service.serviceId}/stop`,
      service.baseUrl,
    );
    super(
      `An older Fungi service (${service.serviceId} on port ${new URL(service.baseUrl).port}) is registered in ${recordPath(directory)}, and this fungi cannot stop it. Stop it with \`curl -X POST ${stopUrl.href}\`; if it keeps running, end the process whose command line contains \`--internal-service ${directory}\`. If it is no longer running, delete ${recordPath(directory)}. Then retry; saved Sessions are kept.`,
    );
  }
}

/** The record of a service speaking this client's protocol, if one is registered. */
export async function readServiceRecord(
  directory: string,
): Promise<ServiceRecord | undefined> {
  const registration = await readServiceRegistration(directory);
  return registration?.kind === "current" ? registration.record : undefined;
}

/** An older listener must not erase its successor's discovery record. */
export async function removeOwnedServiceRecord(
  directory: string,
  serviceId: string,
): Promise<void> {
  const registration = await readServiceRegistration(directory);
  if (
    (registration?.kind === "current" &&
      registration.record.serviceId === serviceId) ||
    (registration?.kind === "other-protocol" &&
      registration.lifecycle.serviceId === serviceId)
  )
    await rm(recordPath(directory), { force: true });
}

/** Remove a `service.json` no protocol wrote; only call it once no owner is live. */
export async function removeUnidentifiedServiceRecord(
  directory: string,
): Promise<void> {
  if ((await readServiceRegistration(directory))?.kind === "unidentified")
    await rm(recordPath(directory), { force: true });
}

const ownerLeaseMarker = (directory: string) =>
  join(directory, "owner.lock", "sqlite-owner");

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

/** Legacy owners have no SQLite lease, so their file lock must not be stolen. */
export async function assertNoUntrackedServiceOwner(directory: string) {
  if (
    (await pathExists(join(directory, "owner.lock"))) &&
    !(await pathExists(ownerLeaseMarker(directory)))
  )
    throw new Error(
      "A previous Fungi service may still own this directory. Stop that service before starting Fungi again; its owner lock was not released.",
    );
}

/** Startup and shutdown serialize with the native listener and lifetime owner lock. */
export async function acquireServiceLock(
  directory: string,
  name: "startup" | "owner",
) {
  if (name === "startup")
    return lockfile.lock(join(directory, name), {
      realpath: false,
      lockfilePath: join(directory, `${name}.lock`),
      retries: { retries: 100, minTimeout: 100, maxTimeout: 100 },
      onCompromised(error) {
        throw error;
      },
    });

  const releaseLease = await acquireServiceOwnerLease(directory);
  const lockPath = join(directory, "owner.lock");
  let created = false;
  try {
    await assertNoUntrackedServiceOwner(directory);
    // A dead owner can leave a marked directory behind. Its process claim has
    // already been replaced transactionally, without trusting a heartbeat.
    if (await pathExists(ownerLeaseMarker(directory)))
      await rm(lockPath, { recursive: true });
    await mkdir(lockPath);
    created = true;
    await writeFile(ownerLeaseMarker(directory), "", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (cause) {
    try {
      if (created) await rm(lockPath, { recursive: true });
    } finally {
      releaseLease();
    }
    throw cause;
  }
  return async () => {
    try {
      await rm(ownerLeaseMarker(directory), { force: true });
      await rmdir(lockPath);
    } finally {
      releaseLease();
    }
  };
}

/**
 * Whether a service process holds this directory's lifetime lease. A held
 * lease is a live owner even when it is too busy to answer its handshake.
 */
export async function serviceOwnerIsLive(directory: string): Promise<boolean> {
  return (await readServiceLeaseOwner(directory)) !== undefined;
}

export type ServiceProbe =
  | Readonly<{ kind: "running"; service: LiveServiceStatus }>
  | Readonly<{ kind: "not-running" }>
  | Readonly<{ kind: "unavailable" }>;
const transportFailureSchema = z.looseObject({
  code: z.string().optional(),
  cause: z.looseObject({ code: z.string().optional() }).optional(),
});

export async function readLiveServiceStatus(
  record: ServiceRecord,
  timeoutMs = 2000,
): Promise<ServiceProbe> {
  try {
    const response = await fetch(
      `${record.baseUrl}/service/${record.serviceId}/status`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return { kind: "unavailable" };
    const actual = liveServiceStatusSchema.parse(await response.json());
    return actual.serviceId === record.serviceId &&
      actual.baseUrl === record.baseUrl &&
      actual.pid === record.pid &&
      actual.startedAt === record.startedAt &&
      actual.version === record.version
      ? { kind: "running", service: actual }
      : { kind: "unavailable" };
  } catch (cause) {
    const failure = transportFailureSchema.safeParse(cause);
    if (failure.success) {
      const codes = [failure.data.code, failure.data.cause?.code];
      if (codes.includes("ECONNREFUSED") || codes.includes("ConnectionRefused"))
        return { kind: "not-running" };
    }
    return { kind: "unavailable" };
  }
}

export async function handshake(record: ServiceRecord): Promise<boolean> {
  return (await readLiveServiceStatus(record)).kind === "running";
}

/**
 * Clear the lifetime lock a killed owner left behind. The lease's process is
 * gone, so acquiring the owner lock removes the marked directory;
 * releasing it at once leaves nothing behind. A live owner makes this throw.
 */
export async function clearAbandonedServiceOwner(
  directory: string,
): Promise<void> {
  const release = await acquireServiceLock(directory, "owner");
  await release();
}
