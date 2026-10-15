import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { logEvent } from "./log-event.js";
import { localExtensions } from "./local-extensions.js";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  cleanupSessionResources,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import type {
  Accepted,
  CommandSettlement,
  VerifiedAgentReply,
} from "@fungi.computer/shiitake";
import {
  parseModelPreference,
  parseModelPreferenceJson,
  resolveModelPreference,
  type ModelPreference,
} from "@fungi.computer/shiitake/model-preference";
import {
  createAgentControlSource,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import { defineIdFamily } from "@fungi.computer/cairn";
import { botanicalExtensionsWithSkills } from "@fungi.computer/shiitake-extensions/roster";
import {
  homeExtension,
  homeGrant,
} from "@fungi.computer/shiitake-extensions/home/host";
import type { ExtensionRosterV0 } from "@fungi.computer/shiitake/extensions";
import { Knapsack } from "@fungi.computer/knapsack";
import {
  type InstructionSource,
  makeHost,
  type ModelSource,
  Shiitake,
  ShiitakeError,
  type RuntimeHost,
  type ShiitakeAgent,
  type ShiitakeSession,
  type ShiitakeOptions,
} from "@fungi.computer/shiitake";
import { createPrivateModels } from "./local-models.js";
import {
  defaultLocalModel,
  listOfferedLocalModels,
} from "./private-local-default-model.js";
import { createLocalModelSettings } from "./private-local-model-settings.js";
import { assertFungiModelsEnabled } from "./private-fungi-model-api.js";
import {
  privateLocalEffectiveModelSchema,
  type PrivateLocalEffectiveModel,
} from "./private-local-effective-model.js";
import { createPrivateInvocationComputer } from "./private-invocation-computer.js";
import {
  createPrivateLocalComputerProcesses,
  type PrivateLocalComputerProcesses,
} from "./private-local-computer-processes.js";
import {
  capturePrivateLocalExecPath,
  parsePrivateLocalExecPath,
} from "./private-local-exec-path.js";
import { ensurePrivateLocalGitExclude } from "./private-local-git-exclude.js";
import {
  acquireNodeStoreLease,
  nodeRuntimeHost,
  type NodeRuntimeHost,
  type NodeStoreLease,
} from "@fungi.computer/shiitake/node";
import { createPrivateInvocationFilesPort } from "./private-invocation-files.js";
import { createLocalSkillSource } from "./local-skill-source.js";
import { createPrivateWorkerdSandbox } from "./private-workerd-sandbox.js";
import {
  createPrivateFungiMcpConnection,
  type PrivateFungiMcpConnectionOptions,
} from "./private-fungi-mcp-connection.js";
import { createPrivateSqliteOwner } from "./private-sqlite-owner.js";
import { createPrivateLocalMailRoom } from "./private-local-mail.js";
import {
  createPrivateLocalDelegation,
  type PrivateLocalMailRouting,
} from "./private-local-delegation.js";

const initialSessionId = "main";
const maximumInstructionReadBytes = 128 * 1_024;
const maximumInstructionSnapshotBytes = 32_000;
const instructionRevisionVersion = "local-host-instructions-v2";
const authoredInstructions =
  "You are the local coding agent. Explain durable changes clearly. Discover available operations through forage.search and inspect their input with forage.describe; call only the exact paths they return. Extension prompt sections describe the Session's tools and controls. After a run fails, each new user message is a new instruction. Retry or continue the previous task only when the user explicitly asks; if the new message is ambiguous, ask what they want before acting.";
const utf8 = new TextEncoder();

const localHostIds = defineIdFamily({
  family: "local-host",
  version: 1,
  kinds: {
    store: { prefix: "local_store" },
    "session-create-request": { prefix: "local_session_create_request" },
  },
});
export type LocalStoreId = ReturnType<typeof localHostIds.store.generate>;

type LocalDatabasePaths = Readonly<{
  agentId: LocalStoreId | undefined;
  databasePath: string;
  sidecarPath: string;
}>;

export type LocalResources = Readonly<{
  agent?: Pick<ShiitakeAgent, "close"> | undefined;
  processes?: Pick<PrivateLocalComputerProcesses, "close"> | undefined;
  runtime: Omit<NodeRuntimeHost, "scheduleWake">;
  database?: Pick<DatabaseSync, "close"> | undefined;
  lease?: NodeStoreLease | undefined;
  providerCacheKey?: string | undefined;
}>;

export type PrivateLocalTools = Readonly<{
  port: Awaited<ReturnType<typeof createPrivateInvocationFilesPort>>;
  tools: NonNullable<ShiitakeOptions["tools"]>;
  extensions: ExtensionRosterV0;
  /** Background Computer processes, scoped per Session; the host closes them. */
  processes: PrivateLocalComputerProcesses;
}>;

/** Inputs for the one private local Agent opener. */
export type PrivateLocalRuntimeHostOptions = Readonly<{
  /** Invocation root captured before selecting a fresh local database. */
  invocationRoot: string;
  /** Existing Agent database to reopen instead of creating a fresh local store. */
  databasePath?: string | undefined;
  /** Stable Local store identity for replaying one Agent create request. */
  createRequestId?: string | undefined;
  /** Explicit Agent model; otherwise inherit manual choice and available login. */
  providerId?: string | undefined;
  modelId?: string | undefined;
  reasoning?: ThinkingLevel | undefined;
  /** Local settings location; credentials remain in their separate owner. */
  modelSettingsPath?: string | undefined;
  /**
   * Service-owned project mail routing. With `agentControl`, it gives this
   * Agent follow-up delegation with authenticated replies and settles its own
   * addressed work back to the sender.
   */
  mail?: PrivateLocalMailRouting | undefined;
  /** Service-owned directory scoped to the captured project. */
  agentControl?: AgentControlDirectory | undefined;
  /** Explicit hosted capability connection; local tools and the Agent store stay local. */
  fungiMcp?: PrivateFungiMcpConnectionOptions | undefined;
}>;

/** Typed Session and awaited resource owner supplied directly to the local TUI. */
export type PrivateLocalRuntimeHost = Readonly<{
  /** Stable Local directory identity of this authorized Agent. */
  agentId: string;
  /** Canonical file path to pass explicitly to a later --db launch. */
  databasePath: string;
  session: ShiitakeSession;
  /** Address a Session through this same Agent and resource owner. */
  getSession: (sessionId: string) => ShiitakeSession;
  /** A selected Session keeps one client's command PATH while this host is live. */
  bindSessionPath: (sessionId: string, path: string) => boolean;
  /** Resolve this Session's effective model and nonsecret credential source. */
  effectiveModel: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<PrivateLocalEffectiveModel>;
  /** Set the persistent Agent default without changing Session overrides. */
  setModel: (model: ModelPreference, signal: AbortSignal) => Promise<void>;
  /** Refuse unrunnable creation or send before claiming acceptance. */
  assertModelReady: (sessionId: string, signal: AbortSignal) => Promise<void>;
  listSessions: ShiitakeAgent["listSessions"];
  createSession: ShiitakeAgent["createSession"];
  deleteSession: ShiitakeAgent["deleteSession"];
  /** List, resume and call this Agent's rostered extensions. */
  extensions: ShiitakeAgent["extensions"];
  /**
   * Admit mail addressed to this Agent: new work that replies to its sender,
   * or a reply authenticated against work this Agent sent. Anything else is
   * refused.
   */
  acceptMail: (mail: BirdDogMail) => Promise<Accepted>;
  /** Exact settled command facts for a delegating sender. */
  readSettlement: (
    sessionId: string,
    commandId: string,
  ) => Promise<CommandSettlement | undefined>;
  close: () => Promise<void>;
}>;

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function sidecarPathFor(databasePath: string) {
  return `${databasePath}.owner.sqlite`;
}

function ensureLocalAgentId(
  database: DatabaseSync,
  pathAgentId: LocalStoreId | undefined,
): LocalStoreId {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS private_local_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        agent_id TEXT NOT NULL UNIQUE
      )
    `);
    const row = database
      .prepare(
        "SELECT agent_id FROM private_local_identity WHERE singleton = 1",
      )
      .get();
    if (row !== undefined) {
      const parsed = localHostIds.store.schema.safeParse(row.agent_id);
      if (
        !parsed.success ||
        (pathAgentId !== undefined && parsed.data !== pathAgentId)
      )
        throw new Error("Local Agent identity does not match its store");
      database.exec("COMMIT");
      return parsed.data;
    }
    const agentId = pathAgentId ?? localHostIds.store.generate();
    database
      .prepare(
        "INSERT INTO private_local_identity (singleton, agent_id) VALUES (1, ?)",
      )
      .run(agentId);
    database.exec("COMMIT");
    return agentId;
  } catch (cause) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          "Local transaction and rollback failed",
          { cause: rollbackCause },
        );
      }
    }
    throw cause;
  }
}

/** Local-owned id for a new Session creation request. */
export function createPrivateLocalSessionRequestId() {
  return localHostIds["session-create-request"].generate();
}

const localCreateReceiptFile = "local-agent-create-receipts.sqlite";
const localCreateReceiptTable = "local_agent_create_receipts";
const maximumReceiptIdAttempts = 3;
const receiptBusyTimeoutMs = 5_000;

export type PrivateLocalCreateStore = Readonly<{
  agentId: LocalStoreId;
  databasePath: string;
}>;

async function ensurePrivateLocalDirectory(path: string) {
  try {
    await mkdir(path);
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !isErrnoException(cause) ||
      cause.code !== "EEXIST"
    )
      throw cause;
  }
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    canonical !== path
  )
    throw new Error("Local Agent create directory is not project owned");
}

async function assertPrivateLocalReceiptFile(path: string) {
  // A concurrent create's commit deletes the rollback journal at any point
  // between these reads; a file that is gone has nothing left to check.
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (await realpath(path)) !== path
    )
      throw new Error(
        "Local Agent create receipt is not a unique project file",
      );
  } catch (cause) {
    if (
      cause instanceof Error &&
      isErrnoException(cause) &&
      cause.code === "ENOENT"
    )
      return;
    throw cause;
  }
}

/** Resolve an Agent create request through its durable Local receipt. */
export async function resolvePrivateLocalCreateStore(
  root: string,
  requestId: string,
): Promise<PrivateLocalCreateStore> {
  if (requestId.length === 0 || requestId.length > 256)
    throw new Error("Local Agent create request id is invalid");
  await ensurePrivateLocalGitExclude(root);
  const fungiDirectory = join(root, ".fungi");
  const agentsDirectory = join(fungiDirectory, "agents");
  await ensurePrivateLocalDirectory(fungiDirectory);
  await ensurePrivateLocalDirectory(agentsDirectory);
  const receiptPath = join(agentsDirectory, localCreateReceiptFile);
  await assertPrivateLocalReceiptFile(receiptPath);
  await assertPrivateLocalReceiptFile(`${receiptPath}-journal`);

  const database = new DatabaseSync(receiptPath, {
    timeout: receiptBusyTimeoutMs,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${String(receiptBusyTimeoutMs)}`);
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${localCreateReceiptTable} (
        request_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL UNIQUE
      ) WITHOUT ROWID
    `);
    const existing = database
      .prepare(
        `SELECT agent_id FROM ${localCreateReceiptTable} WHERE request_id = ?`,
      )
      .get(requestId);
    if (existing !== undefined) {
      const parsed = localHostIds.store.schema.safeParse(existing.agent_id);
      if (!parsed.success)
        throw new Error("Local Agent create receipt is invalid");
      const agentId = parsed.data;
      database.exec("COMMIT");
      await ensurePrivateLocalDirectory(join(agentsDirectory, agentId));
      return {
        agentId,
        databasePath: join(agentsDirectory, agentId, "agent.sqlite"),
      };
    }

    let agentId: LocalStoreId | undefined;
    const insert = database.prepare(
      `INSERT OR IGNORE INTO ${localCreateReceiptTable} (request_id, agent_id) VALUES (?, ?)`,
    );
    for (let attempt = 0; attempt < maximumReceiptIdAttempts; attempt += 1) {
      const candidate = localHostIds.store.generate();
      const candidateDirectory = join(agentsDirectory, candidate);
      try {
        // Keep the SQLite write transaction synchronous. Awaiting filesystem
        // work here lets a concurrent same-process retry block the event loop
        // in BEGIN IMMEDIATE, preventing this mkdir continuation from running.
        mkdirSync(candidateDirectory);
      } catch (cause) {
        if (
          cause instanceof Error &&
          isErrnoException(cause) &&
          cause.code === "EEXIST"
        )
          continue;
        throw cause;
      }
      const metadata = lstatSync(candidateDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        realpathSync(candidateDirectory) !== candidateDirectory
      )
        throw new Error("Local Agent create directory is not project owned");
      if (insert.run(requestId, candidate).changes > 0) {
        agentId = candidate;
        break;
      }
    }
    if (agentId === undefined)
      throw new Error("Could not allocate a unique Local Agent identity");
    database.exec("COMMIT");
    return {
      agentId,
      databasePath: join(agentsDirectory, agentId, "agent.sqlite"),
    };
  } catch (cause) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          "Local transaction and rollback failed",
          { cause: rollbackCause },
        );
      }
    }
    throw cause;
  } finally {
    database.close();
  }
}

async function localDatabasePaths(
  root: string,
  requested: string | undefined,
  createRequestId: string | undefined,
): Promise<LocalDatabasePaths> {
  if (requested !== undefined && createRequestId !== undefined)
    throw new Error(
      "Local Agent database and create request are mutually exclusive",
    );
  if (requested !== undefined) {
    const existing = await realpath(resolve(root, requested));
    const metadata = await stat(existing);
    if (!metadata.isFile())
      throw new Error(`Local Agent database is not a file: ${requested}`);
    const parent = await realpath(dirname(existing));
    const databasePath = join(parent, basename(existing));
    const parsedAgentId = localHostIds.store.parse(basename(parent));
    const agentId = parsedAgentId.ok ? parsedAgentId.value : undefined;
    return { agentId, databasePath, sidecarPath: sidecarPathFor(databasePath) };
  }

  const createStore =
    createRequestId === undefined
      ? undefined
      : await resolvePrivateLocalCreateStore(root, createRequestId);
  const createDatabasePath = createStore?.databasePath;
  const generatedAgentId =
    createStore?.agentId ?? localHostIds.store.generate();
  const selectedParent =
    createDatabasePath === undefined
      ? join(root, ".fungi", "agents", generatedAgentId)
      : dirname(createDatabasePath);
  let parent: string;
  if (createRequestId === undefined) {
    await mkdir(selectedParent, { recursive: true });
    parent = await realpath(selectedParent);
  } else {
    for (const path of [
      join(root, ".fungi"),
      join(root, ".fungi", "agents"),
      selectedParent,
    ]) {
      try {
        await mkdir(path);
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !isErrnoException(cause) ||
          cause.code !== "EEXIST"
        )
          throw cause;
      }
      const metadata = await lstat(path);
      const canonical = await realpath(path);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        canonical !== path
      )
        throw new Error("Local Agent create directory is not project owned");
    }
    parent = await realpath(selectedParent);
    const withinProject = relative(root, parent);
    if (
      isAbsolute(withinProject) ||
      withinProject === ".." ||
      withinProject.startsWith("../")
    )
      throw new Error("Local Agent create directory is outside this project");
  }
  const databasePath = createDatabasePath ?? join(parent, "agent.sqlite");
  if (createRequestId !== undefined) {
    for (const path of [databasePath, sidecarPathFor(databasePath)]) {
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(path);
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !isErrnoException(cause) ||
          cause.code !== "ENOENT"
        )
          throw cause;
        continue;
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1
      )
        throw new Error(
          "Local Agent create store is not a unique project file",
        );
      if ((await realpath(path)) !== path)
        throw new Error(
          "Local Agent create store is not a unique project file",
        );
    }
  }
  return {
    agentId: generatedAgentId,
    databasePath,
    sidecarPath: sidecarPathFor(databasePath),
  };
}

function frame(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + 4 + part.byteLength, 0);
  const framed = new Uint8Array(total);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength);
    offset += 4;
    framed.set(part, offset);
    offset += part.byteLength;
  }
  return framed;
}

async function instructionRevision(
  authored: string,
  agents: string | undefined,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    frame([
      utf8.encode(instructionRevisionVersion),
      utf8.encode(authored),
      Uint8Array.of(agents === undefined ? 0 : 1),
      utf8.encode(agents ?? ""),
    ]),
  );
  return `local-instructions-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/** Build the fixed source read by Shiitake once for each local run. */
