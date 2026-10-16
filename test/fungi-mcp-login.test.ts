import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  signInFungiAccount,
  signOutFungiAccount,
  privateFungiAccountOAuthProvider,
  readFungiAccountStatus,
} from "../src/private-fungi-account.js";
import { createPrivateFungiMcpConnection } from "../src/private-fungi-mcp-connection.js";
import {
  attachPrivateLocalComputer,
  detachPrivateLocalComputer,
  listPrivateLocalComputers,
} from "../src/private-local-computer-attach.js";
import { readFungiMcpSelection } from "../src/private-fungi-mcp-selection.js";

const endpoint = "https://hub.test/api/teams/team-1/mcp";
let root: string;
let credentialPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fungi-mcp-login-"));
  credentialPath = join(root, "credentials.json");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function saveLogin(issuer: string): Promise<void> {
  const provider = privateFungiAccountOAuthProvider({ credentialPath, issuer });
  await provider.saveClientInformation({
    client_id: "local-client",
    redirect_uris: ["http://127.0.0.1/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  await provider.saveTokens({
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    expires_in: 60,
  });
}

const offline: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
const reachableHub: FetchLike = (url, init) =>
  init?.method === "HEAD"
    ? Promise.resolve(new Response(null, { status: 200 }))
    : offline(url, init);

/** Serves only the authorization server metadata and revocation endpoint. */
function hubMetadata(onRevoke: (body: URLSearchParams) => void): FetchLike {
  return async (url, init) => {
    const target = new URL(url);
    if (target.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://hub.test",
        authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
        token_endpoint: "https://hub.test/api/auth/oauth2/token",
        revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (target.pathname === "/api/auth/oauth2/revoke") {
      onRevoke(new URLSearchParams(await new Response(init?.body).text()));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

async function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve(true);
    });
  });
}

it("listens on an OS-chosen loopback port while 8765 is in use", async () => {
  const occupant = createServer();
  const owned = await listen(occupant, 8765);
  try {
    const opened: URL[] = [];
    const browserOpened = Promise.withResolvers<URL>();
    const login = signInFungiAccount(endpoint, {
      credentialPath,
      fetch: reachableHub,
      openBrowser: (url) => {
        opened.push(url);
        browserOpened.resolve(url);
      },
    });
    const setup = await browserOpened.promise;
    expect(setup.origin).toBe("https://hub.test");
    expect(setup.pathname).toBe("/oauth/local-client");
    const registration = new URL(setup.searchParams.get("redirect_uri") ?? "");
    expect(registration.hostname).toBe("127.0.0.1");
    expect(registration.pathname).toBe("/client-registration");
    expect(registration.port).not.toBe("8765");
    // The listener is live: a mismatched registration reaches it and ends the login.
    registration.search = "state=wrong&client_id=attacker";
    const failed = expect(login).rejects.toThrow(
      "Local OAuth registration response was invalid",
    );
    const response = await fetch(registration);
    expect(response.status).toBe(400);
    await failed;
    expect(opened).toHaveLength(1);
  } finally {
    if (owned)
      await new Promise<void>((resolve) => {
        occupant.close(() => {
          resolve();
        });
      });
  }
});

it("refuses another browser account before replacing a cached client's identity", async () => {
  await saveLogin("https://hub.test");
  const before = await readFile(credentialPath, "utf8");
  const opened = Promise.withResolvers<URL>();
  const login = signInFungiAccount(endpoint, {
    credentialPath,
    fetch: reachableHub,
    openBrowser: (url) => {
      opened.resolve(url);
    },
  });
  const failed = expect(login).rejects.toThrow(
    "Fungi Local registration belongs to another account",
  );
  const setup = await opened.promise;
  const callback = new URL(setup.searchParams.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams({
    state: setup.searchParams.get("state") ?? "",
    client_id: "other-account-client",
  }).toString();
  await fetch(callback);
  await failed;
  expect(await readFile(credentialPath, "utf8")).toBe(before);
});

it("logout revokes at the saved issuer and removes the saved login", async () => {
  await saveLogin("https://hub.test");
  expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
    issuer: "https://hub.test",
  });
  let revoked: URLSearchParams | undefined;
  const result = await signOutFungiAccount(endpoint, {
    credentialPath,
    fetch: hubMetadata((body) => {
      revoked = body;
    }),
  });
  expect(result).toMatchObject({ kind: "revoked" });
  expect(revoked?.get("token")).toBe("refresh-token");
  expect(revoked?.get("token_type_hint")).toBe("refresh_token");
  expect(revoked?.get("client_id")).toBe("local-client");
  expect(
    await createPrivateCredentialStore(credentialPath).read("fungi"),
  ).toBeUndefined();
  expect(await readFungiAccountStatus({ credentialPath })).toBeUndefined();
});

