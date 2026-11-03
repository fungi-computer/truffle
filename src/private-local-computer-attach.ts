import { generateKeyPairSync } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/client";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  callFungiMcpControl,
  fungiMcpTeamEndpoint,
  readFungiMcpLocalBackends,
  writeFungiMcpLocalBackends,
} from "./private-fungi-account.js";
import { oysterMcpKeyAuth } from "./private-oyster-mcp-auth.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";
import { createPrivateCredentialStore } from "./private-file-credential-store.js";
import type { OysterLocalBackendRecord } from "./private-local-backend-record.js";
import {
  runLocalComputerBackend,
  startLocalComputerd,
  type LocalBackendStatus,
} from "./private-local-computer-backend.js";

/**
 * `fungi computer attach|status|detach`: this machine's folders as execution
 * backends of Computers, on a Hub Team or a standalone Oyster. Attaching
 * generates a device key here, stores the folder path and private key in
 * Local's owner-only credential file, and sends the host only the public key
 * and two labels through the existing MCP login (the Fungi account for a Team,
 * the saved Oyster key for a standalone Oyster). Every request id is persisted
 * before the network call so an uncertain outcome is retried, never
 * duplicated.
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

/** What one attachment record needs; a Team's carries its Team too. */
type AttachedRecord = OysterLocalBackendRecord & Readonly<{ teamId?: string }>;

/**
 * Where an attachment lives: a Hub Team (its records ride the Fungi login)
 * or a standalone Oyster (its records are keyed by origin, beside its key).
 */
type Host = Readonly<{
  endpoint: URL;
  teamId: string | undefined;
  authentication: "oyster-key" | undefined;
  requireLogin(options: StoreOptions): Promise<void>;
  read(options: StoreOptions): Promise<readonly AttachedRecord[]>;
  edit(
    options: StoreOptions,
    update: (current: readonly AttachedRecord[]) => AttachedRecord[],
  ): Promise<void>;
}>;
type StoreOptions = Readonly<{ credentialPath: string }>;

function teamHost(endpoint: URL, teamId: string): Host {
  const mine = (all: readonly AttachedRecord[]) =>
    all.filter((candidate) => candidate.teamId === teamId);
  return {
    endpoint,
    teamId,
    authentication: undefined,
    requireLogin: async (options) => {
      if ((await readFungiMcpLocalBackends(options)).issuer !== endpoint.origin)
        throw new Error(
          `Fungi MCP sign-in is required; run fungi login --fungi-mcp ${endpoint.href}`,
        );
    },
    read: async (options) =>
      mine((await readFungiMcpLocalBackends(options)).backends),
    edit: (options, update) =>
      writeFungiMcpLocalBackends(
        (all) => [
          ...all.filter((candidate) => candidate.teamId !== teamId),
          ...update(mine(all)).map((record) => ({ ...record, teamId })),
        ],
        options,
      ),
  };
}

function oysterHost(endpoint: URL): Host {
  const store = (options: StoreOptions) =>
    createPrivateCredentialStore(options.credentialPath);
  return {
    endpoint,
    teamId: undefined,
    authentication: "oyster-key",
    // The saved Oyster key is checked by the first control call.
    requireLogin: () => Promise.resolve(),
    read: (options) => store(options).readLocalBackends(endpoint.origin),
    edit: (options, update) =>
      store(options).modifyLocalBackends(endpoint.origin, (all) => update(all)),
  };
}

