import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAIAccessToken } from "./openai-fixtures.js";

/** Our provider seam, not Pi's browser/PKCE implementation; no network or ports. */
export function fixtureChatGPTProvider(
  access = openAIAccessToken("fixture-openai-person"),
  failure?: Error,
): Provider {
  const provider = builtinProviders().find((entry) => entry.id === "openai");
  if (provider === undefined)
    throw new Error("Fixture OpenAI provider missing");
  const credential = (): OAuthCredential => ({
    type: "oauth",
    access,
    refresh: "fixture-openai-refresh",
    expires: Date.now() + 3_600_000,
    clientId: "oaiapp_synthetic",
    scopes: ["chatgpt.tokens.use.direct"],
  });
  return {
    ...provider,
    auth: {
      oauth: {
        name: "Fixture ChatGPT",
        isSubscription: true,
        login: (interaction) => {
          interaction.signal.throwIfAborted();
          if (failure !== undefined) return Promise.reject(failure);
          return Promise.resolve(credential());
        },
        refresh: () => Promise.resolve(credential()),
        toAuth: (current) => Promise.resolve({ apiKey: current.access }),
      },
    },
  };
}
