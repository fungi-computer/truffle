import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { sleep } from "bun";
import { UnsecuredJWT } from "jose";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { runPrivateLocalService } from "../src/private-local-service-listener.js";
import { runLocalAuthCli, type LocalAuthModels } from "../src/auth-cli.js";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { authInteractionFor } from "../src/local-login.js";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import {
  serviceDirectory,
  readServiceRecord,
} from "../src/private-local-service-discovery.js";
import { openAIAccessToken } from "./openai-fixtures.js";
import { fixtureChatGPTProvider } from "./fixture-chatgpt-provider.js";

async function withService(
  runAuth: typeof runLocalAuthCli,
  body: (
    manager: ReturnType<typeof createPrivateLocalServiceManager>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "fungi-auth-rpc-"));
  const directory = await serviceDirectory(root);
  const manager = createPrivateLocalServiceManager({ directory });
  const running = runPrivateLocalService(
    directory,
    () => {
      throw new Error("Auth must not open a Session owner");
    },
    () => Promise.resolve([]),
    runAuth,
  );
  const settled = Promise.allSettled([running]);
  const behaviour = await Promise.allSettled([
    (async () => {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await readServiceRecord(directory)) {
          ready = true;
          break;
        }
        await sleep(10);
      }
      assert.equal(ready, true);
      await body(manager);
    })(),
  ]);
  // `fungi stop` SIGTERMs the service; this listener shares the test process.
  process.emit("SIGTERM", "SIGTERM");
  const service = await settled;
  const removed = await Promise.allSettled([
    rm(root, { recursive: true, force: true }),
  ]);
  const failures: unknown[] = [];
  for (const result of [...behaviour, ...service, ...removed]) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Local auth proof or service teardown failed",
    );
}

test("native service auth carries Pi prompts without opening or stopping Session owners", async () => {
  const notifications: string[] = [];
  await withService(
    async (args, options) => {
      assert.deepEqual(args, ["login", "--provider", "synthetic"]);
      const interaction = options?.interaction;
      assert.ok(interaction);
      const answer = await interaction.prompt({
        type: "secret",
        message: "Fixture secret",
      });
      assert.equal(answer, "synthetic-only");
      interaction.notify({ type: "info", message: "Completed" });
      return { kind: "completed" as const };
    },
    async (manager) => {
      const before = await manager.status();
      await manager.auth(
        { command: "login", provider: "synthetic" },
        {
          prompt: (request) => {
            assert.equal(request.type, "secret");
            return Promise.resolve("synthetic-only");
          },
          notify: (event) => {
            if (event.type === "info") notifications.push(event.message);
          },
        },
      );
      assert.deepEqual(await manager.status(), before);
      assert.deepEqual(notifications, ["Completed"]);
    },
  );
});

test("a blank API key answered through the real runner arrives as plain 'No key entered'", async () => {
  // Pi's own OpenAI key prompt, the real runner and interactionFor; only the
  // credential store is stubbed, and it must never be reached.
  const openai = createPrivateModels()
    .getProviders()
    .find((provider) => provider.id === "openai");
  const apiKey = openai?.auth.apiKey;
  assert.ok(openai);
  const stored: string[] = [];
  const models: LocalAuthModels = {
    getProviders: () => [openai],
    checkAuth: () => Promise.resolve(undefined),
    login: async (_id, _type, interaction) => {
      if (apiKey?.login === undefined) throw new Error("No OpenAI key login");
      const credential = await apiKey.login({
        ...interaction,
        signal: interaction.signal ?? new AbortController().signal,
      });
      stored.push("reached");
      return credential;
    },
    logout: () => Promise.reject(new Error("Unexpected logout")),
  };
  await withService(
    (args, options) => runLocalAuthCli(args, { ...options, models }),
    async (manager) => {
      await assert.rejects(
        manager.auth(
          { command: "login", provider: "openai", authType: "api_key" },
          { prompt: () => Promise.resolve("  "), notify: () => undefined },
        ),
        (cause: unknown) =>
          cause instanceof Error && cause.message === "No key entered",
      );
      assert.deepEqual(stored, []);
    },
  );
});

