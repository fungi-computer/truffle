import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { fungiMcpAccountAuth } from "../src/private-fungi-account.js";
import { fungiMcpReachableFetch } from "../src/private-fungi-mcp-connection.js";

for (const secondUnauthorized of [false, true]) {
  it(`MCP SDK retries exactly once, coalescing late concurrent 401s (second 401: ${String(secondUnauthorized)})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-mcp-retry-"));
    const credentialPath = join(root, "credentials.json");
    const endpoint = new URL("https://hub.test/api/teams/team-1/mcp");
    let rotations = 0;
    let calls = 0;
    let refused = 0;
    let release: (() => void) | undefined;
    const refusedTogether = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new Client({ name: "oauth-retry-proof", version: "1" });
    try {
      await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
        Promise.resolve({
          type: "oauth",
          access: "fixture-old",
          refresh: "fixture-refresh",
          expires: Date.now() + 900_000,
          issuer: endpoint.origin,
          clientId: "local-client",
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
          rotations += 1;
          return Response.json({
            access_token: "fixture-new",
            refresh_token: "fixture-rotated",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const message = z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string(),
          })
          .parse(JSON.parse(await new Response(init.body).text()));
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        calls += 1;
        const old =
          new Headers(init.headers).get("Authorization") ===
          "Bearer fixture-old";
        if (old) {
          refused += 1;
          const position = refused;
          if (refused === 6) release?.();
          await refusedTogether;
          if (position > 3)
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
        if (old || secondUnauthorized)
          return new Response(null, { status: 401 });
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [] },
        });
      };
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          authProvider: fungiMcpAccountAuth(endpoint, {
            credentialPath,
            fetch,
          }),
          fetch: fungiMcpReachableFetch(endpoint, fetch),
        }),
      );
      const responses = await Promise.allSettled(
        Array.from({ length: 6 }, () => client.listTools()),
      );
      expect(responses.map((result) => result.status)).toEqual(
        Array.from({ length: 6 }, () =>
          secondUnauthorized ? "rejected" : "fulfilled",
        ),
      );
      expect(rotations).toBe(1);
      expect(calls).toBe(12);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
