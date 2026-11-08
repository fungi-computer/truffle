import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ModelPreference } from "@fungi.computer/shiitake/model-preference";
import { logEvent } from "./log-event.js";

/** One model offered by a signed-in or configured provider, as a provider/model address. */
export type OfferedLocalModel = Readonly<{ address: string; name: string }>;

/** Return a provider's catalog only when its auth owner admits it. */
async function offeredCatalog(
  models: Models,
  providerId: string,
  signal: AbortSignal,
): Promise<readonly Model<Api>[]> {
  signal.throwIfAborted();
  try {
    if ((await models.checkAuth(providerId, { signal })) === undefined)
      return [];
  } catch (cause) {
    // A provider whose login cannot be resolved offers no models here.
    // Explicit selections report their own safe, provider-specific refusal.
    signal.throwIfAborted();
    logEvent("model-default.check-auth", cause);
    return [];
  }
  if (models.getModels(providerId).length === 0) {
    const refreshed = await models.refresh({
      providers: [providerId],
      signal,
    });
    signal.throwIfAborted();
    if (refreshed.aborted || refreshed.errors.has(providerId)) return [];
  }
  return models.getModels(providerId);
}

/**
 * A fresh Agent starts on Fungi's own default model (the Hub catalog marks
 * Luna) when the member is signed in to Fungi. Without a Fungi account it
 * falls back to the first other signed-in provider's catalog default, so a
 * BYOK-only user still starts on a model they can run.
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
    const catalog = await offeredCatalog(models, provider.id, signal);
    const model =
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
  for (const provider of models.getProviders())
    for (const model of await offeredCatalog(models, provider.id, signal))
      offered.push({ address: `${provider.id}/${model.id}`, name: model.name });
  return offered;
}