export function createPrivateLocalInstructionSource(
  port: Awaited<ReturnType<typeof createPrivateInvocationFilesPort>>,
): InstructionSource {
  return Object.freeze({
    load: async ({ sessionId, signal }) => {
      signal.throwIfAborted();
      let agents: string | undefined;
      try {
        const page = await port.read(
          { path: "AGENTS.md", offset: 0, limit: maximumInstructionReadBytes },
          {
            executionId: `local-instructions/${sessionId}`,
            deadlineAt: null,
            signal,
          },
        );
        if (page.truncated)
          throw new Error(
            "Root AGENTS.md exceeds the 128 KiB instruction bound",
          );
        agents = page.content;
      } catch (cause) {
        if (
          cause instanceof Error &&
          isErrnoException(cause) &&
          cause.code === "ENOENT"
        ) {
          agents = undefined;
        } else throw cause;
      }
      signal.throwIfAborted();
      const text =
        agents === undefined
          ? authoredInstructions
          : `${authoredInstructions}\n\n${agents}`;
      if (utf8.encode(text).byteLength > maximumInstructionSnapshotBytes)
        throw new Error(
          `Local instructions exceed Shiitake's ${String(maximumInstructionSnapshotBytes)}-byte snapshot bound`,
        );
      return Object.freeze({
        revision: await instructionRevision(authoredInstructions, agents),
        text,
      });
    },
  });
}

