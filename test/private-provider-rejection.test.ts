import { normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  observeProviderStatus,
  type ProviderRejection,
} from "@fungi.computer/mule";
import { expect, it } from "vitest";
import {
  modelFailureMessage,
  modelFailureRetryable,
} from "../src/private-provider-rejection.js";
import { openAIAccessToken } from "./openai-fixtures.js";

it("does not infer a provider retry class from assistant error prose", () => {
  expect(
    modelFailureMessage("openai", {
      upstream: fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 service unavailable; retry this request",
      }),
    }),
  ).toBe(
    "openai rejected the model request. Check /login or choose another model with /model.",
  );
});

it("uses typed transport evidence even when Pi did not produce an assistant message", () => {
  expect(
    modelFailureMessage("openai", {
      rejection: { code: "provider_unavailable" },
    }),
  ).toBe("openai service unavailable. Try again shortly.");
});

const retryCases: {
  rejection: ProviderRejection | undefined;
  expected: boolean;
}[] = [
  { rejection: undefined, expected: false },
  { rejection: { code: "usage-limit-reached" }, expected: false },
  {
    rejection: { code: "provider_rejected", status: 429 },
    expected: false,
  },
  {
    rejection: { code: "provider_rejected", status: 401 },
    expected: false,
  },
  { rejection: { code: "provider_unavailable" }, expected: true },
  {
    rejection: { code: "provider_unavailable", status: 503 },
    expected: true,
  },
];

it.each(retryCases)(
  "uses typed evidence $rejection for retry=$expected, not the message",
  ({ rejection, expected }) => {
    expect(
      modelFailureRetryable({
        rejection,
        upstream: fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 service unavailable; retry this request",
        }),
      }),
    ).toBe(expected);
  },
);

it("keeps cancellation and subscription-turn refusals terminal despite transient transport evidence", () => {
  expect(
    modelFailureRetryable({
      rejection: { code: "provider_unavailable" },
      upstream: fauxAssistantMessage("", { stopReason: "aborted" }),
    }),
  ).toBe(false);
  expect(
    modelFailureRetryable({
      rejection: { code: "provider_unavailable" },
      refusal: { category: "refresh_failed", message: "Sign in again" },
    }),
  ).toBe(false);
});

it.each([401, 403])(
  "a real Pi OpenAI HTTP %i failure reports provider_rejected with its status only",
  async (status) => {
    const observer = observeProviderStatus({
      fetch: Object.assign(
        () =>
          Promise.resolve(
            Response.json(
              { error: { message: "fixture-provider-body-must-not-surface" } },
              { status },
            ),
          ),
        globalThis.fetch,
      ),
    });
    const provider = openaiProvider();
    const model = provider.getModels().find(({ id }) => id === "gpt-6-sol");
    if (model === undefined) throw new Error("Fixture model missing");
    const upstream = await provider
      .streamSimple(
        model,
        normalizeContext({
          messages: [{ role: "user", content: "Fixture only", timestamp: 0 }],
        }),
        {
          apiKey: openAIAccessToken("fixture-openai-person"),
          fetch: observer.fetch,
          transport: "sse",
          maxRetries: 0,
        },
      )
      .result();
    expect(upstream.stopReason).toBe("error");
    const message = modelFailureMessage("openai", {
      upstream,
      rejection: observer.rejection(),
    });
    expect(message).toBe(
      `openai rejected the model request (provider_rejected, HTTP ${String(status)}). Check /login or choose another model with /model.`,
    );
    expect(message.includes("fixture-provider-body")).toBe(false);
  },
);

it("a successful status is not a rejection", async () => {
  const observer = observeProviderStatus({
    fetch: Object.assign(
      () => Promise.resolve(new Response("ok", { status: 200 })),
      globalThis.fetch,
    ),
  });
  await observer.fetch("https://api.openai.com/v1/responses");
  expect(observer.rejection()).toBeUndefined();
});
