import {
  UnauthorizedError,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Message, sessionBus } from "@jellybrick/dbus-next";
import { AsyncEntry } from "@napi-rs/keyring";
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

const keychainService = "fungi-oyster-mcp";
const warnedFallbackPaths = new Set<string>();

function fileStore(path: string) {
  return createPrivateCredentialStore(path);
}

function fallbackWarning(path: string): void {
  if (warnedFallbackPaths.has(path)) return;
  warnedFallbackPaths.add(path);
  process.stderr.write(
    `fungi: OS keychain unavailable (Linux Secret Service); Oyster key stored/read in 0600 file ${JSON.stringify(path)}.\n`,
  );
}

/**
 * The keyring binding reports both absent and broken services as GenericFailure.
 * Ask the D-Bus owner for typed names, including activatable services, rather
 * than interpreting its human-readable error text or downgrading every error.
 */
async function secretServiceAbsent(): Promise<boolean> {
  const missingBus = z.object({ code: z.enum(["ENOENT", "ECONNREFUSED"]) });
  let bus: ReturnType<typeof sessionBus> | undefined;
  try {
    bus = sessionBus();
    const connectedBus = bus;
    async function names(member: "ListNames" | "ListActivatableNames") {
      const reply = await Promise.race([
        connectedBus.call(
          new Message({
            destination: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            interface: "org.freedesktop.DBus",
            member,
          }),
        ),
        once(connectedBus, "error", { signal: AbortSignal.timeout(3_000) }),
      ]);
      if (Array.isArray(reply)) {
        const error: unknown = reply[0];
        if (error instanceof Error) throw error;
        throw new Error("Cannot connect to the Secret Service session bus");
      }
      if (reply === null)
        throw new Error("Cannot inspect the Secret Service session bus");
      return z.array(z.string()).parse(reply.body[0]);
    }
    const [active, activatable] = await Promise.all([
      names("ListNames"),
      names("ListActivatableNames"),
    ]);
    return (
      !active.includes("org.freedesktop.secrets") &&
      !activatable.includes("org.freedesktop.secrets")
    );
  } catch (cause) {
    if (missingBus.safeParse(cause).success) return true;
    // dbus-next emits a plain Error when it cannot discover any bus address.
    // Without an explicit address, an XDG bus socket or an X11 display, no
    // session bus can be reached; other errors from a reachable bus stay fatal.
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DISPLAY) {
      const runtime = process.env.XDG_RUNTIME_DIR;
      if (!runtime) return true;
      try {
        await access(join(runtime, "bus"));
      } catch (missingSocket) {
        if (missingBus.safeParse(missingSocket).success) return true;
        throw missingSocket;
      }
    }
    throw cause;
  } finally {
    bus?.disconnect();
  }
}

async function keychain(id: string): Promise<AsyncEntry | undefined> {
  try {
    // Do not accept the library's default, nonpersistent Linux keyutils fallback.
    return new AsyncEntry(keychainService, id, {
      linux: { store: "secret-service" },
    });
  } catch (cause) {
    if (process.platform === "linux" && (await secretServiceAbsent()))
      return undefined;
    throw cause;
  }
}

async function movePlaintextKey(
  id: string,
  path: string,
  entry: AsyncEntry,
): Promise<string | null> {
  const store = fileStore(path);
  const legacy = await store.read(id);
  const saved = await entry.getPassword();
  if (legacy === undefined) return saved;
  if (legacy.type !== "api_key" || legacy.key === undefined)
    throw new Error("The saved Oyster MCP credential is invalid");
  const key = oysterKey.parse(legacy.key);
  if (saved !== null && saved !== key)
    throw new Error(
      "The Oyster MCP keychain and plaintext file disagree; refusing to discard either key",
    );
  if (saved === null) await entry.setPassword(key);
  if ((await entry.getPassword()) !== key)
    throw new Error("The Oyster MCP keychain did not retain the migrated key");
  await store.remove(id, async (current) => {
    if (current.type !== "api_key" || current.key !== key)
      throw new Error("The plaintext Oyster MCP key changed during migration");
    if ((await entry.getPassword()) !== key)
      throw new Error("The Oyster MCP keychain changed during migration");
  });
  return key;
}

/** Read bounded UTF-8 stdin, then place the key in OS custody when available. */
export async function saveOysterMcpKey(
  endpoint: URL,
  input: AsyncIterable<Uint8Array>,
  options: { credentialPath?: string } = {},
): Promise<void> {
  const id = credentialId(endpoint);
  const path =
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath;
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
  const entry = await keychain(id);
  if (entry === undefined) {
    await fileStore(path).modify(id, () =>
      Promise.resolve({ type: "api_key", key: parsed.data }),
    );
    fallbackWarning(path);
    return;
  }
  await movePlaintextKey(id, path, entry);
  await entry.setPassword(parsed.data);
  if ((await entry.getPassword()) !== parsed.data)
    throw new Error("The Oyster MCP keychain did not retain the saved key");
}

/** Static bearer auth reads only the selected origin's credential, without discovery. */
export function oysterMcpKeyAuth(
  endpoint: URL,
  options: { credentialPath?: string } = {},
): AuthProvider {
  const id = credentialId(endpoint);
  const path =
    options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath;
  return {
    async token() {
      const entry = await keychain(id);
      if (entry === undefined) {
        const credential = await fileStore(path).read(id);
        fallbackWarning(path);
        if (credential?.type !== "api_key" || credential.key === undefined)
          throw new OysterMcpKeyRejectedError();
        return oysterKey.parse(credential.key);
      }
      const key = await movePlaintextKey(id, path, entry);
      if (key === null) throw new OysterMcpKeyRejectedError();
      return oysterKey.parse(key);
    },
    onUnauthorized() {
      return Promise.reject(new OysterMcpKeyRejectedError());
    },
  };
}
