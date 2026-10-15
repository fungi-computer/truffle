import {
  loginIdentity,
  pendingLogouts,
  type PendingDetach,
} from "./private-fungi-pending-logouts.js";
import { FungiSignInRequiredError } from "./private-fungi-auth-error.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  auth,
  Client,
  type OAuthDiscoveryState,
  discoverOAuthServerInfo,
  refreshAuthorization,
  OAuthError,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type FetchLike,
  type ConnectOptions,
  type CallToolRequestOptions,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StreamableHTTPClientTransportOptions,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type {
  Credential,
  CredentialStore,
  OAuthAuth,
} from "@earendil-works/pi-ai";
import { createPrivateCredentialStore } from "./private-file-credential-store.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";
import { logEvent } from "./log-event.js";
import {
  fungiMcpClientInfo,
  fungiMcpReachableFetch,
  rejectedFungiMcpAccess,
} from "./private-fungi-mcp-connection.js";

const credentialId = "fungi";
const localScopes =
  "openid profile email offline_access models:invoke git:tracker billing:read";
const callbackHost = "127.0.0.1";
const callbackPath = "/oauth/callback";
const registrationPath = "/client-registration";
/**
 * A non-interactive provider never serves a callback: it refreshes or fails
 * before redirecting. The Hub matches loopback redirects on any port
 * (RFC 8252 §7.3), so the port-free loopback URI names the registered path.
 */
const nonInteractiveCallbackUri = `http://${callbackHost}${callbackPath}`;
/**
 * One folder attached to a Team Computer. The absolute folder path and the
 * device's private key never leave this file; the Hub holds only the public
 * key and the two labels.
 */
const localBackendRecordSchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  teamId: z.string().min(1).max(256),
  computerId: z.string().min(1).max(256),
  computerName: z.string().min(1).max(256),
  rootPath: z.string().min(1).max(4096),
  hostLabel: z.string().min(1).max(256),
  folderLabel: z.string().min(1).max(256),
  publicKey: z.base64().length(44),
  privateKey: z.base64().min(1).max(512),
  backendId: z
    .string()
    .regex(/^local-[a-z2-7]{16}$/)
    .optional(),
});
export type LocalBackendRecord = z.output<typeof localBackendRecordSchema>;

const teamChoiceSchema = z.object({
  teamId: z.string().min(1).max(256),
  handle: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
});
export type FungiAccountTeam = z.output<typeof teamChoiceSchema>;

const savedCredentialSchema = z.looseObject({
  type: z.literal("oauth"),
  access: z.string(),
  refresh: z.string(),
  expires: z.number(),
  clientId: z.string().min(1).optional(),
  issuer: z.url().optional(),
  clientInformation: z.json().optional(),
  tokens: z.json().optional(),
  codeVerifier: z.string().optional(),
  localBackends: z.array(localBackendRecordSchema).max(16).optional(),
  team: teamChoiceSchema.optional(),
  teamCount: z.number().int().min(0).max(1000).optional(),
});

type SavedCredential = z.infer<typeof savedCredentialSchema>;
export type PrivateFungiAccountOAuthProviderOptions = {
  interactive?: boolean;
  credentialPath?: string;
  issuer?: string;
  /** The Team MCP endpoint named in re-login guidance. */
  endpoint?: URL;
  /** The listening loopback callback for an interactive login. */
  redirectUrl?: string;
  openBrowser?: (url: URL) => void;
};

function jsonValue(
  value: StoredOAuthTokens | StoredOAuthClientInformation,
): z.infer<ReturnType<typeof z.json>> {
  const serialized = JSON.stringify(value);
  const decoded: unknown = JSON.parse(serialized);
  return z.json().parse(decoded);
}

function localClientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: "Fungi Local",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: localScopes,
  };
}

function credentialStore(path?: string) {
  return createPrivateCredentialStore(path);
}

async function readCredential(
  path?: string,
): Promise<SavedCredential | undefined> {
  const credential = await credentialStore(path).read(credentialId);
  if (credential?.type !== "oauth") return undefined;
  const result = savedCredentialSchema.safeParse(credential);
  if (!result.success)
    throw new Error("Fungi Local credential data is invalid");
  return result.data;
}

