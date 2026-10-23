import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, expect, it, vi } from "vitest";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { CredentialActivationError } from "../src/subscription-activation.js";
import {
  prepareSubscriptionIdentity,
  retainSubscriptionIdentity,
} from "../src/subscription-identity.js";
import {
  acquireSubscriptionTurn,
  registerSubscriptionTurnOwner,
} from "../src/subscription-turn.js";
import { openAIAccessToken } from "./openai-fixtures.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "fungi-identity-"));
  homes.push(home);
  const credentialPath = join(home, ".config/fungi/credentials.json");
  return {
    credentialPath,
    store: createPrivateCredentialStore(credentialPath),
  };
}

const openAICredential = (
  access = openAIAccessToken("fixture-openai-person"),
) =>
  ({
    type: "oauth",
    access,
    refresh: "fixture-openai-refresh",
    expires: Date.now() + 3_600_000,
    clientId: "oaiapp_synthetic",
    scopes: ["chatgpt.tokens.use.direct"],
  }) satisfies OAuthCredential;

it.each([
  {
    name: "the same person",
    next: openAIAccessToken("fixture-openai-person", "rotated"),
    kept: true,
  },
  {
    name: "a different person",
    next: openAIAccessToken("fixture-other-person", "rotated"),
    kept: false,
  },
  { name: "a malformed access token", next: "fixture-not-a-jwt", kept: false },
])("OpenAI Pi refresh to $name", async ({ next, kept }) => {
  const { store } = await fixture();
  await store.modify("openai", () => Promise.resolve(openAICredential()));
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== "https://auth.openai.com/api/accounts/oauth/token")
      throw new Error("Unexpected fixture network request");
    expect(
      init?.body instanceof URLSearchParams &&
        init.body.get("grant_type") === "refresh_token",
    ).toBe(true);
    requests++;
    return Promise.resolve(
      Response.json({
        access_token: next,
        refresh_token: "fixture-openai-rotated",
        expires_in: 3600,
        scope: "openid offline_access chatgpt.tokens.use.direct",
      }),
    );
  });
  registerBunOAuthFlows();
  const provider = builtinProviders().find((entry) => entry.id === "openai");
  const oauth = provider?.auth.oauth;
  if (provider === undefined || oauth === undefined)
    throw new Error("Fixture OpenAI provider missing");
  const models = createModels({ credentials: store });
  models.setProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: retainSubscriptionIdentity(oauth, "openai"),
    },
  });
  registerSubscriptionTurnOwner(models, store);
  const owner = await acquireSubscriptionTurn(
    models,
    "openai",
    new AbortController().signal,
  );
  try {
    await store.modify("openai", (current) => {
      if (current?.type !== "oauth") throw new Error("Fixture OAuth missing");
      return Promise.resolve({ ...current, expires: 0 });
    });
    const refresh = owner.models.getAuth("openai");
    if (kept) expect((await refresh)?.auth.apiKey === next).toBe(true);
    else
      await expect(refresh).rejects.toMatchObject({
        cause: { category: "account-switched-during-turn" },
      });
    const saved = await store.read("openai");
    // Rotated tokens always commit; issuer and subject decide continuity.
    expect(
      saved?.type === "oauth" &&
        saved.access === next &&
        saved.refresh === "fixture-openai-rotated",
    ).toBe(true);
    expect(Object.hasOwn(saved ?? {}, "accountId")).toBe(false);
    expect(Object.hasOwn(saved ?? {}, "id_token")).toBe(false);
    expect(requests).toBe(1);
  } finally {
    await owner.release();
  }
});

it("preparing an OpenAI person identity needs no request and no rewrite", async () => {
  const { credentialPath, store } = await fixture();
  await store.modify("openai", () => Promise.resolve(openAICredential()));
  const before = await readFile(credentialPath, "utf8");
  const inode = (await stat(credentialPath)).ino;
  await prepareSubscriptionIdentity("openai", {
    credentialPath,
    fetch: () => {
      throw new Error("OpenAI preparation must not make a request");
    },
  });
  expect((await stat(credentialPath)).ino).toBe(inode);
  expect((await readFile(credentialPath, "utf8")) === before).toBe(true);
});

it("preparing an OpenAI credential without a workspace account succeeds on its person", async () => {
  // Real Sign in with ChatGPT grants may carry no account id; the access
  // token's issuer and subject are the identity.
  const { credentialPath, store } = await fixture();
  await store.modify("openai", () => Promise.resolve(openAICredential()));
  const before = await readFile(credentialPath, "utf8");
  await expect(
    prepareSubscriptionIdentity("openai", { credentialPath }),
  ).resolves.toBeUndefined();
  expect((await readFile(credentialPath, "utf8")) === before).toBe(true);
});

it.each([
  {
    name: "a missing access subject",
    credential: () => openAICredential(openAIAccessToken(undefined)),
  },
  {
    name: "a blank access subject",
    credential: () => openAICredential(openAIAccessToken("   ")),
  },
  {
    name: "a non-string access subject",
    credential: () => openAICredential(openAIAccessToken(42)),
  },
  {
    name: "a malformed access token",
    credential: () => openAICredential("fixture-not-a-jwt"),
  },
])("OpenAI preparation fails closed for $name", async ({ credential }) => {
  const { credentialPath, store } = await fixture();
  await store.modify("openai", () => Promise.resolve(credential()));
  const before = await readFile(credentialPath, "utf8");
  await expect(
    prepareSubscriptionIdentity("openai", { credentialPath }),
  ).rejects.toEqual(new CredentialActivationError("identity-unavailable"));
  expect((await readFile(credentialPath, "utf8")) === before).toBe(true);
});
