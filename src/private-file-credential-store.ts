import { correlationKey } from "@fungi.computer/cairn";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  ApiKeyCredential,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const maximumCredentialFileBytes = 256 * 1_024;
const maximumCredentialEntries = 128;
const maximumProviderIdLength = 256;
export const maximumCredentialStringLength = 64 * 1_024;
const maximumEnvironmentEntries = 64;
const maximumExtensionEntries = 64;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const lockOptions: lockfile.LockOptions = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
  retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 100 },
};

const providerIdSchema = z.string().min(1).max(maximumProviderIdLength);
const credentialStringSchema = z.string().max(maximumCredentialStringLength);
const environmentSchema = z
  .record(
    z.string().min(1).max(maximumProviderIdLength),
    credentialStringSchema,
  )
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > maximumEnvironmentEntries) {
      context.addIssue({
        code: "custom",
        message: "Credential environment contains too many entries",
      });
    }
  });
const apiKeyCredentialSchema = z
  .strictObject({
    type: z.literal("api_key"),
    key: credentialStringSchema.optional(),
    env: environmentSchema.optional(),
  })
  .transform((input): ApiKeyCredential => {
    const credential: ApiKeyCredential = { type: "api_key" };
    if (input.key !== undefined) credential.key = input.key;
    if (input.env !== undefined) credential.env = input.env;
    return credential;
  });
const oauthCredentialSchema = z
  .object({
    type: z.literal("oauth"),
    refresh: credentialStringSchema,
    access: credentialStringSchema,
    expires: z.number(),
  })
  .catchall(z.json())
  .superRefine((credential, context) => {
    if (Object.keys(credential).length > maximumExtensionEntries + 4) {
      context.addIssue({
        code: "custom",
        message: "OAuth credential contains too many entries",
      });
    }
    for (const key of Object.keys(credential)) {
      if (key.length > maximumProviderIdLength) {
        context.addIssue({
          code: "custom",
          message: "OAuth credential contains an oversized key",
        });
      }
    }
  });
const credentialSchema = z.discriminatedUnion("type", [
  apiKeyCredentialSchema,
  oauthCredentialSchema,
]);
const credentialMapSchema = z
  .record(providerIdSchema, credentialSchema)
  .superRefine((credentials, context) => {
    if (Object.keys(credentials).length > maximumCredentialEntries) {
      context.addIssue({
        code: "custom",
        message: "Credential store contains too many providers",
      });
    }
  });
const missingFileErrorSchema = z.object({ code: z.literal("ENOENT") });

type CredentialMap = Record<string, Credential>;
export type AtomicWrite = (
  path: string,
  content: string,
  options: Readonly<{
    encoding: BufferEncoding;
    fsync: boolean;
    mode: number;
  }>,
) => Promise<void>;

/** A host-private Pi credential store selected by one absolute filesystem path. */
export type PrivateCredentialStore = CredentialStore & {
  /** Stable host identity supplied to Pi's ChatGPT sign-in, never a credential. */
  getDeviceId(): Promise<string>;
  /** Revoke or validate current custody under the same lock, then delete it atomically. */
  remove<T>(
    providerId: string,
    beforeRemove: (credential: Credential) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T | undefined>;
};

/** Resolve the host-owned default path without consulting project or Agent Home state. */
export function resolveDefaultCredentialPath(home = homedir()): string {
  if (!isAbsolute(home)) {
    throw new Error("Default credential home must be absolute");
  }
  return resolve(home, ".config", "fungi", "credentials.json");
}

function credentialStoreError(message: string): Error {
  return new Error(message);
}

function ownCredential(
  credentials: CredentialMap | undefined,
  providerId: string,
): Credential | undefined {
  if (credentials === undefined || !Object.hasOwn(credentials, providerId)) {
    return undefined;
  }
  return credentials[providerId];
}

function parseCredentials(serialized: string): CredentialMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw credentialStoreError("Credential store contains malformed JSON");
  }

  const result = credentialMapSchema.safeParse(parsed);
  if (!result.success) {
    throw credentialStoreError(
      "Credential store contains invalid credential data",
    );
  }
  return result.data;
}

