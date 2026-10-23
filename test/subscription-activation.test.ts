import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createModels,
  createProvider,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createPrivateModels,
  registerPrivateBundledModelOAuthFlows,
} from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  activateSubscriptionCredential,
  CredentialActivationError,
} from "../src/subscription-activation.js";
import {
  prepareSubscriptionIdentity,
  retainSubscriptionIdentity,
} from "../src/subscription-identity.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true })),
  );
});
const first = {
  type: "oauth",
  access: "fake-first-access",
  refresh: "fake-first-refresh",
  expires: Date.now() + 3_600_000,
} satisfies OAuthCredential;
const second = {
  ...first,
  access: "fake-second-access",
  refresh: "fake-second-refresh",
};
const bytes = (expected: OAuthCredential | null, credential: OAuthCredential) =>
  Readable.from([Buffer.from(JSON.stringify({ expected, credential }))]);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fungi-activation-"));
  homes.push(home);
  const credentialPath = join(home, ".config/fungi/credentials.json");
  return {
    credentialPath,
    store: createPrivateCredentialStore(credentialPath),
  };
}

it("atomically replaces only the selected subscription under the store lock", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("openai", () => Promise.resolve(first));
  await activateSubscriptionCredential("anthropic", bytes(null, first), {
    credentialPath,
  });
  await activateSubscriptionCredential("anthropic", bytes(first, second), {
    credentialPath,
  });
  expect(await store.read("anthropic")).toEqual(second);
  expect(await store.read("openai")).toEqual(first);
  expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
});

it("a concurrent owner refresh wins; stale activation fails closed without secret diagnostics", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("anthropic", () => Promise.resolve(second));
  const before = await readFile(credentialPath, "utf8");
  await expect(
    activateSubscriptionCredential("anthropic", bytes(first, first), {
      credentialPath,
    }),
  ).rejects.toThrow("Credential activation: conflict");
  expect(await readFile(credentialPath, "utf8")).toBe(before);
  for (const payload of [
    Buffer.from('{"expected":"fake-secret-invalid-json'),
    Buffer.from(
      JSON.stringify({ expected: null, credential: { access: "fake-secret" } }),
    ),
    Buffer.alloc(256 * 1024 + 1, 120),
  ]) {
    await expect(
      activateSubscriptionCredential("anthropic", Readable.from([payload]), {
        credentialPath,
      }),
    ).rejects.toEqual(new CredentialActivationError("invalid-input"));
  }
});

it("the same running Models owner picks up the new credential on its next request", async () => {
  const { credentialPath, store } = await fixture();
  const models = createModels({ credentials: store });
  models.setProvider(
    createProvider({
      id: "anthropic",
      name: "Fake subscription",
      models: [],
      auth: {
        oauth: {
          name: "Fake OAuth",
          login: () => Promise.resolve(first),
          refresh: () => {
            throw new Error("unexpired fake credential must not refresh");
          },
          toAuth: (credential) =>
            Promise.resolve({ apiKey: credential.access }),
        },
      },
      api: {
        stream() {
          throw new Error("not used");
        },
        streamSimple() {
          throw new Error("not used");
        },
      },
    }),
  );
  await models.login("anthropic", "oauth", {
    signal: new AbortController().signal,
    notify() {
      throw new Error("fake login emits no notifications");
    },
    prompt() {
      throw new Error("fake login needs no prompts");
    },
  });
  expect(
    (await models.getAuth("anthropic"))?.auth.apiKey === first.access,
  ).toBe(true);
  await activateSubscriptionCredential("anthropic", bytes(first, second), {
    credentialPath,
  });
  expect(
    (await models.getAuth("anthropic"))?.auth.apiKey === second.access,
  ).toBe(true);
});

