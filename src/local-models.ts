import {
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  loginAllowed,
  subscriptionKillSwitchFrom,
} from "@fungi.computer/veil/model-credentials";

import { createFungiAccountCredentialStore } from "./private-fungi-account.js";
import { createFungiModelProvider } from "./private-fungi-model-provider.js";
import { retainSubscriptionIdentity } from "./subscription-identity.js";
import { registerSubscriptionTurnOwner } from "./subscription-turn.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";

/** Register Pi's standalone OAuth modules on the same instance Local uses. */
export function registerPrivateBundledModelOAuthFlows(): void {
  registerBunOAuthFlows();
}

/** Local credentials belong to the one person who owns this machine. */
const allowedHere = (providerId: string, method: "api_key" | "subscription") =>
  loginAllowed(
    { providerId, method, host: "local", scope: "user" },
    // FUNGI_SUBSCRIPTION_KILL=anthropic,openai turns logins off without a release.
    subscriptionKillSwitchFrom(process.env.FUNGI_SUBSCRIPTION_KILL),
  );

/** Keep only the login methods Veil's provider policy allows on this machine. */
function locallyPermitted(provider: Provider): Provider | undefined {
  const apiKey = allowedHere(provider.id, "api_key")
    ? provider.auth.apiKey
    : undefined;
  const oauth = allowedHere(provider.id, "subscription")
    ? provider.auth.oauth
    : undefined;
  if (apiKey === undefined && oauth === undefined) return undefined;
  const auth: Provider["auth"] = {};
  if (apiKey !== undefined) auth.apiKey = apiKey;
  if (oauth !== undefined)
    auth.oauth =
      provider.id === "anthropic" || provider.id === "openai"
        ? retainSubscriptionIdentity(oauth, provider.id)
        : oauth;
  return { ...provider, auth };
}

/** Create the private local Pi collection with Pi's policy-permitted providers. */
export function createPrivateModels(
  credentialPath: string = capturePrivateLocalConfigRoot().credentialPath,
  providerOptions: { providers?: readonly Provider[] } = {},
): MutableModels {
  const options = { credentialPath };
  const credentials = createFungiAccountCredentialStore(options);
  const models = createModels({ credentials });
  registerSubscriptionTurnOwner(models, credentials);
  for (const provider of providerOptions.providers ?? builtinProviders()) {
    const permitted = locallyPermitted(provider);
    if (permitted !== undefined) models.setProvider(permitted);
  }
  const fungi = locallyPermitted(createFungiModelProvider(options));
  if (fungi !== undefined) models.setProvider(fungi);
  return models;
}

export type PrivateLocalModelChoice = Readonly<{
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: readonly ThinkingLevel[];
}>;

/** Refresh configured dynamic catalogs before exposing the bounded owner picker. */
export async function listPrivateModels(
  credentialPath?: string,
): Promise<readonly PrivateLocalModelChoice[]> {
  const models = createPrivateModels(credentialPath);
  const result = await models.refresh();
  if (result.aborted) throw new Error("Model catalog refresh was cancelled");
  const fungiFailure = result.errors.get("fungi");
  if (fungiFailure !== undefined) throw fungiFailure;
  if (result.errors.size > 0)
    throw new AggregateError(
      [...result.errors.values()],
      "Could not refresh model catalogs",
    );
  return Object.freeze(
    models
      .getProviders()
      .flatMap((provider) =>
        models.getModels(provider.id).map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          reasoning: getSupportedThinkingLevels(model).filter(
            (level): level is ThinkingLevel => level !== "off",
          ),
        })),
      )
      .sort(
        (left, right) =>
          left.providerName.localeCompare(right.providerName) ||
          left.name.localeCompare(right.name) ||
          left.providerId.localeCompare(right.providerId) ||
          left.id.localeCompare(right.id),
      )
      .map((choice) =>
        Object.freeze({
          ...choice,
          reasoning: Object.freeze(choice.reasoning),
        }),
      ),
  );
}
