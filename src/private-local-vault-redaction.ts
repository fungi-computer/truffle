import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { ShiitakeOptions } from "@fungi.computer/shiitake";
import {
  createFingerprintRedactor,
  createFingerprintSet,
} from "@fungi.computer/veil/redaction";

/**
 * Local's Vault port for Shiitake: fingerprints of the secrets this machine
 * stores (model API keys and sign-in tokens), so Sessions refuse a pasted
 * stored value and scrub one from output without holding the value.
 *
 * Each load reads the credential file again, so a new /login counts at once.
 * Provider env values are left out: they mix secrets with plain settings
 * such as regions, and Veil's maintained patterns already find provider keys.
 */
export function openLocalVaultRedaction(
  credentials: Pick<CredentialStore, "list" | "read">,
): NonNullable<ShiitakeOptions["redaction"]> {
  // The fingerprint subkey's only owner is this process, which already holds
  // the values; it never leaves memory.
  const ownerKey = crypto.getRandomValues(new Uint8Array(32));
  return {
    load: async () => {
      const values: string[] = [];
      for (const { providerId } of await credentials.list())
        values.push(...secretValues(await credentials.read(providerId)));
      return createFingerprintRedactor(
        await createFingerprintSet(ownerKey, values),
      );
    },
  };
}

/** Veil refuses values shorter than its eight-code-unit fingerprint anchor. */
const fingerprintableLength = 8;

function secretValues(credential: Credential | undefined): string[] {
  const values =
    credential === undefined
      ? []
      : credential.type === "api_key"
        ? [credential.key]
        : [credential.access, credential.refresh];
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          value !== undefined && value.length >= fingerprintableLength,
      ),
    ),
  ];
}
