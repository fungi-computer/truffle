import { isDeepStrictEqual } from "node:util";
import {
  createModels,
  type Credential,
  type CredentialStore,
  type Models,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { readOpenAIPerson } from "./private-openai-claims.js";

// Associate only Local-owned collections with their actual credential owner.
// Caller-supplied Models retain their own auth contract; never guess a file path.
const owners = new WeakMap<Models, CredentialStore>();
export function registerSubscriptionTurnOwner(
  models: Models,
  store: CredentialStore,
): void {
  owners.set(models, store);
}

class SubscriptionTurnError extends Error {
  readonly category = "account-switched-during-turn";
  constructor() {
    super("Account switched during this turn: retry.");
    this.name = "SubscriptionTurnError";
  }
}

const accountSchema = z.object({ accountId: z.string().min(1).max(256) });
type Identity = Readonly<{ person: string }>;
function identity(
  provider: string,
  credential: OAuthCredential,
): Identity | undefined {
  if (provider === "anthropic") {
    const account = accountSchema.safeParse(credential);
    return account.success ? { person: account.data.accountId } : undefined;
  }
  // Only the access token's issuer and subject identify an OpenAI person.
  try {
    const claims = readOpenAIPerson(credential.access);
    return claims.kind === "unproven"
      ? undefined
      : {
          person: JSON.stringify([claims.iss, claims.sub]),
        };
  } catch {
    // Never expose decoder diagnostics or accept an unprovable JWT identity.
    throw new SubscriptionTurnError();
  }
}
function sameAccount(
  provider: string,
  current: Credential | undefined,
  pin: OAuthCredential,
): current is OAuthCredential {
  if (current?.type !== "oauth") return false;
  const pinned = identity(provider, pin);
  const now = identity(provider, current);
  // OpenAI always needs a proven person. Anthropic's opaque grant may not yet
  // have its profile account; exact credential equality still proves continuity.
  if (pinned === undefined || now === undefined)
    return provider !== "openai" && isDeepStrictEqual(current, pin);
  return pinned.person === now.person;
}

/** One accepted user turn owns one in-memory credential view, never a new vault. */
export async function acquireSubscriptionTurn(
  models: Models,
  providerId: string,
  signal: AbortSignal,
) {
  const owner = owners.get(models);
  if (
    owner === undefined ||
    (providerId !== "anthropic" && providerId !== "openai")
  )
    return {
      models,
      refusal: () => undefined,
      release: () => Promise.resolve(),
    };
  const provider = models.getProvider(providerId);
  if (provider === undefined)
    throw new Error("Turn provider is not registered");
  let pin = await owner.read(providerId, { signal });
  let released = false;
  let refusal: SubscriptionTurnError | undefined;
  const fail = (): never => {
    refusal ??= new SubscriptionTurnError();
    throw refusal;
  };
  const assertOpen = () => {
    if (released) throw new Error("Model turn already released");
    if (refusal !== undefined) throw refusal;
  };
  const adopt = (current: Credential | undefined) => {
    assertOpen();
    if (pin?.type !== "oauth") return pin;
    if (sameAccount(providerId, current, pin)) pin = current;
    else if (pin.expires <= Date.now()) fail();
    return pin;
  };
  const view: CredentialStore = {
    async read(id, options) {
      assertOpen();
      if (id !== providerId) throw new Error("Turn provider changed");
      options?.signal?.throwIfAborted();
      if (pin?.type !== "oauth") return pin;
      return adopt(await owner.read(id, options));
    },
    list: () =>
      Promise.resolve(
        pin === undefined ? [] : [{ providerId, type: pin.type }],
      ),
    async modify(id, callback, options) {
      let resolved: Credential | undefined;
      await owner.modify(
        id,
        async (current) => {
          assertOpen();
          if (id !== providerId || pin?.type !== "oauth")
            throw new Error("Turn OAuth credential unavailable");
          if (!sameAccount(providerId, current, pin)) {
            // Pi may request a proactive refresh while the retired token is still
            // valid. Serve it without invoking refresh or modifying the active B.
            if (pin.expires <= Date.now()) fail();
            resolved = pin;
            return undefined;
          }
          const next = await callback(current);
          resolved = next ?? current;
          return next;
        },
        options,
      );
      // Validate adoption only after the owner commits: cancellation or an
      // unprovable/switched refresh must never discard a rotated refresh token.
      // A released turn must not regain a pin.
      return released ? resolved : adopt(resolved);
    },
    delete: () =>
      Promise.reject(new Error("Turn credentials cannot be deleted")),
  };
  const scoped = createModels({ credentials: view });
  scoped.setProvider(provider);
  try {
    // Pin/refresh at acquisition, not at the first tool iteration.
    if ((await scoped.getAuth(providerId, { signal })) === undefined)
      throw new Error("Turn provider is not signed in");
  } catch (error) {
    pin = undefined;
    if (refusal !== undefined) throw refusal;
    throw error;
  }
  return {
    models: scoped,
    refusal: () => refusal,
    release: () => {
      released = true;
      pin = undefined;
      return Promise.resolve();
    },
  };
}
