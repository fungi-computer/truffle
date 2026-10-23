import type { OAuthAuth } from "@earendil-works/pi-ai";
import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createPrivateCredentialStore } from "./private-file-credential-store.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  readOpenAIPerson,
  type OpenAIIdentityDetail,
} from "./private-openai-claims.js";
import { CredentialActivationError } from "./subscription-activation.js";

/** The sign-in proved no person; carries claim names only, never values. */
export class OpenAIIdentityUnavailable extends CredentialActivationError {
  constructor(readonly detail: OpenAIIdentityDetail) {
    super("identity-unavailable");
    this.name = "OpenAIIdentityUnavailable";
  }
}

const identitySchema = z.object({
  accountId: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value.trim().length > 0),
});
const profileSchema = z.object({
  account: z.object({ uuid: z.uuid() }),
});

/** Node exposes both undici's and the web Response; read either structurally. */
type JsonResponse = Readonly<{
  ok: boolean;
  body: {
    cancel: () => Promise<void>;
    getReader: () => {
      read: () => Promise<{ done: boolean; value?: unknown }>;
      cancel: () => Promise<void>;
      releaseLock: () => void;
    };
  } | null;
}>;

async function readBoundedJson<Schema extends z.ZodType>(
  response: JsonResponse,
  schema: Schema,
): Promise<z.output<Schema> | undefined> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new CredentialActivationError("identity-unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = z.instanceof(Uint8Array).parse(chunk.value);
      size += value.byteLength;
      if (size > 64 * 1024)
        throw new CredentialActivationError("identity-unavailable");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const parsed = schema.safeParse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Pi owns OAuth mechanics. OpenAI identity is only the access token's issuer
 * and subject. Anthropic retains its prepared profile account across refresh.
 */
export function retainSubscriptionIdentity(
  oauth: OAuthAuth,
  provider: "anthropic" | "openai",
): OAuthAuth {
  const retained: OAuthAuth = {
    ...oauth,
    async refresh(credential, signal) {
      const next = await oauth.refresh(credential, signal);
      const identity =
        provider === "anthropic"
          ? identitySchema.safeParse(credential)
          : undefined;
      return identity?.success === true
        ? { ...next, accountId: identity.data.accountId }
        : next;
    },
  };
  if (provider === "anthropic") return retained;
  return {
    ...retained,
    async login(interaction, loginOptions) {
      const credential = await oauth.login(interaction, loginOptions);
      const person = readOpenAIPerson(credential.access);
      if (person.kind === "unproven")
        throw new OpenAIIdentityUnavailable(person.detail);
      return credential;
    },
  };
}

/**
 * Explicit import preparation, never an alternate login flow. Anthropic's
 * opaque token requires its own profile. OpenAI's identity is the access
 * token's issuer and subject; preparation only confirms them.
 */
export async function prepareSubscriptionIdentity(
  provider: string,
  options: { credentialPath?: string; fetch?: FetchLike } = {},
): Promise<void> {
  if (provider !== "anthropic" && provider !== "openai")
    throw new CredentialActivationError("invalid-input");
  const store = createPrivateCredentialStore(
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  );
  try {
    await store.modify(provider, async (current) => {
      if (current?.type !== "oauth")
        throw new CredentialActivationError("invalid-input");
      if (provider === "openai") {
        // The access token's issuer and subject are the whole identity.
        if (readOpenAIPerson(current.access).kind === "unproven")
          throw new CredentialActivationError("identity-unavailable");
        return undefined;
      }
      if (identitySchema.safeParse(current).success) return undefined;
      if (current.expires <= Date.now())
        throw new CredentialActivationError("invalid-input");
      const response = await (options.fetch ?? globalThis.fetch)(
        "https://api.anthropic.com/api/oauth/profile",
        {
          headers: {
            Authorization: `Bearer ${current.access}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      const profile = await readBoundedJson(response, profileSchema);
      if (profile === undefined)
        throw new CredentialActivationError("identity-unavailable");
      return { ...current, accountId: profile.account.uuid };
    });
  } catch (error) {
    if (error instanceof CredentialActivationError) throw error;
    throw new CredentialActivationError("identity-unavailable");
  }
}
