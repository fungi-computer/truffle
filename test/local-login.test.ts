import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { loginAllowed } from "@fungi.computer/veil/model-credentials";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createPrivateModels } from "../src/local-models.js";
import {
  authInteractionFor,
  localAccountOwner,
  localLoginProviders,
} from "../src/local-login.js";

describe("local login registry", () => {
  it("describes the policy-permitted Pi providers as registry data", () => {
    const registry = localLoginProviders(createPrivateModels().getProviders());
    const byId = new Map(registry.map((provider) => [provider.id, provider]));
    expect(byId.get("openai")?.methods).toEqual([
      { kind: "api_key", label: "OpenAI API key" },
      { kind: "subscription", label: "Sign in with ChatGPT" },
    ]);
    expect(byId.has("openai-codex")).toBe(false);
    // Pi's own label, not a provider-specific override.
    expect(
      byId
        .get("anthropic")
        ?.methods.find((method) => method.kind === "subscription")?.label,
    ).toBe("Anthropic (Claude Pro/Max)");
    // The registry offers exactly what Veil's policy allows here.
    for (const provider of registry)
      for (const method of provider.methods)
        expect(
          loginAllowed({
            providerId: provider.id,
            method: method.kind,
            host: "local",
            scope: "user",
          }),
        ).toBe(true);
    for (const provider of registry) {
      expect(provider.methods.length).toBeGreaterThan(0);
      expect(provider.name.trim()).not.toBe("");
    }
  });

  it("offers OpenAI without the retired Codex provider", () => {
    const registry = localLoginProviders(createPrivateModels().getProviders());
    expect(registry.some((provider) => provider.id === "openai")).toBe(true);
    expect(registry.some((provider) => provider.id === "openai-codex")).toBe(
      false,
    );
  });
});

it("rejects a preset method a provider's flow never asks about, before any handoff is shown", async () => {
  // Anthropic has exactly one sign-in method and never prompts a `select`;
  // simulate that shape generically instead of depending on Pi's real
  // network flow, and confirm the cancellation beats the browser URL.
  const auth = vi.fn((_request, interaction: AuthInteraction) => {
    interaction.notify({
      type: "auth_url",
      url: "https://example.test/authorize",
    });
    return Promise.resolve({ kind: "completed" as const });
  });
  const owner = localAccountOwner({ auth }, () => []);
  const host = createWhistleInteractionHost({ title: "Anthropic login" });
  const session = host.begin();
  await expect(
    owner.login(
      {
        providerId: "anthropic",
        method: "subscription",
        option: "device_code",
      },
      session.interaction,
    ),
  ).rejects.toThrow("The provider did not offer that sign-in method");
  expect(host.snapshot().handoff).toBeUndefined();
});

describe("Pi auth through a Whistle interaction", () => {
  it("maps device codes and URLs to handoffs and selects to choices", async () => {
    const host = createWhistleInteractionHost({ title: "Sign in" });
    const session = host.begin();
    const auth = authInteractionFor(session.interaction);
    auth.notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.example.test/device",
    });
    expect(host.snapshot().handoff).toEqual({
      type: "handoff",
      url: "https://auth.example.test/device",
      code: "ABCD-1234",
    });
    const answer = auth.prompt({
      type: "select",
      message: "Choose a login method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device_code", label: "Device code" },
      ],
    });
    const pending = host.snapshot().prompt;
    expect(pending?.request).toEqual({
      type: "choice",
      message: "Choose a login method",
      options: [
        { value: "browser", label: "Browser" },
        { value: "device_code", label: "Device code" },
      ],
    });
    host.answer(pending?.sequence ?? -1, "device_code");
    await expect(answer).resolves.toBe("device_code");
  });

  it("answers Pi's method question from a preset and hides secrets", async () => {
    const host = createWhistleInteractionHost({ title: "Sign in" });
    const session = host.begin();
    const auth = authInteractionFor(session.interaction, "device_code");
    await expect(
      auth.prompt({
        type: "select",
        message: "Method",
        options: [{ id: "device_code", label: "Device code" }],
      }),
    ).resolves.toBe("device_code");
    void auth.prompt({ type: "secret", message: "API key" });
    expect(host.snapshot().prompt?.request).toEqual({
      type: "text",
      message: "API key",
      secret: true,
    });
  });

  it("keeps a provider prompt longer than a dialog title as its summary", () => {
    const host = createWhistleInteractionHost({ title: "Sign in" });
    const auth = authInteractionFor(host.begin().interaction);
    const message =
      "Complete login in your browser, or paste the authorization code / redirect URL here:";
    void auth.prompt({
      type: "manual_code",
      message,
      placeholder: "http://localhost:53692/callback",
    });
    expect(host.snapshot().prompt?.request).toEqual({
      type: "text",
      message: "Paste the sign-in code or redirect URL",
      summary: `${message} Connecting over SSH? Paste the URL here instead of opening a browser.`,
      placeholder: "http://localhost:53692/callback",
    });
  });

  it("withdraws a manual-code prompt when Pi's callback wins", async () => {
    const host = createWhistleInteractionHost({ title: "Sign in" });
    const auth = authInteractionFor(host.begin().interaction);
    const callback = new AbortController();
    const manual = auth.prompt({
      type: "manual_code",
      message: "Paste the redirect URL",
      signal: callback.signal,
    });
    callback.abort(new Error("callback"));
    await expect(manual).rejects.toThrow("callback");
    expect(host.snapshot().prompt).toBeUndefined();
  });
});

