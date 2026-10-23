import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { serve, type ServerWebSocket } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createMachineLinkPostChannel,
  machineLinkAudience,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  importSeamVerifiers,
  seamHeader,
  SeamReplayGuard,
  verifySeamRequest,
} from "@fungi.computer/seam";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  createLocalMachineEnrollmentAccount,
  privateFungiAccountOAuthProvider,
  registerFungiAccountOwner,
  signOutOwnedFungiAccount,
} from "../src/private-fungi-account.js";
import { createLocalMeshLinks } from "../src/private-local-mesh-links.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Native mesh condition timed out");
    await delay(10);
  }
}

test.each(["oauth", "oyster"] as const)(
  "%s service link uses the saved pin, shares one native connection and redials freshly",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "local-mesh-link-"));
    const path = join(root, "credentials.json");
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in keys))
      throw new Error("Expected an Ed25519 key pair");
    const encode = (bytes: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const publicKey = encode(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    const privateKey = encode(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    );
    const deviceId = "machine-fixture";
    const teamId = "team-fixture";
    const verifiers = await importSeamVerifiers({ [deviceId]: publicKey });
    const replay = new SeamReplayGuard();
    const signatures: string[] = [];
    const channels = new Map<
      ServerWebSocket,
      ReturnType<typeof createMachineLinkPostChannel>
    >();
    const failures: unknown[] = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, server) => {
        expect(request.headers.get("Authorization")).toBeNull();
        expect(new URL(request.url).pathname).toBe(
          "/api/teams/team-fixture/local/mesh/machine-fixture/connect",
        );
        await verifySeamRequest(
          verifiers,
          machineLinkAudience(teamId, deviceId),
          request.method,
          request.url,
          request.headers.get(seamHeader),
          null,
          replay,
        );
        const signature = request.headers.get(seamHeader);
        if (signature === null)
          throw new Error("Expected a signed native dial");
        signatures.push(signature);
        if (server.upgrade(request, { data: undefined })) return;
        return new Response(null, { status: 426 });
      },
      websocket: {
        open: (socket) => {
          channels.set(
            socket,
            createMachineLinkPostChannel({
              limits: {
                maxInFlight: 32,
                maxFrameBytes: 512 * 1024,
                acknowledgmentMs: 1000,
              },
              send: (frame) => {
                socket.send(frame);
              },
              receive: () => Promise.resolve("refused"),
            }),
          );
        },
        message: (socket, message) => {
          const channel = channels.get(socket);
          const text = z.string().safeParse(message);
          if (!text.success || channel === undefined)
            throw new Error("Expected an authenticated text connection");
          void channel.receive(text.data).then(
            () => undefined,
            (cause: unknown) => {
              failures.push(cause);
              socket.close(1011, "fixture frame failure");
            },
          );
        },
        close: (socket) => {
          channels.get(socket)?.close();
          channels.delete(socket);
        },
      },
    });
    const issuer = server.url.origin;
    let received = 0;
    const links = createLocalMeshLinks({
      credentialPath: path,
      receive: () => {
        received += 1;
        return Promise.resolve("refused");
      },
    });
    const releaseAccountOwner = registerFungiAccountOwner(path, () =>
      links.refresh(),
    );
    try {
      if (kind === "oauth")
        await createPrivateCredentialStore(path).modify("fungi", () =>
          Promise.resolve({
            type: "oauth",
            issuer,
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: Date.now() + 60_000,
          }),
        );
      const account = createLocalMachineEnrollmentAccount(path);
      await account.update({ kind, origin: issuer }, () => [
        {
          state: "enrolled",
          requestId: "join-fixture",
          invocationRoot: root,
          machineLabel: "Fixture",
          target: kind === "oauth" ? { kind, teamId } : { kind },
          scopeId: teamId,
          deviceId,
          publicKey,
          privateKey,
          agents: [],
          bindings: [],
        },
      ]);
      const record = (await account.read())[0]?.enrollments[0];
      if (record?.state !== "enrolled")
        throw new Error("Missing native device pin");
      const pin = { ...record, authority: { kind, origin: issuer } };
      await Promise.all([links.refresh(), links.refresh()]);
      await until(() => channels.size === 1);
      const envelope = {
        key: "opaque-mail",
        kind: "fixture",
        address: {},
        event: {},
      };
      expect(await links.deliver(pin, envelope)).toBe("refused");
      expect(signatures).toHaveLength(1);
      // Identical device, scope and private key do not authorize another
      // issuer. A pin cannot borrow this already-authenticated connection.
      const foreign = {
        ...pin,
        authority: { kind, origin: "https://another-oyster.example" },
      };
      expect(await links.isCurrent(foreign)).toBe(false);
      await assert.rejects(links.deliver(foreign, envelope), {
        reason: "closed",
      });
      expect(await links.isCurrent(pin)).toBe(true);
      expect(signatures).toHaveLength(1);
      for (const socket of channels.keys())
        socket.close(1012, "receiver restart");
      await until(() => signatures.length === 2 && channels.size === 1);
      expect(signatures[0]).not.toBe(signatures[1]);
      expect(await links.deliver(pin, envelope)).toBe("refused");
      // Removing the shared credential is the completed logout boundary. The
      // already-open connection must not retain its former authority.
      if (kind === "oauth") {
        await createPrivateCredentialStore(path).remove("fungi", () =>
          Promise.resolve(),
        );
      } else {
        expect(
          (await signOutOwnedFungiAccount(issuer, { credentialPath: path }))
            .kind,
        ).toBe("removed");
      }
      if (kind === "oauth") {
        const peer = [...channels.values()][0];
        if (peer === undefined)
          throw new Error("Expected the existing mesh link");
        expect(
          await peer.deliver({ ...envelope, key: "new-inbound-after-logout" }),
        ).toBe("refused");
      } else {
        await until(() => channels.size === 0);
      }
      expect(received).toBe(0);
      for (const socket of channels.keys())
        socket.close(1012, "restart after logout");
      await until(() => channels.size === 0);
      await delay(1100);
      expect(signatures).toHaveLength(2);
      await assert.rejects(
        links.deliver(pin, {
          ...envelope,
          key: "new-outbound-after-logout",
        }),
        { reason: "closed" },
      );
      await links.close();
      await until(() => channels.size === 0);
      expect(failures).toEqual([]);
    } finally {
      releaseAccountOwner();
      await links.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a server-refused signed device dial never opens a delivery channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-refused-device-"));
  const path = join(root, "credentials.json");
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("Expected a device key pair");
  const encode = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const publicKey = encode(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );
  const privateKey = encode(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  const deviceId = "revoked-device";
  const scopeId = "agents";
  const verifiers = await importSeamVerifiers({ [deviceId]: publicKey });
  const replay = new SeamReplayGuard();
  let refused = 0;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("Authorization")).toBeNull();
      expect(new URL(request.url).pathname).toBe(
        "/api/teams/agents/local/mesh/revoked-device/connect",
      );
      await verifySeamRequest(
        verifiers,
        machineLinkAudience(scopeId, deviceId),
        request.method,
        request.url,
        request.headers.get(seamHeader),
        null,
        replay,
      );
      refused += 1;
      // Models the HTTP refusal the standalone owner produces for a revoked
      // device. B7 owns proof of the actual Oyster revocation decision.
      return new Response(null, { status: 403 });
    },
  });
  const authority = { kind: "oyster" as const, origin: server.url.origin };
  const record = {
    state: "enrolled" as const,
    requestId: "refused-pin",
    target: { kind: "oyster" as const },
    scopeId,
    deviceId,
    publicKey,
    privateKey,
    invocationRoot: root,
    machineLabel: "Local",
    agents: [],
    bindings: [],
  };
  const links = createLocalMeshLinks({
    credentialPath: path,
    receive: () => Promise.resolve("refused"),
  });
  try {
    await createLocalMachineEnrollmentAccount(path).update(authority, () => [
      record,
    ]);
    await links.refresh();
    await until(() => refused > 0);
    await assert.rejects(
      links.deliver(
        { ...record, authority },
        {
          key: "never-admitted",
          kind: "fixture",
          address: {},
          event: {},
        },
      ),
      { reason: "closed" },
    );
  } finally {
    await links.close();
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("switching the signed-in issuer never dials one issuer with another issuer's enrollment", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-mesh-issuer-switch-"));
  const path = join(root, "credentials.json");
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("Expected a device key pair");
  const encode = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const publicKey = encode(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  );
  const privateKey = encode(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  // Each receiving Hub records which Team/device identifiers reached it, then
  // refuses; the dial path alone is the disclosure under test.
  const receiving = () => {
    const dials: string[] = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        dials.push(new URL(request.url).pathname);
        return new Response(null, { status: 403 });
      },
    });
    return { dials, server, origin: server.url.origin };
  };
  const a = receiving();
  const b = receiving();
  const dialOf = (teamId: string, deviceId: string) =>
    `/api/teams/${teamId}/local/mesh/${deviceId}/connect`;
  const enrollment = (teamId: string, deviceId: string) => ({
    state: "enrolled" as const,
    requestId: `join-${teamId}`,
    invocationRoot: root,
    machineLabel: "Fixture",
    target: { kind: "oauth" as const, teamId },
    scopeId: teamId,
    deviceId,
    publicKey,
    privateKey,
    agents: [],
    bindings: [],
  });
  // The ordinary OAuth provider path that sign-in drives.
  const signIn = async (issuer: string) => {
    const provider = privateFungiAccountOAuthProvider({
      issuer,
      credentialPath: path,
    });
    await provider.saveClientInformation({ client_id: `client-${issuer}` });
    await provider.saveTokens({
      access_token: `access-${issuer}`,
      refresh_token: `refresh-${issuer}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  };
  // The issuer refused the saved grant: the client drops tokens and client.
  const loginRefused = async (issuer: string) => {
    const provider = privateFungiAccountOAuthProvider({
      issuer,
      credentialPath: path,
    });
    if (provider.invalidateCredentials === undefined)
      throw new Error("The Fungi provider must invalidate refused grants");
    await provider.invalidateCredentials("tokens");
    await provider.invalidateCredentials("client");
  };
  // One Local service lifetime: open every saved link, observe, stop.
  const serviceRun = async (observed: () => boolean) => {
    const links = createLocalMeshLinks({
      credentialPath: path,
      receive: () => Promise.resolve("refused"),
    });
    try {
      await links.refresh();
      await until(observed);
      // Let any other saved link dial before the assertions below.
      await delay(300);
    } finally {
      await links.close();
    }
  };
  const account = createLocalMachineEnrollmentAccount(path);
  try {
    await signIn(a.origin);
    await account.update({ kind: "oauth", origin: a.origin }, (current) => [
      ...current,
      enrollment("team-a", "device-a"),
    ]);
    await serviceRun(() => a.dials.includes(dialOf("team-a", "device-a")));

    await loginRefused(a.origin);
    await signIn(b.origin);
    await account.update({ kind: "oauth", origin: b.origin }, (current) => [
      ...current,
      enrollment("team-b", "device-b"),
    ]);
    const aDialsBeforeB = a.dials.length;
    await serviceRun(() => b.dials.includes(dialOf("team-b", "device-b")));
    expect(
      b.dials.filter((dial) => dial !== dialOf("team-b", "device-b")),
    ).toEqual([]);
    expect(a.dials).toHaveLength(aDialsBeforeB);

    // Returning to A reuses A's own enrollment, and only A's.
    await loginRefused(b.origin);
    await signIn(a.origin);
    const aDialsBeforeReturn = a.dials.length;
    await serviceRun(() => a.dials.length > aDialsBeforeReturn);
    expect(
      a.dials
        .slice(aDialsBeforeReturn)
        .filter((dial) => dial !== dialOf("team-a", "device-a")),
    ).toEqual([]);
    expect(a.dials.slice(aDialsBeforeReturn)).toContain(
      dialOf("team-a", "device-a"),
    );
  } finally {
    await a.server.stop(true);
    await b.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
