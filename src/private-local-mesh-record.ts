import { z } from "zod";

const id = z.string().min(1).max(256);
const selected = z.strictObject({
  localAgentId: id,
  databasePath: z.string().min(1).max(4096),
  name: id,
});
export const machineBindingSchema = z.strictObject({
  selection: z.number().int().min(0).max(255),
  agentId: id,
});
const common = z.strictObject({
  requestId: id,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("oauth"), teamId: id }),
    z.strictObject({ kind: z.literal("oyster") }),
  ]),
  invocationRoot: z.string().min(1).max(4096),
  machineLabel: id,
  publicKey: z.base64().length(44),
  privateKey: z.base64().min(1).max(512),
  agents: z.array(selected).max(256),
});

/** Private credential-file state; only public key, label and names go to Hub. */
export const localMachineEnrollmentSchema = z.discriminatedUnion("state", [
  common.extend({ state: z.literal("pending") }),
  common.extend({
    state: z.literal("enrolled"),
    scopeId: id,
    deviceId: id,
    bindings: z.array(machineBindingSchema).max(256),
  }),
]);
export type LocalMachineEnrollment = z.infer<
  typeof localMachineEnrollmentSchema
>;

const origin = z.url().refine((value) => new URL(value).origin === value);
export const machineEnrollmentAuthoritySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("oauth"), origin }),
  z.strictObject({ kind: z.literal("oyster"), origin }),
]);
export type MachineEnrollmentAuthority = z.infer<
  typeof machineEnrollmentAuthoritySchema
>;

/**
 * One authority's device enrollments, keyed in the credential file by origin:
 * a standalone Oyster's, or a Fungi issuer's partition. Every enrollment in a
 * record names the same authority kind. Never a Pi credential or a bearer.
 */
export const machineEnrollmentRecordSchema = z.strictObject({
  type: z.literal("machine_enrollment"),
  origin,
  enrollments: z
    .array(localMachineEnrollmentSchema)
    .max(256)
    .refine((records) =>
      records.every((record) => record.target.kind === records[0]?.target.kind),
    ),
});
export type MachineEnrollmentRecord = z.infer<
  typeof machineEnrollmentRecordSchema
>;

/** The authority kind a record's enrollments serve; none for an empty record. */
export function machineEnrollmentRecordKind(
  record: MachineEnrollmentRecord,
): MachineEnrollmentAuthority["kind"] | undefined {
  return record.enrollments[0]?.target.kind;
}

/** The existing credential owner lends its one cross-process transaction. */
export type LocalMachineEnrollmentAccount = Readonly<{
  read: () => Promise<
    (MachineEnrollmentAuthority & { enrollments: LocalMachineEnrollment[] })[]
  >;
  update: (
    authority: MachineEnrollmentAuthority,
    edit: (
      current: readonly LocalMachineEnrollment[],
    ) => LocalMachineEnrollment[],
  ) => Promise<void>;
}>;
