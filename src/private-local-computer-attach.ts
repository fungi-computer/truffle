import { generateKeyPairSync } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/client";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  callFungiMcpTeamControl,
  fungiMcpTeamEndpoint,
  readFungiMcpLocalBackends,
  writeFungiMcpLocalBackends,
  type LocalBackendRecord,
} from "./private-fungi-account.js";
import {
  runLocalComputerBackend,
  startLocalComputerd,
  type LocalBackendStatus,
} from "./private-local-computer-backend.js";

/**
 * `fungi computer attach|status|detach`: this machine's folders as execution
 * backends of Team Computers. Attaching generates a device key here, stores
 * the folder path and private key in Local's owner-only credential file, and
 * sends the Hub only the public key and two labels through the member's
 * existing Team MCP login. Every request id is persisted before the network
 * call so an uncertain outcome is retried, never duplicated.
 */
const requestIds = defineIdFamily({
  family: "local-computer-backend",
  version: 1,
  kinds: { attach: { prefix: "local_attach_request" } },
});

export type ControlOptions = Readonly<{
  credentialPath?: string;
  fetch?: FetchLike;
}>;

const computerPageSchema = z.looseObject({
  computers: z.array(
    z.looseObject({ computerId: z.string(), name: z.string() }),
  ),
  nextOffset: z.number().int().nonnegative().nullable(),
});
const attachResultSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("attached"),
    requestId: z.string(),
    backendId: z.string().regex(/^local-[a-z2-7]{16}$/),
  }),
  z.looseObject({
    kind: z.enum(["uncertain", "denied", "conflict", "invalid"]),
    requestId: z.string(),
  }),
]);
const detachResultSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("detached"), detached: z.boolean() }),
  z.looseObject({ kind: z.enum(["denied", "uncertain", "invalid"]) }),
]);

async function control<T extends z.ZodType>(
  teamEndpoint: URL,
  call: string,
  schema: T,
  options: ControlOptions,
): Promise<z.output<T> | undefined> {
  const text = await callFungiMcpTeamControl(
    teamEndpoint,
    `return await ${call};`,
    options,
  );
  if (text === undefined) return undefined;
  const parsed = schema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** A Team Computer by id or name, through the member's own directory view. */
async function findComputer(
  teamEndpoint: URL,
  computer: string,
  options: ControlOptions,
): Promise<Readonly<{ computerId: string; name: string }> | undefined> {
  let offset: number | null = 0;
  while (offset !== null) {
    const page: z.output<typeof computerPageSchema> | undefined = await control(
      teamEndpoint,
      `computers.list(${JSON.stringify({ limit: 100, offset })})`,
      computerPageSchema,
      options,
    );
    if (page === undefined)
      throw new Error("The Hub did not list this Team's Computers; retry");
    const found = page.computers.find(
      (candidate) =>
        candidate.computerId === computer || candidate.name === computer,
    );
    if (found !== undefined) return found;
    offset = page.nextOffset;
  }
  return undefined;
}

function sameComputer(record: LocalBackendRecord, computer: string): boolean {
  return record.computerId === computer || record.computerName === computer;
}

/** A fresh Ed25519 device key: raw public key and PKCS#8 private key, base64. */
function deviceKey() {
  const pair = generateKeyPairSync("ed25519");
  const jwk = z
    .object({ x: z.string() })
    .parse(pair.publicKey.export({ format: "jwk" }));
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
}

export type PrivateLocalComputerAttachResult =
  | Readonly<{
      kind: "attached";
      computerId: string;
      computerName: string;
      backendId: string;
      rootPath: string;
    }>
  | Readonly<{
      kind: "not-found" | "uncertain" | "denied" | "conflict" | "invalid";
    }>;

/** Attach `folderPath` to a Team Computer, or return the existing attachment. */
export async function attachPrivateLocalComputer(
  rawEndpoint: string | URL,
  input: Readonly<{ computer: string; folderPath: string; hostLabel?: string }>,
  controlOptions: ControlOptions = {},
): Promise<PrivateLocalComputerAttachResult> {
  const options = {
    ...controlOptions,
    credentialPath:
      controlOptions.credentialPath ??
      capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint, teamId } = fungiMcpTeamEndpoint(rawEndpoint);
  const rootPath = await realpath(resolve(input.folderPath));
  if (!(await stat(rootPath)).isDirectory())
    throw new Error("The folder to attach is not a directory");
  const saved = await readFungiMcpLocalBackends(options);
  if (saved.issuer !== endpoint.origin)
    throw new Error(
      `Fungi MCP sign-in is required; run fungi login --fungi-mcp ${endpoint.href}`,
    );
  let record = saved.backends.find(
    (candidate) =>
      candidate.teamId === teamId && sameComputer(candidate, input.computer),
  );
  if (record !== undefined && record.rootPath !== rootPath)
    throw new Error(
      `This machine is already attached to ${record.computerName} with another folder; run fungi computer detach first`,
    );
  if (record === undefined) {
    const computer = await findComputer(endpoint, input.computer, options);
    if (computer === undefined) return { kind: "not-found" };
    record = {
      requestId: requestIds.attach.generate(),
      teamId,
      computerId: computer.computerId,
      computerName: computer.name,
      rootPath,
      hostLabel: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .parse(input.hostLabel ?? hostname()),
      folderLabel: z.string().min(1).max(256).parse(basename(rootPath)),
      ...deviceKey(),
    };
    const pending = record;
    await writeFungiMcpLocalBackends(
      (current) => [...current, pending],
      options,
    );
  }
  if (record.backendId !== undefined)
    return {
      kind: "attached",
      computerId: record.computerId,
      computerName: record.computerName,
      backendId: record.backendId,
      rootPath,
    };
  const result = await control(
    endpoint,
    `computers.attachLocal(${JSON.stringify({
      computerId: record.computerId,
      publicKey: record.publicKey,
      hostLabel: record.hostLabel,
      folderLabel: record.folderLabel,
      requestId: record.requestId,
    })})`,
    attachResultSchema,
    options,
  );
  if (result === undefined) return { kind: "uncertain" };
  if (result.kind !== "attached") return { kind: result.kind };
  const attached = { ...record, backendId: result.backendId };
  await writeFungiMcpLocalBackends(
    (current) =>
      current.map((candidate) =>
        candidate.requestId === attached.requestId ? attached : candidate,
      ),
    options,
  );
  return {
    kind: "attached",
    computerId: attached.computerId,
    computerName: attached.computerName,
    backendId: result.backendId,
    rootPath,
  };
}

export type PrivateLocalComputerDetachResult = Readonly<{
  kind: "detached" | "not-attached" | "uncertain" | "denied";
}>;

/**
 * Detach a Computer's attachment on the Hub, then forget it here. A pending
 * attach is replayed first so the Hub never keeps an attachment Local forgot.
 */
export async function detachPrivateLocalComputer(
  rawEndpoint: string | URL,
  computer: string,
  input: ControlOptions = {},
): Promise<PrivateLocalComputerDetachResult> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint, teamId } = fungiMcpTeamEndpoint(rawEndpoint);
  const saved = await readFungiMcpLocalBackends(options);
  const record = saved.backends.find(
    (candidate) =>
      candidate.teamId === teamId && sameComputer(candidate, computer),
  );
  if (record === undefined) return { kind: "not-attached" };
  let backendId = record.backendId;
  if (backendId === undefined) {
    const replay = await attachPrivateLocalComputer(
      endpoint,
      { computer: record.computerId, folderPath: record.rootPath },
      options,
    );
    if (replay.kind !== "attached") return { kind: "uncertain" };
    backendId = replay.backendId;
  }
  const result = await control(
    endpoint,
    `computers.detachLocal(${JSON.stringify({
      computerId: record.computerId,
      backendId,
    })})`,
    detachResultSchema,
    options,
  );
  if (result === undefined) return { kind: "uncertain" };
  if (result.kind === "denied") return { kind: "denied" };
  if (result.kind !== "detached") return { kind: "uncertain" };
  await writeFungiMcpLocalBackends(
    (current) =>
      current.filter((candidate) => candidate.requestId !== record.requestId),
    options,
  );
  return { kind: "detached" };
}

