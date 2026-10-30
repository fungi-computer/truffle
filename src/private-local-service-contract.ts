import type { PrivateFungiMcpSelection } from "./private-fungi-mcp-selection-schema.js";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { PrivateLocalAuthRequest } from "./private-local-auth-rpc.js";
import type { LocalAuthResult } from "./auth-cli.js";
import type {
  SessionSnapshot,
  ShiitakeAgent,
  ShiitakeSession,
} from "@fungi.computer/shiitake";
import type { PrivateLocalModelChoice } from "./local-models.js";
import type { PrivateLocalEffectiveModel } from "./private-local-effective-model.js";
import type { StopAllResult } from "./private-local-stop-all.js";
import type { ServiceDiagnosticsStatus } from "./private-local-service-log.js";
import type { LocalSandboxStatus } from "./private-local-sandbox.js";
import type { LocalPermissionMode } from "./private-local-permission-mode.js";
import type { LocalUiAttachmentLifetime } from "./private-local-ui-attachment.js";
import type { PrivateLocalScheduleCapability } from "./private-local-schedule-client.js";

/** Live health, not the on-disk identity record or a cached connection snapshot. */
export type PrivateLocalServiceStatus = Readonly<{
  /** The client-service wire contract this service speaks. */
  protocol: number;
  /** The build: the packed CLI's content hash, or `source`. */
  version: string;
  serviceId: string;
  pid: number;
  baseUrl: string;
  diagnostics: ServiceDiagnosticsStatus;
}>;

export type PrivateLocalServiceStopResult =
  /** `killed`: it did not exit within five seconds of SIGTERM. */
  | Readonly<{ kind: "stopped" | "killed" }>
  | Readonly<{ kind: "not-running"; recordCleaned: boolean }>
  | Readonly<{ kind: "replaced" }>;

/** Selection addresses an existing Agent store; Session identity is not a new store. */
export type PrivateLocalServiceSelection = Readonly<{
  invocationRoot: string;
  /** TUI/form watches own their attachment; ACP retains it until connection close. */
  uiAttachmentLifetime?: LocalUiAttachmentLifetime | undefined;
  clientPath?: string | undefined;
  /** Person-selected Agent mode, not an approval setting. */
  mode?: LocalPermissionMode | undefined;
  databasePath?: string | undefined;
  sessionId?: string | undefined;
  fungiMcp?: PrivateFungiMcpSelection | undefined;
}>;

export type PrivateLocalSessionCreation = Readonly<{
  invocationRoot: string;
  uiAttachmentLifetime?: LocalUiAttachmentLifetime | undefined;
  clientPath?: string | undefined;
  mode?: LocalPermissionMode | undefined;
  databasePath: string;
  requestId: string;
  fungiMcp?: PrivateFungiMcpSelection | undefined;
}>;

export type PrivateLocalServiceRequestOptions = Readonly<{
  signal?: AbortSignal | undefined;
}>;

/** Discovery lists the Agents in use; `archived` lists only the archived ones. */
export type PrivateLocalDiscoveryOptions = PrivateLocalServiceRequestOptions &
  Readonly<{ archived?: boolean | undefined }>;

/** One human request to archive or restore an Agent of this folder. */
export type PrivateLocalArchiveRequest = Readonly<{
  invocationRoot: string;
  agentId: string;
  archived: boolean;
}>;

export type PrivateLocalSessionInspection = Readonly<{
  diagnostics: ServiceDiagnosticsStatus;
  session: ShiitakeSession;
  snapshot: SessionSnapshot;
  close: () => Promise<void>;
}>;

export type PrivateLocalServiceConnection = Readonly<{
  /** The service this connection currently talks to; a rebind replaces it. */
  service: PrivateLocalServiceStatus;
  agentId: string;
  databasePath: string;
  sessionId: string;
  client: ShiitakeAgent;
  session: ShiitakeSession;
  /** Stop this Agent and its made-by descendants without retiring their chats. */
  stopAll: () => Promise<StopAllResult>;
  effectiveModel: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalEffectiveModel>;
  sandboxStatus: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<LocalSandboxStatus>;
  /**
   * Point this connection at the service now named by service.json, which may
   * have a new port and id after a restart, and select the same Session
   * there. The Session handle stays valid; observations on the old service
   * must be reopened. Never starts a service.
   */
  rebind: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalServiceRebind>;
  /**
   * Close observations and release this client's UI attachment. Other work and
   * service ownership stay alive; unanswered forms lose this UI's authority.
   */
  close: () => Promise<void>;
}>;

