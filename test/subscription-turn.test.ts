import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { normalizeContext, type OAuthCredential } from "@earendil-works/pi-ai";
import { decodeJwt, UnsecuredJWT } from "jose";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Shiitake } from "@fungi.computer/shiitake";
import { afterEach, expect, it, vi } from "vitest";
import { openAIAccessToken } from "./openai-fixtures.js";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  createPrivateLocalModelSource,
  createPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { activateSubscriptionCredential } from "../src/subscription-activation.js";
import { acquireSubscriptionTurn } from "../src/subscription-turn.js";

const fixtureCleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of fixtureCleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function openAIRefreshFixture(
  responses: readonly (() => string | Promise<string>)[],
) {
  const root = await mkdtemp(join(tmpdir(), "fungi-pi-turn-"));
  fixtureCleanup.push(() => rm(root, { recursive: true }));
  vi.stubEnv("HOME", root);
  const credentialPath = join(root, ".config/fungi/credentials.json");
  const store = createPrivateCredentialStore(credentialPath);
  const models = createPrivateModels(credentialPath);
  // Issue/pin the disposable credential in the past, then restore real time
  // before testing refresh contention. Future fake time would make a real
  // proper-lockfile mtime appear stale and invalidate the concurrency proof.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
  let refreshes = 0;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://auth.openai.com/api/accounts/oauth/token")
        throw new Error("Unexpected network request in fixture refresh");
      const body = init?.body;
      if (!(body instanceof URLSearchParams))
        throw new Error("Pi refresh did not use a form body");
      expect(body.get("grant_type")).toBe("refresh_token");
      const response = responses[refreshes++];
      if (response === undefined) throw new Error("Unexpected fixture refresh");
      const access = await response();
      return Response.json({
        access_token: access,
        refresh_token: `fixture-rotation-${String(refreshes)}`,
        expires_in: 3600,
        scope: "openid offline_access chatgpt.tokens.use.direct",
      });
    },
  );
  await store.modify("openai", () =>
    Promise.resolve({
      type: "oauth",
      access: "fixture-bootstrap",
      refresh: "fixture-bootstrap",
      expires: 0,
      clientId: "oaiapp_fixture",
    }),
  );
  await models.getAuth("openai");
  const original = await store.read("openai");
  if (original?.type !== "oauth") throw new Error("Missing fixture OAuth");
  const provider = models.getProvider("openai");
  if (provider === undefined) throw new Error("Missing OpenAI provider");
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "identity-refresh" }],
  });
  const seen: string[] = [];
  faux.setResponses([
    () => {
      seen.push("inference");
      return fauxAssistantMessage("continued");
    },
  ]);
  models.setProvider({ ...faux.provider, auth: provider.auth });
  const source = createPrivateLocalModelSource(
    models,
    "openai",
    "identity-refresh",
    "identity-fixture",
  );
  const signal = new AbortController().signal;
  const turn = await source.acquire({
    sessionId: "main",
    signal,
    preference: null,
  });
  fixtureCleanup.push(() => turn.release());
  const acquireOwnerTurn = async () => {
    const ownerTurn = await acquireSubscriptionTurn(models, "openai", signal);
    fixtureCleanup.push(() => ownerTurn.release());
    return ownerTurn;
  };
  return {
    models,
    store,
    acquireOwnerTurn,
    seen,
    refreshes: () => refreshes,
    expire: () => {
      clock.mockRestore();
      expect(original.expires <= Date.now()).toBe(true);
    },
    stream: async () => {
      if (turn.stream === undefined) throw new Error("Missing stream");
      const events = await turn.stream(
        turn.model,
        normalizeContext({ messages: [] }),
        { signal },
      );
      return await events.result();
    },
  };
}

// Realistic direct-access JWTs: issuer + subject, no workspace identity.
const identityToken = (revision: number, sub: string | number | undefined) =>
  openAIAccessToken(sub, revision);

