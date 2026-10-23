import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, Models } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalAuthCli } from "../src/auth-cli.js";
import { fixtureChatGPTProvider } from "./fixture-chatgpt-provider.js";

import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { createPrivateModels, listPrivateModels } from "../src/local-models.js";
import { openAIAccessToken } from "./openai-fixtures.js";

const tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token";
const nativeFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.stubGlobal("fetch", nativeFetch);
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function credentialPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-openai-"));
  temporaryDirectories.push(directory);
  return join(directory, "credentials.json");
}

function providerId(models: Models): string {
  const provider = models.getProvider("openai");
  if (provider === undefined) throw new Error("OpenAI provider is absent");
  return provider.id;
}

function syntheticAccessToken(): string {
  return openAIAccessToken("synthetic-person");
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: syntheticAccessToken(),
      refresh_token: "synthetic-rotated-refresh",
      expires_in: 60 * 60,
      scope: "openid offline_access chatgpt.tokens.use.direct",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function syntheticExpiredCredential(): Credential {
  return {
    type: "oauth",
    access: syntheticAccessToken(),
    refresh: "synthetic-expired-refresh",
    expires: 0,
    clientId: "oaiapp_synthetic",
    scopes: ["chatgpt.tokens.use.direct"],
  };
}

describe("private Pi OpenAI composition", () => {
  it("forwards the same owned device ID through login, logout and a new login", async () => {
    const path = await credentialPath();
    const store = createPrivateCredentialStore(path);
    const provider = fixtureChatGPTProvider();
    const oauth = provider.auth.oauth;
    if (oauth === undefined) throw new Error("Fixture OAuth missing");
    const seen: (string | undefined)[] = [];
    const models = createPrivateModels(path, {
      providers: [
        {
          ...provider,
          auth: {
            oauth: {
              ...oauth,
              login: async (interaction, options) => {
                seen.push(options?.getDeviceId?.());
                return oauth.login(interaction, options);
              },
            },
          },
        },
      ],
    });
    const signIn = () =>
      runLocalAuthCli(
        ["login", "--provider", "openai", "--auth-type", "oauth"],
        {
          models,
          getDeviceId: () => store.getDeviceId(),
          interaction: {
            signal: AbortSignal.timeout(5_000),
            notify: () => undefined,
            prompt: () => Promise.reject(new Error("Fixture must not prompt")),
          },
        },
      );
    await signIn();
    await runLocalAuthCli(["logout", "--provider", "openai"], { models });
    await signIn();
    expect(seen).toEqual([
      await store.getDeviceId(),
      await store.getDeviceId(),
    ]);
  });
  it("registers Claude Sonnet 5.5 for the Local model picker and execution", async () => {
    const models = createPrivateModels();
    const selected = models.getModel("anthropic", "claude-sonnet-5-5");
    expect(selected).toMatchObject({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      api: "anthropic-messages",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
    });
    expect(selected?.thinkingLevelMap?.off).toBeNull();
    expect(selected?.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsMidConvoEffort: true,
      supportsTemperature: false,
    });
    expect(
      (await listPrivateModels(await credentialPath())).find(
        (choice) =>
          choice.providerId === "anthropic" &&
          choice.id === "claude-sonnet-5-5",
      ),
    ).toMatchObject({
      name: "Claude Sonnet 5.5",
      providerName: "Anthropic",
      reasoning: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("projects maintained provider identity and auth metadata into choices", async () => {
    const choices = await listPrivateModels(await credentialPath());
    const openai = choices.find(
      ({ providerId, id }) => providerId === "openai" && id === "gpt-5.6-sol",
    );
    expect(openai).toMatchObject({
      providerId: "openai",
      providerName: "OpenAI",
      id: "gpt-5.6-sol",
    });
    expect(openai?.reasoning).not.toContain("off");
    expect(
      choices
        .filter(({ providerId }) => providerId === "openai")
        .map(({ id }) => id),
    ).toEqual(
      expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]),
    );
    const models = createPrivateModels();
    expect(models.getProvider("openai")?.auth.oauth).toBeDefined();
    expect(models.getProvider("openai-codex")).toBeUndefined();
    expect(choices.some((choice) => choice.providerId === "openai-codex")).toBe(
      false,
    );
    expect(models.getProvider("openai")?.auth.apiKey).toBeDefined();
  });

  it("offers only the logins Veil's provider policy allows locally", () => {
    const anthropic = createPrivateModels().getProvider("anthropic");
    // Claude Pro/Max OAuth is offered the way Pi and OpenCode offer it.
    expect(anthropic?.auth.oauth).toBeDefined();
    expect(anthropic?.auth.apiKey).toBeDefined();
    expect(anthropic?.getModels().length).toBeGreaterThan(0);
  });

  it("lets Pi refresh an expired credential and persist it for a fresh models instance", async () => {
    const path = await credentialPath();
    const firstModels = createPrivateModels(path);
    const id = providerId(firstModels);
    await createPrivateCredentialStore(path).modify(id, () =>
      Promise.resolve(syntheticExpiredCredential()),
    );
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init: RequestInit | undefined) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== tokenEndpoint) {
          return Promise.reject(
            new Error("Unexpected network request in Pi refresh test"),
          );
        }
        refreshes += 1;
        const body = init?.body;
        if (!(body instanceof URLSearchParams)) {
          return Promise.reject(
            new Error("Pi OAuth refresh did not use a form body"),
          );
        }
        expect(body.get("grant_type")).toBe("refresh_token");
        return Promise.resolve(tokenResponse());
      },
    );

    await expect(firstModels.getAuth(id)).resolves.toMatchObject({
      source: "OAuth",
    });
    const restartedModels = createPrivateModels(path);
    await expect(restartedModels.getAuth(id)).resolves.toMatchObject({
      source: "OAuth",
    });
    expect(refreshes).toBe(1);
  });
});
