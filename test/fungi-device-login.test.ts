import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
import { UnsecuredJWT } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  privateFungiAccountOAuthProvider,
  signInFungiAccountWithDeviceCode,
  type FungiDeviceCode,
} from "../src/private-fungi-account.js";

const hub = "https://hub.test";
let root: string;
let credentialPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fungi-device-login-"));
  credentialPath = join(root, "credentials.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

function accessToken(userId: string, loginId: string) {
  return new UnsecuredJWT({
    sub: userId,
    "https://fungi.computer/oauth/login": loginId,
  }).encode();
}

/** A token endpoint answer: an RFC 6749 error, or the issued tokens. */
type TokenAnswer = {
  status: number;
  body:
    | { error: string }
    | {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      };
};

/** The Hub's device endpoints as the CLI sees them; one answer per poll. */
function deviceHub(
  answers: TokenAnswer[],
  options: {
    verificationOrigin?: string;
    userId?: string;
    interval?: number;
  } = {},
) {
  const requests: {
    path: string;
    body: URLSearchParams;
    agent: string | null;
  }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const body = new URLSearchParams(await new Response(init?.body).text());
    requests.push({
      path: url.pathname,
      body,
      agent: new Headers(init?.headers).get("User-Agent"),
    });
    if (url.pathname === "/api/auth/device/code") {
      const page = `${options.verificationOrigin ?? hub}/device`;
      return Response.json({
        device_code: "device-secret",
        user_code: "BCDFGHJK",
        verification_uri: page,
        verification_uri_complete: `${page}?user_code=BCDFGHJK`,
        expires_in: 600,
        interval: options.interval ?? 1,
      });
    }
    if (url.pathname === "/api/auth/oauth2/token") {
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected poll");
      return Response.json(answer.body, { status: answer.status });
    }
    if (url.pathname === "/api/auth/oauth2/revoke")
      return new Response(null, { status: 200 });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: hub,
        authorization_endpoint: `${hub}/api/auth/oauth2/authorize`,
        token_endpoint: `${hub}/api/auth/oauth2/token`,
        revocation_endpoint: `${hub}/api/auth/oauth2/revoke`,
        response_types_supported: ["code"],
      });
    if (url.pathname === "/api/v1/teams")
      return Response.json({
        kind: "accepted",
        items: [{ teamId: "team-1", handle: "one", name: "One" }],
        nextCursor: null,
      });
    return new Response("not found", { status: 404 });
  };
  const approved: TokenAnswer = {
    status: 200,
    body: {
      access_token: accessToken(options.userId ?? "user-1", "login-1"),
      refresh_token: "device-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    },
  };
  return { fetch, requests, approved };
}

const pending: TokenAnswer = {
  status: 400,
  body: { error: "authorization_pending" },
};

it("shows the Hub's page and code, polls until approval and saves the device login", async () => {
  const answers: TokenAnswer[] = [pending];
  const fake = deviceHub(answers);
  answers.push(fake.approved);
  const shown: FungiDeviceCode[] = [];
  await signInFungiAccountWithDeviceCode(hub, {
    credentialPath,
    fetch: fake.fetch,
    showDeviceCode: (code) => shown.push(code),
  });
  expect(shown).toEqual([
    {
      userCode: "BCDFGHJK",
      verificationUri: `${hub}/device`,
      verificationUriComplete: `${hub}/device?user_code=BCDFGHJK`,
      expiresInSeconds: 600,
    },
  ]);
  const [start, ...polls] = fake.requests.filter(({ path }) =>
    path.startsWith("/api/auth/"),
  );
  expect(Object.fromEntries(start?.body ?? [])).toEqual({
    client_id: "fungi-device",
    scope:
      "openid profile email offline_access models:invoke computer:execute git:tracker billing:read",
    resource: `${hub}/api/teams`,
  });
  expect(start?.agent).toEqual(expect.stringContaining("Fungi CLI"));
  expect(polls.map(({ body }) => Object.fromEntries(body))).toEqual(
    Array(2).fill({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-secret",
      client_id: "fungi-device",
      resource: `${hub}/api/teams`,
    }),
  );
  const saved =
    await createPrivateCredentialStore(credentialPath).read("fungi");
  expect(saved).toMatchObject({
    issuer: hub,
    clientId: "fungi-device",
    refresh: "device-refresh",
    team: { teamId: "team-1" },
  });
});

