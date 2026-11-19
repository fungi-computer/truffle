import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, expect, it, vi } from "vitest";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { retainSubscriptionIdentity } from "../src/subscription-identity.js";
import {
  acquireSubscriptionTurn,
  registerSubscriptionTurnOwner,
} from "../src/subscription-turn.js";
import { openAIAccessToken } from "./openai-fixtures.js";
import { openPrivateModels } from "../src/local-models.js";

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

it("seven Anthropic turns adopt one opaque grant rotation without an account switch", async () => {
  const { store } = await fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
  const original: OAuthCredential = {
    type: "oauth",
    access: "fixture-anthropic-access",
    refresh: "fixture-anthropic-refresh",
    expires: Date.now() + 3_600_000,
  };
  await store.modify("anthropic", () => Promise.resolve(original));
  const provider = builtinProviders().find((entry) => entry.id === "anthropic");
  if (provider?.auth.oauth === undefined) throw new Error("Missing Anthropic");
  let refreshes = 0;
  const models = createModels({ credentials: store });
  models.setProvider({
    ...provider,
    auth: {
      oauth: retainSubscriptionIdentity(
        {
          ...provider.auth.oauth,
          refresh: () => {
            refreshes++;
            // Pi's Anthropic refresh returns no profile/account identity.
            return Promise.resolve({
              type: "oauth",
              access: `fixture-rotated-access-${String(refreshes)}`,
              refresh: `fixture-rotated-refresh-${String(refreshes)}`,
              expires: Date.now() + 3_600_000,
            });
          },
        },
        "anthropic",
      ),
    },
  });
  registerSubscriptionTurnOwner(models, store);
  const turns = await Promise.all(
    Array.from({ length: 7 }, () =>
      acquireSubscriptionTurn(
        models,
        "anthropic",
        new AbortController().signal,
      ),
    ),
  );
  try {
    clock.mockRestore();
    const results = await Promise.allSettled(
      turns.map((turn) => turn.models.getAuth("anthropic")),
    );
    expect(refreshes).toBe(1);
    expect(results.map((result) => result.status)).toEqual(
      Array.from({ length: 7 }, () => "fulfilled"),
    );
    expect(turns.every((turn) => turn.refusal() === undefined)).toBe(true);
  } finally {
    await Promise.all(turns.map((turn) => turn.release()));
  }
});

const anthropicSuccess = () =>
  new Response(
    [
      {
        type: "message_start",
        message: {
          id: "fixture-message",
          type: "message",
          role: "assistant",
          content: [],
          model: "fixture-model",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

it.each([false, true])(
  "seven Anthropic 401s share a refresh and retry once (second 401: %s)",
  async (rejectAgain) => {
    const { store, credentialPath } = await fixture();
    const original: OAuthCredential = {
      type: "oauth",
      access: "sk-ant-oat-fixture-original",
      refresh: "fixture-refresh-original",
      expires: Date.now() + 3_600_000,
    };
    await store.modify("anthropic", () => Promise.resolve(original));
    let refreshes = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(
        input instanceof Request ? input.url : String(input),
        init,
      );
      expect(request.url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(await request.json()).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: original.refresh,
      });
      refreshes++;
      return Response.json({
        access_token: "sk-ant-oat-fixture-rotated",
        refresh_token: "fixture-refresh-rotated",
        expires_in: 3600,
      });
    });
    const models = await openPrivateModels(credentialPath);
    const model = models.getModels("anthropic")[0];
    if (model === undefined) throw new Error("Missing fixture model");
    const turns = await Promise.all(
      Array.from({ length: 7 }, () =>
        acquireSubscriptionTurn(
          models,
          "anthropic",
          new AbortController().signal,
        ),
      ),
    );
    const allFirstRequests = Promise.withResolvers<undefined>();
    let firstRequests = 0;
    let retriedRequests = 0;
    const inference: typeof fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = new Request(
          input instanceof Request ? input.url : String(input),
          init,
        );
        const authorization = request.headers.get("authorization");
        if (authorization === `Bearer ${original.access}`) {
          firstRequests++;
          if (firstRequests === 7) allFirstRequests.resolve(undefined);
          await allFirstRequests.promise;
        } else {
          expect(authorization).toBe("Bearer sk-ant-oat-fixture-rotated");
          retriedRequests++;
          if (!rejectAgain) return anthropicSuccess();
        }
        return Response.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "Fixture expired token",
            },
          },
          { status: 401 },
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    try {
      const results = await Promise.all(
        turns.map((turn) =>
          turn.models.completeSimple(
            model,
            { messages: [] },
            {
              fetch: inference,
              maxRetries: 0,
            },
          ),
        ),
      );
      expect(refreshes).toBe(1);
      expect(firstRequests).toBe(7);
      expect(retriedRequests).toBe(7);
      expect(results.map((result) => result.stopReason)).toEqual(
        Array.from({ length: 7 }, () => (rejectAgain ? "error" : "stop")),
      );
      expect(turns.every((turn) => turn.refusal() === undefined)).toBe(true);
    } finally {
      await Promise.all(turns.map((turn) => turn.release()));
    }
  },
);

