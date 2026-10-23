import { UnsecuredJWT } from "jose";
import type { util } from "zod/v4/core";

/** Fixture payloads may carry malformed claims to prove fail-closed decoding. */
type FixtureClaims = Record<string, util.JSONType>;

/** Reported direct-access shape: opaque auth metadata, no workspace claim. */
export function openAIAccessToken(
  sub: string | number | undefined,
  revision: string | number = 0,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    aud: "https://api.openai.com/v1",
    client_id: "oaiapp_synthetic",
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    iss: "https://auth.openai.com",
    iat: issuedAt,
    exp: issuedAt + 3600,
    jti: `fixture-${String(revision)}`,
    nbf: issuedAt,
    "https://api.openai.com/auth": {
      per_user_salt: "fixture-user-salt",
      encrypted_auth_metadata: "fixture-opaque-auth-metadata",
    },
  };
  const payload: FixtureClaims =
    sub === undefined ? claims : { ...claims, sub };
  return new UnsecuredJWT(payload).encode();
}
