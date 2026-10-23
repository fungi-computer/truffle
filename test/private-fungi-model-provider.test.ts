import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModelSource, memoryHost } from "@fungi.computer/shiitake/testing";
import type { ModelPreference } from "@fungi.computer/shiitake/model-preference";
import { createPrivateModels, listPrivateModels } from "../src/local-models.js";
import {
  createFungiAccountCredentialStore,
  switchFungiAccountTeam,
} from "../src/private-fungi-account.js";
import { createFungiModelProvider } from "../src/private-fungi-model-provider.js";
import {
  createPrivateLocalModelSource,
  openPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function signedIn() {
  const root = await mkdtemp(join(tmpdir(), "fungi-models-"));
  roots.push(root);
  const path = join(root, "credentials.json");
  await createPrivateCredentialStore(path).modify("fungi", () =>
    Promise.resolve({
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 900_000,
      issuer: "https://hub.test",
      clientId: "local-client",
      team: { teamId: "team-1", name: "Garden", handle: "garden" },
      teamCount: 2,
    }),
  );
  return path;
}

function refusedRefresh(url: string): Response | undefined {
  const path = new URL(url).pathname;
  if (path.startsWith("/.well-known/oauth-protected-resource"))
    return Response.json({
      resource: "https://hub.test/api/teams",
      authorization_servers: ["https://hub.test/api/auth"],
    });
  if (path.startsWith("/.well-known/oauth-authorization-server"))
    return Response.json({
      issuer: "https://hub.test/api/auth",
      authorization_endpoint: "https://hub.test/api/auth/oauth2/authorize",
      token_endpoint: "https://hub.test/api/auth/oauth2/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  if (path === "/api/auth/oauth2/token")
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  return undefined;
}

const catalog = {
  object: "list",
  data: [
    {
      id: "@fungi/luna",
      object: "model",
      created: 0,
      owned_by: "fungi",
      name: "Luna",
      provider_id: "openai/gpt-6-luna",
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      reasoning_levels: ["low", "medium", "high"],
      input: ["text"],
      default: true,
      cost: {
        input: 0.115,
        output: 0.575,
        cacheRead: 0.0115,
        cacheWrite: 0.14375,
      },
    },
  ],
};

it.each(["explicit", "fallback"] as const)(
  "observes context with an empty authenticated Fungi catalog (%s) without preparing a model",
  async (selection) => {
    const path = await signedIn();
    const requested: string[] = [];
    const credentials = createFungiAccountCredentialStore({
      credentialPath: path,
    });
    const credentialRead = vi.spyOn(credentials, "read");
    const models = createModels({ credentials });
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json(catalog));
    });
    models.setProvider(
      createFungiModelProvider({
        credentialPath: path,
      }),
    );
    expect(models.getModels("fungi")).toEqual([]);
    const refresh = vi.spyOn(models, "refresh");
    const checkAuth = vi.spyOn(models, "checkAuth");
    const getAuth = vi.spyOn(models, "getAuth");
    const local = createPrivateLocalModelSource(
      models,
      selection === "explicit" ? "fungi" : undefined,
      selection === "explicit" ? "@fungi/luna" : undefined,
      "context-observation",
    );
    const describe = local.describe;
    if (describe === undefined) throw new Error("Local description is missing");
    // Seed real settled context with the credential-free maintained faux source.
    // All footer descriptions still go through the real Local model owner.
    const seeded = fauxModelSource([fauxAssistantMessage("Settled context.")]);
    const acquire = vi.spyOn(seeded, "acquire");
    const host = await memoryHost({
      model: { acquire: seeded.acquire, describe },
    });
    try {
      const session = host.agent.session("observational-context");
      await session.send("Keep context.", { requestId: "seed-context" });
      await host.settle("observational-context");
      expect(acquire).toHaveBeenCalledTimes(1);
      const snapshot = await session.read();
      expect(snapshot.context?.tokens).toBeGreaterThan(0);
      expect(refresh).not.toHaveBeenCalled();
      expect(checkAuth).not.toHaveBeenCalled();
      expect(getAuth).not.toHaveBeenCalled();
      expect(credentialRead).not.toHaveBeenCalled();
      expect(requested).toEqual([]);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(snapshot.context?.window).toBeNull();
      expect(models.getModels("fungi")).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

it("observes changing Agent defaults and Session overrides from acquired catalog facts without auth", async () => {
  const path = await signedIn();
  const fetch = vi.fn(() =>
    Promise.resolve(
      Response.json({
        ...catalog,
        data: [
          ...catalog.data,
          {
            ...catalog.data[0],
            id: "@fungi/small",
            name: "Small",
            context_window: 30_000,
            max_output_tokens: 1_000,
            default: false,
          },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const models = createPrivateModels(path);
  let agent: ModelPreference | null = {
    providerId: "fungi",
    modelId: "@fungi/luna",
  };
  const source = createPrivateLocalModelSource(
    models,
    undefined,
    undefined,
    "observed-default",
    undefined,
    { agent: () => agent },
  );
  const describe = source.describe;
  if (describe === undefined) throw new Error("Local description is missing");
  const input = {
    sessionId: "observed-default",
    preference: null,
    signal: new AbortController().signal,
  };
  const refresh = vi.spyOn(models, "refresh");
  const checkAuth = vi.spyOn(models, "checkAuth");
  const acquired = await source.acquire(input);
  try {
    expect(acquired.model.id).toBe("@fungi/luna");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkAuth).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await acquired.release();
  }
  refresh.mockClear();
  checkAuth.mockClear();
  fetch.mockClear();
  await expect(describe(input)).resolves.toEqual({ contextWindow: 1_050_000 });
  agent = { providerId: "fungi", modelId: "@fungi/small" };
  await expect(describe(input)).resolves.toEqual({ contextWindow: 30_000 });
  await expect(
    describe({
      ...input,
      preference: { providerId: "fungi", modelId: "@fungi/luna" },
    }),
  ).resolves.toEqual({ contextWindow: 1_050_000 });
  await expect(
    describe({
      ...input,
      preference: { providerId: "fungi", modelId: "@fungi/not-discovered" },
    }),
  ).resolves.toEqual({ contextWindow: null });
  // A populated catalog is not evidence that a fallback provider is signed in.
  agent = null;
  await expect(describe(input)).resolves.toEqual({ contextWindow: null });
  expect(refresh).not.toHaveBeenCalled();
  expect(checkAuth).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  agent = { providerId: "fungi", modelId: "@fungi/small" };
  const next = await source.acquire(input);
  try {
    expect(next.model.id).toBe("@fungi/small");
    expect(next.model.contextWindow).toBe(30_000);
  } finally {
    await next.release();
  }
});

it("lists the refreshed hosted catalog through the signed-in Team, using Hub limits and prices", async () => {
  const path = await signedIn();
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-access",
      );
      return Promise.resolve(Response.json(catalog));
    },
  );
  const models = createPrivateModels(path);
  expect(models.getProvider("fungi")?.name).toBe("Fungi");
  const result = await models.refresh({ providers: ["fungi"] });
  expect([...result.errors]).toEqual([]);
  expect(models.getModel("fungi", "@fungi/luna")).toMatchObject({
    baseUrl: "https://hub.test/api/v1/teams/team-1",
    provider: "fungi",
    api: "openai-completions",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: catalog.data[0]?.cost,
    default: true,
  });
  expect(await listPrivateModels(path)).toContainEqual({
    providerId: "fungi",
    providerName: "Fungi",
    id: "@fungi/luna",
    name: "Luna",
    reasoning: ["low", "medium", "high"],
  });
  expect(requested).toEqual([
    "https://hub.test/api/v1/teams/team-1/models",
    "https://hub.test/api/v1/teams/team-1/models",
  ]);
});

function answer() {
  return new Response(
    [
      `data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

for (const [code, status, expected] of [
  ["invalid_token", 401, "Sign in to Fungi again"],
  ["insufficient_scope", 403, "Sign in to Fungi again"],
  ["insufficient_quota", 429, "Add credits to Garden"],
  ["subscription_required", 429, "Add credits to Garden"],
  ["paused", 503, "Fungi models are paused"],
] satisfies [string, number, string][]) {
  it(`keeps ${code} on Fungi with an actionable transcript refusal and no supplier fallback`, async () => {
    const path = await signedIn();
    const requested: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const refresh = refusedRefresh(url);
      if (refresh) return Promise.resolve(refresh);
      return Promise.resolve(
        url.endsWith("/models")
          ? Response.json(catalog)
          : Response.json(
              { error: { code, message: "Original Hub refusal" } },
              { status },
            ),
      );
    });
    const models = createPrivateModels(path);
    const refreshed = await models.refresh({ providers: ["fungi"] });
    expect([...refreshed.errors]).toEqual([]);
    const model = models.getModel("fungi", "@fungi/luna");
    if (model === undefined) throw new Error("Fixture Fungi model missing");
    const result = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(expected);
    expect(
      requested.filter((url) => url.endsWith("/oauth2/token")),
    ).toHaveLength(status === 401 ? 1 : 0);
    expect(
      requested.filter((url) => new URL(url).pathname.startsWith("/api/v1/")),
    ).toEqual([
      "https://hub.test/api/v1/teams/team-1/models",
      "https://hub.test/api/v1/teams/team-1/chat/completions",
    ]);
  });
}

it("streams a Fungi reply with usage through Pi's real completion API", async () => {
  const path = await signedIn();
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-access",
      );
      expect(init?.redirect).toBe("error");
      return Promise.resolve(
        url.endsWith("/models") ? Response.json(catalog) : answer(),
      );
    },
  );
  const models = createPrivateModels(path);
  expect([...(await models.refresh({ providers: ["fungi"] })).errors]).toEqual(
    [],
  );
  const model = models.getModel("fungi", "@fungi/luna");
  if (model === undefined) throw new Error("Fixture Fungi model missing");
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
  });
  expect(result).toMatchObject({
    provider: "fungi",
    model: "@fungi/luna",
    stopReason: "stop",
    content: [{ type: "text", text: "OK" }],
    usage: { input: 10, output: 1 },
  });
});

it("reports an unreachable Fungi catalog rather than silently returning other providers", async () => {
  const path = await signedIn();
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("Fixture network unavailable")),
  );
  await expect(listPrivateModels(path)).rejects.toThrow("Fungi is unreachable");
  const models = createPrivateModels(path);
  const error = (await models.refresh({ providers: ["fungi"] })).errors.get(
    "fungi",
  );
  expect(error?.message).toContain("Fungi is unreachable");
  expect(models.getModels("fungi")).toEqual([]);
});

it("Veil denies killed Fungi logins and stops an already-registered provider before dispatch", async () => {
  const path = await signedIn();
  let calls = 0;
  vi.stubGlobal("fetch", () => {
    calls += 1;
    return Promise.resolve(Response.json(catalog));
  });
  const models = createPrivateModels(path);
  expect([...(await models.refresh({ providers: ["fungi"] })).errors]).toEqual(
    [],
  );
  const model = models.getModel("fungi", "@fungi/luna");
  if (model === undefined) throw new Error("Fixture Fungi model missing");
  vi.stubEnv("FUNGI_SUBSCRIPTION_KILL", "fungi");
  expect(createPrivateModels(path).getProvider("fungi")).toBeUndefined();
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  expect(result.errorMessage).toContain("Fungi models are paused");
  expect(calls).toBe(1);
});

it("keeps an unreachable model dispatch on Fungi with actionable text", async () => {
  const path = await signedIn();
  const requested: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    return url.endsWith("/models")
      ? Promise.resolve(Response.json(catalog))
      : Promise.reject(new Error("Fixture network unavailable"));
  });
  const models = createPrivateModels(path);
  expect([...(await models.refresh({ providers: ["fungi"] })).errors]).toEqual(
    [],
  );
  const model = models.getModel("fungi", "@fungi/luna");
  if (model === undefined) throw new Error("Fixture Fungi model missing");
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Fungi is unreachable");
  expect(requested).toEqual([
    "https://hub.test/api/v1/teams/team-1/models",
    "https://hub.test/api/v1/teams/team-1/chat/completions",
  ]);
});

it("opens an explicitly selected Fungi model after refreshing its live catalog", async () => {
  const path = await signedIn();
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json(catalog)));
  const models = createPrivateModels(path);
  expect(models.getModel("fungi", "@fungi/luna")).toBeUndefined();
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: dirname(path),
      providerId: "fungi",
      modelId: "@fungi/luna",
    },
    models,
  );
  try {
    expect(
      await host.effectiveModel("main", AbortSignal.timeout(5_000)),
    ).toMatchObject({
      providerId: "fungi",
      providerName: "Fungi",
      modelId: "@fungi/luna",
      modelName: "Luna",
    });
  } finally {
    await host.close();
  }
});

it("uses the current selected Team for both dispatch and its credit refusal after a Team switch", async () => {
  const path = await signedIn();
  const requested: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    return Promise.resolve(
      url.endsWith("/models")
        ? Response.json(catalog)
        : Response.json(
            {
              error: { code: "insufficient_quota", message: "Missing credit" },
            },
            { status: 429 },
          ),
    );
  });
  const models = createPrivateModels(path);
  expect([...(await models.refresh({ providers: ["fungi"] })).errors]).toEqual(
    [],
  );
  const model = models.getModel("fungi", "@fungi/luna");
  if (model === undefined) throw new Error("Fixture Fungi model missing");
  await switchFungiAccountTeam("team-2", {
    credentialPath: path,
    fetch: () =>
      Promise.resolve(
        Response.json({
          kind: "accepted",
          items: [{ teamId: "team-2", name: "Orchard", handle: "orchard" }],
          nextCursor: null,
        }),
      ),
  });
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  expect(result.errorMessage).toContain("Add credits to Orchard");
  expect(requested).toEqual([
    "https://hub.test/api/v1/teams/team-1/models",
    "https://hub.test/api/v1/teams/team-2/chat/completions",
  ]);
});

it("uses the Hub default for a new Agent and preserves explicit and saved model choices", async () => {
  const path = await signedIn();
  const liveCatalog = {
    ...catalog,
    data: [
      { ...catalog.data[0], default: false },
      { ...catalog.data[0], id: "@fungi/sol", name: "Sol", default: true },
    ],
  };
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json(liveCatalog)));
  const models = createPrivateModels(path);
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: dirname(path),
    },
    models,
  );
  try {
    expect(
      await host.effectiveModel("main", AbortSignal.timeout(5_000)),
    ).toMatchObject({ providerId: "fungi", modelId: "@fungi/sol" });
    await host.session.modelPreference.set({
      providerId: "fungi",
      modelId: "@fungi/luna",
    });
    expect(
      await host.effectiveModel("main", AbortSignal.timeout(5_000)),
    ).toMatchObject({ modelId: "@fungi/luna" });
    const explicit = createPrivateLocalModelSource(
      models,
      "fungi",
      "@fungi/luna",
      "explicit",
    );
    const acquisition = await explicit.acquire({
      sessionId: "main",
      preference: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(acquisition.model.id).toBe("@fungi/luna");
    await acquisition.release();
  } finally {
    await host.close();
  }
});

it("keeps an explicit Fungi choice when unreachable and retries there after recovery", async () => {
  const path = await signedIn();
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("Fixture network unavailable")),
  );
  const models = createPrivateModels(path);
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: dirname(path),
      providerId: "fungi",
      modelId: "@fungi/luna",
    },
    models,
  );
  try {
    const status = await host.effectiveModel(
      "main",
      AbortSignal.timeout(5_000),
    );
    expect(status.providerId).toBe("fungi");
    expect(status.credential.source).toContain("Fungi models are unavailable");
    const source = createPrivateLocalModelSource(
      models,
      "fungi",
      undefined,
      "unreachable",
    );
    await expect(
      source.acquire({
        sessionId: "main",
        preference: null,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow("Fungi models are unavailable");
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json(catalog)));
    expect(
      await host.effectiveModel("main", AbortSignal.timeout(5_000)),
    ).toMatchObject({ providerId: "fungi", modelId: "@fungi/luna" });
    const acquired = await source.acquire({
      sessionId: "main",
      preference: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(acquired.model.provider).toBe("fungi");
    await acquired.release();
  } finally {
    await host.close();
  }
});

it("refuses signed-out Fungi dispatch even when an explicit alternative is available", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-default-signed-out-"));
  roots.push(root);
  const models = createPrivateModels(join(root, "credentials.json"));
  const source = createPrivateLocalModelSource(
    models,
    "fungi",
    undefined,
    "signed-out",
  );
  await expect(
    source.acquire({
      sessionId: "main",
      preference: null,
      signal: AbortSignal.timeout(5_000),
    }),
  ).rejects.toThrow("fungi is not signed in. Run /login");
});

it("keeps a revoked grant refusal in the acquired model stream after catalog acquisition", async () => {
  const path = await signedIn();
  let revoked = false;
  const requested: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    const refresh = refusedRefresh(url);
    if (refresh) return Promise.resolve(refresh);
    return Promise.resolve(
      !revoked && url.endsWith("/models")
        ? Response.json(catalog)
        : Response.json(
            {
              error: {
                code: "invalid_token",
                message: "Fixture revoked grant",
              },
            },
            { status: 401 },
          ),
    );
  });
  const models = createPrivateModels(path);
  await models.refresh({ providers: ["fungi"] });
  revoked = true;
  const source = createPrivateLocalModelSource(
    models,
    "fungi",
    "@fungi/luna",
    "revoked-proof",
  );
  const acquisition = await source.acquire({
    sessionId: "main",
    preference: null,
    signal: AbortSignal.timeout(5000),
  });
  try {
    const result = await models.completeSimple(acquisition.model, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Sign in to Fungi again");
    expect(
      requested.filter((url) => url.endsWith("/oauth2/token")),
    ).toHaveLength(1);
    expect(
      requested.filter((url) => new URL(url).pathname.startsWith("/api/v1/")),
    ).toEqual([
      "https://hub.test/api/v1/teams/team-1/models",
      "https://hub.test/api/v1/teams/team-1/chat/completions",
    ]);
  } finally {
    await acquisition.release();
  }
});

it("replays the model POST body once after refreshing a refused access token", async () => {
  const path = await signedIn();
  const bodies: string[] = [];
  let rotations = 0;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/api/auth/oauth2/token") {
        rotations += 1;
        return Response.json({
          access_token: "fixture-renewed",
          refresh_token: "fixture-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const discovery = refusedRefresh(url);
      if (discovery) return discovery;
      if (url.endsWith("/models")) return Response.json(catalog);
      expect(url).toBe("https://hub.test/api/v1/teams/team-1/chat/completions");
      bodies.push(await new Response(init?.body).text());
      if (
        new Headers(init?.headers).get("Authorization") ===
        "Bearer fixture-access"
      )
        return Response.json(
          { error: { code: "invalid_token", message: "Sign in again" } },
          { status: 401 },
        );
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-renewed",
      );
      return answer();
    },
  );
  const models = createPrivateModels(path);
  expect([...(await models.refresh({ providers: ["fungi"] })).errors]).toEqual(
    [],
  );
  const model = models.getModel("fungi", "@fungi/luna");
  if (!model) throw new Error("Fixture model missing");
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  });
  expect(result.errorMessage).toBeUndefined();
  expect(result.content).toContainEqual({ type: "text", text: "OK" });
  expect(rotations).toBe(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(bodies[0]).toContain("Hello");
});
