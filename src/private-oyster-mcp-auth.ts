import {
  UnauthorizedError,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  createPrivateCredentialStore,
  maximumCredentialStringLength,
} from "./private-file-credential-store.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";

/** A selected Oyster refused its key; never fall through to Hub OAuth. */
export class OysterMcpKeyRejectedError extends UnauthorizedError {
  constructor() {
    super(
      "The Oyster MCP key was refused. Replace it with fungi mcp use <url> --from-file -.",
    );
    this.name = "OysterMcpKeyRejectedError";
  }
}

function credentialId(endpoint: URL): string {
  return `oyster-mcp:${parseFungiMcpEndpoint(endpoint).origin}`;
}

// Ear Tag's Oyster producer uses the oyk family and nanoid's URL-safe alphabet.
const oysterKey = z
  .string()
  .trim()
  .min(5)
  .max(maximumCredentialStringLength)
  .regex(/^oyk_[A-Za-z0-9_-]+$/);

/** Read bounded UTF-8 stdin, then place the key in Local's existing private store. */
export async function saveOysterMcpKey(
  endpoint: URL,
  input: AsyncIterable<Uint8Array>,
  options: { credentialPath?: string } = {},
): Promise<void> {
  const id = credentialId(endpoint);
  const store = createPrivateCredentialStore(
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > maximumCredentialStringLength)
      throw new Error("Oyster key input is too large");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const parsed = oysterKey.safeParse(text);
  if (!parsed.success) throw new Error("Expected one Oyster oyk_ key on stdin");
  await store.modify(id, () =>
    Promise.resolve({ type: "api_key", key: parsed.data }),
  );
}

/** Static bearer auth reads only the selected origin's credential, without discovery. */
export function oysterMcpKeyAuth(
  endpoint: URL,
  options: { credentialPath?: string } = {},
): AuthProvider {
  const id = credentialId(endpoint);
  const store = createPrivateCredentialStore(
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  );
  return {
    async token() {
      const credential = await store.read(id);
      if (credential?.type !== "api_key" || credential.key === undefined)
        throw new OysterMcpKeyRejectedError();
      return credential.key;
    },
    onUnauthorized() {
      return Promise.reject(new OysterMcpKeyRejectedError());
    },
  };
}