/** Save one attachment whose Hub outcome is still pending. */
async function seedPendingAttachment(): Promise<void> {
  const store = createPrivateCredentialStore(credentialPath);
  await store.modify("fungi", (current) => {
    const credential = z
      .looseObject({
        type: z.literal("oauth"),
        access: z.string(),
        refresh: z.string(),
        expires: z.number(),
      })
      .parse(current);
    return Promise.resolve({
      ...credential,
      localBackends: [
        {
          requestId: "local_attach_request_one",
          teamId: "team-1",
          computerId: "computer_one",
          computerName: "cedar",
          rootPath: root,
          hostLabel: "test host",
          folderLabel: "project",
          publicKey: btoa("k".repeat(32)),
          privateKey: btoa("private"),
        },
      ],
    });
  });
}

it("retains one attach request and device key across an unreachable Hub retry", async () => {
  await saveLogin("https://hub.test");
  await seedPendingAttachment();
  const before =
    await createPrivateCredentialStore(credentialPath).read("fungi");
  for (let attempt = 0; attempt < 2; attempt += 1)
    await expect(
      attachPrivateLocalComputer(
        endpoint,
        { computer: "cedar", folderPath: root },
        { credentialPath, fetch: offline },
      ),
    ).resolves.toEqual({ kind: "uncertain" });
  const after =
    await createPrivateCredentialStore(credentialPath).read("fungi");
  const records = z.looseObject({
    localBackends: z.array(z.looseObject({})),
  });
  expect(records.parse(after).localBackends).toEqual(
    records.parse(before).localBackends,
  );
  // Another folder cannot silently replace the pending attachment.
  await expect(
    attachPrivateLocalComputer(
      endpoint,
      { computer: "cedar", folderPath: tmpdir() },
      { credentialPath, fetch: offline },
    ),
  ).rejects.toThrow("already attached");
});

it("signs out locally even when a Computer detach remains unconfirmed", async () => {
  await saveLogin("https://hub.test");
  await seedPendingAttachment();
  await expect(
    detachPrivateLocalComputer(endpoint, "cedar", {
      credentialPath,
      fetch: offline,
    }),
  ).resolves.toEqual({ kind: "uncertain" });
  await expect(
    signOutFungiAccount(endpoint, { credentialPath, fetch: offline }),
  ).resolves.toMatchObject({ kind: "removed" });
  expect(await readFungiAccountStatus({ credentialPath })).toBeUndefined();
  expect(await listPrivateLocalComputers({ credentialPath })).toEqual([]);
});

it("logout offline still removes the login and reports revocation unconfirmed", async () => {
  await saveLogin("https://hub.test");
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(
      await signOutFungiAccount("https://hub.test", {
        credentialPath,
        fetch: offline,
      }),
    ).toMatchObject({ kind: "removed" });
    expect(report).toHaveBeenCalledTimes(4);
    const event = String(report.mock.calls[1]?.[0]);
    expect(event).toBe(
      JSON.stringify({
        source: "local-runtime",
        operation: "fungi-account.revoke",
        failureKind: "Error",
      }),
    );
    expect(event).not.toContain("fetch failed");
  } finally {
    report.mockRestore();
  }
  expect(await readFungiAccountStatus({ credentialPath })).toBeUndefined();
});

