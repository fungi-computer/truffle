import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  registerFungiAccountOwner,
  signOutFungiAccount,
} from "../src/private-fungi-account.js";

async function saveLogin(credentialPath: string) {
  const access = await new SignJWT({
    sub: "account-a",
    "https://fungi.computer/oauth/login": "login-a",
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new Uint8Array(32).fill(7));
  const store = createPrivateCredentialStore(credentialPath);
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
  return store;
}

it("the shared logout clears offline without starting a service", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-offline-logout-"));
  const root = capturePrivateLocalConfigRoot(home);
  try {
    const store = await saveLogin(root.credentialPath);
    const result = await signOutFungiAccount(undefined, {
      credentialPath: root.credentialPath,
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    expect(result.kind).toBe("removed");
    expect(await store.read("fungi")).toBeUndefined();
    await expect(
      stat(join(root.serviceDirectory, "service.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("the in-process owner emits after removal and before remote revocation", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-owned-logout-"));
  const root = capturePrivateLocalConfigRoot(home);
  let release: (() => void) | undefined;
  try {
    const store = await saveLogin(root.credentialPath);
    let changes = 0;
    release = registerFungiAccountOwner(root.credentialPath, async (event) => {
      expect(event).toEqual({ type: "signed-out" });
      expect(await store.read("fungi")).toBeUndefined();
      changes += 1;
    });
    const result = await signOutFungiAccount(undefined, {
      credentialPath: root.credentialPath,
      fetch: () => {
        expect(changes).toBe(1);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    expect(result.kind).toBe("removed");
    expect(changes).toBe(1);
  } finally {
    release?.();
    await rm(home, { recursive: true, force: true });
  }
});
