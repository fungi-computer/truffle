import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  signInFungiAccount,
  privateFungiAccountOAuthProvider,
  readFungiAccountStatus,
} from "../src/private-fungi-account.js";

it.each([
  {
    label: "only Team",
    teams: [{ teamId: "team-1", handle: "one", name: "One" }],
    selected: "team-1",
    prompts: 0,
  },
  {
    label: "chosen Team",
    teams: [
      { teamId: "team-1", handle: "one", name: "One" },
      { teamId: "team-2", handle: "two", name: "Two" },
    ],
    selected: "team-2",
    prompts: 1,
  },
])(
  "finishes scoped account OAuth and picks the $label without opening MCP",
  async ({ teams, selected, prompts }) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-mcp-retry-"));
    const credentialPath = join(root, "credentials.json");
    const endpoint = "https://hub.test/api/teams/team-1/mcp";
    const provider = privateFungiAccountOAuthProvider({
      credentialPath,
      issuer: "https://hub.test",
    });
    await provider.saveClientInformation({
      client_id: "local-client",
      redirect_uris: ["http://127.0.0.1/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
    const registrationOpened = Promise.withResolvers<URL>();
    const browserOpened = Promise.withResolvers<URL>();
    let authorizedCalls = 0;
    let discoveryCalls = 0;
    let teamPrompts = 0;
    const hubFetch: FetchLike = async (input, init) => {
      const request = new Request(input.toString(), init);
      const url = new URL(request.url);
      if (request.method === "HEAD" && url.pathname === "/")
        return new Response(null, { status: 200 });
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
      if (url.pathname === "/api/auth/oauth2/token")
        return Response.json({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
          expires_in: 60,
        });
      if (url.pathname === "/api/v1/teams") {
        expect(request.headers.get("Authorization")).toBe(
          "Bearer fixture-access",
        );
        discoveryCalls += 1;
        return Response.json({
          kind: "accepted",
          items: teams,
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/teams/team-1/mcp") {
        if (request.headers.get("Authorization") !== "Bearer fixture-access")
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource"',
            },
          });
        authorizedCalls += 1;
        const body: unknown = await request.json();
        const message = z
          .object({ method: z.string(), id: z.union([z.string(), z.number()]) })
          .safeParse(body);
        if (message.success && message.data.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.data.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
    };
    try {
      const login = signInFungiAccount(endpoint, {
        credentialPath,
        fetch: hubFetch,
        chooseTeam: (choices) => {
          teamPrompts += 1;
          expect(choices).toEqual(teams);
          return Promise.resolve(selected);
        },
        openBrowser: (url) => {
          if (url.pathname === "/oauth/local-client")
            registrationOpened.resolve(url);
          else browserOpened.resolve(url);
        },
      });
      // Even a saved client revisits the idempotent registration owner so new
      // requested scopes become available before fresh human authorization.
      const setup = await registrationOpened.promise;
      const registration = new URL(
        setup.searchParams.get("redirect_uri") ?? "",
      );
      registration.search = new URLSearchParams({
        state: setup.searchParams.get("state") ?? "",
        client_id: "local-client",
      }).toString();
      expect((await fetch(registration)).status).toBe(200);
      const authorizationUrl = await browserOpened.promise;
      const callback = new URL(
        authorizationUrl.searchParams.get("redirect_uri") ?? "",
      );
      callback.search = new URLSearchParams({
        state: authorizationUrl.searchParams.get("state") ?? "",
        code: "fixture-code",
        iss: "https://hub.test/api/auth",
      }).toString();
      expect((await fetch(callback)).status).toBe(200);
      await expect(login).resolves.toBeUndefined();
      expect(authorizedCalls).toBe(0);
      expect(discoveryCalls).toBe(1);
      expect(teamPrompts).toBe(prompts);
      expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
        "models:invoke",
      );
      expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
        "git:tracker",
      );
      expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
        "billing:read",
      );
      expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
        issuer: "https://hub.test",
        team: { teamId: selected },
        teamCount: teams.length,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