it.each(
  [
    {
      name: "the same person",
      before: identityToken(1, "fixture-person"),
      after: identityToken(2, "fixture-person"),
      accepted: true,
    },
    {
      name: "different people",
      before: identityToken(1, "fixture-person-a"),
      after: identityToken(2, "fixture-person-b"),
      accepted: false,
    },
    {
      name: "no provable person",
      before: identityToken(1, "fixture-person"),
      after: identityToken(2, undefined),
      accepted: false,
    },
    {
      name: "malformed person identity",
      before: identityToken(1, "fixture-person"),
      after: identityToken(2, 42),
      accepted: false,
    },
    {
      name: "malformed JWT",
      before: identityToken(1, "fixture-person"),
      after: "fixture-not-a-jwt",
      accepted: false,
    },
  ].flatMap((fixture) =>
    ["shared-owner", "pinned-turn"].map((refreshBy) => ({
      ...fixture,
      refreshBy,
    })),
  ),
)(
  "maintained Pi $refreshBy refresh: $name",
  async ({ before, after, accepted, refreshBy }) => {
    const fixture = await openAIRefreshFixture([() => before, () => after]);
    fixture.expire();
    if (refreshBy === "shared-owner") await fixture.models.getAuth("openai");
    const result = await fixture.stream();
    expect(result.stopReason).toBe(accepted ? "stop" : "error");
    expect(fixture.seen.length).toBe(accepted ? 1 : 0);
    expect(fixture.refreshes()).toBe(2);
    const persisted = await fixture.store.read("openai");
    // Refusing a turn must not discard an already rotated refresh result.
    expect(persisted?.type === "oauth" && persisted.access === after).toBe(
      true,
    );
    expect(Object.hasOwn(persisted ?? {}, "accountId")).toBe(false);
  },
);

it("cancelling and releasing an in-flight turn preserves its refresh commit for a competing turn", async () => {
  const entered = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<string>();
  const fresh = identityToken(2, "fixture-person");
  const fixture = await openAIRefreshFixture([
    () => identityToken(1, "fixture-person"),
    () => {
      entered.resolve(undefined);
      return complete.promise;
    },
  ]);
  const owner = await fixture.acquireOwnerTurn();
  const other = await fixture.acquireOwnerTurn();
  fixture.expire();
  const controller = new AbortController();
  const cancelled = owner.models.getAuth("openai", {
    signal: controller.signal,
  });
  const cancellation = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  const pending: Promise<unknown>[] = [cancellation];
  try {
    await entered.promise;
    const competing = other.models.getAuth("openai");
    pending.push(competing);
    controller.abort();
    await owner.release();
    await cancellation;
    complete.resolve(fresh);
    expect((await competing)?.auth.apiKey === fresh).toBe(true);
    expect(fixture.refreshes()).toBe(2);
    const stored = await fixture.store.read("openai");
    expect(stored?.type === "oauth" && stored.access === fresh).toBe(true);
    await expect(owner.models.getAuth("openai")).rejects.toBeInstanceOf(Error);
    expect(fixture.seen).toHaveLength(0);
  } finally {
    complete.resolve(fresh);
    await Promise.all(pending);
  }
});

it("cancelling a competing turn does not cancel or duplicate the active refresh", async () => {
  const entered = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<string>();
  const fresh = identityToken(2, "fixture-person");
  const fixture = await openAIRefreshFixture([
    () => identityToken(1, "fixture-person"),
    () => {
      entered.resolve(undefined);
      return complete.promise;
    },
  ]);
  const owner = await fixture.acquireOwnerTurn();
  const other = await fixture.acquireOwnerTurn();
  fixture.expire();
  const refreshing = owner.models.getAuth("openai");
  const pending: Promise<unknown>[] = [refreshing];
  try {
    await entered.promise;
    const controller = new AbortController();
    const cancelled = other.models.getAuth("openai", {
      signal: controller.signal,
    });
    const cancellation = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    pending.push(cancellation);
    controller.abort();
    await cancellation;
    complete.resolve(fresh);
    expect((await refreshing)?.auth.apiKey === fresh).toBe(true);
    expect(fixture.refreshes()).toBe(2);
    const stored = await fixture.store.read("openai");
    expect(stored?.type === "oauth" && stored.access === fresh).toBe(true);
    expect(fixture.seen).toHaveLength(0);
  } finally {
    complete.resolve(fresh);
    await Promise.all(pending);
  }
});

