import {
  createModels,
  type Credential,
  type CredentialStore,
  type FetchFunction,
  type Models,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { inactiveSubscriptionNotice } from "./local-login.js";
import { readOpenAIPerson } from "./private-openai-claims.js";
import { anthropicGrantIdentity } from "./subscription-identity.js";

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
    return {
      person: account.success
        ? `account:${account.data.accountId}`
        : `grant:${anthropicGrantIdentity(credential)}`,
    };
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
  // OpenAI always needs a proven person. An opaque Anthropic grant instead
  // carries continuity from the refresh that exchanged it, across processes.
  if (pinned === undefined || now === undefined) return false;
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
    throw new ShiitakeError(
      "model",
      "rejected",
      "Turn provider is not registered; pick another model with /model.",
    );
  const readSavedCredential: CredentialStore["read"] = async (id, options) => {
    try {
      return await owner.read(id, options);
    } catch (cause) {
      options?.signal?.throwIfAborted();
      throw new ShiitakeError(
        "model",
        "rejected",
        "Couldn't read your saved sign-in; retry, or run fungi doctor.",
        undefined,
        cause,
      );
    }
  };
  let pin = await readSavedCredential(providerId, { signal });
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
      return adopt(await readSavedCredential(id, options));
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
  const oauth = provider.auth.oauth;
  const refreshRejected = async (
    rejected: OAuthCredential,
    requestSignal: AbortSignal,
  ) => {
    // Recheck under Pi's cross-process lock. A peer's committed rotation wins;
    // once refresh starts, cancellation must not discard its rotated token.
    const current = await owner.modify(providerId, async (saved) => {
      assertOpen();
      requestSignal.throwIfAborted();
      if (!sameAccount(providerId, saved, rejected)) return fail();
      if (saved.access !== rejected.access) return undefined;
      if (oauth === undefined) throw new Error("Turn OAuth unavailable");
      return oauth.refresh(saved, AbortSignal.timeout(15_000));
    });
    requestSignal.throwIfAborted();
    const next = adopt(current);
    if (next?.type !== "oauth") return fail();
    return next.access;
  };
  // Retry at the HTTP boundary: a 401 has produced no model output. Never
  // replay an SSE stream, a tool call, an API key or caller-owned headers.
  const recoveringFetch = (
    upstream: FetchFunction = globalThis.fetch,
  ): FetchFunction => {
    const rejected = pin;
    if (rejected?.type !== "oauth") return upstream;
    let retried = false;
    const transport = async (
      input: Parameters<FetchFunction>[0],
      init?: Parameters<FetchFunction>[1],
    ) => {
      if (init === undefined) return upstream(input);
      const headers = new Headers(init.headers);
      const replayBody = z.string().safeParse(init.body);
      if (
        retried ||
        // Pi's Anthropic SDK sends a URL and a JSON string. Do not attempt
        // to replay a consumed Request or an arbitrary streaming body.
        input instanceof Request ||
        !replayBody.success ||
        headers.get("authorization") !== `Bearer ${rejected.access}`
      )
        return upstream(input, init);
      const response = await upstream(input, init);
      if (response.status !== 401) return response;
      retried = true;
      await response.body?.cancel();
      const access = await refreshRejected(rejected, init.signal ?? signal);
      headers.set("authorization", `Bearer ${access}`);
      return upstream(input, { ...init, body: replayBody.data, headers });
    };
    return Object.assign(transport, { preconnect: upstream.preconnect });
  };
  scoped.setProvider(
    providerId === "anthropic" && oauth !== undefined
      ? {
          ...provider,
          stream: (model, context, options) =>
            provider.stream(
              model,
              context,
              Object.assign({}, options, {
                fetch: recoveringFetch(options?.fetch),
              }),
            ),
          streamSimple: (model, context, options) =>
            provider.streamSimple(model, context, {
              ...options,
              fetch: recoveringFetch(options?.fetch),
            }),
        }
      : provider,
  );
  try {
    // Pin/refresh at acquisition, not at the first tool iteration.
    if ((await scoped.getAuth(providerId, { signal })) === undefined)
      throw new ShiitakeError(
        "model",
        "rejected",
        pin?.type === "oauth" && provider.auth.oauth === undefined
          ? `${provider.name}: ${inactiveSubscriptionNotice} Choose another model with /model.`
          : "Turn provider is not signed in. Run /login or choose another model with /model.",
      );
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