/** A Hub Team MCP endpoint, or a standalone Oyster's `/mcp`. */
function hostOf(rawEndpoint: string | URL): Host {
  const parsed = parseFungiMcpEndpoint(rawEndpoint);
  if (parsed.pathname === "/mcp") return oysterHost(parsed);
  const { endpoint, teamId } = fungiMcpTeamEndpoint(parsed);
  return teamHost(endpoint, teamId);
}

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
  host: Host,
  call: string,
  schema: T,
  options: ControlOptions,
): Promise<z.output<T> | undefined> {
  const text = await callFungiMcpControl(
    host.endpoint,
    `return await ${call};`,
    {
      ...options,
      authProvider:
        host.authentication === "oyster-key"
          ? oysterMcpKeyAuth(host.endpoint, options)
          : undefined,
    },
  );
  if (text === undefined) return undefined;
  const parsed = schema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

/** A Computer by id or name, through the caller's own directory view. */
async function findComputer(
  host: Host,
  computer: string,
  options: ControlOptions,
): Promise<Readonly<{ computerId: string; name: string }> | undefined> {
  let offset: number | null = 0;
  while (offset !== null) {
    const page: z.output<typeof computerPageSchema> | undefined = await control(
      host,
      `env.computers.list(${JSON.stringify({ limit: 100, offset })})`,
      computerPageSchema,
      options,
    );
    if (page === undefined)
      throw new Error(
        "The host did not list its Computers; check your login or Oyster key, then retry",
      );
    const found = page.computers.find(
      (candidate) =>
        candidate.computerId === computer || candidate.name === computer,
    );
    if (found !== undefined) return found;
    offset = page.nextOffset;
  }
  return undefined;
}

function sameComputer(record: AttachedRecord, computer: string): boolean {
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

/** Attach `folderPath` to a Computer, or return the existing attachment. */
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
  const host = hostOf(rawEndpoint);
  const rootPath = await realpath(resolve(input.folderPath));
  if (!(await stat(rootPath)).isDirectory())
    throw new Error("The folder to attach is not a directory");
  await host.requireLogin(options);
  let record = (await host.read(options)).find((candidate) =>
    sameComputer(candidate, input.computer),
  );
  if (record !== undefined && record.rootPath !== rootPath)
    throw new Error(
      `This machine is already attached to ${record.computerName} with another folder; run fungi computer detach first`,
    );
  if (record === undefined) {
    const computer = await findComputer(host, input.computer, options);
    if (computer === undefined) return { kind: "not-found" };
    const pending: AttachedRecord = {
      requestId: requestIds.attach.generate(),
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
    record = pending;
    await host.edit(options, (current) => [...current, pending]);
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
    host,
    `env.computers.attachLocal(${JSON.stringify({
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
  await host.edit(options, (current) =>
    current.map((candidate) =>
      candidate.requestId === attached.requestId ? attached : candidate,
    ),
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
 * Detach a Computer's attachment on its host, then forget it here. A pending
 * attach is replayed first so the host never keeps an attachment Local forgot.
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
  const host = hostOf(rawEndpoint);
  const record = (await host.read(options)).find((candidate) =>
    sameComputer(candidate, computer),
  );
  if (record === undefined) return { kind: "not-attached" };
  let backendId = record.backendId;
  if (backendId === undefined) {
    const replay = await attachPrivateLocalComputer(
      host.endpoint,
      { computer: record.computerId, folderPath: record.rootPath },
      options,
    );
    if (replay.kind !== "attached") return { kind: "uncertain" };
    backendId = replay.backendId;
  }
  const result = await control(
    host,
    `env.computers.detachLocal(${JSON.stringify({
      computerId: record.computerId,
      backendId,
    })})`,
    detachResultSchema,
    options,
  );
  if (result === undefined) return { kind: "uncertain" };
  if (result.kind === "denied") return { kind: "denied" };
  if (result.kind !== "detached") return { kind: "uncertain" };
  await host.edit(options, (current) =>
    current.filter((candidate) => candidate.requestId !== record.requestId),
  );
  return { kind: "detached" };
}

/** What `fungi computer status` shows: never a key. */
export async function listPrivateLocalComputers(
  options: Readonly<{ credentialPath?: string }> = {},
): Promise<
  readonly Readonly<{
    /** The Hub Team, or null for a standalone Oyster. */
    teamId: string | null;
    /** The standalone Oyster's origin, or null for a Hub Team. */
    origin: string | null;
    computerId: string;
    computerName: string;
    rootPath: string;
    backendId: string | null;
  }>[]
> {
  const credentialPath =
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath;
  const view = (record: AttachedRecord, origin: string | null) => ({
    teamId: record.teamId ?? null,
    origin,
    computerId: record.computerId,
    computerName: record.computerName,
    rootPath: record.rootPath,
    backendId: record.backendId ?? null,
  });
  const hub = await readFungiMcpLocalBackends({ credentialPath });
  const oysters =
    await createPrivateCredentialStore(credentialPath).readAllLocalBackends();
  return [
    ...hub.backends.map((record) => view(record, null)),
    ...oysters.flatMap((entry) =>
      entry.backends.map((record) => view(record, entry.origin)),
    ),
  ];
}

export type PrivateLocalComputerRunOptions = {
  credentialPath?: string;
  signal: AbortSignal;
  onStatus?: (status: LocalBackendStatus) => void;
};

/**
 * Serve one attached folder until `signal` aborts or its host refuses the
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
  const host = hostOf(rawEndpoint);
  const record = (await host.read(options)).find((candidate) =>
    sameComputer(candidate, computer),
  );
  if (record?.backendId === undefined)
    throw new Error(`This machine is not attached to ${computer}`);
  const daemon = await startLocalComputerd({ root: record.rootPath });
  try {
    const outcome = await runLocalComputerBackend({
      target: {
        origin: host.endpoint.origin,
        teamId: host.teamId,
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
    await host.edit(options, (current) =>
      current.filter((candidate) => candidate.requestId !== record.requestId),
    );
    return "detached";
  } finally {
    await daemon.stop();
  }
}