it("parallel OpenAI turns adopt a shared maintained Pi refresh and continue tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-pi-parallel-refresh-"));
  vi.stubEnv("HOME", root);
  const credentialPath = join(root, ".config/fungi/credentials.json");
  const store = createPrivateCredentialStore(credentialPath);
  const models = createPrivateModels(credentialPath);
  const nativeFetch = globalThis.fetch;
  const releaseTools = Promise.withResolvers<undefined>();
  const close: (() => Promise<void>)[] = [];
  const databases: DatabaseSync[] = [];
  let refreshes = 0;
  const token = (revision: number) =>
    new UnsecuredJWT({ iss: "https://auth.openai.com", sub: "fixture-person" })
      .setIssuedAt(revision)
      .encode();
  const interceptRefresh = () => {
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== "https://auth.openai.com/api/accounts/oauth/token")
          throw new Error("Unexpected network request in fixture refresh");
        const body = init?.body;
        if (!(body instanceof URLSearchParams))
          throw new Error("Pi refresh did not use a form body");
        expect(body.get("grant_type")).toBe("refresh_token");
        refreshes++;
        return Promise.resolve(
          Response.json({
            access_token: token(refreshes),
            refresh_token: `fixture-refresh-${String(refreshes)}`,
            expires_in: 3600,
            scope: "openid offline_access chatgpt.tokens.use.direct",
          }),
        );
      },
    );
  };
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
  const restoreClock = () => {
    clock.mockRestore();
  };
  try {
    // Bootstrap through the actual OpenAI ChatGPT producer, not a refresh
    // double that spreads fields the maintained producer does not retain.
    await store.modify("openai", () =>
      Promise.resolve({
        type: "oauth",
        access: token(0),
        refresh: "fixture-bootstrap",
        expires: 0,
        clientId: "oaiapp_fixture",
      }),
    );
    interceptRefresh();
    await models.getAuth("openai");
    vi.stubGlobal("fetch", nativeFetch);
    const pinned = await store.read("openai");
    if (pinned?.type !== "oauth") throw new Error("Missing fixture OAuth");
    expect(Object.hasOwn(pinned, "accountId")).toBe(false);
    expect(refreshes).toBe(1);

    const { createPrivateLocalTools } =
      await import("../dist/private-local-runtime-host.js");
    const localTools = await createPrivateLocalTools(root);
    close.push(() => localTools.processes.close());
    const firstSeen: boolean[] = [];
    const freshSeen: boolean[] = [];
    const sessions = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const turnModels = createPrivateModels(credentialPath);
        const provider = turnModels.getProvider("openai");
        if (provider === undefined) throw new Error("Missing OpenAI provider");
        const faux = fauxProvider({
          provider: "openai",
          models: [{ id: "parallel-refresh" }],
        });
        faux.setResponses([
          async (_context, options) => {
            firstSeen.push(options?.apiKey === pinned.access);
            await releaseTools.promise;
            return fauxAssistantMessage(
              fauxToolCall("execute", { code: 'return "refresh checkpoint";' }),
              { stopReason: "toolUse" },
            );
          },
          (_context, options) => {
            freshSeen.push(options?.apiKey === token(2));
            return fauxAssistantMessage("continued after shared refresh");
          },
        ]);
        // Only inference is synthetic. Login, refresh, auth derivation and
        // store locking remain the actual registered Pi OpenAI implementation.
        turnModels.setProvider({ ...faux.provider, auth: provider.auth });
        const database = new DatabaseSync(":memory:");
        databases.push(database);
        const agent = await Shiitake.make({
          store: createPrivateSqliteOwner(database),
          extensions: localTools.extensions,
          runtime: createPrivateLocalRuntimeHost(),
          instructions: {
            load: () =>
              Promise.resolve({ revision: "refresh", text: "Use a tool." }),
          },
          model: createPrivateLocalModelSource(
            turnModels,
            "openai",
            "parallel-refresh",
            `fixture-${String(index)}`,
          ),
          tools: localTools.tools,
        });
        close.push(() => agent.close());
        const session = agent.session("main");
        await session.send("Run the checkpoint", { requestId: "checkpoint" });
        return session;
      }),
    );
    await vi.waitFor(
      () => {
        expect(firstSeen).toHaveLength(5);
      },
      {
        timeout: 10_000,
      },
    );
    // Restore real time with every turn held at its first provider response.
    // The earlier-issued pins are now expired; lock timing remains real.
    restoreClock();
    expect(pinned.expires <= Date.now()).toBe(true);
    interceptRefresh();
    await models.getAuth("openai");
    vi.stubGlobal("fetch", nativeFetch);
    const rotated = await store.read("openai");
    if (rotated?.type !== "oauth") throw new Error("Missing rotated fixture");
    expect(Object.hasOwn(rotated, "accountId")).toBe(false);
    expect(decodeJwt(pinned.access).sub === decodeJwt(rotated.access).sub).toBe(
      true,
    );
    expect(refreshes).toBe(2);
    releaseTools.resolve(undefined);
    await vi.waitFor(
      async () => {
        for (const session of sessions)
          expect((await session.read()).terminals).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const snapshots = await Promise.all(sessions.map((s) => s.read()));
    expect(
      snapshots.map((snapshot) => ({
        outcome: snapshot.terminals[0]?.outcome,
        accountRefusal:
          snapshot.terminals[0]?.diagnostic?.includes(
            "account-switched-during-turn",
          ) ?? false,
      })),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        outcome: "completed",
        accountRefusal: false,
      })),
    );
    expect(firstSeen).toEqual(Array.from({ length: 5 }, () => true));
    expect(freshSeen).toEqual(Array.from({ length: 5 }, () => true));
    for (const snapshot of snapshots)
      expect(
        snapshot.messages.some(
          (m) => m.value.role === "toolResult" && !m.value.isError,
        ),
      ).toBe(true);
  } finally {
    vi.stubGlobal("fetch", nativeFetch);
    restoreClock();
    releaseTools.resolve(undefined);
    for (const shutdown of close.reverse()) await shutdown();
    for (const database of databases) database.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true });
  }
}, 30_000);

