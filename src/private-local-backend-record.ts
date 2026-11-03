import { z } from "zod";

/**
 * One folder attached to a Computer. The absolute folder path and the device's
 * private key never leave Local's owner-only credential file; the host holds
 * only the public key and the two labels.
 */
const localBackendFields = {
  requestId: z.string().min(1).max(256),
  computerId: z.string().min(1).max(256),
  computerName: z.string().min(1).max(256),
  rootPath: z.string().min(1).max(4096),
  hostLabel: z.string().min(1).max(256),
  folderLabel: z.string().min(1).max(256),
  publicKey: z.base64().length(44),
  privateKey: z.base64().min(1).max(512),
  backendId: z
    .string()
    .regex(/^local-[a-z2-7]{16}$/)
    .optional(),
};

/** A folder attached to a Hub Team Computer; the Hub login holds the record. */
export const hubLocalBackendRecordSchema = z.strictObject({
  ...localBackendFields,
  teamId: z.string().min(1).max(256),
});
export type HubLocalBackendRecord = z.output<
  typeof hubLocalBackendRecordSchema
>;

/** A folder attached to a standalone Oyster's Computer; keyed by its origin. */
const oysterLocalBackendRecordSchema = z.strictObject(localBackendFields);
export type OysterLocalBackendRecord = z.output<
  typeof oysterLocalBackendRecordSchema
>;

/** One standalone Oyster's attached folders, keyed in the credential file by origin. */
export const localBackendsRecordSchema = z.strictObject({
  type: z.literal("local_backends"),
  origin: z.url().refine((value) => new URL(value).origin === value),
  backends: z.array(oysterLocalBackendRecordSchema).min(1).max(16),
});
export type LocalBackendsRecord = z.output<typeof localBackendsRecordSchema>;