it("two activators cannot both replace the same observed credential", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("openai", () => Promise.resolve(first));
  const results = await Promise.allSettled([
    activateSubscriptionCredential("openai", bytes(first, second), {
      credentialPath,
    }),
    activateSubscriptionCredential("openai", bytes(first, second), {
      credentialPath,
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
});

it("an expired subscription refresh overlaps activation under the real owner's lock without a stale overwrite", async () => {
  const { credentialPath, store } = await fixture();
  const expired = {
    ...first,
    expires: Date.now() - 1,
    accountId: "fake-owner-account",
  };
  await store.modify("anthropic", () => Promise.resolve(expired));
  const started = Promise.withResolvers<undefined>();
  const respond = Promise.withResolvers<undefined>();
  let requests = 0;
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      // Only the transport is substituted: Pi's real Anthropic refresh decodes
      // the response and persists it through the owner's real credential store.
      expect(url === "https://platform.claude.com/v1/oauth/token").toBe(true);
      const decoded: unknown = JSON.parse(z.string().parse(init?.body));
      const request = z
        .object({
          grant_type: z.literal("refresh_token"),
          refresh_token: z.string(),
        })
        .parse(decoded);
      expect(request.refresh_token === expired.refresh).toBe(true);
      requests++;
      started.resolve(undefined);
      await respond.promise;
      return Response.json({
        access_token: "fake-real-owner-refreshed",
        refresh_token: "fake-real-owner-rotated",
        expires_in: 28800,
      });
    });
  try {
    registerPrivateBundledModelOAuthFlows();
    const models = createPrivateModels(credentialPath);
    const auth = models.getAuth("anthropic");
    await started.promise;
    const submitted = Promise.withResolvers<undefined>();
    const input = Readable.from([
      Buffer.from(JSON.stringify({ expected: expired, credential: second })),
    ]);
    input.once("end", () => {
      submitted.resolve(undefined);
    });
    const activation = activateSubscriptionCredential("anthropic", input, {
      credentialPath,
    }).then(
      () => "committed",
      (error: unknown) => {
        if (error instanceof CredentialActivationError) return error.category;
        throw error;
      },
    );
    await submitted.promise;
    // Activation has consumed its complete payload while the actual OAuth
    // refresh is awaiting its response and still owns the native writer lock.
    const waiting = await store.read("anthropic");
    expect(
      waiting?.type === "oauth" && waiting.expires === expired.expires,
    ).toBe(true);
    respond.resolve(undefined);
    expect((await auth)?.auth.apiKey === "fake-real-owner-refreshed").toBe(
      true,
    );
    expect(await activation).toBe("conflict");
    const current = await store.read("anthropic");
    expect(
      current?.type === "oauth" &&
        current.access === "fake-real-owner-refreshed" &&
        current.refresh === "fake-real-owner-rotated",
    ).toBe(true);
    expect(
      current?.type === "oauth" && current.accountId === expired.accountId,
    ).toBe(true);
    expect(requests).toBe(1);
  } finally {
    respond.resolve(undefined);
    fetch.mockRestore();
  }
});

it("Anthropic import preparation persists profile identity and retains it across owner refresh", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("anthropic", () => Promise.resolve(first));
  let profiles = 0;
  await prepareSubscriptionIdentity("anthropic", {
    credentialPath,
    fetch: (url, init) => {
      expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
      expect(
        new Headers(init?.headers).get("Authorization") ===
          `Bearer ${first.access}`,
      ).toBe(true);
      profiles++;
      return Promise.resolve(
        Response.json({
          account: { uuid: "00000000-0000-4000-8000-000000000001" },
        }),
      );
    },
  });
  expect(profiles).toBe(1);
  const current = await store.read("anthropic");
  if (current?.type !== "oauth") throw new Error("fixture login missing");
  const owner = retainSubscriptionIdentity(
    {
      name: "Fake refresh",
      login: () => Promise.resolve(first),
      refresh: () => Promise.resolve(second),
      toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
    },
    "anthropic",
  );
  expect(
    (await owner.refresh(current, new AbortController().signal)).accountId,
  ).toBe("00000000-0000-4000-8000-000000000001");
});

it("unavailable or malformed account identity never mutates the credential or echoes payloads", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("anthropic", () => Promise.resolve(first));
  for (const response of [
    Response.json({ account: { uuid: { access: "fake-profile-secret" } } }),
    new Response("fake-profile-secret", { status: 403 }),
  ]) {
    await expect(
      prepareSubscriptionIdentity("anthropic", {
        credentialPath,
        fetch: () => Promise.resolve(response),
      }),
    ).rejects.toEqual(new CredentialActivationError("identity-unavailable"));
    const saved = await store.read("anthropic");
    expect(saved?.type === "oauth" && saved.access === first.access).toBe(true);
  }
});