it.each([
  { providerId: "anthropic", expire: false, lifetimeMs: 3_600_000 },
  { providerId: "anthropic", expire: false, lifetimeMs: 10_000 },
  { providerId: "anthropic", expire: true, lifetimeMs: 250 },
  { providerId: "openai", expire: false, lifetimeMs: 3_600_000 },
  { providerId: "openai", expire: false, lifetimeMs: 10_000 },
  { providerId: "openai", expire: true, lifetimeMs: 250 },
])(
  "$providerId pins an account across real tool iterations (expired after switching: $expire; lifetime: $lifetimeMs)",
  async ({ providerId, expire, lifetimeMs }) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-turn-pin-"));
    const credentialPath = join(root, ".config/fungi/credentials.json");
    const store = createPrivateCredentialStore(credentialPath);
    const access = (subject: string, marker: string) =>
      providerId === "openai"
        ? new UnsecuredJWT({
            iss: "https://auth.openai.com",
            sub: subject,
            marker,
          }).encode()
        : marker;
    const refreshed = access("account-a", "fake-turn-a-refreshed");
    const first: OAuthCredential = {
      type: "oauth",
      accountId:
        providerId === "openai" ? "shared-workspace" : "fake-account-a",
      access: access("account-a", "fake-turn-a-expired"),
      refresh: "fake-turn-a-refresh",
      expires: Date.now() - 1,
    };
    const second: OAuthCredential = {
      ...first,
      accountId:
        providerId === "openai" ? "shared-workspace" : "fake-account-b",
      access: access("account-b", "fake-turn-b"),
      refresh: "fake-turn-b-refresh",
      expires: Date.now() + 3_600_000,
    };
    await store.modify(providerId, () => Promise.resolve(first));
    const models = createPrivateModels(credentialPath);
    const faux = fauxProvider({
      provider: providerId,
      models: [{ id: "turn-pin", name: "Turn pin" }],
    });
    let refreshes = 0;
    let refreshesAtSwitch = -1;
    let vaultBefore: Buffer | undefined;
    const vaultPath = join(root, "foreign-fairy-ring-vault.json");
    const seen: boolean[] = [];
    const steps: FauxResponseStep[] = [
      async (_context, options) => {
        seen.push(options?.apiKey === refreshed);
        const active = await store.read(providerId);
        if (active?.type !== "oauth") throw new Error("missing fixture login");
        // Fairy Ring's vault is foreign to Fungi. Keep an opaque slot-map copy
        // and prove the retired account is never rotated behind its back.
        await writeFile(
          vaultPath,
          JSON.stringify({
            subscription: JSON.stringify({ [providerId]: active }),
          }),
        );
        vaultBefore = await readFile(vaultPath);
        refreshesAtSwitch = refreshes;
        await activateSubscriptionCredential(
          providerId,
          Readable.from([
            Buffer.from(
              JSON.stringify({
                expected: active,
                credential: second,
              }),
            ),
          ]),
          { credentialPath },
        );
        if (expire) {
          // A real clock and a genuinely expiring token, not fake timers.
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, active.expires - Date.now()) + 25),
          );
        }
        return fauxAssistantMessage(
          fauxToolCall("execute", { code: 'return "turn checkpoint";' }),
          { stopReason: "toolUse" },
        );
      },
    ];
    if (!expire)
      steps.push((_context, options) => {
        seen.push(options?.apiKey === refreshed);
        return fauxAssistantMessage("A finished its turn");
      });
    steps.push((_context, options) => {
      seen.push(options?.apiKey === second.access);
      return fauxAssistantMessage("B runs on the next turn");
    });
    faux.setResponses(steps);
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Expiring fake subscription",
          login: () => Promise.resolve(first),
          refresh: (credential) => {
            if (credential.accountId !== first.accountId)
              throw new Error("must not refresh a different account");
            if (
              providerId === "openai" &&
              decodeJwt(credential.access).sub !== "account-a"
            )
              throw new Error("must not refresh a different workspace seat");
            refreshes++;
            return Promise.resolve({
              ...credential,
              access: refreshed,
              expires: Date.now() + lifetimeMs,
            });
          },
          toAuth: (credential) =>
            Promise.resolve({ apiKey: credential.access }),
        },
      },
    });
    const database = new DatabaseSync(":memory:");
    const { createPrivateLocalTools } =
      await import("../dist/private-local-runtime-host.js");
    const localTools = await createPrivateLocalTools(root);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: localTools.extensions,
      runtime: createPrivateLocalRuntimeHost(),
      instructions: {
        load: () =>
          Promise.resolve({ revision: "pin", text: "Use a checkpoint." }),
      },
      model: createPrivateLocalModelSource(
        models,
        providerId,
        "turn-pin",
        "pin-fixture",
      ),
      tools: localTools.tools,
    });
    const session = agent.session("main");
    try {
      const firstTurn = await session.send("First turn", {
        requestId: "first",
      });
      await vi.waitFor(
        async () => {
          expect(
            (await session.read()).terminals.some(
              (terminal) => terminal.commandId === firstTurn.commandId,
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      const snapshot = await session.read();
      const terminal = snapshot.terminals.find(
        (t) => t.commandId === firstTurn.commandId,
      );
      expect(terminal?.outcome).toBe(expire ? "failed" : "completed");
      if (expire)
        expect(
          terminal?.diagnostic?.includes("account-switched-during-turn"),
        ).toBe(true);
      expect(
        snapshot.messages.some(
          (m) => m.value.role === "toolResult" && !m.value.isError,
        ),
      ).toBe(true);
      expect(refreshesAtSwitch).toBeGreaterThan(0);
      expect(refreshes).toBe(refreshesAtSwitch);
      expect(
        vaultBefore !== undefined &&
          (await readFile(vaultPath)).equals(vaultBefore),
      ).toBe(true);
      const next = await session.send("Next turn", { requestId: "next" });
      await vi.waitFor(
        async () => {
          expect(
            (await session.read()).terminals.some(
              (t) =>
                t.commandId === next.commandId && t.outcome === "completed",
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(seen).toEqual(expire ? [true, true] : [true, true, true]);
      const output = JSON.stringify(await session.read());
      expect(output.includes("fake-turn-")).toBe(false);
      for (const secret of [
        first.access,
        refreshed,
        second.access,
        first.refresh,
        second.refresh,
      ])
        expect(output.includes(secret)).toBe(false);
      const active = await store.read(providerId);
      expect(active?.type === "oauth" && active.access === second.access).toBe(
        true,
      );
    } finally {
      await agent.close();
      await localTools.processes.close();
      database.close();
      await rm(root, { recursive: true });
    }
  },
  20_000,
);

it.each(["anthropic", "openai"])(
  "%s refreshes an expiring credential of the same pinned account between requests",
  async (providerId) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-turn-refresh-"));
    const credentialPath = join(root, "credentials.json");
    const store = createPrivateCredentialStore(credentialPath);
    const token = (version: number) =>
      providerId === "openai"
        ? new UnsecuredJWT({
            iss: "https://auth.openai.com",
            sub: "one-person",
            version,
          }).encode()
        : `fake-same-account-${String(version)}`;
    const original: OAuthCredential = {
      type: "oauth",
      accountId: "one-account",
      access: token(0),
      refresh: "fake-same-account-refresh",
      expires: Date.now() - 1,
    };
    await store.modify(providerId, () => Promise.resolve(original));
    const models = createPrivateModels(credentialPath);
    const faux = fauxProvider({
      provider: providerId,
      models: [{ id: "refresh-turn" }],
    });
    let refreshes = 0;
    const seen: boolean[] = [];
    faux.setResponses(
      [1, 2].map(() => (_context, options) => {
        seen.push(options?.apiKey === token(refreshes));
        return fauxAssistantMessage("same account");
      }),
    );
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Real expiry fixture",
          login: () => Promise.resolve(original),
          refresh: (current) => {
            refreshes++;
            return Promise.resolve({
              ...current,
              access: token(refreshes),
              expires: Date.now() + (refreshes < 3 ? 250 : 3_600_000),
            });
          },
          toAuth: (current) => Promise.resolve({ apiKey: current.access }),
        },
      },
    });
    const signal = new AbortController().signal;
    const source = createPrivateLocalModelSource(
      models,
      providerId,
      "refresh-turn",
      "refresh",
    );
    const turn = await source.acquire({
      signal,
      sessionId: "main",
      preference: null,
    });
    try {
      if (turn.stream === undefined) throw new Error("missing stream");
      const firstStream = await turn.stream(
        turn.model,
        normalizeContext({ messages: [] }),
        { signal },
      );
      expect((await firstStream.result()).stopReason).toBe("stop");
      const before = await store.read(providerId);
      if (before?.type !== "oauth") throw new Error("missing login");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, before.expires - Date.now()) + 25),
      );
      const nextStream = await turn.stream(
        turn.model,
        normalizeContext({ messages: [] }),
        { signal },
      );
      expect((await nextStream.result()).stopReason).toBe("stop");
      const after = await store.read(providerId);
      expect(
        after?.type === "oauth" &&
          after.access !== before.access &&
          after.accountId === before.accountId,
      ).toBe(true);
      expect(refreshes).toBe(3);
      expect(seen).toEqual([true, true]);
    } finally {
      await turn.release();
      await rm(root, { recursive: true });
    }
  },
);

