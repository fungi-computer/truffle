import { decodeJwt, errors } from "jose";
import { z } from "zod";

const identityComponent = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const authNamespace = "https://api.openai.com/auth";
const claimObjectSchema = z.record(z.string(), z.json());
type ClaimObject = z.output<typeof claimObjectSchema>;
/** At most this many claim names, each at most this long, ever cross. */
const claimNameLimit = 32;
const claimNameLength = 64;
const claimNamesSchema = z
  .array(z.string().max(claimNameLength))
  .max(claimNameLimit);

/**
 * Why a sign-in proved no person: the token or claim at fault and the claim
 * NAMES present. Never claim values, emails, subjects or tokens.
 */
export const openAIIdentityDetailSchema = z.strictObject({
  claim: z.enum(["access_token", "access_token.iss", "access_token.sub"]),
  problem: z.enum(["malformed", "absent", "invalid"]),
  claimNames: claimNamesSchema,
  authClaimNames: claimNamesSchema.optional(),
});
export type OpenAIIdentityDetail = z.output<typeof openAIIdentityDetailSchema>;

const names = (claims: ClaimObject) =>
  Object.keys(claims)
    .slice(0, claimNameLimit)
    .map((name) => name.slice(0, claimNameLength));

/** Decode JWT claims; only jose's JWTInvalid means a malformed token. */
function claimsOf(
  token: string,
  decode: typeof decodeJwt,
): ClaimObject | undefined {
  try {
    return claimObjectSchema.parse(decode(token));
  } catch (error) {
    // Anything other than JWTInvalid is a real fault, not a malformed token.
    if (error instanceof errors.JWTInvalid) return undefined;
    throw error;
  }
}

/** The person a direct-access token belongs to: its issuer and subject. */
export function readOpenAIPerson(
  access: string,
  decode: typeof decodeJwt = decodeJwt,
):
  | Readonly<{ kind: "person"; iss: string; sub: string }>
  | Readonly<{ kind: "unproven"; detail: OpenAIIdentityDetail }> {
  const claims = claimsOf(access, decode);
  if (claims === undefined)
    return {
      kind: "unproven",
      detail: { claim: "access_token", problem: "malformed", claimNames: [] },
    };
  const claimNames = names(claims);
  const auth = claimObjectSchema.safeParse(claims[authNamespace]);
  const context = auth.success
    ? { claimNames, authClaimNames: names(auth.data) }
    : { claimNames };
  const unproven = (
    claim: "access_token.iss" | "access_token.sub",
    key: string,
  ): ReturnType<typeof readOpenAIPerson> => ({
    kind: "unproven",
    detail: {
      claim,
      problem: key in claims ? "invalid" : "absent",
      ...context,
    },
  });
  const iss = identityComponent.safeParse(claims.iss);
  if (!iss.success) return unproven("access_token.iss", "iss");
  const sub = identityComponent.safeParse(claims.sub);
  if (!sub.success) return unproven("access_token.sub", "sub");
  return { kind: "person", iss: iss.data, sub: sub.data };
}
