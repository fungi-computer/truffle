import { PassThrough } from "node:stream";
import type {
  ApiKeyCredential,
  AuthInteraction,
  Models,
  OAuthCredential,
  Provider,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";

import { localLoginProviders } from "../src/local-login.js";
import { createPrivateModels } from "../src/local-models.js";

import { runLocalAuthCli, type LocalAuthCliOptions } from "../src/auth-cli.js";

type AuthModels = Pick<
  Models,
  "checkAuth" | "getProviders" | "login" | "logout"
>;

function outputHarness() {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

function oauthCredential(): OAuthCredential {
  return {
    access: "synthetic-access",
    expires: 0,
    refresh: "synthetic-refresh",
    type: "oauth",
  };
}

function apiKeyCredential(): ApiKeyCredential {
  return { key: "synthetic-api-key", type: "api_key" };
}

const noAuth = () => Promise.resolve(undefined);

function provider(id: string, auth: Provider["auth"], name = id): Provider {
  const faux = fauxProvider({ provider: id });
  return { ...faux.provider, name, auth };
}

function options(
  models: AuthModels,
  interaction?: AuthInteraction,
): LocalAuthCliOptions {
  const harness = outputHarness();
  return interaction === undefined
    ? { models, output: harness.output }
    : { models, output: harness.output, interaction };
}

describe("Local auth CLI", () => {
  describe("API key prompt", () => {
    function keyLogin(answer: string) {
      const stored: ApiKeyCredential[] = [];
      const providerLogin = vi.fn(
        async (auth: AuthInteraction): Promise<ApiKeyCredential> => {
          const key = await auth.prompt({
            type: "secret",
            message: "Enter OpenAI API key",
          });
          return { key, type: "api_key" };
        },
      );
      const login = vi.fn<AuthModels["login"]>(async (_id, _type, auth) => {
        const credential = await providerLogin(auth);
        stored.push(credential);
        return credential;
      });
      const notices: string[] = [];
      const interaction: AuthInteraction = {
        prompt: vi.fn(() => Promise.resolve(answer)),
        notify: vi.fn((event: Parameters<AuthInteraction["notify"]>[0]) => {
          if (event.type === "info") notices.push(event.message);
        }),
      };
      const models: AuthModels = {
        getProviders: () => [
          provider("openai", {
            apiKey: {
              name: "OpenAI API key",
              login: providerLogin,
              resolve: noAuth,
            },
          }),
        ],
        checkAuth: vi.fn(),
        login,
        logout: vi.fn(),
      };
      const run = runLocalAuthCli(
        ["login", "--provider", "openai", "--auth-type", "api_key"],
        options(models, interaction),
      );
      return { run, stored, notices };
    }

    it.each(["", "   ", "\t\n"])(
      "refuses a blank API key (%j) with No key entered and stores nothing",
      async (blank) => {
        const { run, stored, notices } = keyLogin(blank);
        await expect(run).rejects.toThrow("No key entered");
        expect(stored).toEqual([]);
        expect(notices.join("\n")).not.toContain("login complete");
      },
    );

    it("still completes with a non-empty API key", async () => {
      const { run, stored, notices } = keyLogin("synthetic-api-key");
      await run;
      expect(stored).toEqual([{ key: "synthetic-api-key", type: "api_key" }]);
      expect(notices.join("\n")).toContain("login complete");
    });
  });

  it("selects among actual providers and dispatches API-key login", async () => {
    const providerLogin = vi.fn(() => Promise.resolve(apiKeyCredential()));
    const providers = [
      provider("ambient", {
        apiKey: { name: "Ambient credentials", resolve: noAuth },
      }),
      provider(
        "synthetic",
        {
          apiKey: {
            name: "Synthetic API key",
            login: providerLogin,
            resolve: noAuth,
          },
        },
        "Synthetic",
      ),
    ];
    const prompts: string[] = [];
    const interaction: AuthInteraction = {
      prompt: vi.fn((prompt: Parameters<AuthInteraction["prompt"]>[0]) => {
        prompts.push(prompt.type);
        if (prompt.type !== "select")
          throw new Error("unexpected secret prompt");
        return Promise.resolve(
          prompt.options.find((option) => option.id === "synthetic")?.id ??
            "api_key",
        );
      }),
      notify: vi.fn(),
    };
    const login = vi.fn((...args: Parameters<Models["login"]>) => {
      void args;
      return providerLogin();
    });
    const models: AuthModels = {
      getProviders: () => providers,
      checkAuth: vi.fn(),
      login,
      logout: vi.fn(),
    };

    await runLocalAuthCli(["login"], options(models, interaction));

    expect(prompts).toEqual(["select"]);
    expect(login).toHaveBeenCalledOnce();
    expect(login.mock.calls[0]?.[0]).toBe("synthetic");
    expect(login.mock.calls[0]?.[1]).toBe("api_key");
  });

  it("dispatches an explicitly selected Pi OAuth method and accepts device-code spelling", async () => {
    const providerLogin = vi.fn(
      async (auth: AuthInteraction): Promise<OAuthCredential> => {
        await expect(
          auth.prompt({
            message: "Choose OAuth method",
            options: [
              { id: "browser", label: "Browser" },
              { id: "device_code", label: "Device code" },
            ],
            type: "select",
          }),
        ).resolves.toBe("device_code");
        await expect(
          auth.prompt({
            message: "Choose account",
            options: [{ id: "account-a", label: "Account A" }],
            type: "select",
          }),
        ).resolves.toBe("account-a");
        return oauthCredential();
      },
    );
    const login = vi.fn<AuthModels["login"]>((_id, _type, auth) =>
      providerLogin(auth),
    );
    const interaction: AuthInteraction = {
      prompt: vi.fn((prompt: Parameters<AuthInteraction["prompt"]>[0]) => {
        if (prompt.type !== "select") throw new Error("unexpected text prompt");
        const option = prompt.options[0];
        if (option === undefined) throw new Error("no synthetic prompt choice");
        return Promise.resolve(option.id);
      }),
      notify: vi.fn(),
    };
    const models: AuthModels = {
      getProviders: () => [
        provider("openai", {
          oauth: {
            name: "OpenAI",
            login: providerLogin,
            refresh: vi.fn(),
            toAuth: vi.fn(),
          },
        }),
      ],
      checkAuth: vi.fn(),
      login,
      logout: vi.fn(),
    };

    await runLocalAuthCli(
      [
        "login",
        "--provider",
        "openai",
        "--auth-type",
        "oauth",
        "--method",
        "device-code",
      ],
      options(models, interaction),
    );

    expect(login).toHaveBeenCalledWith(
      "openai",
      "oauth",
      expect.any(Object),
      expect.any(Object),
    );
    expect(login.mock.calls[0]?.[3]?.getDeviceId).toBeTypeOf("function");
    expect(login.mock.calls[0]?.[3]?.agentName).toBe("Shiitake");
  });

  it("stamps the resolved provider's display name onto an auth_url notice", async () => {
    const notified: unknown[] = [];
    const providerLogin = vi.fn((auth: AuthInteraction) => {
      auth.notify({ type: "auth_url", url: "https://example.com/authorize" });
      return Promise.resolve(oauthCredential());
    });
    const login = vi.fn<AuthModels["login"]>((_id, _type, auth) =>
      providerLogin(auth),
    );
    const interaction: AuthInteraction = {
      prompt: vi.fn(() => Promise.reject(new Error("no prompt expected"))),
      notify: vi.fn((event) => {
        notified.push(event);
      }),
    };
    const models: AuthModels = {
      getProviders: () => [
        provider(
          "openai",
          {
            oauth: {
              name: "OpenAI (ChatGPT subscription)",
              login: providerLogin,
              refresh: vi.fn(),
              toAuth: vi.fn(),
            },
          },
          "OpenAI",
        ),
      ],
      checkAuth: vi.fn(),
      login,
      logout: vi.fn(),
    };

    await runLocalAuthCli(
      ["login", "--provider", "openai", "--auth-type", "oauth"],
      options(models, interaction),
    );

    // The provider's own oauth.login() only ever hands this one auth_url
    // event to interaction.notify(); `login()` must augment it with the
    // provider's display name before it reaches the caller's interaction.
    expect(notified[0]).toEqual({
      type: "auth_url",
      url: "https://example.com/authorize",
      providerLabel: "ChatGPT for Shiitake",
    });
  });

  it("reports ambient-only API-key providers without attempting a login", async () => {
    const harness = outputHarness();
    const login = vi.fn();
    const models: AuthModels = {
      getProviders: () => [
        provider("ambient", {
          apiKey: { name: "Environment", resolve: noAuth },
        }),
      ],
      checkAuth: vi.fn(),
      login,
      logout: vi.fn(),
    };

    await expect(
      runLocalAuthCli(
        ["login", "--provider", "ambient", "--auth-type", "api_key"],
        { models, output: harness.output },
      ),
    ).rejects.toThrow("No credential was changed");
    expect(login).not.toHaveBeenCalled();
    expect(harness.text()).toContain("ambient credentials");
    expect(harness.text()).toContain("No credential was changed");
  });

  it("enumerates safe checkAuth metadata for every provider", async () => {
    const harness = outputHarness();
    const checkAuth = vi.fn((id: string) =>
      Promise.resolve(
        id === "ready"
          ? { type: "oauth" as const, source: "OAuth" }
          : undefined,
      ),
    );
    const models: AuthModels = {
      getProviders: () => [
        provider("ready", {
          oauth: {
            name: "Ready",
            login: () => Promise.resolve(oauthCredential()),
            refresh: vi.fn(),
            toAuth: vi.fn(),
          },
        }),
        provider("missing", {
          apiKey: { name: "Missing", resolve: noAuth },
        }),
      ],
      checkAuth,
      login: vi.fn(),
      logout: vi.fn(),
    };

    const statuses = await runLocalAuthCli(["status"], {
      models,
      output: harness.output,
    });

    expect(checkAuth).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual({
      kind: "status",
      providers: [
        {
          providerId: "ready",
          providerName: "ready",
          state: "configured",
          type: "oauth",
        },
        {
          providerId: "missing",
          providerName: "missing",
          state: "unconfigured",
        },
      ],
    });
    // Signed-in providers are listed; the rest collapse into one summary.
    expect(harness.text()).toContain("ready: signed in (subscription)");
    expect(harness.text()).toContain("1 other providers not signed in");
    expect(harness.text()).not.toContain("missing");
    expect(harness.text()).not.toContain("OAuth");
  });

  it("logs out only of a signed-in provider, and says so when there is none", async () => {
    const harness = outputHarness();
    const logout = vi.fn(() => Promise.resolve());
    const prompted = vi.fn();
    const models: AuthModels = {
      getProviders: () => [
        provider("first", { apiKey: { name: "First", resolve: noAuth } }),
        provider("second", { apiKey: { name: "Second", resolve: noAuth } }),
      ],
      checkAuth: vi.fn(() => Promise.resolve(undefined)),
      login: vi.fn(),
      logout,
    };
    await runLocalAuthCli(["logout"], {
      models,
      output: harness.output,
      interaction: { prompt: prompted, notify: vi.fn() },
    });
    expect(prompted).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    const offered: string[] = [];
    await runLocalAuthCli(["logout"], {
      models: {
        ...models,
        checkAuth: vi.fn((id: string) =>
          Promise.resolve(
            id === "second" ? { type: "api_key" as const } : undefined,
          ),
        ),
      },
      output: harness.output,
      interaction: {
        prompt: (prompt) => {
          if (prompt.type === "select")
            offered.push(...prompt.options.map((option) => option.id));
          return Promise.resolve("second");
        },
        notify: vi.fn(),
      },
    });
    expect(offered).toEqual(["second"]);
    expect(logout).toHaveBeenCalledWith("second", expect.any(Object));
  });

  it("limits status to an explicitly selected provider", async () => {
    const checkAuth = vi.fn(() => Promise.resolve(undefined));
    const models: AuthModels = {
      getProviders: () => [
        provider("first", {
          apiKey: { name: "First", resolve: noAuth },
        }),
        provider("second", {
          apiKey: { name: "Second", resolve: noAuth },
        }),
      ],
      checkAuth,
      login: vi.fn(),
      logout: vi.fn(),
    };

    await runLocalAuthCli(["status", "--provider", "second"], {
      models,
      output: new PassThrough(),
    });

    expect(checkAuth).toHaveBeenCalledOnce();
    expect(checkAuth).toHaveBeenCalledWith("second", expect.any(Object));
  });

  it("cancels a superseded provider prompt without cancelling the login", async () => {
    const promptController = new AbortController();
    const promptStarted = Promise.withResolvers<undefined>();
    const cancelled = new Error("callback completed");
    const notify = vi.fn();
    const interaction: AuthInteraction = {
      prompt: (prompt) => {
        promptStarted.resolve(undefined);
        return new Promise<string>((_resolve, reject) => {
          const signal = prompt.signal;
          if (signal === undefined) throw new Error("Missing prompt signal");
          if (signal.aborted) reject(cancelled);
          else
            signal.addEventListener(
              "abort",
              () => {
                reject(cancelled);
              },
              {
                once: true,
              },
            );
        });
      },
      notify,
    };
    const login: AuthModels["login"] = async (_provider, _type, supplied) => {
      const pending = supplied.prompt({
        type: "manual_code",
        message: "Paste the callback code",
        signal: promptController.signal,
      });
      const rejected = expect(pending).rejects.toBe(cancelled);
      await promptStarted.promise;
      promptController.abort(cancelled);
      await rejected;
      expect(supplied.signal?.aborted).toBe(false);
      return oauthCredential();
    };
    const models: AuthModels = {
      getProviders: () => [
        provider("synthetic", {
          oauth: {
            name: "Synthetic OAuth",
            login: () => Promise.resolve(oauthCredential()),
            refresh: vi.fn(),
            toAuth: vi.fn(),
          },
        }),
      ],
      checkAuth: vi.fn(),
      login,
      logout: vi.fn(),
    };
    await runLocalAuthCli(
      ["login", "--provider", "synthetic", "--auth-type", "oauth"],
      options(models, interaction),
    );
    expect(notify).toHaveBeenCalledWith({
      type: "info",
      message: "synthetic login complete.",
    });
  });

  it("honors cancellation and removes signal listeners", async () => {
    const listeners = new Map<string, () => void>();
    const signals = {
      once: (name: NodeJS.Signals, listener: () => void) =>
        listeners.set(name, listener),
      removeListener: (name: NodeJS.Signals) => listeners.delete(name),
    };
    const interaction: AuthInteraction = {
      prompt: vi.fn(
        (prompt: Parameters<AuthInteraction["prompt"]>[0]) =>
          new Promise<string>((_resolve, reject) => {
            const signal = prompt.signal;
            if (signal?.aborted) {
              reject(new Error("cancelled"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          }),
      ),
      notify: vi.fn(),
    };
    const models: AuthModels = {
      getProviders: () => [
        provider("synthetic", {
          apiKey: {
            name: "Synthetic",
            login: () => Promise.resolve(apiKeyCredential()),
            resolve: noAuth,
          },
        }),
      ],
      checkAuth: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    };
    const completion = runLocalAuthCli(["login"], {
      ...options(models, interaction),
      signals,
    });
    listeners.get("SIGINT")?.();
    await expect(completion).rejects.toBeDefined();
    expect(listeners.size).toBe(0);
  });
});

it("CLI offers Anthropic methods in the same registry order as /login", async () => {
  const providers = createPrivateModels()
    .getProviders()
    .filter((one) => one.id === "anthropic");
  const [entry] = localLoginProviders(providers);
  expect(entry?.methods.map((method) => method.kind)).toEqual([
    "api_key",
    "subscription",
  ]);
  const prompts: unknown[] = [];
  const models: AuthModels = {
    getProviders: () => providers,
    checkAuth: noAuth,
    login: () => Promise.resolve(apiKeyCredential()),
    logout: () => Promise.resolve(),
  };
  await runLocalAuthCli(
    ["login", "--provider", "anthropic"],
    options(models, {
      prompt: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve("api_key");
      },
      notify: () => undefined,
    }),
  );
  expect(prompts).toEqual([
    expect.objectContaining({
      type: "select",
      options: entry?.methods.map((method) => ({
        id: method.kind === "subscription" ? "oauth" : "api_key",
        label: method.label,
      })),
    }),
  ]);
});
