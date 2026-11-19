import {
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type OAuthAuth,
  type Provider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  loginAllowed,
  subscriptionKillSwitchFrom,
} from "@fungi.computer/veil/model-credentials";

import type { LocalLoginContributionV1 } from "./local-login.js";
import {
  LocalExtensionError,
  localExtensions,
  type LocalExtensionLogin,
  type LocalExtensionLogins,
} from "./local-extensions.js";
import { createFungiAccountCredentialStore } from "./private-fungi-account.js";
import { createFungiModelProvider } from "./private-fungi-model-provider.js";
import { retainSubscriptionIdentity } from "./subscription-identity.js";
import { registerSubscriptionTurnOwner } from "./subscription-turn.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import { defaultCredentialHome } from "./private-file-credential-store.js";

/** Local credentials belong to the one person who owns this machine. */
const allowedHere = (
  providerId: string,
  method: "api_key" | "subscription",
  source: "builtin" | "extension",
) =>
  loginAllowed(
    { providerId, method, host: "local", scope: "user", source },
    // FUNGI_SUBSCRIPTION_KILL=anthropic,openai turns logins off without a release.
    subscriptionKillSwitchFrom(process.env.FUNGI_SUBSCRIPTION_KILL),
  );

/** Anthropic and OpenAI sign-ins keep their account identity across refresh. */
function retainIdentity(providerId: string, oauth: OAuthAuth): OAuthAuth {
  return providerId === "anthropic" || providerId === "openai"
    ? retainSubscriptionIdentity(oauth, providerId)
    : oauth;
}

/** Keep only the login methods Veil's provider policy allows on this machine. */
function locallyPermitted(provider: Provider): Provider | undefined {
  const apiKey = allowedHere(provider.id, "api_key", "builtin")
    ? provider.auth.apiKey
    : undefined;
  const oauth = allowedHere(provider.id, "subscription", "builtin")
    ? provider.auth.oauth
    : undefined;
  if (apiKey === undefined && oauth === undefined) return undefined;
  const auth: Provider["auth"] = {};
  if (apiKey !== undefined) auth.apiKey = apiKey;
  if (oauth !== undefined) auth.oauth = retainIdentity(provider.id, oauth);
  return { ...provider, auth };
}

const slotName = (contribution: LocalLoginContributionV1) =>
  `${contribution.providerId} ${contribution.method}`;

/**
 * Fill empty login slots with what enabled extensions contribute. This is the
 * one place the merge rules live. An extension fills a slot only when its
 * provider is already registered (an extension adds no provider), the slot is
 * empty after the built-in pass (it never replaces a login Fungi offers),
 * Veil's policy allows an extension there, and no other enabled extension
 * claims the same slot. Two claimants are both refused: Fungi never picks one
 * silently. Every refusal is a diagnostic, never a signed-in login.
 */
function mergeExtensionLogins(
  models: MutableModels,
  logins: LocalExtensionLogins,
  report: (error: Error) => void,
) {
  for (const { error } of logins.diagnostics) report(error);
  const claims = new Map<string, LocalExtensionLogin[]>();
  for (const login of logins.contributions) {
    const slot = slotName(login.contribution);
    claims.set(slot, [...(claims.get(slot) ?? []), login]);
  }
  for (const [slot, claimants] of claims) {
    const [claimant] = claimants;
    if (claimant === undefined) continue;
    const refuse = (reason: string) => {
      for (const { extensionId } of claimants)
        report(
          new LocalExtensionError(
            "load",
            `Extension ${extensionId} did not fill the ${slot} login: ${reason}`,
          ),
        );
    };
    if (claimants.length > 1) {
      refuse(
        `${claimants.map((one) => one.extensionId).join(" and ")} both claim it, so neither is used`,
      );
      continue;
    }
    const { extensionId, contribution } = claimant;
    const provider = models.getProvider(contribution.providerId);
    if (provider === undefined) {
      refuse("the provider is not available here");
      continue;
    }
    const filled =
      contribution.method === "subscription"
        ? provider.auth.oauth
        : provider.auth.apiKey;
    if (filled !== undefined) {
      refuse("Fungi already provides this sign-in");
      continue;
    }
    if (
      !allowedHere(contribution.providerId, contribution.method, "extension")
    ) {
      refuse("Fungi does not allow an extension to provide it");
      continue;
    }
    if (contribution.method === "subscription") {
      const oauth = retainIdentity(contribution.providerId, contribution.oauth);
      models.setProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            ...oauth,
            loginLabel: `${oauth.loginLabel ?? oauth.name} · from ${extensionId}`,
          },
        },
      });
    } else {
      models.setProvider({
        ...provider,
        auth: {
          ...provider.auth,
          apiKey: {
            ...contribution.apiKey,
            name: `${contribution.apiKey.name} · from ${extensionId}`,
          },
        },
      });
    }
  }
}

/**
 * What enabled extensions contribute. Damaged extension records are reported
 * and contribute nothing: they must not take built-in sign-in down with them.
 */
async function readExtensionLogins(
  home: string,
  report: (error: Error) => void,
): Promise<LocalExtensionLogins> {
  try {
    return await localExtensions({ home }).logins();
  } catch (cause) {
    report(
      new LocalExtensionError(
        "load",
        "Extension logins could not be read; built-in sign-in is unchanged",
        { cause: cause instanceof Error ? cause : new Error(String(cause)) },
      ),
    );
    return { contributions: [], diagnostics: [] };
  }
}

export type PrivateModelsOptions = Readonly<{
  /** Pi providers to offer instead of Pi's built-in list. */
  providers?: readonly Provider[];
  /** Where an extension's refusal or load failure goes. Defaults to stderr. */
  report?: (error: Error) => void;
}>;

const reportToStderr = (error: Error) => {
  process.stderr.write(`Extension: ${error.message}\n`);
};

/**
 * Open the private local Pi collection: Pi's policy-permitted providers, then
 * any login slot an enabled extension may fill. Async because loading an
 * extension's `./logins` entry is.
 *
 * The extensions are those of the home the credential path belongs to
 * (`<home>/.config/fungi/credentials.json`), so a collection never reads one
 * home's extensions for another's credentials. A credential path that is not a
 * home's default belongs to no home, and no extension fills its slots.
 */
export async function openPrivateModels(
  credentialPath?: string,
  providerOptions: PrivateModelsOptions = {},
): Promise<MutableModels> {
  // Pi loads OAuth flows through relative imports that a bundle (the CLI, or
  // the separately bundled service worker) does not contain. Register its
  // static loaders wherever Local builds a model collection.
  registerBunOAuthFlows();
  const options = {
    credentialPath:
      credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const home = defaultCredentialHome(options.credentialPath);
  const report = providerOptions.report ?? reportToStderr;
  const credentials = createFungiAccountCredentialStore(options);
  const models = createModels({ credentials });
  registerSubscriptionTurnOwner(models, credentials);
  for (const provider of providerOptions.providers ?? builtinProviders()) {
    const permitted = locallyPermitted(provider);
    if (permitted !== undefined) models.setProvider(permitted);
  }
  const fungi = locallyPermitted(createFungiModelProvider(options));
  if (fungi !== undefined) models.setProvider(fungi);
  if (home !== undefined)
    mergeExtensionLogins(
      models,
      await readExtensionLogins(home, report),
      report,
    );
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
  options: PrivateModelsOptions = {},
): Promise<readonly PrivateLocalModelChoice[]> {
  const models = await openPrivateModels(credentialPath, options);
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