async function updateCredential(
  patch: Partial<SavedCredential>,
  path?: string,
): Promise<void> {
  const store = credentialStore(path);
  await store.modify(credentialId, (current) => {
    const parsed = savedCredentialSchema.safeParse(current);
    const previous: SavedCredential = parsed.success
      ? parsed.data
      : {
          type: "oauth",
          access: "",
          refresh: "",
          expires: 0,
        };
    const next = savedCredentialSchema.parse(
      Object.fromEntries(
        Object.entries({ ...previous, ...patch }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    );
    return Promise.resolve(next);
  });
}

function loginCommand(endpoint: URL | string): string {
  return `fungi login --fungi-mcp ${endpoint instanceof URL ? endpoint.href : endpoint}`;
}

function openBrowser(url: URL): void {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Fungi OAuth login supports macOS and Linux");
  process.stderr.write(`Open this URL to connect Fungi Local:\n${url.href}\n`);
  const child = spawn(
    process.platform === "darwin" ? "open" : "xdg-open",
    [url.href],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.once("error", (cause) => {
    logEvent("fungi-account.open-browser", cause);
  });
  child.unref();
}

function respond(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Fungi Local</title><p>${message}</p>`,
  );
}

/** Persisted OAuth state uses Local's existing owner-only Pi credential file. */
export function privateFungiAccountOAuthProvider(
  options: PrivateFungiAccountOAuthProviderOptions = {},
): OAuthClientProvider & {
  saveClientInformation(
    information: StoredOAuthClientInformation,
  ): Promise<void>;
  expectedState(): string | undefined;
  authorizationUrl(): URL | undefined;
} {
  const interactive = options.interactive ?? false;
  const credentialPath = options.credentialPath;
  const issuer = options.issuer ?? options.endpoint?.origin;
  const redirectUrl = options.redirectUrl ?? nonInteractiveCallbackUri;
  const relogin = loginCommand(
    options.endpoint ?? `${issuer ?? "https://<hub>"}/api/teams/<team>/mcp`,
  );
  const anotherIssuer = (kind: string, saved: string | undefined) =>
    new Error(
      `Saved Fungi OAuth ${kind} another issuer (${saved ?? "unknown"}); run ${relogin} to replace it`,
    );
  let savedAuthorizationUrl: URL | undefined;
  let expectedState: string | undefined;
  let discovery: OAuthDiscoveryState | undefined;

  return {
    get redirectUrl() {
      return redirectUrl;
    },

    get clientMetadata() {
      return localClientMetadata(redirectUrl);
    },

    saveDiscoveryState(state: OAuthDiscoveryState) {
      if (
        issuer !== undefined &&
        (new URL(state.authorizationServerUrl).origin !== issuer ||
          (state.authorizationServerMetadata?.issuer !== undefined &&
            new URL(state.authorizationServerMetadata.issuer).origin !==
              issuer))
      )
        throw new Error("Fungi OAuth discovery belongs to another issuer");
      discovery = state;
    },

    discoveryState() {
      return discovery;
    },

    validateResourceURL(_serverUrl, resource) {
      if (issuer === undefined)
        throw new Error("Fungi account issuer is required");
      const expected = new URL("/api/teams", issuer);
      if (resource !== undefined && resource !== expected.href)
        throw new Error("Fungi OAuth resource did not match this account");
      return Promise.resolve(expected);
    },

    state() {
      expectedState = randomBytes(32).toString("base64url");
      return expectedState;
    },

    async clientInformation(): Promise<
      StoredOAuthClientInformation | undefined
    > {
      const saved = await readCredential(credentialPath);
      const clientId = saved?.clientId;
      if (clientId === undefined) return undefined;
      if (issuer !== undefined && saved?.issuer !== issuer)
        throw anotherIssuer("client belongs to", saved?.issuer);
      const parsed = z
        .looseObject({ client_id: z.string().min(1) })
        .safeParse(saved?.clientInformation ?? { client_id: clientId });
      return parsed.success
        ? {
            ...parsed.data,
            client_id: clientId,
            redirect_uris: [redirectUrl],
            token_endpoint_auth_method: "none",
          }
        : undefined;
    },

    async saveClientInformation(
      information: StoredOAuthClientInformation,
    ): Promise<void> {
      const parsed = z
        .looseObject({ client_id: z.string().min(1) })
        .parse(information);
      const patch: Partial<SavedCredential> = {
        clientId: parsed.client_id,
        clientInformation: jsonValue(information),
      };
      if (issuer !== undefined) patch.issuer = issuer;
      await updateCredential(patch, credentialPath);
    },

    async tokens(): Promise<StoredOAuthTokens | undefined> {
      const saved = await readCredential(credentialPath);
      if (
        issuer !== undefined &&
        saved?.tokens !== undefined &&
        saved.issuer !== issuer
      )
        throw anotherIssuer("tokens belong to", saved.issuer);
      const parsed = z
        .looseObject({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          token_type: z.string().min(1),
        })
        .safeParse(saved?.tokens);
      return parsed.success ? { ...parsed.data } : undefined;
    },

    async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
      const parsed = jsonValue(tokens);
      const value = z
        .looseObject({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          token_type: z.string().min(1),
          expires_in: z.number().optional(),
        })
        .parse(parsed);
      await updateCredential(
        {
          access: value.access_token,
          refresh: value.refresh_token,
          expires: Date.now() + (value.expires_in ?? 0) * 1_000,
          tokens: jsonValue(tokens),
          team: undefined,
          teamCount: undefined,
        },
        credentialPath,
      );
    },

    redirectToAuthorization(url: URL): Promise<void> {
      if (!interactive)
        throw new Error(
          `Fungi MCP sign-in is missing, expired or revoked; run ${relogin}`,
        );
      savedAuthorizationUrl = new URL(url);
      (options.openBrowser ?? openBrowser)(savedAuthorizationUrl);
      return Promise.resolve();
    },

    async saveCodeVerifier(verifier: string): Promise<void> {
      await updateCredential({ codeVerifier: verifier }, credentialPath);
    },

    async codeVerifier(): Promise<string> {
      const verifier = (await readCredential(credentialPath))?.codeVerifier;
      if (verifier === undefined)
        throw new Error("Fungi OAuth verifier is unavailable");
      return verifier;
    },

    async invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): Promise<void> {
      if (scope === "all") {
        await credentialStore(credentialPath).remove(
          credentialId,
          (current) => {
            if (
              (savedCredentialSchema.parse(current).localBackends ?? [])
                .length > 0
            )
              throw new Error(
                "Detach this machine's Computers before clearing Fungi account custody",
              );
            return Promise.resolve();
          },
        );
        return;
      }
      if (scope === "client")
        await updateCredential(
          { clientId: undefined, clientInformation: undefined },
          credentialPath,
        );
      if (scope === "tokens")
        await updateCredential(
          { tokens: undefined, access: "", refresh: "", expires: 0 },
          credentialPath,
        );
      if (scope === "verifier")
        await updateCredential({ codeVerifier: undefined }, credentialPath);
    },

    expectedState() {
      return expectedState;
    },

    authorizationUrl() {
      return savedAuthorizationUrl;
    },
  };
}

function validateEndpoint(value: string | URL): URL {
  return parseFungiMcpEndpoint(value);
}

export type PrivateFungiAccountLoginOptions = {
  credentialPath?: string;
  /**
   * Asked before a login for another origin replaces the saved login. Without
   * it, a login for another origin fails with the logout command to run.
   */
  confirmReplace?: (
    savedIssuer: string,
    nextIssuer: string,
  ) => Promise<boolean>;
  /** Choose a current membership when the account has several Teams. */
  chooseTeam?: (teams: readonly FungiAccountTeam[]) => Promise<string>;
  signal?: AbortSignal;
  /** The maintained OAuth fetch seam. */
  fetch?: FetchLike;
  /** Opens the Hub pages; the default launches the platform browser. */
  openBrowser?: (url: URL) => void;
};

export type PrivateFungiAccountLogoutResult = Readonly<{
  kind: "not-logged-in" | "removed" | "revoked";
  message: string;
  unconfirmedComputers: readonly Readonly<{ name: string; url: string }>[];
}>;

function logoutResult(
  kind: PrivateFungiAccountLogoutResult["kind"],
  issuer: string | undefined,
  unconfirmedComputers: PrivateFungiAccountLogoutResult["unconfirmedComputers"] = [],
): PrivateFungiAccountLogoutResult {
  const status =
    kind === "not-logged-in"
      ? `Fungi was not logged in${issuer ? ` to ${issuer}` : ""}.`
      : kind === "revoked" && issuer !== undefined
        ? `Fungi logged out of ${issuer}; the Hub revoked this login.`
        : "Signed out here. Couldn't confirm with Fungi; you can revoke this login under Connected logins.";
  const warnings = unconfirmedComputers.map(
    ({ name, url }) =>
      `Computer ${JSON.stringify(name)} may still be attached and serving commands. Detach it on the Hub Computers page (${url}) or press Ctrl-C in the terminal running fungi computer attach. Cleanup will retry after your next sign-in to this account.`,
  );
  return {
    kind,
    message: [status, ...warnings].join("\n"),
    unconfirmedComputers,
  };
}

async function detachForLogout(
  issuer: string,
  target: PendingDetach,
  request: FetchLike,
): Promise<boolean> {
  try {
    const path = `/api/v1/teams/${encodeURIComponent(target.teamId)}/computers/${encodeURIComponent(target.computerId)}/backends/local/requests/${encodeURIComponent(target.requestId)}/detach`;
    const response = await request(new URL(path, issuer), { method: "POST" });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    return z.object({ detached: z.boolean() }).safeParse(await response.json())
      .success;
  } catch (cause) {
    logEvent("fungi-account.logout-detach", cause);
    return false;
  }
}

/** The configured Hub is the only destination for account protocol traffic. */
function ownFungiFetch(
  issuer: string,
  fetchImpl?: FetchLike,
  signal?: AbortSignal,
): FetchLike {
  const reachable = fungiMcpReachableFetch(new URL(issuer), fetchImpl);
  return (input, init) => {
    if (new URL(input).origin !== issuer)
      throw new Error("Fungi OAuth refused an endpoint from another issuer");
    const headers = new Headers(init?.headers);
    headers.set("Origin", issuer);
    return reachable(input, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  };
}

/** Revoke the saved refresh grant at the saved issuer's advertised endpoint. */
async function revokeSavedGrant(
  saved: SavedCredential,
  fetchImpl: FetchLike | undefined,
): Promise<boolean> {
  const issuer = saved.issuer;
  const clientId = saved.clientId;
  if (issuer === undefined || clientId === undefined || saved.refresh === "")
    return false;
  try {
    const ownFetch = ownFungiFetch(issuer, fetchImpl);
    const { authorizationServerMetadata } = await discoverOAuthServerInfo(
      new URL("/api/teams", issuer),
      { fetchFn: ownFetch },
    );
    // OpenID provider metadata types omit the RFC 7009 field; read it by shape.
    const revocation = z
      .looseObject({ revocation_endpoint: z.url().optional() })
      .safeParse(authorizationServerMetadata).data?.revocation_endpoint;
    // The refresh token goes only to its own issuer.
    if (revocation === undefined || new URL(revocation).origin !== issuer)
      return false;
    const response = await ownFetch(revocation, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: saved.refresh,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
      redirect: "error",
    });
    return response.ok;
  } catch (cause) {
    logEvent("fungi-account.revoke", cause);
    // Unreachable or refused: the caller reports that revocation is unconfirmed.
    return false;
  }
}

async function removeSavedLogin(
  saved: SavedCredential,
  options: { credentialPath?: string; fetch?: FetchLike },
): Promise<PrivateFungiAccountLogoutResult> {
  const pending = pendingLogouts(options.credentialPath);
  const unconfirmed: { name: string; url: string }[] = [];
  const signal = AbortSignal.timeout(30_000);
  const latest = await credentialStore(options.credentialPath).remove(
    credentialId,
    async (current) => {
      const value = savedCredentialSchema.parse(current);
      if (value.issuer !== saved.issuer)
        throw new Error(
          "Fungi account changed during sign-out. Retry for the current account.",
        );
      const identity =
        value.issuer && loginIdentity(value.issuer, value.access);
      if (identity) {
        try {
          await pending.remember(
            identity,
            (value.localBackends ?? []).map(
              ({ teamId, computerId, requestId }) => ({
                teamId,
                computerId,
                requestId,
              }),
            ),
          );
        } catch (cause) {
          // A failed intent write must never retain a credential after logout.
          logEvent("fungi-account.pending-revoke-write", cause);
        }
      }
      // The credential lock keeps concurrent attachment writes out of sign-out.
      // Use the saved bearer directly here: refresh would reacquire that lock.
      if (value.issuer) {
        const issuer = value.issuer;
        const transport = ownFungiFetch(issuer, options.fetch, signal);
        const request: FetchLike = (input, init) =>
          transport(input, {
            ...init,
            headers: { Authorization: `Bearer ${value.access}` },
          });
        for (const target of value.localBackends ?? []) {
          if (await detachForLogout(issuer, target, request)) {
            if (identity) {
              try {
                await pending.confirmed(identity, target);
              } catch (cause) {
                logEvent("fungi-account.pending-detach-clear", cause);
              }
            }
          } else {
            unconfirmed.push({
              name: target.computerName,
              url: new URL(
                `/teams/${encodeURIComponent(target.teamId)}/computers`,
                issuer,
              ).href,
            });
          }
        }
      }
      return value;
    },
  );
  if (latest === undefined || latest.refresh === "")
    return logoutResult("not-logged-in", saved.issuer, unconfirmed);
  let revoked = await revokeSavedGrant(latest, options.fetch);
  if (!revoked) revoked = await revokeSavedGrant(latest, options.fetch);
  const identity = latest.issuer && loginIdentity(latest.issuer, latest.access);
  if (revoked && identity) {
    try {
      await pending.confirmed(identity);
    } catch (cause) {
      logEvent("fungi-account.pending-revoke-clear", cause);
    }
  }
  return logoutResult(
    revoked ? "revoked" : "removed",
    latest.issuer,
    unconfirmed,
  );
}

export type FungiAccountStatus = {
  issuer: string;
  accessExpiresAt: Date;
  team?: FungiAccountTeam;
  teamCount?: number;
};

/** Non-secret status of the shared Fungi account. */
export async function readFungiAccountStatus(
  options: { credentialPath?: string } = {},
): Promise<FungiAccountStatus | undefined> {
  const saved = await readCredential(options.credentialPath);
  if (saved?.issuer === undefined || saved.access === "") return undefined;
  const status: FungiAccountStatus = {
    issuer: saved.issuer,
    accessExpiresAt: new Date(saved.expires),
  };
  if (saved.team !== undefined) status.team = saved.team;
  if (saved.teamCount !== undefined) status.teamCount = saved.teamCount;
  return status;
}

/**
 * Remove the saved Fungi MCP login for the endpoint's origin and ask that
 * issuer to revoke its refresh grant. A login for another origin is kept.
 */
export async function signOutFungiAccount(
  rawEndpoint?: string | URL,
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): Promise<PrivateFungiAccountLogoutResult> {
  const saved = await readCredential(options.credentialPath);
  const origin =
    rawEndpoint === undefined
      ? saved?.issuer
      : validateEndpoint(rawEndpoint).origin;
  if (saved === undefined || saved.issuer !== origin)
    return logoutResult("not-logged-in", origin);
  return removeSavedLogin(saved, options);
}

/**
 * Run one Mycelium control call against the Team MCP endpoint with the saved
 * login, and return the tool's text result. An error result or a transport
 * failure is `undefined`: the caller retries with its persisted request id.
 */
export async function callFungiMcpTeamControl(
  teamEndpoint: URL,
  code: string,
  options: Readonly<{
    credentialPath?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {},
): Promise<string | undefined> {
  const client = new Client(fungiMcpClientInfo);
  const requestInit: RequestInit = { redirect: "error" };
  const connectOptions: ConnectOptions = {};
  const callOptions: CallToolRequestOptions = {};
  if (options.signal !== undefined) {
    requestInit.signal = options.signal;
    connectOptions.signal = options.signal;
    callOptions.signal = options.signal;
  }
  if (options.timeoutMs !== undefined) callOptions.timeout = options.timeoutMs;
  const transportOptions: StreamableHTTPClientTransportOptions = {
    authProvider: fungiMcpAccountAuth(teamEndpoint, options),
    requestInit,
  };
  if (options.fetch !== undefined) transportOptions.fetch = options.fetch;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(teamEndpoint, transportOptions),
      connectOptions,
    );
    const response = z
      .looseObject({
        isError: z.boolean(),
        content: z.array(
          z.looseObject({ type: z.string(), text: z.string().optional() }),
        ),
      })
      .parse(
        await client.callTool(
          { name: "execute", arguments: { code } },
          callOptions,
        ),
      );
    if (response.isError) return undefined;
    return response.content.find((item) => item.text !== undefined)?.text;
  } catch (cause) {
    logEvent("fungi-mcp.control-request", cause);
    return undefined;
  } finally {
    await client.close();
  }
}

/** The Team MCP endpoint and Team a control call addresses, validated. */
export function fungiMcpTeamEndpoint(rawEndpoint: string | URL) {
  const endpoint = validateEndpoint(rawEndpoint);
  const routeParts = z
    .tuple([
      z.literal("api"),
      z.literal("teams"),
      z.string().min(1).max(256),
      z.literal("mcp"),
    ])
    .safeParse(endpoint.pathname.split("/").filter((part) => part.length > 0));
  if (!routeParts.success)
    throw new Error(
      "A Team MCP endpoint is required: https://<hub>/api/teams/<team>/mcp",
    );
  let teamId: string;
  try {
    teamId = decodeURIComponent(routeParts.data[2]);
  } catch (cause) {
    throw new Error("The Team MCP endpoint's Team ID is invalid", { cause });
  }
  return { endpoint, teamId };
}

/** The machine's attached folders, as Local keeps them. */
export async function readFungiMcpLocalBackends(
  options: Readonly<{ credentialPath?: string }> = {},
): Promise<
  Readonly<{ issuer: string | undefined; backends: LocalBackendRecord[] }>
> {
  const saved = await readCredential(options.credentialPath);
  return {
    issuer: saved?.issuer,
    backends: saved?.localBackends ?? [],
  };
}

/** Replace the attached folder records in the owner-only credential file. */
export async function writeFungiMcpLocalBackends(
  update: (current: readonly LocalBackendRecord[]) => LocalBackendRecord[],
  options: Readonly<{ credentialPath?: string }> = {},
): Promise<void> {
  await credentialStore(options.credentialPath).modify(
    credentialId,
    (current) => {
      const saved = savedCredentialSchema.parse(current);
      if (saved.access === "")
        throw new Error("Fungi sign-in is required before attaching a folder");
      return Promise.resolve(
        savedCredentialSchema.parse({
          ...saved,
          localBackends: update(saved.localBackends ?? []),
        }),
      );
    },
  );
}

/** A new session, never the saved family ID, authorizes delayed logout cleanup. */
async function retryPendingLogout(
  endpoint: URL,
  options: PrivateFungiAccountLoginOptions,
): Promise<void> {
  try {
    const saved = await readCredential(options.credentialPath);
    if (saved?.issuer !== endpoint.origin) return;
    const identity = loginIdentity(saved.issuer, saved.access);
    if (identity === undefined) return;
    const pending = pendingLogouts(options.credentialPath);
    const records = await pending.forAccount(identity);
    // Recovery must not hold up a successful sign-in across many offline requests.
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const request = fungiAccountFetch(endpoint, { ...options, signal });
    for (const record of records) {
      for (const target of record.detaches) {
        if (signal.aborted) return;
        if (await detachForLogout(endpoint.origin, target, request))
          await pending.confirmed(record, target);
      }
      if (!record.revoke) continue;
      const response = await request(
        new URL("/api/local/oauth-logins/revoke", endpoint.origin),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grantId: record.loginId }),
        },
      );
      await response.body?.cancel();
      if (!response.ok) break;
      await pending.confirmed(record);
    }
  } catch (cause) {
    // Keep the IDs for the next successful sign-in; never undo the new session.
    logEvent("fungi-account.pending-revoke", cause);
  }
}

/** Complete first-party registration and OAuth authorization in a foreground TUI. */
export async function signInFungiAccount(
  rawEndpoint: string | URL,
  options: PrivateFungiAccountLoginOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const endpoint = validateEndpoint(rawEndpoint);
  const saved = await readCredential(options.credentialPath);
  if (
    saved !== undefined &&
    (saved.clientId !== undefined || saved.tokens !== undefined) &&
    saved.issuer !== endpoint.origin
  ) {
    const savedIssuer = saved.issuer ?? "an earlier Fungi origin";
    const replace =
      (await options.confirmReplace?.(savedIssuer, endpoint.origin)) ?? false;
    if (!replace)
      throw new Error(
        `Fungi MCP is logged in to ${savedIssuer}. Run fungi logout --fungi-mcp ${saved.issuer ?? "<url>"} first, or rerun this login in a terminal to replace it.`,
      );
    const logout = await removeSavedLogin(saved, options);
    if (logout.unconfirmedComputers.length > 0) throw new Error(logout.message);
  }
  const fetchImpl = ownFungiFetch(
    endpoint.origin,
    options.fetch,
    options.signal,
  );
  const launchBrowser = options.openBrowser ?? openBrowser;
  let resolveRegistration!: (clientId: string) => void;
  let rejectRegistration!: (error: Error) => void;
  const registration = new Promise<string>((resolve, reject) => {
    resolveRegistration = resolve;
    rejectRegistration = reject;
  });
  let resolveAuthorization!: (params: URLSearchParams) => void;
  let rejectAuthorization!: (error: Error) => void;
  const authorization = new Promise<URLSearchParams>((resolve, reject) => {
    resolveAuthorization = resolve;
    rejectAuthorization = reject;
  });
  // Callbacks may race ahead of their awaits; a timeout is reported once.
  const registrationOutcome = registration.then(
    (clientId) =>
      ({
        kind: "registered",
        clientId,
      }) satisfies { kind: "registered"; clientId: string },
    (cause: unknown) =>
      ({
        kind: "failed",
        cause,
      }) satisfies { kind: "failed"; cause: unknown },
  );
  const authorizationOutcome = authorization.then(
    (params) =>
      ({
        kind: "authorized",
        params,
      }) satisfies { kind: "authorized"; params: URLSearchParams },
    (cause: unknown) =>
      ({
        kind: "failed",
        cause,
      }) satisfies { kind: "failed"; cause: unknown },
  );
  const setupState = randomBytes(32).toString("base64url");
  let clientId: string | undefined;
  // RFC 8252 §7.3: the OS picks a free loopback port; the Hub accepts any port.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, callbackHost, resolve);
  });
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const callbackOrigin = `http://${callbackHost}:${String(port)}`;
  const redirectUrl = `${callbackOrigin}${callbackPath}`;
  const providerOptions: PrivateFungiAccountOAuthProviderOptions = {
    interactive: true,
    endpoint,
    redirectUrl,
    openBrowser: launchBrowser,
  };
  if (options.credentialPath !== undefined)
    providerOptions.credentialPath = options.credentialPath;
  const provider = privateFungiAccountOAuthProvider(providerOptions);
  // The browser is opened only after this handler is attached.
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${callbackHost}`);
    if (url.pathname === registrationPath && clientId === undefined) {
      const receivedState = url.searchParams.get("state");
      const receivedClientId = url.searchParams.get("client_id");
      if (receivedState !== setupState || !receivedClientId) {
        respond(
          response,
          400,
          "Local OAuth registration did not match this login. Return to the terminal and retry.",
        );
        rejectRegistration(
          new Error("Local OAuth registration response was invalid"),
        );
        return;
      }
      clientId = receivedClientId;
      resolveRegistration(receivedClientId);
      respond(
        response,
        200,
        "Fungi Local is registered. Return to your terminal to continue sign in.",
      );
      return;
    }
    if (url.pathname === callbackPath) {
      const params = url.searchParams;
      if (params.get("state") !== provider.expectedState()) {
        respond(
          response,
          400,
          "OAuth state did not match. Return to the terminal and retry.",
        );
        rejectAuthorization(
          new Error("Fungi OAuth callback state did not match"),
        );
        return;
      }
      resolveAuthorization(params);
      respond(
        response,
        200,
        "Fungi sign-in returned to Local. Continue in your terminal to choose a Team.",
      );
      return;
    }
    respond(response, 404, "Fungi Local callback not found.");
  });
  const onAbort = () => {
    const cause = new Error("Fungi sign-in cancelled", {
      cause: options.signal?.reason,
    });
    rejectRegistration(cause);
    rejectAuthorization(cause);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(() => {
    const error = new Error("Fungi OAuth login timed out");
    rejectRegistration(error);
    rejectAuthorization(error);
  }, 5 * 60_000);
  try {
    // Explicit sign-in refreshes the existing Hub-owned client registration
    // before requesting current scopes. Existing tokens gain no authority.
    const previousClientId = (await provider.clientInformation())?.client_id;
    const setupUrl = new URL("/oauth/local-client", endpoint.origin);
    setupUrl.search = new URLSearchParams({
      redirect_uri: `${callbackOrigin}${registrationPath}`,
      state: setupState,
    }).toString();
    launchBrowser(setupUrl);
    clientId = await Promise.race([
      registrationOutcome.then((outcome) => {
        if (outcome.kind === "failed") throw outcome.cause;
        return outcome.clientId;
      }),
      authorizationOutcome.then((outcome) => {
        if (outcome.kind === "failed") throw outcome.cause;
        return "";
      }),
    ]);
    if (!clientId)
      throw new Error("OAuth callback arrived before Local registration");
    if (previousClientId !== undefined && clientId !== previousClientId)
      throw new Error(
        "Fungi Local registration belongs to another account. Use the browser account for your saved login, or detach its Computers and sign out before switching accounts.",
      );
    await provider.saveClientInformation({
      client_id: clientId,
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none",
    });
    const resource = new URL("/api/teams", endpoint.origin);
    const ownIssuerFetch = fetchImpl;
    const result = await auth(provider, {
      serverUrl: resource,
      scope: localScopes,
      fetchFn: ownIssuerFetch,
      forceReauthorization: true,
    });
    if (result === "REDIRECT") {
      const callback = await authorizationOutcome;
      if (callback.kind === "failed") throw callback.cause;
      const code = callback.params.get("code");
      if (callback.params.has("error") || code === null)
        throw new Error(
          "Fungi sign-in was declined or did not return an authorization code",
        );
      const callbackIssuer = callback.params.get("iss");
      const exchange: Parameters<typeof auth>[1] = {
        serverUrl: resource,
        authorizationCode: code,
        fetchFn: ownIssuerFetch,
      };
      if (callbackIssuer !== null) exchange.iss = callbackIssuer;
      await auth(provider, exchange);
    }
    await retryPendingLogout(endpoint, options);
    await chooseFungiAccountTeam(endpoint, options);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const teamPageSchema = z.looseObject({
  kind: z.literal("accepted"),
  items: z.array(teamChoiceSchema).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
});

/** Read current memberships; the selected model Team never changes project MCP addressing. */
async function accountTeams(
  rawHub: string | URL,
  options: { credentialPath?: string; fetch?: FetchLike; signal?: AbortSignal },
): Promise<FungiAccountTeam[]> {
  const issuer = validateEndpoint(rawHub).origin;
  const teams: FungiAccountTeam[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL("/api/v1/teams", issuer);
    url.searchParams.set("limit", "100");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const response = await fungiAccountFetch(issuer, options)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Sign in to Fungi again to choose a Team"
          : "Fungi is unreachable or could not list your Teams. Retry.",
      );
    const data = teamPageSchema.parse(await response.json());
    teams.push(...data.items);
    if (data.nextCursor === null) return teams;
    cursor = data.nextCursor;
  }
  throw new Error(
    "Your Team list is too large for this picker. Contact Fungi support.",
  );
}

async function saveSelectedTeam(
  issuer: string,
  team: FungiAccountTeam,
  teamCount: number,
  credentialPath?: string,
) {
  await credentialStore(credentialPath).modify(credentialId, (current) => {
    const saved = savedCredentialSchema.parse(current);
    if (saved.issuer !== issuer || saved.access === "")
      throw new Error(
        "Fungi account changed while choosing a Team. Sign in again.",
      );
    return Promise.resolve(
      savedCredentialSchema.parse({ ...saved, team, teamCount }),
    );
  });
}

async function chooseFungiAccountTeam(
  rawHub: string | URL,
  options: PrivateFungiAccountLoginOptions,
) {
  const issuer = validateEndpoint(rawHub).origin;
  const teams = await accountTeams(issuer, options);
  if (teams.length === 0)
    throw new Error(
      `Create or join a Team at ${issuer} before using Fungi models`,
    );
  const selectedId =
    teams.length === 1 ? teams[0]?.teamId : await options.chooseTeam?.(teams);
  const team = teams.find((candidate) => candidate.teamId === selectedId);
  if (team === undefined)
    throw new Error("Choose a current Team to pay for Fungi models");
  await saveSelectedTeam(issuer, team, teams.length, options.credentialPath);
}

/** Switch only to a fresh membership; failure preserves the prior selected Team. */
export async function switchFungiAccountTeam(
  teamId: string,
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): Promise<void> {
  const saved = await readCredential(options.credentialPath);
  if (saved?.issuer === undefined)
    throw new Error("Sign in to Fungi to choose a Team");
  const teams = await accountTeams(saved.issuer, options);
  const selected = teams.find((team) => team.teamId === teamId);
  if (selected === undefined)
    throw new Error("You are not a current member of that Team");
  await saveSelectedTeam(
    saved.issuer,
    selected,
    teams.length,
    options.credentialPath,
  );
}

export type FungiAccountTeams = Readonly<{
  teams: readonly FungiAccountTeam[];
  selectedTeamId?: string;
}>;

/** Fresh memberships for the saved account, with the Team that pays for models. */
export async function readFungiAccountTeams(
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): Promise<FungiAccountTeams> {
  const saved = await readCredential(options.credentialPath);
  if (saved?.issuer === undefined || saved.access === "")
    throw new Error("Sign in to Fungi to list your Teams");
  const teams = await accountTeams(saved.issuer, options);
  return saved.team === undefined
    ? { teams }
    : { teams, selectedTeamId: saved.team.teamId };
}

/** The Hub billing read's JSON money snapshot (Billing owns the full shape). */
const moneySnapshotSchema = z.object({
  amount: z
    .string()
    .max(16)
    .regex(/^(?:0|[1-9]\d*)$/u),
  currency: z.object({
    code: z.literal("USD"),
    base: z.literal(10),
    exponent: z.literal(2),
  }),
  scale: z.literal(5),
});
const teamBalanceSchema = z.object({
  teamId: z.string().min(1).max(256),
  balance: moneySnapshotSchema,
  included: z
    .strictObject({
      granted: moneySnapshotSchema,
      remaining: moneySnapshotSchema,
      expiresAt: z.number().int().nonnegative(),
    })
    .nullable(),
  reserved: moneySnapshotSchema,
  available: moneySnapshotSchema,
});
export type FungiTeamCredit = z.output<typeof teamBalanceSchema>;

/**
 * The selected Team's credit as the Hub billing read reports it. Refusals are
 * typed absences: 404 the person is no longer a member, 403 this sign-in
 * lacks the billing:read grant (signed in before it existed; sign in again),
 * 401 the Hub does not admit this sign-in for billing.
 */
export type FungiTeamBalance =
  | Readonly<{ kind: "balance"; credit: FungiTeamCredit }>
  | Readonly<{
      kind: "not-available";
      reason:
        "no-team" | "not-a-member" | "sign-in-again" | "sign-in-not-admitted";
    }>;

export async function readFungiTeamBalance(
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): Promise<FungiTeamBalance> {
  const saved = await readCredential(options.credentialPath);
  if (saved?.issuer === undefined || saved.access === "")
    throw new Error("Sign in to Fungi to read your Team balance");
  if (saved.team === undefined)
    return { kind: "not-available", reason: "no-team" };
  const url = new URL(
    `/api/teams/${encodeURIComponent(saved.team.teamId)}/billing/balance`,
    saved.issuer,
  );
  // One request with fresh access: a Hub that refuses this sign-in answers
  // 401, which is an absence here, not a reason to rotate the grant.
  const access = await freshFungiAccess(saved.issuer, options);
  const response = await ownFungiFetch(saved.issuer, options.fetch)(url.href, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const refusal = (
    {
      401: "sign-in-not-admitted",
      403: "sign-in-again",
      404: "not-a-member",
    } as const
  )[response.status];
  if (refusal !== undefined) {
    await response.body?.cancel();
    return { kind: "not-available", reason: refusal };
  }
  if (!response.ok)
    throw new Error(
      "Fungi is unreachable or could not read your Team balance. Retry.",
    );
  const credit = teamBalanceSchema.parse(await response.json());
  if (credit.teamId !== saved.team.teamId)
    throw new Error("Fungi returned the balance of a different Team");
  return { kind: "balance", credit };
}

/** Called only inside the shared credential lock, including Pi's refresh callback. */
async function refreshSavedCredential(
  saved: SavedCredential,
  options: { fetch?: FetchLike; signal?: AbortSignal },
): Promise<SavedCredential> {
  const issuer = saved.issuer;
  const clientId = saved.clientId;
  if (issuer === undefined || clientId === undefined || saved.refresh === "")
    throw new FungiSignInRequiredError();
  const endpoint = new URL("/api/teams", validateEndpoint(issuer));
  const ownIssuerFetch = ownFungiFetch(issuer, options.fetch, options.signal);
  try {
    const info = await discoverOAuthServerInfo(endpoint, {
      fetchFn: ownIssuerFetch,
    });
    if (
      new URL(info.authorizationServerUrl).origin !== issuer ||
      (info.resourceMetadata !== undefined &&
        info.resourceMetadata.resource !== endpoint.href)
    )
      throw new Error(
        "Fungi OAuth discovery did not match the account issuer and resource",
      );
    const refresh: Parameters<typeof refreshAuthorization>[1] = {
      clientInformation: {
        client_id: clientId,
        token_endpoint_auth_method: "none",
      },
      refreshToken: saved.refresh,
      resource: endpoint,
      fetchFn: ownIssuerFetch,
    };
    if (info.authorizationServerMetadata !== undefined)
      refresh.metadata = info.authorizationServerMetadata;
    const tokens = await refreshAuthorization(
      info.authorizationServerUrl,
      refresh,
    );
    return savedCredentialSchema.parse({
      ...saved,
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? saved.refresh,
      expires: Date.now() + (tokens.expires_in ?? 0) * 1000,
      tokens: jsonValue(tokens),
    });
  } catch (cause) {
    logEvent("fungi-account.refresh", cause);
    if (
      cause instanceof OAuthError &&
      ["invalid_grant", "invalid_client", "unauthorized_client"].includes(
        cause.code,
      )
    )
      throw new FungiSignInRequiredError({
        cause,
      });
    throw new Error(
      "Fungi is unreachable or could not refresh your sign-in. Retry or sign in again.",
      { cause },
    );
  }
}

/** True once the saved access token is past its life or already refused. */
function fungiAccessNeedsRefresh(
  saved: SavedCredential,
  rejectedAccess: string | undefined,
): boolean {
  return saved.expires <= Date.now() || saved.access === rejectedAccess;
}

/** The cached access token, only when it is this issuer's and still good. */
function cachedFungiAccess(
  cached: SavedCredential | undefined,
  issuer: string,
  rejectedAccess: string | undefined,
): string | undefined {
  if (
    cached?.issuer !== issuer ||
    cached.access === "" ||
    fungiAccessNeedsRefresh(cached, rejectedAccess)
  )
    return undefined;
  return cached.access;
}

/**
 * One cross-process credential lock serves MCP and model access, but only
 * when the saved access token actually needs it: a plain read never takes
 * the lock or rewrites the file, so a still-valid credential stays untouched.
 */
export async function freshFungiAccess(
  rawHub: string | URL,
  options: {
    credentialPath?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
    /** Compare inside the lock: another request may already have rotated it. */
    rejectedAccess?: string;
  } = {},
): Promise<string> {
  const issuer = validateEndpoint(rawHub).origin;
  options.signal?.throwIfAborted();
  const cached = await readCredential(options.credentialPath);
  const stillValid = cachedFungiAccess(cached, issuer, options.rejectedAccess);
  if (stillValid !== undefined) return stillValid;
  const current = await credentialStore(options.credentialPath).modify(
    credentialId,
    async (value) => {
      if (value?.type !== "oauth")
        throw new Error("Sign in to Fungi to use models and Computers");
      const saved = savedCredentialSchema.parse(value);
      if (saved.issuer !== issuer)
        throw new Error("Saved Fungi sign-in belongs to another issuer");
      if (saved.access === "") throw new FungiSignInRequiredError();
      return fungiAccessNeedsRefresh(saved, options.rejectedAccess)
        ? refreshSavedCredential(saved, options)
        : saved;
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return savedCredentialSchema.parse(current).access;
}

/** Retry an explicitly refused request once; the cloned body is replayable. */
export function fungiAccountFetch(
  rawHub: string | URL,
  options: {
    credentialPath?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
  } = {},
): typeof globalThis.fetch {
  const issuer = validateEndpoint(rawHub).origin;
  const transport = ownFungiFetch(issuer, options.fetch, options.signal);
  const requestWithRetry = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const request =
      input instanceof Request
        ? new Request(input, { ...init, redirect: "error" })
        : new Request(String(input), { ...init, redirect: "error" });
    if (new URL(request.url).origin !== issuer)
      throw new Error("Fungi refused a request to another issuer");
    const supplied = request.headers.get("Authorization");
    const access = supplied?.startsWith("Bearer ")
      ? supplied.slice(7)
      : await freshFungiAccess(issuer, options);
    request.headers.set("Authorization", `Bearer ${access}`);
    const retry = request.clone();
    const response = await transport(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body,
      signal: request.signal,
      redirect: "error",
      duplex: "half",
    });
    if (response.status !== 401) return response;
    await response.body?.cancel();
    const renewed = await freshFungiAccess(issuer, {
      ...options,
      rejectedAccess: access,
    });
    retry.headers.set("Authorization", `Bearer ${renewed}`);
    return transport(retry.url, {
      method: retry.method,
      headers: Object.fromEntries(retry.headers),
      body: retry.body,
      signal: retry.signal,
      redirect: "error",
      duplex: "half",
    });
  };
  return Object.assign(requestWithRetry, {
    preconnect: globalThis.fetch.preconnect,
  });
}

/** The SDK owns exactly one retry; this hook rotates only the refused credential. */
export function fungiMcpAccountAuth(
  endpoint: URL,
  options: {
    credentialPath?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
  } = {},
): AuthProvider {
  let lastToken: string | undefined;
  return {
    token: async () => {
      lastToken = await freshFungiAccess(endpoint, options);
      return lastToken;
    },
    onUnauthorized: async ({ response }) => {
      const rejectedAccess = rejectedFungiMcpAccess(response) ?? lastToken;
      if (rejectedAccess === undefined) throw new FungiSignInRequiredError();
      await freshFungiAccess(endpoint, { ...options, rejectedAccess });
    },
  };
}

/** Selected payer metadata belongs to the shared account, never a model request body. */
export function fungiAccountTeam(credential: Credential): FungiAccountTeam {
  const saved = savedCredentialSchema.parse(credential);
  if (saved.team === undefined)
    throw new Error(
      "Choose a Team with fungi login --provider fungi before using Fungi models",
    );
  return saved.team;
}

/** Pi uses its own locked modify; this owner supplies the same refresh as MCP. */
export function createFungiAccountOAuth(
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): OAuthAuth {
  return {
    name: "Fungi",
    loginLabel: "Sign in to Fungi",
    isSubscription: true,
    async login(interaction) {
      const saved = await readCredential(options.credentialPath);
      await signInFungiAccount(saved?.issuer ?? "https://fungi.computer", {
        ...options,
        signal: interaction.signal,
        openBrowser: (url) => {
          interaction.notify({ type: "auth_url", url: url.href });
        },
        chooseTeam: (teams) =>
          interaction.prompt({
            type: "select",
            signal: interaction.signal,
            message: "Which Team pays for Fungi models?",
            options: teams.map((team) => ({
              id: team.teamId,
              label: team.name,
              description: team.handle,
            })),
          }),
      });
      const current = await readCredential(options.credentialPath);
      if (current === undefined || current.access === "")
        throw new Error("Fungi sign-in did not finish");
      return current;
    },
    refresh: (credential, signal) =>
      refreshSavedCredential(savedCredentialSchema.parse(credential), {
        ...options,
        signal,
      }),
    toAuth(credential) {
      const saved = savedCredentialSchema.parse(credential);
      if (saved.issuer === undefined || saved.access === "")
        throw new Error("Sign in to Fungi to use models");
      const team = fungiAccountTeam(credential);
      const issuer = validateEndpoint(saved.issuer).origin;
      if (issuer !== saved.issuer)
        throw new Error("Saved Fungi account issuer is invalid");
      return Promise.resolve({
        apiKey: saved.access,
        baseUrl: `${issuer}/api/v1/teams/${encodeURIComponent(team.teamId)}`,
      });
    },
  };
}

/** Pi deletion clears Local custody and reports unconfirmed remote revocation. */
export function createFungiAccountCredentialStore(
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): CredentialStore {
  const store = credentialStore(options.credentialPath);
  return {
    async read(id, operation) {
      const current = await store.read(id, operation);
      if (id !== credentialId || current === undefined) return current;
      const saved = savedCredentialSchema.parse(current);
      return saved.access === "" || saved.team === undefined
        ? undefined
        : saved;
    },
    async list(operation) {
      const entries = await store.list(operation);
      const current = await store.read(credentialId, operation);
      const saved =
        current === undefined
          ? undefined
          : savedCredentialSchema.parse(current);
      return saved !== undefined &&
        saved.access !== "" &&
        saved.team !== undefined
        ? entries
        : entries.filter((entry) => entry.providerId !== credentialId);
    },
    modify: (id, callback, operation) => store.modify(id, callback, operation),
    async delete(id, operation) {
      if (id !== credentialId) return store.delete(id, operation);
      operation?.signal?.throwIfAborted();
      const result = await signOutFungiAccount(undefined, options);
      if (result.kind === "removed" || result.unconfirmedComputers.length > 0)
        throw new Error(result.message);
    },
  };
}
