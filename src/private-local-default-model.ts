import type { Api, AuthCheck, Model, Models } from "@earendil-works/pi-ai";
import type { ModelPreference } from "@fungi.computer/shiitake/model-preference";
import { logEvent } from "./log-event.js";

/** One model offered by a signed-in or configured provider, as a provider/model address. */
export type OfferedLocalModel = Readonly<{ address: string; name: string }>;

/** Return a provider's catalog only when its auth owner admits it. */
async function offeredCatalog(
  models: Models,
  providerId: string,
  signal: AbortSignal,
): Promise<
  Readonly<{ catalog: readonly Model<Api>[]; auth: AuthCheck }> | undefined
> {
  signal.throwIfAborted();
  let auth: AuthCheck | undefined;
  try {
    auth = await models.checkAuth(providerId, { signal });
    if (auth === undefined) return undefined;
  } catch (cause) {
    // A provider whose login cannot be resolved offers no models here.
    // Explicit selections report their own safe, provider-specific refusal.
    signal.throwIfAborted();
    logEvent("model-default.check-auth", cause);
    return undefined;
  }
  if (models.getModels(providerId).length === 0) {
    const refreshed = await models.refresh({
      providers: [providerId],
      signal,
    });
    signal.throwIfAborted();
    if (refreshed.aborted || refreshed.errors.has(providerId)) return undefined;
  }
  return { catalog: models.getModels(providerId), auth };
}

/**
 * A fresh Agent starts on Fungi's own default model (the Hub catalog marks
 * Luna) when the member is signed in to Fungi. Without a Fungi account it
 * uses Sol for ChatGPT subscriptions and Opus for Claude subscriptions. API
 * keys and other providers keep their catalog default.
 */
export async function defaultLocalModel(
  models: Models,
  signal: AbortSignal,
): Promise<ModelPreference | null> {
  const providers = models.getProviders();
  const ordered = [
    ...providers.filter(({ id }) => id === "fungi"),
    ...providers.filter(({ id }) => id !== "fungi"),
  ];
  for (const provider of ordered) {
    const offered = await offeredCatalog(models, provider.id, signal);
    if (offered === undefined) continue;
    const { catalog, auth } = offered;
    const subscriptionDefault =
      auth.type !== "oauth"
        ? undefined
        : provider.id === "openai"
          ? "gpt-6.1-sol"
          : provider.id === "anthropic"
            ? "claude-opus-5-5"
            : undefined;
    const model =
      catalog.find((entry) => entry.id === subscriptionDefault) ??
      catalog.find((entry) => "default" in entry && entry.default === true) ??
      catalog[0];
    if (model !== undefined)
      return { providerId: provider.id, modelId: model.id };
  }
  return null;
}

/** List models from signed-in or configured providers only, in registry order. */
export async function listOfferedLocalModels(
  models: Models,
  signal: AbortSignal,
): Promise<readonly OfferedLocalModel[]> {
  const offered: OfferedLocalModel[] = [];
  for (const provider of models.getProviders()) {
    const available = await offeredCatalog(models, provider.id, signal);
    for (const model of available?.catalog ?? [])
      offered.push({ address: `${provider.id}/${model.id}`, name: model.name });
  }
  return offered;
}