test("native auth status crosses the service as typed provider state", async () => {
  await withService(
    (args) => {
      assert.deepEqual(args, ["status"]);
      return Promise.resolve({
        kind: "status" as const,
        providers: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            state: "unconfigured" as const,
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            state: "configured" as const,
            type: "api_key" as const,
          },
        ],
      });
    },
    async (manager) => {
      const statuses = await manager.auth(
        { command: "status" },
        { prompt: () => Promise.resolve(""), notify: () => undefined },
      );
      assert.deepEqual(statuses, {
        kind: "status",
        providers: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            state: "unconfigured",
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            state: "configured",
            type: "api_key",
          },
        ],
      });
    },
  );
});

test("cancelling an auth dialog aborts its remote operation and leaves the service alive", async () => {
  const started = Promise.withResolvers<undefined>();
  let providerAborted = false;
  await withService(
    async (_args, options) => {
      const interaction = options?.interaction;
      assert.ok(interaction);
      try {
        await interaction.prompt({ type: "manual_code", message: "Waiting" });
      } finally {
        providerAborted = interaction.signal?.aborted === true;
      }
      return { kind: "completed" as const };
    },
    async (manager) => {
      const abort = new AbortController();
      const operation = manager.auth(
        { command: "login" },
        {
          signal: abort.signal,
          prompt: (request) =>
            new Promise<string>((_resolve, reject) => {
              assert.ok(request.signal);
              request.signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("Cancelled fixture prompt"));
                },
                { once: true },
              );
              started.resolve(undefined);
            }),
          notify: () => undefined,
        },
      );
      const rejected = assert.rejects(operation, /Authentication cancelled/u);
      await started.promise;
      abort.abort();
      await rejected;
      assert.equal(providerAborted, true);
      assert.ok(await manager.status());
    },
  );
});

/**
 * The TUI's in-app /login: the real service runs the real runLocalAuthCli on
 * createPrivateModels with a fixture OAuth provider. No callback listener or
 * provider network transport runs; credential paths are explicitly isolated.
 */
async function inAppOpenAILogin(
  access = openAIAccessToken("fixture-openai-person"),
  failure?: Error,
) {
  // Never rely on HOME (Bun keeps homedir() fixed): inject explicit paths,
  // and fail if the real default credential or device-id file changes.
  const selected = capturePrivateLocalConfigRoot();
  const home = await mkdtemp(join(tmpdir(), "fungi-in-app-login-"));
  const path = join(home, ".config/fungi/credentials.json");
  const realFiles = [
    selected.credentialPath,
    selected.credentialPath + ".device-id",
  ];
  const before = await Promise.all(realFiles.map(metadata));
  let outcome:
    | Readonly<{ completed: true }>
    | Readonly<{ completed: false; cause: unknown }>
    | undefined;
  try {
    const runAuth: typeof runLocalAuthCli = (args, options) =>
      runLocalAuthCli(args, {
        ...options,
        models: createPrivateModels(path, {
          providers: [fixtureChatGPTProvider(access, failure)],
        }),
        getDeviceId: () => createPrivateCredentialStore(path).getDeviceId(),
      });
    await withService(runAuth, async (manager) => {
      outcome = await manager
        .auth(
          { command: "login", provider: "openai", authType: "oauth" },
          {
            prompt: () => Promise.reject(new Error("Fixture must not prompt")),
            notify: () => undefined,
          },
        )
        .then(
          () => ({ completed: true as const }),
          (cause: unknown) => ({ completed: false as const, cause }),
        );
    });
    const stored = await createPrivateCredentialStore(path).read("openai");
    const text = await readIfPresent(path);
    return { outcome, stored, text };
  } finally {
    await rm(home, { recursive: true, force: true });
    // Guard, metadata only: the real files must be exactly as found.
    assert.deepEqual(await Promise.all(realFiles.map(metadata)), before);
  }
}

/** The owned temp credential text, or empty when no login stored one. */
async function readIfPresent(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return "";
    throw cause;
  }
}

