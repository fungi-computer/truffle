import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  WhistleInteraction,
  WhistleNotice,
} from "@fungi.computer/whistle";
import { interactionTitleLimit } from "@fungi.computer/whistle/wire";

import type { PrivateLocalServiceManager } from "./private-local-service.js";

/** Display order for popular model providers; labels remain owned by Pi. */
export const localPopularProviderIds = Object.freeze([
  "fungi",
  "openai",
  "anthropic",
  "deepseek",
  "kimi-coding",
  "openrouter",
]);

/** One sign-in method, in the provider registry's vocabulary. */
export type LocalLoginMethod = Readonly<{
  kind: "api_key" | "subscription";
  label: string;
}>;

/** One provider Local can sign in to, derived from Pi's provider data. */
export type LocalLoginProvider = Readonly<{
  id: string;
  name: string;
  methods: readonly LocalLoginMethod[];
}>;

/**
 * Describe Pi's providers as registry data. Pi's OAuth sign-in is the
 * provider's consumer subscription; ambient-only API keys (no interactive
 * setup) are not offered. Callers pass the policy-filtered collection from
 * `createPrivateModels`.
 */
export function localLoginProviders(
  providers: readonly Provider[],
): readonly LocalLoginProvider[] {
  return providers.flatMap((provider) => {
    const methods: LocalLoginMethod[] = [];
    if (provider.auth.apiKey?.login !== undefined)
      methods.push({ kind: "api_key", label: provider.auth.apiKey.name });
    if (provider.auth.oauth !== undefined)
      methods.push({
        kind: "subscription",
        label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
      });
    return methods.length === 0
      ? []
      : [{ id: provider.id, name: provider.name, methods }];
  });
}

function notice(event: AuthEvent): WhistleNotice {
  switch (event.type) {
    case "auth_url":
      return event.instructions === undefined
        ? { type: "handoff", url: event.url }
        : { type: "handoff", url: event.url, message: event.instructions };
    case "device_code":
      return {
        type: "handoff",
        url: event.verificationUri,
        code: event.userCode,
      };
    case "info":
      return event.links === undefined
        ? { type: "info", message: event.message }
        : {
            type: "info",
            message: event.message,
            links: event.links.map((link) =>
              link.label === undefined
                ? { url: link.url }
                : { url: link.url, label: link.label },
            ),
          };
    case "progress":
      return { type: "progress", message: event.message };
  }
}

/**
 * Pi's prompt text is provider wording, not a modal title: Whistle titles are
 * at most `interactionTitleLimit` characters, and Pi 1.3's Anthropic paste
 * prompt is longer. A message that fits stays the title; a longer one keeps
 * every word as the summary under Fungi's fixed title for that prompt kind,
 * so a provider sentence can never make the dialog refuse to open.
 */
function modalText(
  message: string,
  fallbackTitle: string,
  hint?: string,
): Readonly<{ message: string; summary?: string }> {
  const fits = message.trim() !== "" && message.length <= interactionTitleLimit;
  const lines = [
    ...(fits ? [] : [message]),
    ...(hint === undefined ? [] : [hint]),
  ];
  const title = fits ? message : fallbackTitle;
  return lines.length === 0
    ? { message: title }
    : { message: title, summary: lines.join(" ") };
}

const placeholderOf = (placeholder: string | undefined) =>
  placeholder === undefined ? {} : { placeholder };