describe("local account owner", () => {
  it.each(["openai", "anthropic"])(
    "routes %s subscription login to the service",
    async (providerId) => {
      const auth = vi.fn(() => Promise.resolve({ kind: "completed" as const }));
      const owner = localAccountOwner({ auth }, () => []);
      const host = createWhistleInteractionHost({ title: "Sign in" });
      await owner.login(
        { providerId, method: "subscription" },
        host.begin().interaction,
      );
      expect(auth).toHaveBeenCalledWith(
        { command: "login", provider: providerId, authType: "oauth" },
        expect.anything(),
      );
    },
  );

  it("summarizes only configured providers", async () => {
    const owner = localAccountOwner(
      {
        auth: () =>
          Promise.resolve({
            kind: "status" as const,
            providers: [
              {
                providerId: "openai",
                providerName: "OpenAI",
                state: "unconfigured" as const,
              },
              {
                providerId: "chatgpt",
                providerName: "ChatGPT",
                state: "configured" as const,
                type: "oauth" as const,
              },
            ],
          }),
      },
      () => [],
    );
    await expect(owner.status(new AbortController().signal)).resolves.toBe(
      "ChatGPT: configured (oauth)",
    );
  });
});

it("projects parsed configured access, including ambient providers without interactive methods", async () => {
  const auth = vi.fn<Parameters<typeof localAccountOwner>[0]["auth"]>(() =>
    Promise.resolve({
      kind: "status",
      providers: [
        {
          providerId: "ambient",
          providerName: "Ambient",
          state: "configured",
          type: "api_key",
        },
        { providerId: "openai", providerName: "OpenAI", state: "unconfigured" },
      ],
    }),
  );
  const owner = localAccountOwner({ auth }, () => []);
  const signal = new AbortController().signal;
  expect(await owner.access(signal)).toEqual([
    {
      providerId: "ambient",
      providerName: "Ambient",
      state: "configured",
      type: "api_key",
    },
  ]);
  expect(auth).toHaveBeenCalledWith(
    { command: "status" },
    expect.objectContaining({ signal }),
  );
  expect(await owner.providers()).toEqual([]);
  expect(owner.popularProviderIds).toEqual([
    "fungi",
    "openai",
    "anthropic",
    "deepseek",
    "kimi-coding",
    "openrouter",
  ]);
});

it("never presents a failed or unexpected status response as unsigned access", async () => {
  const auth = vi.fn<Parameters<typeof localAccountOwner>[0]["auth"]>(() =>
    Promise.resolve({ kind: "completed" }),
  );
  const owner = localAccountOwner({ auth }, () => []);
  const signal = new AbortController().signal;
  await expect(owner.access(signal)).rejects.toThrow("non-status result");
  await expect(owner.status(signal)).rejects.toThrow("non-status result");
  const failure = new Error("Status transport unavailable");
  auth.mockRejectedValue(failure);
  await expect(owner.access(signal)).rejects.toBe(failure);
});