/** Size and mtime only; never reads a credential's contents. */
async function metadata(file: string) {
  try {
    const { size, mtimeMs } = await stat(file);
    return { size, mtimeMs };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return "absent";
    throw cause;
  }
}

test("in-app OpenAI login through the real service stores only the person grant", async () => {
  const { outcome, stored } = await inAppOpenAILogin();
  assert.deepEqual(outcome, { completed: true });
  assert.equal(Object.hasOwn(stored ?? {}, "accountId"), false);
});

test("in-app login with a real grant's claims (no workspace account) is saved by person identity", async () => {
  const { outcome, stored } = await inAppOpenAILogin();
  assert.deepEqual(outcome, { completed: true });
  assert.ok(stored?.type === "oauth");
  assert.equal(Object.hasOwn(stored, "accountId"), false);
});

test("an access token without a subject reaches the dialog as identity-unavailable with claim names only", async () => {
  const values = {
    iss: "https://fixture-issuer.example.test",
    email: "fixture-person@example.test",
    elsewhere: "fixture-account-elsewhere",
    salt: "fixture-user-salt-value",
  };
  const access = new UnsecuredJWT({
    iss: values.iss,
    email: values.email,
    chatgpt_account_id: values.elsewhere,
    "https://api.openai.com/auth": { per_user_salt: values.salt },
  }).encode();
  const { outcome, stored } = await inAppOpenAILogin(access);
  assert.ok(outcome?.completed === false);
  const cause = outcome.cause;
  assert.ok(cause instanceof Error);
  assert.equal(
    cause.message,
    "OpenAI sign-in did not identify the person (identity-unavailable: access_token.sub absent; claims: iss, email, chatgpt_account_id, https://api.openai.com/auth; auth claims: per_user_salt). Nothing was saved.",
  );
  const serialized = JSON.stringify(cause, Object.getOwnPropertyNames(cause));
  for (const value of [...Object.values(values), access])
    assert.equal(serialized.includes(value), false, "a claim value crossed");
  assert.equal(stored, undefined);
});

test("a provider callback-port refusal reaches the dialog without binding a port", async () => {
  const { outcome, stored } = await inAppOpenAILogin(
    openAIAccessToken("fixture-openai-person"),
    new Error("Port 1455 is in use"),
  );
  assert.ok(outcome?.completed === false);
  assert.ok(outcome.cause instanceof Error);
  assert.equal(
    outcome.cause.message,
    "The sign-in callback port is in use, probably by another sign-in or the Codex CLI. Close it and try again.",
  );
  assert.equal(stored, undefined);
});

test("Pi's real token-request refusal crosses auth RPC as status only", async () => {
  registerBunOAuthFlows();
  const oauth = builtinProviders().find((provider) => provider.id === "openai")
    ?.auth.oauth;
  assert.ok(oauth);
  const marker = "fixture-token-response-body-must-not-cross";
  const nativeFetch = globalThis.fetch;
  let requests = 0;
  let failure: unknown;
  try {
    globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = input instanceof Request ? input.url : input.toString();
        assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
        assert.ok(init?.body instanceof URLSearchParams);
        assert.equal(init.body.get("grant_type"), "refresh_token");
        requests++;
        return Promise.resolve(new Response(marker, { status: 403 }));
      },
      nativeFetch,
    );
    // Pi's refresh and code exchange share requestToken. Reach that real
    // unpatched implementation without starting its OAuth callback server.
    failure = await oauth
      .refresh(
        {
          type: "oauth",
          access: openAIAccessToken("fixture-openai-person"),
          refresh: "fixture-refresh",
          expires: 0,
          clientId: "oaiapp_synthetic",
        },
        AbortSignal.timeout(5_000),
      )
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
  } finally {
    globalThis.fetch = nativeFetch;
  }
  assert.equal(requests, 1);
  assert.ok(failure instanceof Error);
  assert.equal(
    failure.message,
    `OpenAI OAuth token request failed (403): ${marker}`,
  );
  const { outcome, stored } = await inAppOpenAILogin(
    openAIAccessToken("fixture-openai-person"),
    failure,
  );
  assert.ok(outcome?.completed === false);
  const cause = outcome.cause;
  assert.ok(cause instanceof Error);
  assert.ok("failure" in cause);
  const serialized = JSON.stringify({
    failure: cause.failure,
    message: cause.message,
    stack: cause.stack,
  });
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('"status":403'), true);
  assert.deepEqual(cause.failure, {
    category: "token-exchange-rejected",
    status: 403,
  });
  assert.equal(
    cause.message,
    "OpenAI refused the sign-in token exchange (HTTP 403).",
  );
  assert.equal(stored, undefined);
});

