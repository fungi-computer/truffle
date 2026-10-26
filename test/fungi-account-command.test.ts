import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { runFungiAccountCommand } from "../src/fungi-account-command.js";
import { readFungiAccountStatus } from "../src/private-fungi-account.js";

const access = "eyJhbGciOiJSUzI1NiJ9.fixture-access-secret.signature";
const refresh = "fixture-refresh-secret";
const teams = [
  { teamId: "team-old", handle: "old", name: "Old Team" },
  { teamId: "team-new", handle: "new", name: "New Team" },
];
const usd = (amount: string) => ({
  amount,
  currency: { code: "USD", base: 10, exponent: 2 },
  scale: 5,
});

let home: string;
let credentialPath: string;
let output: string[];
const stdout = { write: (text: string) => void output.push(text) };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-account-command-home-"));
  credentialPath = join(home, ".fungi", "credentials.json");
  output = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function signIn() {
  await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
    Promise.resolve({
      type: "oauth",
      access,
      refresh,
      expires: Date.parse("2099-01-01T00:00:00.000Z"),
      issuer: "https://hub.test",
      clientId: "local-client",
      team: teams[0],
      teamCount: 2,
    }),
  );
}

function hub(
  balance: (teamId: string) => Response = () =>
    new Response(null, { status: 401 }),
) {
  const requests: string[] = [];
  const fetch = (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(url.pathname);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${access}`,
    );
    if (url.pathname === "/api/v1/teams")
      return Promise.resolve(
        Response.json({ kind: "accepted", items: teams, nextCursor: null }),
      );
    const match = /^\/api\/teams\/([^/]+)\/billing\/balance$/u.exec(
      url.pathname,
    );
    if (match?.[1] !== undefined) return Promise.resolve(balance(match[1]));
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { fetch, requests };
}

/**
 * write-file-atomic always renames a fresh temp file over the target, so a
 * changed inode is the decisive, timing-independent sign that a write
 * happened at all; bytes and size round out the proof the brief asks for.
 */
async function credentialFingerprint() {
  const info = await stat(credentialPath);
  return {
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    bytes: await readFile(credentialPath),
  };
}

function replies() {
  const text = output.join("");
  expect(text).not.toContain(access);
  expect(text).not.toContain(refresh);
  expect(text).not.toMatch(/eyJ|"access"|"refresh"/u);
  return text
    .trim()
    .split("\n")
    .map((line) => z.json().parse(JSON.parse(line)));
}

it("status is a non-secret reply, signed in or not", async () => {
  await runFungiAccountCommand(
    { action: "status" },
    { json: true, stdout, credentialPath },
  );
  await signIn();
  await runFungiAccountCommand(
    { action: "status" },
    { json: true, stdout, credentialPath },
  );
  expect(replies()).toEqual([
    { schemaVersion: 1, signedIn: false },
    {
      schemaVersion: 1,
      signedIn: true,
      hub: "https://hub.test",
      team: teams[0],
      teamCount: 2,
      accessExpiresAt: "2099-01-01T00:00:00.000Z",
    },
  ]);
});

it("teams reads fresh memberships and marks the selected Team", async () => {
  await signIn();
  const { fetch, requests } = hub();
  await runFungiAccountCommand(
    { action: "teams" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(requests).toEqual(["/api/v1/teams"]);
  expect(replies()).toEqual([
    {
      schemaVersion: 1,
      teams: [
        { ...teams[0], selected: true },
        { ...teams[1], selected: false },
      ],
    },
  ]);
});

it("use-team selects a current membership and keeps the prior Team on refusal", async () => {
  await signIn();
  const { fetch } = hub();
  await runFungiAccountCommand(
    { action: "use-team", teamId: "team-new" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(replies()).toEqual([{ schemaVersion: 1, team: teams[1] }]);
  await expect(
    runFungiAccountCommand(
      { action: "use-team", teamId: "team-foreign" },
      { json: true, stdout, credentialPath, fetch },
    ),
  ).rejects.toThrow("You are not a current member of that Team");
  expect((await readFungiAccountStatus({ credentialPath }))?.team).toEqual(
    teams[1],
  );
});

it("balance reads the selected Team's credit for an authorized member", async () => {
  await signIn();
  const { fetch, requests } = hub((teamId) =>
    Response.json({
      teamId,
      balance: usd("1250000"),
      included: null,
      reserved: usd("50000"),
      available: usd("1200000"),
    }),
  );
  await runFungiAccountCommand(
    { action: "balance" },
    { json: true, stdout, credentialPath, fetch },
  );
  await runFungiAccountCommand(
    { action: "balance" },
    { json: false, stdout, credentialPath, fetch },
  );
  expect(requests).toEqual([
    "/api/teams/team-old/billing/balance",
    "/api/teams/team-old/billing/balance",
  ]);
  const [json, text] = output;
  expect(JSON.parse(json ?? "")).toEqual({
    schemaVersion: 1,
    kind: "balance",
    teamId: "team-old",
    credit: {
      balance: usd("1250000"),
      included: null,
      reserved: usd("50000"),
      available: usd("1200000"),
    },
  });
  expect(text).toBe("Available $12.00 (purchased $12.50, reserved $0.50).\n");
});

it("balance maps each Hub refusal to a typed absence", async () => {
  await signIn();
  for (const status of [401, 403, 404]) {
    const { fetch } = hub(() => new Response(null, { status }));
    await runFungiAccountCommand(
      { action: "balance" },
      { json: true, stdout, credentialPath, fetch },
    );
  }
  expect(replies()).toEqual([
    { schemaVersion: 1, kind: "not-available", reason: "sign-in-not-admitted" },
    { schemaVersion: 1, kind: "not-available", reason: "sign-in-again" },
    { schemaVersion: 1, kind: "not-available", reason: "not-a-member" },
  ]);
  // A refused balance never rotates or rewrites the saved sign-in.
  expect(await readFungiAccountStatus({ credentialPath })).toMatchObject({
    team: teams[0],
  });
});

it("status never reaches the network or rewrites a still-valid credential", async () => {
  await signIn();
  const before = await credentialFingerprint();
  const fetch = () => {
    throw new Error("status must never reach the network");
  };
  await runFungiAccountCommand(
    { action: "status" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(await credentialFingerprint()).toEqual(before);
});

it("teams and balance leave a still-valid credential untouched, making only the API request", async () => {
  await signIn();
  const before = await credentialFingerprint();
  const { fetch, requests } = hub((teamId) =>
    Response.json({
      teamId,
      balance: usd("1250000"),
      included: null,
      reserved: usd("50000"),
      available: usd("1200000"),
    }),
  );
  await runFungiAccountCommand(
    { action: "teams" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(requests).toEqual(["/api/v1/teams"]);
  expect(await credentialFingerprint()).toEqual(before);

  await runFungiAccountCommand(
    { action: "balance" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(requests).toEqual([
    "/api/v1/teams",
    "/api/teams/team-old/billing/balance",
  ]);
  expect(await credentialFingerprint()).toEqual(before);
});

it("an expired token refreshes and writes exactly once, then the rotated token is read-only", async () => {
  await createPrivateCredentialStore(credentialPath).modify("fungi", () =>
    Promise.resolve({
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 0,
      issuer: "https://hub.test",
      clientId: "local-client",
      team: teams[0],
      teamCount: 2,
    }),
  );
  const before = await credentialFingerprint();
  let refreshes = 0;
  const requests: string[] = [];
  const fetch = (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Promise.resolve(
        Response.json({
          resource: "https://hub.test/api/teams",
          authorization_servers: ["https://hub.test/api/auth"],
        }),
      );
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return Promise.resolve(
        Response.json({
          issuer: "https://hub.test/api/auth",
          authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
          token_endpoint: "https://hub.test/api/auth/oauth2/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    if (url.pathname === "/api/auth/oauth2/token") {
      refreshes += 1;
      return Promise.resolve(
        Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    }
    requests.push(url.pathname);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer rotated-access",
    );
    if (url.pathname === "/api/v1/teams")
      return Promise.resolve(
        Response.json({ kind: "accepted", items: teams, nextCursor: null }),
      );
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  await runFungiAccountCommand(
    { action: "teams" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(refreshes).toBe(1);
  expect(requests).toEqual(["/api/v1/teams"]);
  const afterRefresh = await credentialFingerprint();
  // The refresh actually renamed a new file into place; the earlier inode is gone.
  expect(afterRefresh.ino).not.toBe(before.ino);

  // The now-valid rotated token is read straight off disk: no second
  // refresh, no second write, and only the Team list is requested again.
  await runFungiAccountCommand(
    { action: "teams" },
    { json: true, stdout, credentialPath, fetch },
  );
  expect(refreshes).toBe(1);
  expect(requests).toEqual(["/api/v1/teams", "/api/v1/teams"]);
  expect(await credentialFingerprint()).toEqual(afterRefresh);
});

for (const action of ["status", "teams", "balance"] satisfies readonly (
  "status" | "teams" | "balance"
)[]) {
  it(`${action} reports a fresh account as signed out without network access`, async () => {
    const fetch = () => Promise.reject(new Error("must not reach the Hub"));
    await runFungiAccountCommand(
      { action },
      { json: false, stdout, credentialPath, fetch },
    );
    expect(output.join("")).toBe(
      "Not signed in to Fungi. Run fungi login --provider fungi.\n",
    );
    output = [];
    await runFungiAccountCommand(
      { action },
      { json: true, stdout, credentialPath, fetch },
    );
    expect(replies()).toEqual([{ schemaVersion: 1, signedIn: false }]);
  });
}

for (const providerId of ["openai", "anthropic"] as const) {
  it(
    "account status stays about Fungi when " +
      providerId +
      " credentials are saved",
    async () => {
      await createPrivateCredentialStore(credentialPath).modify(
        providerId,
        () =>
          Promise.resolve({
            type: "oauth",
            access: "synthetic-" + providerId + "-access",
            refresh: "synthetic-" + providerId + "-refresh",
            expires: Date.now() + 3_600_000,
            clientId: "synthetic-provider-client",
            scopes: [],
          }),
      );

      await runFungiAccountCommand(
        { action: "status" },
        {
          json: false,
          stdout,
          credentialPath,
          fetch: () => Promise.reject(new Error("must not reach the Hub")),
        },
      );

      expect(output.join("")).toBe(
        "Not signed in to Fungi. Run fungi login --provider fungi.\n",
      );
      expect(await readFungiAccountStatus({ credentialPath })).toBeUndefined();
    },
  );
}