/** `unavailable`: service.json names no service that answers. */
export type PrivateLocalServiceRebind =
  | Readonly<{ kind: "rebound"; service: PrivateLocalServiceStatus }>
  | Readonly<{ kind: "unavailable"; alive: boolean }>;

export type PrivateLocalSessionChoice = Readonly<{
  databasePath: string;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Reopen this saved store through the persistent service connection. */
  resume: (
    options?: PrivateLocalServiceRequestOptions & {
      fungiMcp?: PrivateFungiMcpSelection | undefined;
      mode?: LocalPermissionMode | undefined;
    },
  ) => Promise<PrivateLocalServiceConnection>;
}>;

export type PrivateLocalSessionProblem = Readonly<{
  kind: "corrupt" | "in_use" | "unreadable";
}>;

/** One saved Agent store in the folder, whether or not it has conversations yet. */
export type PrivateLocalAgentChoice = Readonly<{
  agentId: string;
  /** Why this Agent's store cannot be read (it predates the current schema); set, the row shows it. */
  unreadable?: string | undefined;
  /** The Agent's chosen display name; absent while its store is unreadable. */
  name?: string | undefined;
  /** Creating Agent id; null for a human-created Agent, absent if unreadable. */
  createdBy?: string | null | undefined;
  databasePath: string;
  sessionCount: number;
  /** Latest Session activity; absent while the Agent has no readable Session. */
  updatedAt?: number | undefined;
}>;

export type PrivateLocalSessionDiscovery = Readonly<{
  agents: readonly PrivateLocalAgentChoice[];
  sessions: readonly PrivateLocalSessionChoice[];
  problems: readonly PrivateLocalSessionProblem[];
}>;

/** Local process management stays outside the shared Session HTTP contract. */
export type PrivateLocalServiceManager = Readonly<{
  /** Explicit private person-only capability; never provided by a mesh/App grant. */
  schedules: (invocationRoot: string) => PrivateLocalScheduleCapability;
  reload: (invocationRoot: string) => Promise<string>;
  /** Throws `LocalServiceUpdated` when a live service speaks another protocol. */
  status: () => Promise<PrivateLocalServiceStatus | undefined>;
  /**
   * Ensure a service of this build: reuse a match, otherwise stop the
   * registered one and start this build's. Once this client has reached a
   * service it keeps any service of its protocol and throws
   * `LocalServiceUpdated` for another protocol. Every request starts here.
   */
  start: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalServiceStatus>;
  createSession: (
    creation: PrivateLocalSessionCreation,
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalServiceConnection>;
  connect: (
    selection: PrivateLocalServiceSelection,
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalServiceConnection>;
  discover: (
    invocationRoot: string,
    options?: PrivateLocalDiscoveryOptions,
  ) => Promise<PrivateLocalSessionDiscovery>;
  /**
   * Archive or restore any Agent of the folder; refused with
   * `AgentArchiveRefused` while it has a running command. Nothing is deleted.
   */
  archive: (
    request: PrivateLocalArchiveRequest,
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<void>;
  inspect: (
    selection: Omit<
      PrivateLocalServiceSelection,
      "clientPath" | "uiAttachmentLifetime"
    >,
    options?: PrivateLocalServiceRequestOptions &
      Readonly<{ limit?: number | undefined }>,
  ) => Promise<PrivateLocalSessionInspection>;
  auth: (
    request: PrivateLocalAuthRequest,
    interaction: AuthInteraction,
  ) => Promise<LocalAuthResult>;
  models: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<readonly PrivateLocalModelChoice[]>;
  /**
   * SIGTERM, then SIGKILL after five seconds; the record and owner lock are
   * cleared either way. An expected identity avoids stopping a replacement
   * started by another client.
   */
  stop: (expectedServiceId?: string) => Promise<PrivateLocalServiceStopResult>;
}>;