test("an embedded Pi token-error prefix remains unknown and does not expose its suffix", async () => {
  const marker = "fixture-embedded-error-body";
  const { outcome } = await inAppOpenAILogin(
    openAIAccessToken("fixture-openai-person"),
    new Error(
      `Other provider: OpenAI OAuth token request failed (403): ${marker}`,
    ),
  );
  assert.ok(outcome?.completed === false);
  const cause = outcome.cause;
  assert.ok(cause instanceof Error && "failure" in cause);
  assert.deepEqual(cause.failure, { category: "unknown", errorName: "Error" });
  assert.equal(
    cause.message,
    "Local authentication failed (unknown: Error). Nothing was saved.",
  );
  assert.equal(
    JSON.stringify({
      failure: cause.failure,
      message: cause.message,
      stack: cause.stack,
    }).includes(marker),
    false,
  );
});

test("Pi's Anthropic browser sign-in opens the paste dialog through the service, and a blank paste is a typed failure", async () => {
  // Regression (spore 0.4.0): Pi 1.3's 86-character paste prompt broke the
  // Whistle 60-character title contract, the dialog refused it, and the
  // person saw only "Local authentication failed" with nowhere to paste.
  const credentials = await mkdtemp(join(tmpdir(), "fungi-anthropic-auth-"));
  const host = createWhistleInteractionHost({ title: "Sign in" });
  const session = host.begin();
  const asked: string[] = [];
  const unsubscribe = host.subscribe(() => {
    const pending = host.snapshot().prompt;
    if (pending === undefined || asked.length > pending.sequence) return;
    asked.push(pending.request.message);
    const request = pending.request;
    queueMicrotask(() => {
      host.answer(
        pending.sequence,
        request.type === "choice" ? (request.options[0]?.value ?? "") : "",
      );
    });
  });
  try {
    await withService(
      (args, options) =>
        runLocalAuthCli(args, {
          ...options,
          credentialPath: join(credentials, "credentials.json"),
        }),
      async (manager) => {
        await assert.rejects(
          manager.auth(
            { command: "login", provider: "anthropic", authType: "oauth" },
            authInteractionFor(session.interaction),
          ),
          (cause: unknown) =>
            cause instanceof Error &&
            "failure" in cause &&
            JSON.stringify(cause.failure) ===
              JSON.stringify({ category: "missing-authorization-code" }) &&
            cause.message ===
              "No authorization code was found in what was pasted. Paste the code or the full redirect URL.",
        );
      },
    );
  } finally {
    unsubscribe();
    await rm(credentials, { recursive: true, force: true });
  }
  assert.equal(asked.length, 2);
  assert.equal(asked[1], "Paste the sign-in code or redirect URL");
  assert.ok(host.snapshot().handoff?.url.startsWith("https://claude.ai/"));
});

test("a provider question the person's dialog cannot show is a typed prompt failure", async () => {
  await withService(
    async (_args, options) => {
      const interaction = options?.interaction;
      assert.ok(interaction);
      await interaction.prompt({ type: "text", message: "Fixture question" });
      return { kind: "completed" as const };
    },
    async (manager) => {
      await assert.rejects(
        manager.auth(
          { command: "login", provider: "synthetic" },
          {
            prompt: () =>
              Promise.reject(new Error("fixture-presenter-secret-marker")),
            notify: () => undefined,
          },
        ),
        (cause: unknown) =>
          cause instanceof Error &&
          "failure" in cause &&
          JSON.stringify(cause.failure) ===
            JSON.stringify({ category: "prompt-failed" }) &&
          !cause.message.includes("fixture-presenter-secret-marker"),
      );
    },
  );
});
