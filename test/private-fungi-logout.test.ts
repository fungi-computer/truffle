import { mkdtemp, readFile, rm } from "node:fs/promises";
import { SignJWT } from "jose";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  signOutFungiAccount,
  createFungiAccountCredentialStore,
} from "../src/private-fungi-account.js";

it("retries an unconfirmed logout once and removes the local credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-logout-"));
  const credentialPath = join(root, "credentials.json");
  const store = createPrivateCredentialStore(credentialPath);
  const access = await new SignJWT({
    sub: "account-a",
    "https://fungi.computer/oauth/login": "login-a",
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new Uint8Array(32).fill(7));
  let attempts = 0;
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://hub.test",
        authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
        token_endpoint: "https://hub.test/api/auth/oauth2/token",
        revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
        response_types_supported: ["code"],
      });
    if (url.pathname === "/api/auth/oauth2/revoke") {
      attempts += 1;
      expect(await store.read("fungi")).toBeUndefined();
      return new Response(null, { status: attempts === 1 ? 503 : 200 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    await store.modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access,
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
        issuer: "https://hub.test",
        clientId: "local-client",
      }),
    );
    const result = await signOutFungiAccount("https://hub.test", {
      credentialPath,
      fetch,
    });
    expect(result).toMatchObject({ kind: "revoked" });
    expect(attempts).toBe(2);
    expect(await store.read("fungi")).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(`${credentialPath}.pending-logouts.json`, "utf8"),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps only family identity after two failed revoke attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-pending-revoke-"));
  const credentialPath = join(root, "credentials.json");
  const store = createPrivateCredentialStore(credentialPath);
  const access = await new SignJWT({
    sub: "account-a",
    "https://fungi.computer/oauth/login": "login-a",
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new Uint8Array(32).fill(7));
  let attempts = 0;
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://hub.test",
        authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
        token_endpoint: "https://hub.test/api/auth/oauth2/token",
        revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
        response_types_supported: ["code"],
      });
    if (url.pathname === "/api/auth/oauth2/revoke") {
      attempts += 1;
      expect(await store.read("fungi")).toBeUndefined();
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 404 });
  };
  try {
    await store.modify("fungi", () =>
      Promise.resolve({
        type: "oauth",
        access,
        refresh: "fixture-secret-refresh",
        expires: Date.now() + 60_000,
        issuer: "https://hub.test",
        clientId: "local-client",
      }),
    );
    expect(
      await signOutFungiAccount("https://hub.test", { credentialPath, fetch }),
    ).toMatchObject({ kind: "removed" });
    expect(attempts).toBe(2);
    expect(await store.read("fungi")).toBeUndefined();
    const pending = await readFile(
      `${credentialPath}.pending-logouts.json`,
      "utf8",
    );
    expect(
      pending.includes(access) || pending.includes("fixture-secret-refresh"),
    ).toBe(false);
    expect(JSON.parse(pending)).toEqual([
      {
        issuer: "https://hub.test",
        userId: "account-a",
        loginId: "login-a",
        revoke: true,
        detaches: [],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { caller: "direct", status: 503 },
  { caller: "pi", status: 503 },
  { caller: "direct", status: 200 },
  { caller: "pi", status: 200 },
])(
  "$caller logout tries detach before erasing keys and handles status $status",
  async ({ caller, status }) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-detach-logout-"));
    const credentialPath = join(root, "credentials.json");
    const store = createPrivateCredentialStore(credentialPath);
    const access = await new SignJWT({
      sub: "account-a",
      "https://fungi.computer/oauth/login": "login-a",
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new Uint8Array(32).fill(7));
    const requests: string[] = [];
    const transport: FetchLike = async (input, init) => {
      const request = new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname.includes("/backends/local/requests/")) {
        requests.push(url.pathname);
        expect(request.method).toBe("POST");
        expect(
          request.headers.get("Authorization") === `Bearer ${access}`,
        ).toBe(true);
        expect(await store.read("fungi")).toBeDefined();
        return Response.json({ detached: true }, { status });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://hub.test",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          revocation_endpoint: "https://hub.test/api/auth/oauth2/revoke",
          response_types_supported: ["code"],
        });
      if (url.pathname === "/api/auth/oauth2/revoke")
        return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    };
    try {
      await store.modify("fungi", () =>
        Promise.resolve({
          type: "oauth",
          access,
          refresh: "fixture-refresh",
          expires: Date.now() + 60_000,
          issuer: "https://hub.test",
          clientId: "local-client",
          localBackends: [
            {
              requestId: "attach-one",
              teamId: "team-1",
              computerId: "computer-one",
              computerName: "cedar",
              rootPath: "/private/folder",
              hostLabel: "laptop",
              folderLabel: "folder",
              publicKey: btoa("k".repeat(32)),
              privateKey: btoa("private-device-key"),
            },
          ],
        }),
      );
      const options = { credentialPath, fetch: transport };
      if (caller === "pi") {
        const deletion =
          createFungiAccountCredentialStore(options).delete("fungi");
        if (status === 200) await expect(deletion).resolves.toBeUndefined();
        else await expect(deletion).rejects.toThrow("cedar");
      } else {
        const result = await signOutFungiAccount("https://hub.test", options);
        expect(result).toMatchObject({ kind: "revoked" });
        expect(result.unconfirmedComputers).toHaveLength(
          status === 200 ? 0 : 1,
        );
        if (status !== 200) {
          expect(result.message).toContain("cedar");
          expect(result.message).toContain(
            "https://hub.test/teams/team-1/computers",
          );
          expect(result.message).toContain("may still be attached");
        }
      }
      expect(requests).toEqual([
        "/api/v1/teams/team-1/computers/computer-one/backends/local/requests/attach-one/detach",
      ]);
      expect(await store.read("fungi")).toBeUndefined();
      const pending: unknown = JSON.parse(
        await readFile(`${credentialPath}.pending-logouts.json`, "utf8"),
      );
      expect(pending).toEqual(
        status === 200
          ? []
          : [
              {
                issuer: "https://hub.test",
                userId: "account-a",
                loginId: "login-a",
                revoke: false,
                detaches: [
                  {
                    teamId: "team-1",
                    computerId: "computer-one",
                    requestId: "attach-one",
                  },
                ],
              },
            ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
