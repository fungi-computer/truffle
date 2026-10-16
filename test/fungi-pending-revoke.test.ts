import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import { signInFungiAccount } from "../src/private-fungi-account.js";

it.each([
  {
    userId: "account-a",
    issuer: "https://hub.test",
    status: 200,
    attempts: 1,
    remaining: 0,
  },
  {
    userId: "account-a",
    issuer: "https://hub.test",
    status: 503,
    attempts: 1,
    remaining: 1,
  },
  {
    userId: "account-b",
    issuer: "https://hub.test",
    status: 200,
    attempts: 0,
    remaining: 0,
  },
  {
    userId: "account-a",
    issuer: "https://other.test",
    status: 200,
    attempts: 0,
    remaining: 0,
  },
])(
  "finishes sign-in for $userId with a pending $issuer revoke returning $status",
  async ({ userId, issuer, status, attempts, remaining }) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-pending-signin-"));
    const credentialPath = join(root, "credentials.json");
    const pendingPath = `${credentialPath}.pending-logouts.json`;
    const access = await new SignJWT({
      sub: userId,
      "https://fungi.computer/oauth/login": "new-login",
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new Uint8Array(32).fill(7));
    await writeFile(
      pendingPath,
      JSON.stringify([
        {
          issuer,
          userId: "account-a",
          loginId: "old-login",
          revoke: true,
          detaches: [
            {
              teamId: "team-1",
              computerId: "computer-one",
              requestId: "attach-one",
            },
          ],
        },
      ]),
    );
    const order: string[] = [];
    const transport: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      const url = new URL(request.url);
      if (request.method === "HEAD" && url.pathname === "/")
        return new Response(null, { status: 200 });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: "https://hub.test/api/teams",
          authorization_servers: ["https://hub.test"],
        });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
        return Response.json({
          issuer: "https://hub.test",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/api/auth/oauth2/token")
        return Response.json({
          access_token: access,
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 900,
        });
      if (
        url.pathname ===
        "/api/v1/teams/team-1/computers/computer-one/backends/local/requests/attach-one/detach"
      ) {
        order.push("detach");
        expect(
          request.headers.get("Authorization") === `Bearer ${access}`,
        ).toBe(true);
        expect(request.method).toBe("POST");
        return Response.json({ detached: true }, { status });
      }
      if (url.pathname === "/api/local/oauth-logins/revoke") {
        order.push("revoke");
        expect(
          request.headers.get("Authorization") === `Bearer ${access}`,
        ).toBe(true);
        expect(await request.json()).toEqual({ grantId: "old-login" });
        return Response.json({ status: status === 200 }, { status });
      }
      if (url.pathname === "/api/v1/teams") {
        order.push("teams");
        return Response.json({
          kind: "accepted",
          items: [{ teamId: "team-1", handle: "one", name: "One" }],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected fixture path ${url.pathname}`);
    };
    const registrationOpened = Promise.withResolvers<URL>();
    const authorizationOpened = Promise.withResolvers<URL>();
    try {
      const login = signInFungiAccount("https://hub.test", {
        credentialPath,
        fetch: transport,
        openBrowser: (url) => {
          if (url.pathname === "/oauth/local-client")
            registrationOpened.resolve(url);
          else authorizationOpened.resolve(url);
        },
      });
      for (const opened of [
        registrationOpened.promise,
        authorizationOpened.promise,
      ]) {
        const url = await opened;
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        const fields = new URLSearchParams({
          state: url.searchParams.get("state") ?? "",
        });
        if (url.pathname === "/oauth/local-client")
          fields.set("client_id", "local-client");
        else {
          fields.set("code", "fixture-code");
          fields.set("iss", "https://hub.test");
        }
        callback.search = fields.toString();
        expect((await fetch(callback)).status).toBe(200);
      }
      await login;
      expect(order).toEqual([
        ...Array.from({ length: attempts }, () => ["detach", "revoke"]).flat(),
        "teams",
      ]);
      expect(JSON.parse(await readFile(pendingPath, "utf8"))).toHaveLength(
        remaining,
      );
      const credential = await readFile(credentialPath, "utf8");
      expect(credential.includes("new-refresh")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
