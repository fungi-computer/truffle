import type {
  SimpleStreamOptions,
  ProviderData,
} from "@fungi.computer/mule/effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { mule } from "@fungi.computer/mule";
import { expect, it } from "vitest";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";

it.each([
  { status: 503, code: "unavailable", retryable: true },
  { status: 401, code: "invalid_request", retryable: false },
  { status: 429, code: "insufficient_quota", retryable: false },
  { status: 429, code: "rate_limit_exceeded", retryable: true },
  { status: 200, code: "overloaded_error", retryable: true },
  {
    status: 200,
    code: "subscription_sharing_usage_limit_exceeded",
    retryable: false,
  },
])(
  "Local's actual acquired owner carries typed $code decisions through Mule",
  async ({ status, code, retryable }) => {
    const directory = await mkdtemp(join(tmpdir(), "local-typed-retry-"));
    try {
      const faux = fauxProvider({
        provider: "faux-typed",
        models: [{ id: "owned-model", name: "Owned model" }],
      });
      const models = createPrivateModels(join(directory, "credentials.json"), {
        providers: [faux.provider],
      });
      const source = createPrivateLocalModelSource(
        models,
        "faux-typed",
        "owned-model",
        "synthetic-local-retry",
      );
      const parsedFailure = {
        type: "response.failed",
        response: { error: { code } },
      };
      const reply: FauxResponseFactory = async (_context, options) => {
        if (options?.fetch === undefined)
          throw new Error("Expected the Local request-local fetch");
        await options.fetch("https://provider.invalid/model");
        // This is the SDK's parsed-event port, not a second SSE decoder.
        if (status === 200 && code !== "overloaded_error")
          await options.onProviderStreamEvent?.(parsedFailure, faux.models[0]);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage:
            code === "overloaded_error"
              ? JSON.stringify({
                  type: "error",
                  error: { type: code, message: "Overloaded" },
                })
              : retryable
                ? "401 permanently rejected"
                : "503 retry now",
        });
      };
      faux.setResponses([reply, reply, reply, reply]);
      let requests = 0;
      const parsedEvents: ProviderData[] = [];
      const options: SimpleStreamOptions = {
        fetch: Object.assign(() => {
          requests += 1;
          return Promise.resolve(
            Response.json(
              { error: { code } },
              { status, headers: { "retry-after": "12" } },
            ),
          );
        }, globalThis.fetch),
        onProviderStreamEvent: (data) => {
          parsedEvents.push(data);
        },
      };
      const controller = new globalThis.AbortController();
      const lease = await source.acquire({
        sessionId: "synthetic-local-retry",
        preference: null,
        signal: controller.signal,
      });
      try {
        const stream = lease.stream;
        if (stream === undefined)
          throw new Error("Expected the Local model stream");
        const context = normalizeContext({ messages: [] });
        const response = await stream(lease.model, context, options);
        let terminal: AssistantMessage | undefined;
        for await (const event of response) {
          if (event.type === "error") {
            terminal = event.error;
            expect(lease.retryable(event.error)).toBe(retryable);
          }
        }
        const first = await response.result();
        expect(terminal).toBe(first);
        expect(lease.retryable(first)).toBe(retryable);
        expect(lease.retryable(globalThis.structuredClone(first))).toBe(false);
        expect(lease.retryAfterMs?.(first)).toBe(
          code === "rate_limit_exceeded" ? 12000 : undefined,
        );
        expect(
          lease.retryAfterMs?.(globalThis.structuredClone(first)),
        ).toBeUndefined();
        expect(
          lease.rejection?.(globalThis.structuredClone(first)),
        ).toBeUndefined();
        if (code === "overloaded_error") {
          expect(parsedEvents).toEqual([]);
          expect(first.errorMessage).toBe(
            "faux-typed is overloaded; try again shortly.",
          );
          expect(lease.rejection?.(first)).toEqual({ code: "overloaded" });
        } else if (status === 200) {
          expect(parsedEvents).toEqual([parsedFailure]);
          expect(first.errorMessage).toBe("faux-typed usage limit reached.");
          expect(lease.rejection?.(first)).toEqual({
            code: "usage-limit-reached",
          });
        }
        requests = 0;
        const outcome = await mule.run({
          model: lease.model,
          stream,
          retryable: lease.retryable,
          streamOptions: options,
          systemPrompt: "Synthetic Local provider proof.",
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        });
        expect(outcome.status).toBe("failed");
        expect(requests).toBe(retryable ? 2 : 1);
        expect(lease.retryable(first)).toBe(false);
        const latestResponse = await stream(lease.model, context, options);
        const latest = await latestResponse.result();
        expect(lease.retryable(latest)).toBe(retryable);
        controller.abort();
        expect(lease.retryable(latest)).toBe(false);
      } finally {
        controller.abort();
        await lease.release();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