it("names a denied or expired approval and saves nothing", async () => {
  for (const [error, message] of [
    ["access_denied", "Device sign-in was denied in the browser."],
    [
      "expired_token",
      "The code expired before it was approved. Run fungi login --device again.",
    ],
  ] as const) {
    const fake = deviceHub([{ status: 400, body: { error } }]);
    await expect(
      signInFungiAccountWithDeviceCode(hub, {
        credentialPath,
        fetch: fake.fetch,
        showDeviceCode: () => undefined,
      }),
    ).rejects.toThrow(message);
    await expect(readFile(credentialPath, "utf8")).rejects.toThrow("ENOENT");
  }
});

it("keeps a saved login when another account approves, and revokes the stray login", async () => {
  const provider = privateFungiAccountOAuthProvider({
    credentialPath,
    issuer: hub,
  });
  await provider.saveClientInformation({
    client_id: "fungi-device",
    redirect_uris: [],
    token_endpoint_auth_method: "none",
  });
  await provider.saveTokens({
    access_token: accessToken("user-1", "login-0"),
    refresh_token: "saved-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  });
  const before = await readFile(credentialPath, "utf8");
  const answers: TokenAnswer[] = [];
  const fake = deviceHub(answers, { userId: "user-2" });
  answers.push(fake.approved);
  await expect(
    signInFungiAccountWithDeviceCode(hub, {
      credentialPath,
      fetch: fake.fetch,
      showDeviceCode: () => undefined,
    }),
  ).rejects.toThrow("approved a different Fungi account");
  expect(await readFile(credentialPath, "utf8")).toBe(before);
  const revoked = fake.requests.find(
    ({ path }) => path === "/api/auth/oauth2/revoke",
  );
  expect(revoked?.body.get("token")).toBe("device-refresh");
});

it("refuses an approval page on another origin before showing a code", async () => {
  const fake = deviceHub([], { verificationOrigin: "https://phish.test" });
  const shown: FungiDeviceCode[] = [];
  await expect(
    signInFungiAccountWithDeviceCode(hub, {
      credentialPath,
      fetch: fake.fetch,
      showDeviceCode: (code) => shown.push(code),
    }),
  ).rejects.toThrow("another origin");
  expect(shown).toEqual([]);
});

/** Advance only the timer I/O boundary; keep the client loop and response parsing real. */
function pollingClock() {
  let now = Date.now();
  const waits: number[] = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(timers, "setTimeout").mockImplementation((delay, value, options) => {
    options?.signal?.throwIfAborted();
    waits.push(delay ?? 0);
    now += delay ?? 0;
    return Promise.resolve(value);
  });
  syncBuiltinESMExports();
  return waits;
}

it("stops polling at the ten-minute deadline before sending a request with an expired code", async () => {
  pollingClock();
  const fake = deviceHub(
    Array.from({ length: 121 }, () => pending),
    { interval: 5 },
  );
  await expect(
    signInFungiAccountWithDeviceCode(hub, {
      credentialPath,
      fetch: fake.fetch,
      showDeviceCode: () => undefined,
    }),
  ).rejects.toThrow(
    "The code expired before it was approved. Run fungi login --device again.",
  );
  expect(
    fake.requests.filter(({ path }) => path === "/api/auth/oauth2/token")
      .length,
  ).toBe(119);
});

it("honors the server interval and retains the five-second slow-down for later polls", async () => {
  const waits = pollingClock();
  const answers: TokenAnswer[] = [
    pending,
    { status: 400, body: { error: "slow_down" } },
    pending,
  ];
  const fake = deviceHub(answers, { interval: 5 });
  answers.push(fake.approved);
  await signInFungiAccountWithDeviceCode(hub, {
    credentialPath,
    fetch: fake.fetch,
    showDeviceCode: () => undefined,
  });
  expect(waits).toEqual([5_000, 5_000, 10_000, 10_000]);
});