/** Validate the selected registered model before resolving credentials. */
function validateLocalReasoning(
  model: Parameters<typeof getSupportedThinkingLevels>[0],
  requested: ThinkingLevel | undefined,
): void {
  if (requested === undefined) return;
  const supported = getSupportedThinkingLevels(model).filter(
    (level) => level !== "off",
  );
  if (!supported.includes(requested))
    throw new Error(
      "Reasoning level " +
        requested +
        " is not supported by " +
        model.provider +
        "/" +
        model.id +
        "; supported levels: " +
        (supported.join(", ") || "none"),
    );
}

/** Local's default is medium, clamped through Pi's model capabilities. */
function defaultLocalReasoning(
  model: Parameters<typeof getSupportedThinkingLevels>[0],
): ThinkingLevel | undefined {
  const level = clampThinkingLevel(model, "medium");
  return level === "off" ? undefined : level;
}

export function createPrivateLocalModelSource(
  models: Models,
  providerId: string | undefined,
  modelId: string | undefined,
  providerCacheKey: string,
  selectedOwnerReasoning?: ThinkingLevel,
  defaults?: Readonly<{
    agent?: () => ModelPreference | null;
    manual: () => Promise<ModelPreference | null>;
  }>,
): ModelSource &
  Readonly<{
    /** The secret-free effective selection the footer and /model show. */
    effective: (
      preference: ModelPreference | null,
      signal: AbortSignal,
    ) => Promise<PrivateLocalEffectiveModel>;
    assertReady: (
      preference: ModelPreference | null,
      signal: AbortSignal,
    ) => Promise<void>;
  }> {
  const model =
    modelId === undefined || providerId === undefined
      ? undefined
      : models.getModel(providerId, modelId);
  if (providerId !== undefined && providerId !== "fungi" && model === undefined)
    throw new ShiitakeError(
      "model",
      "rejected",
      `Local model is not registered: ${providerId}/${modelId ?? "select with --model"}`,
    );
  if (model !== undefined)
    validateLocalReasoning(model, selectedOwnerReasoning);
  const ownerReasoning =
    selectedOwnerReasoning ??
    (model === undefined ? undefined : defaultLocalReasoning(model));
  const select = async (
    preference: ModelPreference | null,
    signal: AbortSignal,
  ) => {
    const agent =
      defaults?.agent?.() ??
      (providerId === undefined
        ? null
        : {
            providerId,
            modelId: modelId ?? "@fungi/luna",
          });
    const explicit = resolveModelPreference({
      session: preference,
      agent,
      manual:
        preference === null && agent === null ? await defaults?.manual() : null,
    });
    const choice = resolveModelPreference({
      session: explicit,
      available:
        explicit === null ? await defaultLocalModel(models, signal) : null,
    });
    if (choice === null)
      throw new ShiitakeError(
        "model",
        "rejected",
        "No signed-in model provider is available. Run /login, then choose a model with /model.",
      );
    const selectedProvider = choice.providerId;
    if (selectedProvider === "fungi") {
      try {
        assertFungiModelsEnabled();
      } catch (cause) {
        throw new ShiitakeError(
          "model",
          "rejected",
          "Fungi models are paused. Try again later.",
          undefined,
          cause,
        );
      }
      await assertAuthenticated("fungi", signal);
      // Catalog facts choose a model; every stream rechecks live Hub authority.
      // A failed catalog refresh must not hide a dispatch refusal from the transcript.
      if (models.getModels("fungi").length === 0) {
        const result = await models.refresh({ providers: ["fungi"], signal });
        if (result.aborted)
          throw new Error("Fungi model catalog refresh was cancelled");
        const failure = result.errors.get("fungi");
        if (failure !== undefined)
          throw new ShiitakeError(
            "model",
            "rejected",
            "Fungi models are unavailable. Sign in with /login or choose another provider with /model.",
            undefined,
            failure,
          );
      }
    }
    const selectedId = choice.modelId;
    const selected = models.getModel(selectedProvider, selectedId);
    if (selected === undefined)
      throw new ShiitakeError(
        "model",
        "rejected",
        `Local model is not registered: ${selectedProvider}/${selectedId}`,
      );
    const reasoning =
      choice.reasoning ??
      (ownerReasoning !== undefined &&
      getSupportedThinkingLevels(selected).includes(ownerReasoning)
        ? ownerReasoning
        : defaultLocalReasoning(selected));
    validateLocalReasoning(selected, reasoning);
    return { selected, reasoning };
  };
  const assertAuthenticated = async (provider: string, signal: AbortSignal) => {
    const message = `${provider} is not signed in. Run /login or choose another model with /model.`;
    try {
      if ((await models.checkAuth(provider, { signal })) === undefined)
        throw new ShiitakeError("model", "rejected", message);
      signal.throwIfAborted();
    } catch (cause) {
      signal.throwIfAborted();
      throw new ShiitakeError("model", "rejected", message, undefined, cause);
    }
  };
  return Object.freeze({
    assertReady: async (preference, signal) => {
      const { selected } = await select(preference, signal);
      await assertAuthenticated(selected.provider, signal);
    },
    effective: async (preference, signal) => {
      signal.throwIfAborted();
      let selection: Awaited<ReturnType<typeof select>>;
      try {
        selection = await select(preference, signal);
      } catch (cause) {
        if (
          signal.aborted ||
          (preference?.providerId ?? providerId) !== "fungi"
        )
          throw cause;
        logEvent("fungi-model.status", cause);
        const source =
          cause instanceof ShiitakeError
            ? cause.message
            : "Fungi is unreachable or unavailable. Retry or sign in again.";
        return privateLocalEffectiveModelSchema.parse({
          agentName: "Shiitake",
          providerId: "fungi",
          providerName: "Fungi",
          modelId: preference?.modelId ?? modelId ?? "@fungi/luna",
          modelName: "Fungi",
          credential: { kind: "missing", source },
          label: `Shiitake · Fungi · ${source}`,
        });
      }
      const { selected, reasoning } = selection;
      const provider = models.getProvider(selected.provider);
      if (provider === undefined)
        throw new Error("Local model provider is not registered");
      const auth = await models.checkAuth(provider.id, { signal });
      signal.throwIfAborted();
      const source =
        auth === undefined
          ? "Sign in required"
          : auth.source === undefined || auth.source === "OAuth"
            ? auth.type === "oauth"
              ? `${provider.name} login`
              : "API key"
            : auth.source;
      return privateLocalEffectiveModelSchema.parse({
        agentName: "Shiitake",
        providerId: provider.id,
        providerName: provider.name,
        modelId: selected.id,
        modelName: selected.name,
        credential: { kind: auth?.type ?? "missing", source },
        label: `Shiitake · ${selected.name} (${reasoning ?? "no reasoning"}) · ${source}`,
      });
    },
    // The window comes from the same registry entry a run would acquire.
    describe: async ({ signal, preference }) => {
      signal.throwIfAborted();
      const { selected } = await select(preference, signal);
      return {
        contextWindow:
          selected.contextWindow > 0 ? selected.contextWindow : null,
      };
    },
    acquire: async ({ signal, preference }) => {
      signal.throwIfAborted();
      const { selected, reasoning: selectedReasoning } = await select(
        preference,
        signal,
      );
      await assertAuthenticated(selected.provider, signal);
      return Promise.resolve(
        Object.freeze({
          model: selected,
          stream: (selected, context, options) => {
            const streamOptions = { ...options };
            const reasoning = options?.reasoning ?? selectedReasoning;
            if (reasoning !== undefined) streamOptions.reasoning = reasoning;
            const events = createAssistantMessageEventStream();
            const failure = (
              usage: AssistantMessage["usage"],
              aborted: boolean,
              upstream?: AssistantMessage,
            ): AssistantMessage => {
              let message = `${selected.provider} rejected the model request. Check /login or choose another model with /model.`;
              if (upstream !== undefined) {
                if (isContextOverflow(upstream))
                  message = `${selected.provider} request exceeds the context window. Compact the Session or choose another model.`;
                else if (isRetryableAssistantError(upstream))
                  message = `${selected.provider} service unavailable. Try again shortly.`;
              }
              return {
                role: "assistant",
                content: [],
                api: selected.api,
                provider: selected.provider,
                model: selected.id,
                usage,
                stopReason: aborted ? "aborted" : "error",
                timestamp: Date.now(),
                errorMessage: aborted ? "Run cancelled" : message,
              };
            };
            void (async () => {
              try {
                const upstream = models.streamSimple(selected, context, {
                  ...streamOptions,
                  sessionId: providerCacheKey,
                  transport: options?.transport ?? "auto",
                });
                for await (const event of upstream) {
                  if (event.type === "error") {
                    const error = failure(
                      event.error.usage,
                      event.reason === "aborted",
                      event.error,
                    );
                    events.push({ ...event, error });
                    events.end(error);
                    return;
                  }
                  events.push(event);
                }
                events.end(await upstream.result());
              } catch {
                const aborted = (options?.signal ?? signal).aborted;
                const error = failure(
                  {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                  aborted,
                );
                events.push({
                  type: "error",
                  reason: aborted ? "aborted" : "error",
                  error,
                });
                events.end(error);
              }
            })();
            return events;
          },
          release: () => Promise.resolve(),
        }),
      );
    },
  });
}

/** One local Computer source, resolving its PATH and process scope per Session. */
function createPrivateLocalComputerSource(
  root: string,
  port: PrivateLocalTools["port"],
  sessionPath: (sessionId: string) => string | undefined,
  processes: PrivateLocalComputerProcesses,
) {
  const id = "local-computer";
  return {
    id,
    acquire: async (
      context: Parameters<ReturnType<typeof Knapsack.computer>["acquire"]>[0],
    ) => {
      const sessionId = context.session?.sessionId;
      if (sessionId === undefined)
        throw new Error("Local Computer requires a Session");
      const path =
        sessionPath(sessionId) ??
        capturePrivateLocalExecPath(
          process.env.PATH ?? "/usr/bin:/bin",
          process.cwd(),
        );
      const selected = await createPrivateInvocationComputer(
        root,
        path,
        processes.scope(sessionId),
      );
      return Knapsack.computer({
        id,
        name: "local",
        namespace: ["computers"],
        files: {
          port,
          pathInstructions: localPathInstructions(root),
        },
        computer: selected,
      }).acquire(context);
    },
  };
}

function localPathInstructions(root: string): string {
  return `Files root: ${root}. Relative paths resolve from this root; absolute paths must remain inside it.`;
}

/** Assemble the existing Files, Computer, and workerd owners once per host. */
export async function createPrivateLocalTools(
  invocationRoot: string,
  fungiMcp?: PrivateFungiMcpConnectionOptions,
  agentControl?: AgentControlDirectory,
  sessionPath?: (sessionId: string) => string | undefined,
  /** This Agent's store; its owner-enabled installed extensions join the roster. */
  storeDirectory?: string,
): Promise<PrivateLocalTools> {
  const root = await realpath(resolve(invocationRoot));
  const port = await createPrivateInvocationFilesPort(root);
  const processes = createPrivateLocalComputerProcesses(root);
  const computerSources =
    sessionPath === undefined
      ? [
          Knapsack.computer({
            id: "local-computer",
            name: "local",
            namespace: ["computers"],
            files: {
              port,
              pathInstructions: localPathInstructions(root),
            },
            computer: await createPrivateInvocationComputer(
              root,
              undefined,
              processes.scope("invocation"),
            ),
          }),
        ]
      : [createPrivateLocalComputerSource(root, port, sessionPath, processes)];
  const base = botanicalExtensionsWithSkills(
    createLocalSkillSource({ cwd: root }),
  );
  const installed =
    storeDirectory === undefined
      ? { roster: [], grants: [], diagnostics: [] }
      : await localExtensions().agent(storeDirectory, root);
  for (const diagnostic of installed.diagnostics)
    logEvent("local-extension-load", diagnostic.error);
  const extensions: ExtensionRosterV0 = {
    roster: [
      ...base.roster,
      homeExtension({
        computers: {
          read: () => [{ name: "local", attachmentId: "local-computer", port }],
        },
      }),
      ...installed.roster,
    ],
    grants: [...base.grants, homeGrant, ...installed.grants],
  };
  return Object.freeze({
    port,
    extensions,
    processes,
    tools: Object.freeze({
      execution: Object.freeze({ timeoutMs: 900_000 }),
      sources: Object.freeze([
        ...(agentControl === undefined
          ? []
          : [createAgentControlSource(agentControl)]),
        ...computerSources,
        ...(fungiMcp === undefined
          ? []
          : [createPrivateFungiMcpConnection(fungiMcp)]),
      ]),
      sandbox: createPrivateWorkerdSandbox(),
    }),
  });
}

/** Shiitake's public Node runtime host, reporting failed passes to local logs. */
function localRuntimeOwner(): NodeRuntimeHost {
  return nodeRuntimeHost((cause) => {
    logEvent("shiitake_reconciliation_failed", cause);
  });
}

/** Event-loop adaptation for the one local Shiitake owner; it has no queue policy. */
export function createPrivateLocalRuntimeHost(): RuntimeHost {
  return localRuntimeOwner().runtime;
}

function asLocalFailure(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function aggregateLocalFailures(failures: readonly Error[], message: string) {
  if (failures.length === 1) {
    const [failure] = failures;
    if (failure === undefined) throw new Error("Missing local close failure");
    return failure;
  }
  return new AggregateError(failures, message);
}

async function captureCloseFailure(
  close: () => Promise<void>,
  message: string,
): Promise<Error | undefined> {
  try {
    await close();
    return undefined;
  } catch (cause) {
    return asLocalFailure(cause, message);
  }
}

/**
 * Close the fixed local owner in dependency order without surrendering its
 * sidecar before runtime drain and main-database close have succeeded.
 *
 * This source-local seam is intentionally not re-exported by the package; the
 * focused tests use it to falsify injected failure ordering.
 */
export async function closePrivateLocalResources(
  resources: LocalResources,
  initiatingFailure?: Error,
): Promise<void> {
  const failures = initiatingFailure === undefined ? [] : [initiatingFailure];
  if (resources.agent !== undefined) {
    const failure = await captureCloseFailure(
      resources.agent.close,
      "Local Agent close failed",
    );
    if (failure !== undefined) failures.push(failure);
  }

  // No tool call runs after the Agent closed: stop its background processes.
  if (resources.processes !== undefined) {
    const failure = await captureCloseFailure(
      resources.processes.close,
      "Local Computer processes close failed",
    );
    if (failure !== undefined) failures.push(failure);
  }

  const runtimeFailure = await captureCloseFailure(
    resources.runtime.close,
    "Local runtime close failed",
  );
  if (runtimeFailure !== undefined) {
    failures.push(runtimeFailure);
    throw aggregateLocalFailures(failures, "Local host close failed");
  }

  const providerCacheKey = resources.providerCacheKey;
  if (providerCacheKey !== undefined) {
    const modelFailure = await captureCloseFailure(
      () =>
        Promise.resolve().then(() => {
          cleanupSessionResources(providerCacheKey);
        }),
      "Local provider resources close failed",
    );
    if (modelFailure !== undefined) failures.push(modelFailure);
  }

  if (resources.database !== undefined) {
    const databaseFailure = await captureCloseFailure(
      () => Promise.resolve().then(() => resources.database?.close()),
      "Local Agent database close failed",
    );
    if (databaseFailure !== undefined) {
      failures.push(databaseFailure);
      throw aggregateLocalFailures(failures, "Local host close failed");
    }
  }

  if (resources.lease !== undefined) {
    const leaseFailure = await captureCloseFailure(
      () => Promise.resolve().then(() => resources.lease?.release()),
      "Local ownership sidecar release failed",
    );
    if (leaseFailure !== undefined) failures.push(leaseFailure);
  }
  if (failures.length > 0)
    throw aggregateLocalFailures(failures, "Local host close failed");
}

/**
 * Open one private file-backed local Shiitake host and its fixed Session.
 *
 * The returned close owns agent, main database, and sidecar release in that
 * order. It is the only lifecycle the current terminal caller needs to learn.
 */
export async function openPrivateLocalRuntimeHost(
  input: PrivateLocalRuntimeHostOptions,
  models: Models = createPrivateModels(),
): Promise<PrivateLocalRuntimeHost> {
  const root = await realpath(resolve(input.invocationRoot));
  await ensurePrivateLocalGitExclude(root);
  const selectedProviderId = input.providerId;
  const selectedModelId = input.modelId;
  if (selectedProviderId !== undefined && selectedProviderId !== "fungi") {
    const model =
      selectedModelId === undefined
        ? undefined
        : models.getModel(selectedProviderId, selectedModelId);
    if (model === undefined)
      throw new ShiitakeError(
        "model",
        "rejected",
        `Local model is not registered: ${selectedProviderId}/${selectedModelId ?? "select with --model"}`,
      );
    validateLocalReasoning(model, input.reasoning);
  }
  const paths = await localDatabasePaths(
    root,
    input.databasePath,
    input.createRequestId,
  );
  const runtime = localRuntimeOwner();
  let lease: NodeStoreLease | undefined;
  let providerCacheKey: string | undefined;
  let database: DatabaseSync | undefined;
  let agent: ShiitakeAgent | undefined;
  let processes: PrivateLocalComputerProcesses | undefined;
  const sessionPaths = new Map<string, string>();

  try {
    lease = acquireNodeStoreLease(paths.sidecarPath);
    // Claim only after the lease: a rejected opener must not clean up its live owner.
    providerCacheKey = createHash("sha256")
      .update(
        JSON.stringify(["fungi-local", paths.databasePath, initialSessionId]),
      )
      .digest("hex");
    database = new DatabaseSync(paths.databasePath, { timeout: 0 });
    database.exec("PRAGMA foreign_keys = ON");
    const agentId = ensureLocalAgentId(database, paths.agentId);
    const modelDatabase = database;
    modelDatabase.exec(
      "CREATE TABLE IF NOT EXISTS private_local_model_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), model TEXT NOT NULL) STRICT",
    );
    let initialModel =
      selectedProviderId === undefined || selectedModelId === undefined
        ? null
        : parseModelPreference({
            providerId: selectedProviderId,
            modelId: selectedModelId,
          });
    if (initialModel !== null && input.reasoning !== undefined)
      initialModel = parseModelPreference({
        ...initialModel,
        reasoning: input.reasoning,
      });
    modelDatabase
      .prepare(
        "INSERT OR IGNORE INTO private_local_model_settings VALUES (1, ?)",
      )
      .run(JSON.stringify(initialModel));
    const readAgentModel = () => {
      const row = modelDatabase
        .prepare(
          "SELECT model FROM private_local_model_settings WHERE singleton = 1",
        )
        .get();
      return parseModelPreferenceJson(row?.model);
    };
    const modelSettings = createLocalModelSettings(input.modelSettingsPath);

    const store = createPrivateSqliteOwner(database);
    let acceptMail:
      | ((
          mail: BirdDogMail,
          meta?: BirdDogMail["meta"],
          reply?: VerifiedAgentReply,
        ) => Promise<Accepted>)
      | undefined;
    let readSettlement:
      | ((
          sessionId: string,
          commandId: string,
        ) => Promise<CommandSettlement | undefined>)
      | undefined;
    if (input.mail !== undefined && input.agentControl === undefined)
      throw new Error("Local delegation requires the project Agent directory");
    const delegation =
      input.mail === undefined || input.agentControl === undefined
        ? undefined
        : createPrivateLocalDelegation({
            agentId,
            storage: store,
            directory: input.agentControl,
            routing: input.mail,
            accept: (mail, meta, reply) => {
              if (acceptMail === undefined)
                return Promise.reject(
                  new Error("Local mail ingress is unavailable"),
                );
              return acceptMail(mail, meta, reply);
            },
          });
    let agentControl: AgentControlDirectory | undefined;
    if (input.agentControl !== undefined) {
      agentControl = {
        ...input.agentControl,
        models: (signal) => listOfferedLocalModels(models, signal),
      };
      if (delegation !== undefined)
        agentControl = { ...agentControl, send: delegation.send };
    }
    const localTools = await createPrivateLocalTools(
      root,
      input.fungiMcp,
      agentControl,
      (sessionId) => sessionPaths.get(sessionId),
      dirname(paths.databasePath),
    );
    processes = localTools.processes;
    const sessionProcesses = processes;
    const modelSource = createPrivateLocalModelSource(
      models,
      selectedProviderId,
      selectedModelId,
      providerCacheKey,
      input.reasoning,
      { agent: readAgentModel, manual: modelSettings.read },
    );
    const hostOptions = {
      store,
      runtime: runtime.runtime,
      extensions: localTools.extensions,
      model: modelSource,
      instructions: createPrivateLocalInstructionSource(localTools.port),
      tools: localTools.tools,
    };
    if (input.mail === undefined) {
      agent = await Shiitake.make(hostOptions);
    } else {
      const mailRoom = createPrivateLocalMailRoom(database, {
        deliver: input.mail.deliver,
        scheduleWake: runtime.scheduleWake,
      });
      const host = await makeHost(hostOptions, mailRoom);
      agent = host.agent;
      acceptMail = host.acceptMail;
      readSettlement = host.readSettlement;
    }

    const sessionOwner = agent;
    const getSession = (sessionId: string): ShiitakeSession => {
      const session = sessionOwner.session(sessionId);
      return {
        ...session,
        modelPreference: {
          read: session.modelPreference.read,
          set: async (input) => {
            const preference = parseModelPreference(input);
            if (preference !== null)
              await modelSource.assertReady(
                preference,
                new AbortController().signal,
              );
            await session.modelPreference.set(preference);
          },
        },
      };
    };
    const session = getSession(initialSessionId);
    let closing: Promise<void> | undefined;
    return Object.freeze({
      agentId,
      databasePath: paths.databasePath,
      session,
      getSession,
      setModel: async (input, signal) => {
        const preference = parseModelPreference(input);
        if (preference === null)
          throw new ShiitakeError(
            "model",
            "invalid",
            "An Agent model is required",
          );
        await modelSource.assertReady(preference, signal);
        signal.throwIfAborted();
        modelDatabase
          .prepare(
            "UPDATE private_local_model_settings SET model = ? WHERE singleton = 1",
          )
          .run(JSON.stringify(preference));
      },
      assertModelReady: async (sessionId, signal) => {
        const preference = await sessionOwner
          .session(sessionId)
          .modelPreference.read();
        await modelSource.assertReady(preference, signal);
      },
      bindSessionPath: (sessionId, path) => {
        const selected = parsePrivateLocalExecPath(path);
        const previous = sessionPaths.get(sessionId);
        if (previous !== undefined && previous !== selected) return false;
        sessionPaths.set(sessionId, selected);
        return true;
      },
      effectiveModel: async (sessionId, signal) => {
        signal.throwIfAborted();
        const preference = await sessionOwner
          .session(sessionId)
          .modelPreference.read();
        return modelSource.effective(preference, signal);
      },
      listSessions: (after) => sessionOwner.listSessions(after),
      createSession: (requestId) => sessionOwner.createSession(requestId),
      deleteSession: async (sessionId) => {
        const deleted = await sessionOwner.deleteSession(sessionId);
        // The Session ended: its background processes and logs go with it.
        await sessionProcesses.disposeScope(sessionId);
        return deleted;
      },
      extensions: sessionOwner.extensions,
      acceptMail: (mail) =>
        delegation === undefined
          ? Promise.reject(new Error("Local mail ingress is unavailable"))
          : delegation.receive(mail),
      readSettlement: (sessionId, commandId) =>
        readSettlement === undefined
          ? Promise.reject(new Error("Local settlement reads are unavailable"))
          : readSettlement(sessionId, commandId),
      close: () => {
        closing ??= closePrivateLocalResources({
          agent,
          processes,
          runtime,
          database,
          lease,
          providerCacheKey,
        });
        return closing;
      },
    });
  } catch (cause) {
    const openingFailure = asLocalFailure(cause, "Local host opening failed");
    await closePrivateLocalResources(
      { agent, processes, runtime, database, lease, providerCacheKey },
      openingFailure,
    );
    throw openingFailure;
  }
}