it.each([
  {
    name: "different workspace accounts (A vs B)",
    current: "fixture-account-b",
    accepted: true,
  },
  {
    name: "a workspace account on one side only",
    current: undefined,
    accepted: true,
  },
])(
  "the same OpenAI person (issuer + subject) with $name",
  async ({ current, accepted }) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-turn-account-"));
    fixtureCleanup.push(() => rm(root, { recursive: true }));
    vi.stubGlobal("fetch", () =>
      Promise.reject(new Error("No refresh is expected in this fixture")),
    );
    const credentialPath = join(root, ".config/fungi/credentials.json");
    const store = createPrivateCredentialStore(credentialPath);
    const person = (revision: string) =>
      new UnsecuredJWT({
        iss: "https://auth.openai.com",
        sub: "fixture-person",
        jti: revision,
      }).encode();
    // Pin in the past, then restore real time: a switch is refused once the
    // retired pin can no longer be served, never while it is still valid.
    const realNow = Date.now();
    const pinned: OAuthCredential = {
      type: "oauth",
      access: person("pinned"),
      refresh: "fixture-pinned-refresh",
      expires: realNow - 60_000,
      clientId: "oaiapp_fixture",
      accountId: "fixture-account-a",
    };
    const replacement: OAuthCredential = {
      type: "oauth",
      access: person("replacement"),
      refresh: "fixture-replacement-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "oaiapp_fixture",
    };
    if (current !== undefined) replacement.accountId = current;
    await store.modify("openai", () => Promise.resolve(pinned));
    const models = createPrivateModels(credentialPath);
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow - 3_600_000);
    const turn = await acquireSubscriptionTurn(
      models,
      "openai",
      new AbortController().signal,
    );
    clock.mockRestore();
    fixtureCleanup.push(() => turn.release());
    expect(pinned.expires <= Date.now()).toBe(true);
    await store.modify("openai", () => Promise.resolve(replacement));
    const auth = turn.models.getAuth("openai");
    if (accepted)
      expect((await auth)?.auth.apiKey === replacement.access).toBe(true);
    else
      await expect(auth).rejects.toMatchObject({
        cause: { category: "account-switched-during-turn" },
      });
  },
);
