import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthInteraction,
  Credential,
  Models,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runLocalAuthCli } from "../src/auth-cli.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { createPrivateModels, listPrivateModels } from "../src/local-models.js";

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
  return [
    "synthetic",
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
        },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: syntheticAccessToken(),
      refresh_token: "synthetic-rotated-refresh",
      expires_in: 60 * 60,
      id_token: "synthetic-id-token",
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

  it("completes Pi browser login through its localhost callback and persists it", async () => {
    const path = await credentialPath();
    const models = createPrivateModels(path);
    const id = providerId(models);
    const deviceId = await createPrivateCredentialStore(path).getDeviceId();
    const callback = Promise.withResolvers<Response>();
    const prompts: string[] = [];
    let exchanges = 0;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init: RequestInit | undefined) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === tokenEndpoint) {
          exchanges += 1;
          const body = init?.body;
          if (!(body instanceof URLSearchParams)) {
            throw new Error("Pi OAuth request did not use a form body");
          }
          expect(body.get("grant_type")).toBe("authorization_code");
          return tokenResponse();
        }
        return nativeFetch(input, init);
      },
    );

    const interaction: AuthInteraction = {
      signal: AbortSignal.timeout(5_000),
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        if (prompt.type !== "manual_code" || prompt.signal === undefined) {
          throw new Error("Unexpected Pi browser login prompt");
        }
        return await new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("Pi callback completed browser login"));
            },
            { once: true },
          );
        });
      },
      notify: (event) => {
        if (event.type !== "auth_url") return;
        const authorization = new URL(event.url);
        const state = authorization.searchParams.get("state");
        if (state === null) throw new Error("Pi browser login omitted state");
        void nativeFetch(
          `http://127.0.0.1:1455/auth/callback?code=synthetic-callback-code&state=${encodeURIComponent(state)}&client_id=oaiapp_synthetic`,
        ).then(callback.resolve, callback.reject);
      },
    };

    await models.login(id, "oauth", interaction, {
      getDeviceId: () => deviceId,
    });
    await expect(callback.promise).resolves.toMatchObject({ status: 200 });
    expect(prompts).toEqual(["manual_code"]);
    expect(exchanges).toBe(1);
    await expect(createPrivateModels(path).checkAuth(id)).resolves.toEqual({
      source: "OAuth",
      type: "oauth",
    });
  });

  it("accepts the full redirect URL over SSH and logs out", async () => {
    const path = await credentialPath();
    const models = createPrivateModels(path);
    const store = createPrivateCredentialStore(path);
    let authorization: URL | undefined;
    const prompts: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== tokenEndpoint)
        return Promise.reject(
          new Error("Unexpected network request in manual login test"),
        );
      return Promise.resolve(tokenResponse());
    });
    await runLocalAuthCli(
      ["login", "--provider", "openai", "--auth-type", "oauth"],
      {
        models,
        getDeviceId: () => store.getDeviceId(),
        interaction: {
          signal: AbortSignal.timeout(5_000),
          notify: (event) => {
            if (event.type === "auth_url") authorization = new URL(event.url);
          },
          prompt: (prompt) => {
            prompts.push(prompt.type);
            if (prompt.type !== "manual_code" || authorization === undefined)
              throw new Error("Unexpected OpenAI login prompt");
            const callback = new URL(
              authorization.searchParams.get("redirect_uri") ?? "",
            );
            callback.searchParams.set("code", "synthetic-manual-code");
            callback.searchParams.set(
              "state",
              authorization.searchParams.get("state") ?? "",
            );
            callback.searchParams.set("client_id", "oaiapp_synthetic");
            return Promise.resolve(callback.toString());
          },
        },
      },
    );
    expect(prompts).toEqual(["manual_code"]);
    await expect(models.checkAuth("openai")).resolves.toEqual({
      source: "OAuth",
      type: "oauth",
    });
    await models.logout("openai");
    await expect(models.checkAuth("openai")).resolves.toBeUndefined();
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

