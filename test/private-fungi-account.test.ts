import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { z } from "zod";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import {
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { expect, it } from "vitest";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  freshFungiAccess,
  fungiMcpAccountAuth,
  signOutFungiAccount,
  createFungiAccountOAuth,
  readFungiAccountStatus,
  switchFungiAccountTeam,
  createFungiAccountCredentialStore,
} from "../src/private-fungi-account.js";

it("MCP receives only the shared account's access token and refuses a different issuer", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-account-"));
  const credentialPath = join(root, "credentials.json");
  try {
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
        issuer: "https://hub.test",
        clientId: "local-client",
      }),
    );
    const auth = fungiMcpAccountAuth(
      new URL("https://hub.test/api/teams/team-1/mcp"),
      { credentialPath },
    );
    expect(Object.keys(auth)).toEqual(["token", "onUnauthorized"]);
    await expect(auth.token()).resolves.toBe("fixture-access");
    await expect(
      freshFungiAccess("https://other.test", { credentialPath }),
    ).rejects.toThrow("another issuer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refreshes an expired shared grant once with the trusted Hub Origin before giving either caller access", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-refresh-"));
  const credentialPath = join(root, "credentials.json");
  let refreshes = 0;
  try {
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "expired",
        refresh: "fixture-refresh",
        expires: 0,
        issuer: "https://hub.test",
        clientId: "local-client",
      }),
    );
    const hubFetch = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: "https://hub.test/api/teams",
          authorization_servers: ["https://hub.test/api/auth"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: "https://hub.test/api/auth",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/api/auth/oauth2/token") {
        if (new Headers(init?.headers).get("Origin") !== "https://hub.test")
          return Response.json(
            { code: "MISSING_OR_NULL_ORIGIN", message: "Origin is required" },
            { status: 403 },
          );
        const body = new URLSearchParams(await new Response(init?.body).text());
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("fixture-refresh");
        expect(body.get("client_id")).toBe("local-client");
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      throw new Error("Unexpected account fixture request");
    };
    const options = { credentialPath, fetch: hubFetch };
    const auth = fungiMcpAccountAuth(
      new URL("https://hub.test/api/teams/project-team/mcp"),
      options,
    );
    await expect(
      Promise.all([
        freshFungiAccess("https://hub.test", options),
        auth.token(),
      ]),
    ).resolves.toEqual(["rotated-access", "rotated-access"]);
    expect(refreshes).toBe(1);
    expect(
      await createPrivateCredentialStore(credentialPath).read("fungi"),
    ).toMatchObject({ refresh: "rotated-refresh" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("sign-out waits for a competing refresh and revokes its rotated grant before deleting custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-sign-out-"));
  const credentialPath = join(root, "credentials.json");
  const refreshing = Promise.withResolvers<undefined>();
  const continueRefresh = Promise.withResolvers<undefined>();
  const revoked: string[] = [];
  try {
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "expired",
        refresh: "old-refresh",
        expires: 0,
        issuer: "https://hub.test",
        clientId: "local-client",
        tokens: {},
      }),
    );
    const hubFetch = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: "https://hub.test/api/teams",
          authorization_servers: ["https://hub.test/api/auth"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: "https://hub.test/api/auth",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
          response_types_supported: ["code"],
        });
      if (url.pathname === "/api/auth/oauth2/token") {
        refreshing.resolve(undefined);
        await continueRefresh.promise;
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/api/auth/oauth2/revoke") {
        revoked.push(
          new URLSearchParams(await new Response(init?.body).text()).get(
            "token",
          ) ?? "missing",
        );
        return new Response(null, { status: 200 });
      }
      throw new Error("Unexpected sign-out fixture request");
    };
    const options = { credentialPath, fetch: hubFetch };
    const access = freshFungiAccess("https://hub.test", options);
    await refreshing.promise;
    const logout = signOutFungiAccount("https://hub.test", options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const earlyRevocations = [...revoked];
    continueRefresh.resolve(undefined);
    await access;
    await expect(logout).resolves.toMatchObject({ kind: "revoked" });
    expect(earlyRevocations).toEqual([]);
    expect(revoked).toEqual(["rotated-refresh"]);
    expect(
      await createPrivateCredentialStore(credentialPath).read("fungi"),
    ).toBeUndefined();
  } finally {
    continueRefresh.resolve(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("Pi derives the selected Team endpoint from the same account and revokes on logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-pi-account-"));
  const credentialPath = join(root, "credentials.json");
  const revoked: string[] = [];
  try {
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 900_000,
        issuer: "https://hub.test",
        clientId: "local-client",
        team: { teamId: "team-1", handle: "one", name: "One" },
        teamCount: 1,
      }),
    );
    const hubFetch = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: "https://hub.test/api/teams",
          authorization_servers: ["https://hub.test/api/auth"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: "https://hub.test/api/auth",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
          response_types_supported: ["code"],
        });
      if (url.pathname === "/api/auth/oauth2/revoke") {
        revoked.push(
          new URLSearchParams(await new Response(init?.body).text()).get(
            "token",
          ) ?? "missing",
        );
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const options = { credentialPath, fetch: hubFetch };
    const models = createModels({
      credentials: createFungiAccountCredentialStore(options),
    });
    models.setProvider(
      createProvider({
        id: "fungi",
        models: [],
        auth: { oauth: createFungiAccountOAuth(options) },
        api: { stream, streamSimple },
      }),
    );
    await expect(models.getAuth("fungi")).resolves.toMatchObject({
      auth: {
        apiKey: "fixture-access",
        baseUrl: "https://hub.test/api/v1/teams/team-1",
      },
    });
    await models.logout("fungi");
    expect(revoked).toEqual(["fixture-refresh"]);
    await expect(models.checkAuth("fungi")).resolves.toBeUndefined();
    expect(
      await createPrivateCredentialStore(credentialPath).read("fungi"),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("two processes sharing the account rotate an expired refresh token only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-process-refresh-"));
  const credentialPath = join(root, "credentials.json");
  let issuer = "";
  let refreshes = 0;
  const children: ChildProcess[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    response.setHeader("content-type", "application/json");
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      response.end(
        JSON.stringify({
          resource: `${issuer}/api/teams`,
          authorization_servers: [`${issuer}/api/auth`],
        }),
      );
    else if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      response.end(
        JSON.stringify({
          issuer: `${issuer}/api/auth`,
          authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
          token_endpoint: `${issuer}/api/auth/oauth2/token`,
          response_types_supported: ["code"],
        }),
      );
    else if (url.pathname === "/api/auth/oauth2/token") {
      refreshes += 1;
      if (refreshes > 1) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "invalid_grant" }));
      } else
        setTimeout(
          () =>
            response.end(
              JSON.stringify({
                access_token: "process-access",
                refresh_token: "process-refresh",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            ),
          50,
        );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = z.object({ port: z.number() }).parse(server.address());
    issuer = `http://127.0.0.1:${String(address.port)}`;
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "expired",
        refresh: "old-refresh",
        expires: 0,
        issuer,
        clientId: "local-client",
      }),
    );
    const entry = pathToFileURL(resolve("dist/private-fungi-account.js")).href;
    const program = `
      const { freshFungiAccess } = await import(${JSON.stringify(entry)});
      const [credentialPath, issuer] = process.argv.slice(1);
      try {
        const access = await freshFungiAccess(issuer, { credentialPath });
        if (access !== "process-access") throw new Error("Incorrect refreshed access");
      } catch (cause) {
        console.error(JSON.stringify({ operation: "fungi-account.child-refresh", failureKind: cause instanceof Error ? "Error" : "NonErrorThrown" }));
        process.exitCode = 1;
      }
    `;
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "--eval", program, credentialPath, issuer],
          { stdio: ["ignore", "ignore", "inherit"] },
        );
        children.push(child);
        child.once("error", reject);
        child.once("close", resolve);
      });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(refreshes).toBe(1);
    expect(await freshFungiAccess(issuer, { credentialPath })).toBe(
      "process-access",
    );
    expect(refreshes).toBe(1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("switches only to a fresh membership while preserving the prior Team after refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-switch-team-"));
  const credentialPath = join(root, "credentials.json");
  try {
    await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 900_000,
        issuer: "https://hub.test",
        clientId: "client",
        team: { teamId: "old-team", handle: "old", name: "Old" },
      }),
    );
    const fetch = (input: string | URL, init?: RequestInit) => {
      expect(new URL(input).href).toBe(
        "https://hub.test/api/v1/teams?limit=100",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer access",
      );
      return Promise.resolve(
        Response.json({
          kind: "accepted",
          items: [{ teamId: "new-team", handle: "new", name: "New" }],
          nextCursor: null,
        }),
      );
    };
    await switchFungiAccountTeam("new-team", { credentialPath, fetch });
    await expect(
      switchFungiAccountTeam("foreign-team", { credentialPath, fetch }),
    ).rejects.toThrow("not a current member");
    expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
      team: { teamId: "new-team", name: "New" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a missing account gives actionable sign-in guidance before network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-signed-out-"));
  try {
    await expect(
      freshFungiAccess("https://hub.test", {
        credentialPath: join(root, "credentials.json"),
      }),
    ).rejects.toThrow("Sign in to Fungi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const result of [
  "accepted",
  "concurrent",
  "second-401",
  "invalid-grant",
  "forbidden",
] as const) {
  it(`Team discovery refreshes once after a 401: ${result}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-retry-"));
    const credentialPath = join(root, "credentials.json");
    let requests = 0;
    let refreshes = 0;
    let refused = 0;
    let releaseRefusals: (() => void) | undefined;
    const allRefused = new Promise<void>((resolve) => {
      releaseRefusals = resolve;
    });
    try {
      await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
        Promise.resolve({
          type: "oauth",
          access: "fixture-old-access",
          refresh: "fixture-refresh",
          expires: Date.now() + 900_000,
          issuer: "https://hub.test",
          clientId: "client",
          team: { teamId: "old-team", handle: "old", name: "Old" },
        }),
      );
      const fetch = async (input: string | URL, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({
            resource: "https://hub.test/api/teams",
            authorization_servers: ["https://hub.test/api/auth"],
          });
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
          return Response.json({
            issuer: "https://hub.test/api/auth",
            authorization_endpoint:
              "https://hub.test/api/auth/oauth2/authorize",
            token_endpoint: "https://hub.test/api/auth/oauth2/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url.pathname === "/api/auth/oauth2/token") {
          refreshes += 1;
          if (result === "invalid-grant")
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({
            access_token: "fixture-new-access",
            refresh_token: "fixture-new-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (url.pathname !== "/api/v1/teams")
          throw new Error("Unexpected fixture destination");
        requests += 1;
        if (result === "forbidden") return new Response(null, { status: 403 });
        if (
          new Headers(init?.headers).get("Authorization") ===
          "Bearer fixture-old-access"
        ) {
          if (result === "concurrent") {
            refused += 1;
            if (refused === 6) releaseRefusals?.();
            await allRefused;
          }
          return new Response(null, { status: 401 });
        }
        if (result === "second-401") return new Response(null, { status: 401 });
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer fixture-new-access",
        );
        return Response.json({
          kind: "accepted",
          items: [{ teamId: "new-team", handle: "new", name: "New" }],
          nextCursor: null,
        });
      };
      const operation =
        result === "concurrent"
          ? Promise.all(
              Array.from({ length: 6 }, () =>
                switchFungiAccountTeam("new-team", { credentialPath, fetch }),
              ),
            )
          : switchFungiAccountTeam("new-team", { credentialPath, fetch });
      if (result === "accepted" || result === "concurrent") {
        await operation;
        expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
          team: { teamId: "new-team" },
        });
      } else {
        await expect(operation).rejects.toThrow("Sign in to Fungi again");
        expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
          team: { teamId: "old-team" },
        });
      }
      expect(refreshes).toBe(result === "forbidden" ? 0 : 1);
      expect(requests).toBe(
        result === "concurrent"
          ? 12
          : ["accepted", "second-401"].includes(result)
            ? 2
            : 1,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
