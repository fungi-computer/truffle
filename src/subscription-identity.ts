import type { OAuthAuth } from "@earendil-works/pi-ai";
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