describe("private Pi ChatGPT plan composition", () => {
  it("logs in through the Local auth command, persists registration and refreshes after restart", async () => {
    const path = await credentialPath();
    const models = createPrivateModels(path);
    const store = createPrivateCredentialStore(path);
    let authorization: URL | undefined;
    const grants: string[] = [];
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== "https://auth.openai.com/api/accounts/oauth/token")
          return Promise.reject(
            new Error("Unexpected request in synthetic ChatGPT login"),
          );
        const body = init?.body;
        if (!(body instanceof URLSearchParams))
          throw new Error("Pi OAuth request did not use a form body");
        expect(body.get("client_id")).toBe("oaiapp_synthetic");
        grants.push(body.get("grant_type") ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "synthetic-chatgpt-access",
              refresh_token: "synthetic-chatgpt-refresh",
              id_token: "synthetic-id-token",
              expires_in: 3600,
              scope:
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    );
    await runLocalAuthCli(
      ["login", "--provider", "openai", "--auth-type", "oauth"],
      {
        models,
        getDeviceId: () => store.getDeviceId(),
        interaction: {
          signal: AbortSignal.timeout(5_000),
          notify: (event) => {
            if (event.type === "auth_url") authorization = new URL(event.url);
          },
          prompt: (prompt) => {
            if (prompt.type !== "manual_code" || authorization === undefined)
              throw new Error("Unexpected synthetic ChatGPT prompt");
            const callback = new URL(
              authorization.searchParams.get("redirect_uri") ?? "",
            );
            callback.searchParams.set("code", "synthetic-chatgpt-code");
            callback.searchParams.set(
              "state",
              authorization.searchParams.get("state") ?? "",
            );
            callback.searchParams.set("client_id", "oaiapp_synthetic");
            return Promise.resolve(callback.toString());
          },
        },
      },
    );
    const deviceId = await store.getDeviceId();
    expect(authorization?.searchParams.get("ext_agent_host_id")).toBe(
      `urn:uuid:${deviceId}`,
    );
    expect(authorization?.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:1455/auth/callback",
    );
    expect(authorization?.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const credential = await store.read("openai");
    expect(credential).toMatchObject({
      type: "oauth",
      clientId: "oaiapp_synthetic",
    });
    if (credential?.type !== "oauth")
      throw new Error("Synthetic login did not persist OAuth");
    expect(credential.scopes).toContain("chatgpt.tokens.use.direct");
    await store.modify("openai", () =>
      Promise.resolve({ ...credential, expires: 0 }),
    );
    const restarted = createPrivateModels(path);
    await expect(restarted.getAuth("openai")).resolves.toMatchObject({
      source: "OAuth",
    });
    await expect(restarted.checkAuth("openai")).resolves.toEqual({
      type: "oauth",
      source: "OAuth",
    });
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
    await restarted.logout("openai");
    await expect(
      createPrivateCredentialStore(path).read("openai"),
    ).resolves.toBeUndefined();
    await expect(
      createPrivateCredentialStore(path).getDeviceId(),
    ).resolves.toBe(deviceId);
  });

  it("passes the same device ID across two openai oauth logins and a logout", async () => {
    const path = await credentialPath();
    const store = createPrivateCredentialStore(path);
    const deviceId = await store.getDeviceId();
    const models = createPrivateModels(path);
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== "https://auth.openai.com/api/accounts/oauth/token")
          return Promise.reject(
            new Error("Unexpected request in synthetic ChatGPT login"),
          );
        void init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "synthetic-chatgpt-access",
              refresh_token: "synthetic-chatgpt-refresh",
              id_token: "synthetic-id-token",
              expires_in: 3600,
              scope:
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    );

    function signIn(): Promise<void> {
      let authorization: URL | undefined;
      return runLocalAuthCli(
        ["login", "--provider", "openai", "--auth-type", "oauth"],
        {
          models,
          getDeviceId: () => store.getDeviceId(),
          interaction: {
            signal: AbortSignal.timeout(5_000),
            notify: (event) => {
              if (event.type === "auth_url") authorization = new URL(event.url);
            },
            prompt: (prompt) => {
              if (prompt.type !== "manual_code" || authorization === undefined)
                throw new Error("Unexpected synthetic ChatGPT prompt");
              expect(authorization.searchParams.get("ext_agent_host_id")).toBe(
                `urn:uuid:${deviceId}`,
              );
              const callback = new URL(
                authorization.searchParams.get("redirect_uri") ?? "",
              );
              callback.searchParams.set("code", "synthetic-chatgpt-code");
              callback.searchParams.set(
                "state",
                authorization.searchParams.get("state") ?? "",
              );
              callback.searchParams.set("client_id", "oaiapp_synthetic");
              return Promise.resolve(callback.toString());
            },
          },
        },
      ).then(() => undefined);
    }

    await signIn();
    await runLocalAuthCli(["logout", "--provider", "openai"], { models });
    await expect(store.getDeviceId()).resolves.toBe(deviceId);
    await signIn();
  });
});