/**
 * Internal constructor permits one focused write-failure test while the public
 * package surface remains the Pi CredentialStore factory below.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #writeAtomic: AtomicWrite;

  constructor(path: string, writeAtomic: AtomicWrite = writeFileAtomic) {
    if (!isAbsolute(path)) {
      throw new Error("Private credential path must be absolute");
    }
    this.#path = path;
    this.#writeAtomic = writeAtomic;
  }

  /** Keep the installation UUID beside credentials, across logout and restart. */
  async getDeviceId(): Promise<string> {
    return this.#withLock(async () => {
      const path = `${this.#path}.device-id`;
      let handle: FileHandle;
      try {
        handle = await open(path, "r");
      } catch (error) {
        if (!missingFileErrorSchema.safeParse(error).success) throw error;
        const id = correlationKey();
        await this.#writeAtomic(path, id, {
          encoding: "utf8",
          fsync: true,
          mode: privateFileMode,
        });
        return id;
      }
      try {
        // A UUID has exactly 36 bytes; the extra byte detects oversized input.
        const bytes = Buffer.alloc(37);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const parsed = z
          .uuid()
          .safeParse(bytes.subarray(0, bytesRead).toString("utf8"));
        if (!parsed.success)
          throw credentialStoreError("Local model device ID is invalid");
        return parsed.data;
      } finally {
        await handle.close();
      }
    });
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return ownCredential(await this.#readCredentials(), providerId);
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const credentials = await this.#readCredentials();
    if (credentials === undefined) return [];
    return Object.entries(credentials).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    callback: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return await this.#withLock(async () => {
      options?.signal?.throwIfAborted();
      const credentials = (await this.#readCredentials()) ?? {};
      const current = ownCredential(credentials, providerId);
      const next = await callback(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;

      const validated = this.#validateCredentials({
        ...credentials,
        [providerId]: next,
      });
      await this.#replace(validated);
      const persisted = ownCredential(validated, providerId);
      if (persisted === undefined) {
        throw credentialStoreError(
          "Credential store failed to retain its update",
        );
      }
      return persisted;
    });
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    await this.remove(providerId, () => Promise.resolve(), options);
  }

  async remove<T>(
    providerId: string,
    beforeRemove: (credential: Credential) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T | undefined> {
    options?.signal?.throwIfAborted();
    return this.#withLock(async () => {
      options?.signal?.throwIfAborted();
      const credentials = await this.#readCredentials();
      const current = ownCredential(credentials, providerId);
      if (credentials === undefined || current === undefined) return undefined;
      const result = await beforeRemove(current);
      const next = Object.fromEntries(
        Object.entries(credentials).filter(([id]) => id !== providerId),
      );
      options?.signal?.throwIfAborted();
      await this.#replace(this.#validateCredentials(next));
      return result;
    });
  }

  #validateCredentials(credentials: CredentialMap): CredentialMap {
    const result = credentialMapSchema.safeParse(credentials);
    if (!result.success) {
      throw credentialStoreError(
        "Credential update contains invalid credential data",
      );
    }
    return result.data;
  }

  async #readCredentials(): Promise<CredentialMap | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(this.#path, "r");
    } catch (error) {
      if (missingFileErrorSchema.safeParse(error).success) return undefined;
      throw error;
    }
    try {
      const bytes = Buffer.alloc(maximumCredentialFileBytes + 1);
      let totalBytesRead = 0;
      while (totalBytesRead < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          totalBytesRead,
          bytes.length - totalBytesRead,
          totalBytesRead,
        );
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      if (totalBytesRead > maximumCredentialFileBytes) {
        throw credentialStoreError(
          "Credential store exceeds its private file bound",
        );
      }
      return parseCredentials(
        bytes.subarray(0, totalBytesRead).toString("utf8"),
      );
    } finally {
      await handle.close();
    }
  }

  async #replace(credentials: CredentialMap): Promise<void> {
    await this.#writeAtomic(this.#path, JSON.stringify(credentials), {
      encoding: "utf8",
      fsync: true,
      mode: privateFileMode,
    });
  }

  /**
   * proper-lockfile bounds acquisition through retries but cannot cancel it
   * while queued. Callers check their signal before acquisition and
   * immediately after it succeeds.
   */
  async #withLock<Value>(callback: () => Promise<Value>): Promise<Value> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: privateDirectoryMode });
    await chmod(directory, privateDirectoryMode);
    const release = await lockfile.lock(this.#path, lockOptions);
    try {
      return await callback();
    } finally {
      await release();
    }
  }
}

/** Create the one private Pi CredentialStore selected by the local host. */
export function createPrivateCredentialStore(
  path = resolveDefaultCredentialPath(),
): PrivateCredentialStore {
  return new FileCredentialStore(path);
}
