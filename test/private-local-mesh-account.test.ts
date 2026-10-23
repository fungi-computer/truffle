import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import type { Credential } from "@earendil-works/pi-ai";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  createFungiAccountCredentialStore,
  createLocalMachineEnrollmentAccount,
  privateFungiAccountOAuthProvider,
  type FungiAccountTeam,
} from "../src/private-fungi-account.js";
import type { LocalMachineEnrollment } from "../src/private-local-mesh-record.js";
import { importSeamSigner } from "@fungi.computer/seam";

const issuer = "http://127.0.0.1:57000";
const authority = { kind: "oauth" as const, origin: issuer };
const pair = await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
]);
if (!("publicKey" in pair)) throw new Error("Expected an Ed25519 key pair");
const encode = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const pending: LocalMachineEnrollment = {
  state: "pending",
  requestId: "one-enrollment",
  target: { kind: "oauth", teamId: "team" },
  invocationRoot: "/fixture/project",
  machineLabel: "Fixture laptop",
  publicKey: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
  privateKey: encode(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  agents: [
    {
      localAgentId: "private-selector",
      databasePath: "/fixture/project/agent.sqlite",
      name: "Local",
    },
  ],
};

async function fixture(withPayer = true) {
  const root = await mkdtemp(join(tmpdir(), "mesh-account-"));
  const path = join(root, "credentials.json");
  const raw = createPrivateCredentialStore(path);
  const credential: Extract<Credential, { type: "oauth" }> & {
    issuer: string;
    team?: FungiAccountTeam;
  } = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 60_000,
    issuer,
  };
  if (withPayer)
    credential.team = {
      teamId: "team",
      handle: "fixture-team",
      name: "Fixture Team",
    };
  await raw.modify("fungi", () => Promise.resolve(credential));
  return {
    root,
    path,
    raw,
    account: createLocalMachineEnrollmentAccount(path),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

it("reopens the same pending pin through the existing account owner without rewriting a read", async () => {
  const f = await fixture();
  try {
    await f.account.update(authority, () => [pending]);
    const before = await readFile(f.path, "utf8");
    const reopened = createLocalMachineEnrollmentAccount(f.path);
    expect(await reopened.read()).toEqual([
      { ...authority, enrollments: [pending] },
    ]);
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    await importSeamSigner(`fixture:${pending.privateKey}`);
    await reopened.update(authority, (current) =>
      current.map((record): LocalMachineEnrollment => ({
        ...record,
        state: "enrolled",
        scopeId: "team",
        deviceId: "device",
        bindings: [{ selection: 0, agentId: "team-agent" }],
      })),
    );
    expect((await f.account.read())[0]?.enrollments[0]).toMatchObject({
      state: "enrolled",
      publicKey: pending.publicKey,
      privateKey: pending.privateKey,
      requestId: pending.requestId,
    });
  } finally {
    await f.close();
  }
});

it("enrollment does not require selected payer metadata or change Pi's credential view", async () => {
  const f = await fixture(false);
  try {
    expect(
      await createFungiAccountCredentialStore({
        credentialPath: f.path,
      }).read("fungi"),
    ).toBeUndefined();
    expect(await f.account.read()).toEqual([{ ...authority, enrollments: [] }]);
    await f.account.update(authority, () => [pending]);
    const before = await readFile(f.path, "utf8");
    expect(await createLocalMachineEnrollmentAccount(f.path).read()).toEqual([
      {
        ...authority,
        enrollments: [pending],
      },
    ]);
    expect(await readFile(f.path, "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

it("concurrent account and enrollment edits keep both updates under the maintained lock", async () => {
  const f = await fixture();
  try {
    const accountOwner = createFungiAccountCredentialStore({
      credentialPath: f.path,
    });
    await Promise.all([
      f.account.update(authority, () => [pending]),
      accountOwner.modify("fungi", (current) => {
        if (current?.type !== "oauth")
          throw new Error("Fixture account disappeared");
        return Promise.resolve({ ...current, access: "rotated-access" });
      }),
    ]);
    const saved = await f.raw.read("fungi");
    if (saved?.type !== "oauth") throw new Error("Fixture account disappeared");
    expect(saved.access).toBe("rotated-access");
    expect((await f.account.read())[0]?.enrollments).toEqual([pending]);
  } finally {
    await f.close();
  }
});

it("wrong issuer and removed credentials refuse rather than restoring lost custody", async () => {
  const f = await fixture();
  try {
    await expect(
      f.account.update(
        { kind: "oauth", origin: "https://another.test" },
        () => [pending],
      ),
    ).rejects.toThrow("sign-in changed");
    expect((await f.account.read())[0]?.enrollments).toEqual([]);
    await f.raw.delete("fungi");
    await expect(f.account.update(authority, () => [pending])).rejects.toThrow(
      "sign-in changed",
    );
    expect(await f.raw.read("fungi")).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("a malformed enrollment record fails decoding instead of becoming an empty enrollment", async () => {
  const f = await fixture();
  try {
    await f.account.update(authority, () => [pending]);
    const saved = z
      .record(z.string(), z.json())
      .parse(JSON.parse(await readFile(f.path, "utf8")));
    const [id] = Object.keys(saved).filter((key) => key !== "fungi");
    if (id === undefined) throw new Error("Missing the issuer's partition");
    await writeFile(
      f.path,
      JSON.stringify({
        ...saved,
        [id]: { type: "machine_enrollment", origin: issuer, enrollments: 1 },
      }),
    );
    await expect(f.account.read()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("drops a preview credential's unbound enrollments: never read, and gone after the next write", async () => {
  const f = await fixture();
  try {
    await f.raw.modify("fungi", (current) => {
      if (current?.type !== "oauth") throw new Error("Missing OAuth fixture");
      return Promise.resolve({ ...current, machineEnrollments: [pending] });
    });
    expect(await f.account.read()).toEqual([{ ...authority, enrollments: [] }]);
    await privateFungiAccountOAuthProvider({
      issuer,
      credentialPath: f.path,
    }).saveCodeVerifier("fixture-verifier");
    expect(await f.raw.read("fungi")).not.toHaveProperty("machineEnrollments");
    expect(await f.raw.read("fungi")).toMatchObject({
      codeVerifier: "fixture-verifier",
    });
  } finally {
    await f.close();
  }
});

it("partitions Fungi enrollments by issuer: only the signed-in issuer's are read, and its own return", async () => {
  const f = await fixture();
  const other = "http://127.0.0.1:57001";
  const signIn = (origin: string) =>
    f.raw.modify("fungi", (current) => {
      if (current?.type !== "oauth") throw new Error("Missing OAuth fixture");
      return Promise.resolve({ ...current, issuer: origin });
    });
  const elsewhere = { ...pending, requestId: "other-enrollment" };
  try {
    await f.account.update(authority, () => [pending]);
    await signIn(other);
    await expect(f.account.update(authority, () => [])).rejects.toThrow(
      "sign-in changed",
    );
    expect(await f.account.read()).toEqual([
      { kind: "oauth", origin: other, enrollments: [] },
    ]);
    await f.account.update({ kind: "oauth", origin: other }, (current) => [
      ...current,
      elsewhere,
    ]);
    expect(await f.account.read()).toEqual([
      { kind: "oauth", origin: other, enrollments: [elsewhere] },
    ]);
    await signIn(issuer);
    expect(await f.account.read()).toEqual([
      { ...authority, enrollments: [pending] },
    ]);
    // An empty partition leaves no record behind.
    await f.account.update(authority, () => []);
    expect(await f.account.read()).toEqual([{ ...authority, enrollments: [] }]);
    // One origin's record never mixes authority kinds.
    await expect(
      f.account.update({ kind: "oyster", origin: other }, (current) => [
        ...current,
        { ...pending, target: { kind: "oyster" } },
      ]),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("standalone and OAuth enrollments share the lock without exposing a machine record to Pi", async () => {
  const f = await fixture();
  const oyster = { kind: "oyster" as const, origin: "https://oyster.example" };
  const standalone = { ...pending, target: { kind: "oyster" as const } };
  try {
    await Promise.all([
      f.account.update(authority, () => [pending]),
      f.account.update(oyster, () => [standalone]),
      f.raw.modify("fungi", (current) => {
        if (current?.type !== "oauth") throw new Error("Missing OAuth fixture");
        return Promise.resolve({ ...current, access: "rotated-access" });
      }),
    ]);
    expect(await f.account.read()).toEqual([
      { ...authority, enrollments: [pending] },
      { ...oyster, enrollments: [standalone] },
    ]);
    expect(await f.raw.list()).toEqual([
      { providerId: "fungi", type: "oauth" },
    ]);
    expect(await f.raw.read("fungi")).toMatchObject({
      access: "rotated-access",
    });
    const before = await readFile(f.path, "utf8");
    expect(
      await createLocalMachineEnrollmentAccount(f.path).read(),
    ).toHaveLength(2);
    expect(await readFile(f.path, "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});
