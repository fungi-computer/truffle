import { fungiMcpSelectionSchema } from "./private-fungi-mcp-selection.js";
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
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { privateSqliteFailureCode } from "./private-sqlite-owner.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

const serviceRecordSchema = z.strictObject({
  serviceId: z.string().refine((value) => localServiceIds.service.is(value)),
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
const serviceStatusSchema = serviceRecordSchema.safeExtend({
  buildId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export type ServiceRecord = z.infer<typeof serviceRecordSchema>;
export const selectionSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  clientPath: privateLocalExecPathSchema,
  databasePath: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  fungiMcp: fungiMcpSelectionSchema.optional(),
});
export const sessionCreationSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  clientPath: privateLocalExecPathSchema,
  databasePath: z.string().min(1),
  requestId: z.string().min(1),
  fungiMcp: fungiMcpSelectionSchema.optional(),
});
export const sessionInspectionSchema = selectionSchema
  .omit({ clientPath: true })
  .extend({
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(200),
  });
export const selectedSchema = z.strictObject({
  agentId: z.string().min(1),
  databasePath: z.string().min(1),
  sessionId: z.string().min(1),
  routePath: z.string().regex(/^\/agents\/[0-9]+$/),
});
export const sessionDiscoverySchema = z.strictObject({
  root: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
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
const reasoningLevels = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];
export const modelChoicesSchema = z.array(
  z.strictObject({
    providerId: z.string().min(1),
    providerName: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    reasoning: z.array(z.enum(reasoningLevels)),
  }),
);

export async function serviceDirectory(directory?: string): Promise<string> {
  const path = resolve(directory ?? join(homedir(), ".fungi", "service"));
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return realpath(path);
}
export const recordPath = (directory: string) =>
  join(directory, "service.json");

export async function readServiceRecord(
  directory: string,
): Promise<ServiceRecord | undefined> {
  try {
    return serviceRecordSchema.parse(
      JSON.parse(await readFile(recordPath(directory), "utf8")),
    );
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
}

/** An older listener must not erase its successor's discovery record. */
export async function removeOwnedServiceRecord(
  directory: string,
  serviceId: string,
): Promise<void> {
  if ((await readServiceRecord(directory))?.serviceId === serviceId)
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

  // The SQLite lease is the lifetime guard. proper-lockfile cannot heartbeat
  // a directory containing the marker: writing the marker changes its mtime
  // and makes its own heartbeat declare the live lock compromised.
  const lease = acquireNodeStoreLease(join(directory, "owner.sqlite"));
  const lockPath = join(directory, "owner.lock");
  let created = false;
  try {
    await assertNoUntrackedServiceOwner(directory);
    // A dead updated owner can leave a marked directory behind. The SQLite
    // lease is already free, so removing it does not trust a heartbeat.
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
      lease.release();
    }
    throw cause;
  }
  return async () => {
    try {
      await rm(ownerLeaseMarker(directory), { force: true });
      await rmdir(lockPath);
    } finally {
      lease.release();
    }
  };
}

/**
 * Whether a service process holds this directory's lifetime lease. A held
 * lease is a live owner even when it is too busy to answer its handshake.
 */
export function serviceOwnerIsLive(directory: string): boolean {
  let lease: ReturnType<typeof acquireNodeStoreLease>;
  try {
    lease = acquireNodeStoreLease(join(directory, "owner.sqlite"));
  } catch (cause) {
    if (privateSqliteFailureCode(cause) === "busy") return true;
    throw cause;
  }
  lease.release();
  return false;
}

export type ServiceProbe =
  | Readonly<{ kind: "running"; service: z.infer<typeof serviceStatusSchema> }>
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
    const actual = serviceStatusSchema.parse(await response.json());
    return actual.serviceId === record.serviceId &&
      actual.baseUrl === record.baseUrl
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
