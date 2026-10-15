import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeJwt } from "jose";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { logEvent } from "./log-event.js";
import { resolveDefaultCredentialPath } from "./private-file-credential-store.js";

const identitySchema = z.strictObject({
  issuer: z.url().max(2048),
  userId: z.string().min(1).max(256),
  loginId: z.string().min(1).max(256),
});
const detachSchema = z.strictObject({
  teamId: z.string().min(1).max(256),
  computerId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
});
export type PendingDetach = z.output<typeof detachSchema>;
const recordSchema = identitySchema.extend({
  revoke: z.boolean(),
  detaches: z.array(detachSchema).max(16),
});
const recordsSchema = z.array(recordSchema).max(128);
type PendingLogout = z.output<typeof recordSchema>;
const missingFile = z.object({ code: z.literal("ENOENT") });
export type LoginIdentity = z.output<typeof identitySchema>;

/** Decode only routing metadata. These IDs never authorize a revocation. */
export function loginIdentity(
  issuer: string,
  access: string,
): LoginIdentity | undefined {
  try {
    const claims = decodeJwt(access);
    return identitySchema.parse({
      issuer,
      userId: claims.sub,
      loginId: claims["https://fungi.computer/oauth/login"],
    });
  } catch (cause) {
    logEvent("fungi-account.pending-revoke-identity", cause);
    return undefined;
  }
}

function matches(left: LoginIdentity, right: LoginIdentity): boolean {
  return (
    left.issuer === right.issuer &&
    left.userId === right.userId &&
    left.loginId === right.loginId
  );
}

/** Durable logout intent, separate from the credential that logout destroys. */
export function pendingLogouts(
  credentialPath = resolveDefaultCredentialPath(),
) {
  const path = `${credentialPath}.pending-logouts.json`;
  async function update<T>(
    change: (records: PendingLogout[]) => {
      records: PendingLogout[];
      result: T;
    },
  ): Promise<T> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      let records: PendingLogout[] = [];
      try {
        const file = await open(path, "r");
        try {
          if ((await file.stat()).size > 256 * 1024)
            throw new Error("Pending revocations exceed the storage limit");
          records = recordsSchema.parse(
            JSON.parse(await file.readFile("utf8")),
          );
        } finally {
          await file.close();
        }
      } catch (cause) {
        if (!missingFile.safeParse(cause).success) throw cause;
      }
      const changed = change(records);
      const serialized = JSON.stringify(recordsSchema.parse(changed.records));
      if (Buffer.byteLength(serialized) > 256 * 1024)
        throw new Error("Pending revocations exceed the storage limit");
      await writeFileAtomic(path, serialized, {
        encoding: "utf8",
        fsync: true,
        mode: 0o600,
      });
      return changed.result;
    } finally {
      await release();
    }
  }
  return {
    remember(
      identity: LoginIdentity,
      detaches: PendingDetach[],
    ): Promise<void> {
      return update((records) => {
        const next = [
          ...records.filter((record) => !matches(record, identity)),
          recordSchema.parse({ ...identity, revoke: true, detaches }),
        ];
        let evicted = false;
        while (
          next.length > 128 ||
          Buffer.byteLength(JSON.stringify(next)) > 256 * 1024
        ) {
          next.shift();
          evicted = true;
        }
        if (evicted)
          logEvent(
            "fungi-account.pending-logout-evicted",
            new Error("Oldest logout intent evicted at storage limit"),
          );
        return { records: next, result: undefined };
      });
    },
    confirmed(identity: LoginIdentity, detach?: PendingDetach): Promise<void> {
      return update((records) => ({
        records: records
          .map((record) => {
            if (!matches(record, identity)) return record;
            return detach === undefined
              ? { ...record, revoke: false }
              : {
                  ...record,
                  detaches: record.detaches.filter(
                    (item) =>
                      item.teamId !== detach.teamId ||
                      item.computerId !== detach.computerId ||
                      item.requestId !== detach.requestId,
                  ),
                };
          })
          .filter((record) => record.revoke || record.detaches.length > 0),
        result: undefined,
      }));
    },
    forAccount(identity: LoginIdentity): Promise<PendingLogout[]> {
      return update((records) => {
        const kept = records.filter(
          (record) =>
            record.issuer === identity.issuer &&
            record.userId === identity.userId,
        );
        return {
          records: kept,
          result: kept,
        };
      });
    },
  };
}
