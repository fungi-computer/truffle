import type { PrivateFungiMcpSelection } from "./private-fungi-mcp-selection.js";
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

/** Service identity is checked by handshake, never inferred from a discovery PID. */
export type PrivateLocalServiceStatus = Readonly<{
  serviceId: string;
  baseUrl: string;
  /** Captured from the packed CLI at service launch. */
  buildId?: string | undefined;
}>;

export type PrivateLocalServiceStopResult =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "not-running"; recordCleaned: boolean }>
  | Readonly<{ kind: "replaced" }>;

/** Selection addresses an existing Agent store; Session identity is not a new store. */
export type PrivateLocalServiceSelection = Readonly<{
  invocationRoot: string;
  clientPath?: string | undefined;
  databasePath?: string | undefined;
  sessionId?: string | undefined;
  fungiMcp?: PrivateFungiMcpSelection | undefined;
}>;

export type PrivateLocalSessionCreation = Readonly<{
  invocationRoot: string;
  clientPath?: string | undefined;
  databasePath: string;
  requestId: string;
  fungiMcp?: PrivateFungiMcpSelection | undefined;
}>;

export type PrivateLocalServiceRequestOptions = Readonly<{
  signal?: AbortSignal | undefined;
}>;

export type PrivateLocalSessionInspection = Readonly<{
  session: ShiitakeSession;
  snapshot: SessionSnapshot;
  close: () => Promise<void>;
}>;

export type PrivateLocalServiceConnection = Readonly<{
  service: PrivateLocalServiceStatus;
  agentId: string;
  databasePath: string;
  sessionId: string;
  client: ShiitakeAgent;
  session: ShiitakeSession;
  effectiveModel: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalEffectiveModel>;
  /** Releases this client's watches only. Work and service ownership remain alive. */
  close: () => Promise<void>;
}>;

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
    },
  ) => Promise<PrivateLocalServiceConnection>;
}>;

export type PrivateLocalSessionProblem = Readonly<{
  kind: "corrupt" | "in_use" | "unreadable";
}>;

export type PrivateLocalSessionDiscovery = Readonly<{
  agentCount: number;
  sessions: readonly PrivateLocalSessionChoice[];
  problems: readonly PrivateLocalSessionProblem[];
}>;

/** Local process management stays outside the shared Session HTTP contract. */
export type PrivateLocalServiceManager = Readonly<{
  status: () => Promise<PrivateLocalServiceStatus | undefined>;
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
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalSessionDiscovery>;
  inspect: (
    selection: Omit<PrivateLocalServiceSelection, "clientPath">,
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
  /** An expected identity avoids stopping a replacement started by another client. */
  stop: (expectedServiceId?: string) => Promise<PrivateLocalServiceStopResult>;
}>;
