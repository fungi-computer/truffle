import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  createPrivateCredentialStore,
  oauthCredentialSchema,
} from "./private-file-credential-store.js";

const maximumInputBytes = 256 * 1024;
const providerSchema = z.enum(["anthropic", "openai"]);
const subscriptionSchema = oauthCredentialSchema.refine(
  (value) => value.access.length > 0 && value.refresh.length > 0,
);
const activationSchema = z.strictObject({
  expected: subscriptionSchema.nullable(),
  credential: subscriptionSchema,
});

/** Fixed categories only: neither parser diagnostics nor filesystem causes escape. */
export class CredentialActivationError extends Error {
  constructor(
    readonly category:
      "invalid-input" | "conflict" | "store-failure" | "identity-unavailable",
  ) {
    super(`Credential activation: ${category}`);
    this.name = "CredentialActivationError";
  }
}

/** The credential owner performs a provider-scoped CAS under its refresh lock. */
export async function activateSubscriptionCredential(
  provider: string,
  input: AsyncIterable<Uint8Array>,
  options: { credentialPath?: string } = {},
): Promise<void> {
  const providerId = providerSchema.safeParse(provider);
  if (!providerId.success) throw new CredentialActivationError("invalid-input");
  const credentialPath =
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      size += chunk.byteLength;
      if (size > maximumInputBytes)
        throw new CredentialActivationError("invalid-input");
      chunks.push(chunk);
    }
  } catch {
    throw new CredentialActivationError("invalid-input");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CredentialActivationError("invalid-input");
  }
  const parsed = activationSchema.safeParse(decoded);
  if (!parsed.success) throw new CredentialActivationError("invalid-input");
  try {
    await createPrivateCredentialStore(credentialPath).modify(
      providerId.data,
      (current) => {
        if (!isDeepStrictEqual(current ?? null, parsed.data.expected))
          throw new CredentialActivationError("conflict");
        return Promise.resolve(parsed.data.credential);
      },
    );
  } catch (error) {
    if (error instanceof CredentialActivationError) throw error;
    throw new CredentialActivationError("store-failure");
  }
}
