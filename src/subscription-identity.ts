import { createHash } from "node:crypto";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  readOpenAIPerson,
  type OpenAIIdentityDetail,
} from "./private-openai-claims.js";

/** The sign-in proved no person; carries claim names only, never values. */
export class OpenAIIdentityUnavailable extends Error {
  constructor(readonly detail: OpenAIIdentityDetail) {
    super("Subscription identity unavailable");
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

const grantSchema = z.object({ fungiAnthropicGrant: z.string().length(64) });

/** Continuity of an opaque grant, not a claim about the person's profile. */
export function anthropicGrantIdentity(credential: OAuthCredential): string {
  const saved = grantSchema.safeParse(credential);
  return saved.success
    ? saved.data.fungiAnthropicGrant
    : createHash("sha256").update(credential.refresh).digest("hex");
}

/**
 * Pi owns OAuth mechanics. OpenAI identity is only the access token's issuer
 * and subject. Anthropic retains its account identity across refresh.
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
      if (provider !== "anthropic") return next;
      const retainedCredential: OAuthCredential = {
        ...next,
        fungiAnthropicGrant: anthropicGrantIdentity(credential),
      };
      if (identity?.success === true && !identitySchema.safeParse(next).success)
        retainedCredential.accountId = identity.data.accountId;
      return retainedCredential;
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