it("logout for another origin keeps the saved login", async () => {
  await saveLogin("https://preview.test");
  expect(
    await signOutFungiAccount(endpoint, { credentialPath, fetch: offline }),
  ).toMatchObject({ kind: "not-logged-in" });
  expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
    issuer: "https://preview.test",
  });
});

it("a login for another issuer needs confirmation, then replaces the saved login", async () => {
  await saveLogin("https://preview.test");
  await expect(
    signInFungiAccount(endpoint, {
      credentialPath,
      fetch: reachableHub,
      openBrowser: () => undefined,
    }),
  ).rejects.toThrow(
    "Fungi MCP is logged in to https://preview.test. Run fungi logout --fungi-mcp https://preview.test first",
  );
  expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
    issuer: "https://preview.test",
  });

  const asked: string[][] = [];
  const browserOpened = Promise.withResolvers<URL>();
  const login = signInFungiAccount(endpoint, {
    credentialPath,
    fetch: reachableHub,
    confirmReplace: (saved, next) => {
      asked.push([saved, next]);
      return Promise.resolve(true);
    },
    openBrowser: (url) => {
      browserOpened.resolve(url);
    },
  });
  const setup = await browserOpened.promise;
  expect(asked).toEqual([["https://preview.test", "https://hub.test"]]);
  expect(setup.origin).toBe("https://hub.test");
  expect(await readFungiAccountStatus({ credentialPath })).toBeUndefined();
  const registration = new URL(setup.searchParams.get("redirect_uri") ?? "");
  registration.search = "state=wrong&client_id=x";
  const failed = expect(login).rejects.toThrow(
    "registration response was invalid",
  );
  await fetch(registration);
  await failed;
});

it("an offline authorization after registration names the unreachable origin", async () => {
  await saveLogin("https://hub.test");
  const opened = Promise.withResolvers<URL>();
  const login = signInFungiAccount(endpoint, {
    credentialPath,
    fetch: reachableHub,
    openBrowser: (url) => {
      opened.resolve(url);
    },
  });
  const failed = expect(login).rejects.toThrow(
    "Can't reach https://hub.test (fetch failed). Check your connection and try again.",
  );
  const setup = await opened.promise;
  const callback = new URL(setup.searchParams.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams({
    state: setup.searchParams.get("state") ?? "",
    client_id: "local-client",
  }).toString();
  await fetch(callback);
  await failed;
});

it("an offline sign-in stops before registration and keeps the saved account", async () => {
  await saveLogin("https://hub.test");
  const before = await readFile(credentialPath, "utf8");
  const openBrowser = vi.fn();
  await expect(
    signInFungiAccount(endpoint, {
      credentialPath,
      fetch: offline,
      openBrowser,
    }),
  ).rejects.toThrow(
    "Can't reach hub.test. Check your connection and try again.",
  );
  expect(openBrowser).not.toHaveBeenCalled();
  expect(await readFile(credentialPath, "utf8")).toBe(before);
});

it("an offline hosted connection names the unreachable origin", async () => {
  await saveLogin("https://hub.test");
  const selection = readFungiMcpSelection({ endpoint }, { credentialPath });
  const connection = createPrivateFungiMcpConnection({
    ...selection,
    fetch: offline,
  });
  await expect(
    connection.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    }),
  ).rejects.toThrow("Can't reach https://hub.test");
});

it("a revoked hosted connection says which login to run", async () => {
  await saveLogin("https://hub.test");
  const metadata = hubMetadata(() => undefined);
  let refreshes = 0;
  const fetch: FetchLike = async (url, init) => {
    const target = new URL(url);
    if (target.pathname === "/api/teams/team-1/mcp")
      return new Response(null, { status: 401 });
    if (target.pathname === "/api/auth/oauth2/token") {
      refreshes += 1;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return metadata(url, init);
  };
  // The shared account owner and MCP transport both use this network boundary.
  vi.stubGlobal("fetch", fetch);
  const connection = createPrivateFungiMcpConnection({
    ...readFungiMcpSelection({ endpoint }, { credentialPath }),
    fetch,
  });
  await expect(
    connection.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    }),
  ).rejects.toThrow(`run fungi login --fungi-mcp ${endpoint}`);
  expect(refreshes).toBe(1);
});