it("a cancelled 401 recovery commits its rotated token without replaying inference", async () => {
  const { store, credentialPath } = await fixture();
  await store.modify("anthropic", () =>
    Promise.resolve({
      type: "oauth",
      access: "sk-ant-oat-fixture-original",
      refresh: "fixture-original",
      expires: Date.now() + 3_600_000,
    }),
  );
  const models = await openPrivateModels(credentialPath);
  const model = models.getModels("anthropic")[0];
  if (model === undefined) throw new Error("Missing fixture model");
  const controller = new AbortController();
  const turn = await acquireSubscriptionTurn(
    models,
    "anthropic",
    controller.signal,
  );
  let refreshes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    refreshes++;
    controller.abort();
    await turn.release();
    return Response.json({
      access_token: "sk-ant-oat-fixture-rotated",
      refresh_token: "fixture-rotated",
      expires_in: 3600,
    });
  });
  let requests = 0;
  try {
    const result = await turn.models.completeSimple(
      model,
      { messages: [] },
      {
        signal: controller.signal,
        maxRetries: 0,
        fetch: Object.assign(
          () => {
            requests++;
            return Promise.resolve(
              Response.json({ error: "fixture refused" }, { status: 401 }),
            );
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      },
    );
    expect(result.stopReason).toBe("aborted");
    expect(requests).toBe(1);
    expect(refreshes).toBe(1);
    expect(await store.read("anthropic")).toMatchObject({
      access: "sk-ant-oat-fixture-rotated",
      refresh: "fixture-rotated",
    });
  } finally {
    await turn.release();
  }
});

it.each([
  "other-status",
  "switch",
  "logout",
  "api-key",
  "cancel",
  "refresh-failure",
])("Anthropic recovery does not replay after %s", async (scenario) => {
  const { store, credentialPath } = await fixture();
  const original: OAuthCredential = {
    type: "oauth",
    access: "sk-ant-oat-fixture-original",
    refresh: "fixture-original",
    expires: Date.now() + 3_600_000,
  };
  await store.modify("anthropic", () =>
    Promise.resolve(
      scenario === "api-key"
        ? { type: "api_key", key: "fixture-api-key" }
        : original,
    ),
  );
  let refreshes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    refreshes++;
    return Promise.resolve(
      Response.json({ error: "fixture refresh refused" }, { status: 400 }),
    );
  });
  const models = await openPrivateModels(credentialPath);
  const model = models.getModels("anthropic")[0];
  if (model === undefined) throw new Error("Missing fixture model");
  const controller = new AbortController();
  const turn = await acquireSubscriptionTurn(
    models,
    "anthropic",
    controller.signal,
  );
  let requests = 0;
  try {
    const result = await turn.models.completeSimple(
      model,
      { messages: [] },
      {
        signal: controller.signal,
        maxRetries: 0,
        fetch: Object.assign(
          async () => {
            requests++;
            if (scenario === "switch")
              await store.modify("anthropic", () =>
                Promise.resolve({
                  ...original,
                  access: "sk-ant-oat-fixture-other",
                  refresh: "fixture-other",
                }),
              );
            if (scenario === "logout") await store.delete("anthropic");
            if (scenario === "cancel") controller.abort();
            return Response.json(
              {
                type: "error",
                error: {
                  type: "authentication_error",
                  message: "Fixture refusal",
                },
              },
              { status: scenario === "other-status" ? 403 : 401 },
            );
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      },
    );
    expect(result.stopReason).toBe(scenario === "cancel" ? "aborted" : "error");
    expect(requests).toBe(1);
    expect(refreshes).toBe(scenario === "refresh-failure" ? 1 : 0);
    if (scenario === "switch" || scenario === "logout")
      expect(turn.refusal()?.category).toBe("account-switched-during-turn");
  } finally {
    await turn.release();
  }
});

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