/** What `fungi computer status` shows: never a key. */
export async function listPrivateLocalComputers(
  options: Readonly<{ credentialPath?: string }> = {},
): Promise<
  readonly Readonly<{
    teamId: string;
    computerId: string;
    computerName: string;
    rootPath: string;
    backendId: string | null;
  }>[]
> {
  const saved = await readFungiMcpLocalBackends(options);
  return saved.backends.map((record) => ({
    teamId: record.teamId,
    computerId: record.computerId,
    computerName: record.computerName,
    rootPath: record.rootPath,
    backendId: record.backendId ?? null,
  }));
}

export type PrivateLocalComputerRunOptions = {
  credentialPath?: string;
  signal: AbortSignal;
  onStatus?: (status: LocalBackendStatus) => void;
};

/**
 * Serve one attached folder until `signal` aborts or the Hub refuses the
 * machine (it was detached elsewhere), in which case Local forgets it.
 */
export async function runPrivateLocalComputer(
  rawEndpoint: string | URL,
  computer: string,
  input: PrivateLocalComputerRunOptions,
): Promise<"stopped" | "detached"> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint, teamId } = fungiMcpTeamEndpoint(rawEndpoint);
  const saved = await readFungiMcpLocalBackends(options);
  const record = saved.backends.find(
    (candidate) =>
      candidate.teamId === teamId && sameComputer(candidate, computer),
  );
  if (record?.backendId === undefined)
    throw new Error(`This machine is not attached to ${computer}`);
  const daemon = await startLocalComputerd({ root: record.rootPath });
  try {
    const outcome = await runLocalComputerBackend({
      target: {
        hubOrigin: endpoint.origin,
        teamId,
        computerId: record.computerId,
        backendId: record.backendId,
        deviceId: record.backendId.slice("local-".length),
        privateKey: record.privateKey,
      },
      root: record.rootPath,
      computerdPort: daemon.port,
      signal: options.signal,
      onStatus: options.onStatus,
    });
    if (outcome === "stopped") return "stopped";
    await writeFungiMcpLocalBackends(
      (current) =>
        current.filter((candidate) => candidate.requestId !== record.requestId),
      options,
    );
    return "detached";
  } finally {
    await daemon.stop();
  }
}