async function ask(
  interaction: WhistleInteraction,
  prompt: AuthPrompt,
): Promise<string> {
  const options = prompt.signal === undefined ? {} : { signal: prompt.signal };
  switch (prompt.type) {
    case "select":
      return interaction.prompt(
        {
          type: "choice",
          ...modalText(prompt.message, "Choose a sign-in option"),
          options: prompt.options.map((option) =>
            option.description === undefined
              ? { value: option.id, label: option.label }
              : {
                  value: option.id,
                  label: option.label,
                  description: option.description,
                },
          ),
        },
        options,
      );
    case "manual_code":
      // Generic across every provider that falls back to a pasted code or
      // redirect URL (OpenAI, Anthropic): the provider's own
      // message explains what to paste; this adds the SSH hint once, here,
      // instead of baking it into one provider's registry label.
      return interaction.prompt(
        {
          type: "text",
          ...modalText(
            prompt.message,
            "Paste the sign-in code or redirect URL",
            "Connecting over SSH? Paste the URL here instead of opening a browser.",
          ),
          ...placeholderOf(prompt.placeholder),
        },
        options,
      );
    case "secret":
    case "text":
      return interaction.prompt(
        {
          type: "text",
          ...modalText(
            prompt.message,
            prompt.type === "secret" ? "Enter your key" : "Enter a value",
          ),
          ...placeholderOf(prompt.placeholder),
          secret: prompt.type === "secret",
        },
        options,
      );
  }
}

const methodNotOffered = "The provider did not offer that sign-in method";

/**
 * Present Pi's provider sign-in through a Whistle interaction. `option`
 * answers Pi's own method question (e.g. `device_code`) without asking. If
 * the flow's first event -- a prompt or a notification -- is not a `select`
 * offering that option, the flow never asks the question at all (e.g.
 * Anthropic, which has only one sign-in method); cancel before relaying
 * anything to the host, so no browser URL or other handoff is ever shown
 * for a method the provider silently ignored.
 */
export function authInteractionFor(
  interaction: WhistleInteraction,
  option?: string,
): AuthInteraction {
  let preset = option;
  return {
    signal: interaction.signal,
    prompt: (prompt) => {
      if (preset === undefined) return ask(interaction, prompt);
      if (prompt.type !== "select") {
        preset = undefined;
        return Promise.reject(new Error(methodNotOffered));
      }
      const chosen = prompt.options.find((one) => one.id === preset);
      preset = undefined;
      if (chosen === undefined)
        return Promise.reject(new Error(methodNotOffered));
      return Promise.resolve(chosen.id);
    },
    notify: (event) => {
      if (preset !== undefined) {
        preset = undefined;
        throw new Error(methodNotOffered);
      }
      interaction.notify(notice(event));
    },
  };
}

/** The Local credential owner behind provider-agnostic account commands. */
export function localAccountOwner(
  manager: Pick<PrivateLocalServiceManager, "auth">,
  providers: () => readonly Provider[],
) {
  const access = async (signal: AbortSignal) => {
    const result = await manager.auth(
      { command: "status" },
      {
        signal,
        prompt: () => Promise.reject(new Error("Account status cannot prompt")),
        notify: () => undefined,
      },
    );
    if (result.kind !== "status")
      throw new Error("Account status returned a non-status result");
    return result.providers.filter(
      (provider) => provider.state === "configured",
    );
  };
  return {
    popularProviderIds: localPopularProviderIds,
    access,
    providers: () => Promise.resolve(localLoginProviders(providers())),
    login: async (
      request: Readonly<{
        providerId: string;
        method: LocalLoginMethod["kind"];
        option?: string;
      }>,
      interaction: WhistleInteraction,
    ): Promise<void> => {
      await manager.auth(
        {
          command: "login",
          provider: request.providerId,
          authType: request.method === "subscription" ? "oauth" : "api_key",
        },
        authInteractionFor(interaction, request.option),
      );
    },
    logout: async (
      providerId: string,
      interaction: WhistleInteraction,
    ): Promise<void> => {
      await manager.auth(
        { command: "logout", provider: providerId },
        authInteractionFor(interaction),
      );
    },
    status: async (signal: AbortSignal) => {
      const configured = (await access(signal)).map(
        (provider) => `${provider.providerName}: configured (${provider.type})`,
      );
      return configured.length === 0
        ? "No model provider is signed in. Use /login to add one."
        : configured.join("\n");
    },
  };
}
