import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { afterEach, expect, it, vi } from "vitest";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";
import { openAIAccessToken } from "./openai-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const bodyMarker = "fixture-provider-body-must-not-surface";

/** One real Local turn failure for a fixture OpenAI HTTP error reply. */
async function turnFailure(
  status: number,
  error: Readonly<Record<string, string>>,
) {
  const root = await mkdtemp(join(tmpdir(), "fungi-provider-rejection-"));
  roots.push(root);
  const credentialPath = join(root, "credentials.json");
  await createPrivateCredentialStore(credentialPath).modify("openai", () =>
    Promise.resolve({
      type: "oauth",
      access: openAIAccessToken("fixture-openai-person"),
      refresh: "fixture-openai-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "oaiapp_synthetic",
      scopes: ["chatgpt.tokens.use.direct"],
    }),
  );
  const requests: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    if (url !== "https://api.openai.com/v1/responses")
      throw new Error("Unexpected offline provider request");
    return Promise.resolve(Response.json({ error }, { status }));
  });
  const models = createPrivateModels(credentialPath);
  const source = createPrivateLocalModelSource(
    models,
    "openai",
    "gpt-6-sol",
    "fixture-rejection",
  );
  const acquisition = await source.acquire({
    sessionId: "main",
    preference: null,
    signal: new AbortController().signal,
  });
  try {
    if (acquisition.stream === undefined) throw new Error("Missing stream");
    const stream = await acquisition.stream(
      acquisition.model,
      normalizeContext({
        messages: [{ role: "user", content: "Fixture only", timestamp: 0 }],
      }),
      { transport: "sse", maxRetries: 0 },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    const diagnostic = acquisition.failureReason?.(result);
    const providerError = acquisition.providerError?.(result);
    expect(diagnostic).not.toContain(bodyMarker);
    expect(diagnostic?.length).toBeLessThanOrEqual(200);
    expect(requests).toEqual(["https://api.openai.com/v1/responses"]);
    // The turn's errorMessage is the safe reason; provider prose is a
    // separate fact handed only to the turn recorder.
    expect(result.errorMessage).toBe(diagnostic);
    return { result, diagnostic, providerError };
  } finally {
    await acquisition.release();
  }
}

it.each([400, 401, 403])(
  "OpenAI HTTP %i rejection keeps Pi text on the turn but only its typed status in the diagnostic",
  async (status) => {
    const { providerError, diagnostic } = await turnFailure(status, {
      message: bodyMarker,
    });
    expect(diagnostic).toBe(
      `OpenAI rejected the request (HTTP ${String(status)}); check your sign-in or choose another model.`,
    );
    expect(providerError).toContain(bodyMarker);
  },
);

it("a Sign in with ChatGPT usage limit reaches the turn as the typed usage-limit-reached reason", async () => {
  const { result, providerError, diagnostic } = await turnFailure(429, {
    code: "subscription_sharing_usage_limit_exceeded",
    message: bodyMarker,
  });
  expect(diagnostic).toBe(
    "OpenAI usage limit reached on your ChatGPT subscription.",
  );
  expect(providerError).toContain(bodyMarker);
  // A usage limit resets after hours: the turn must fail once, not retry.
  expect(isRetryableAssistantError(result)).toBe(false);
});

it("a throttling 429 reports the rate limit separately from service availability", async () => {
  const { providerError, diagnostic } = await turnFailure(429, {
    code: "rate_limit_exceeded",
    message: "Rate limit reached for requests",
  });
  expect(diagnostic).toBe("OpenAI rate limit reached; try again shortly.");
  expect(providerError).toContain("Rate limit reached for requests");
});

it("any other 429 stays provider_rejected HTTP 429", async () => {
  const { providerError, diagnostic } = await turnFailure(429, {
    code: "insufficient_quota",
    message: bodyMarker,
  });
  expect(diagnostic).toBe(
    "OpenAI rejected the request (HTTP 429); check your sign-in or choose another model.",
  );
  expect(providerError).toContain(bodyMarker);
});
