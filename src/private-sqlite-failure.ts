import { z } from "zod";

export type PrivateSqliteFailureCode =
  "busy" | "locked" | "corrupt" | "not_a_database" | "other";

const sqliteFailureSchema = z.union([
  z
    .object({
      code: z.literal("ERR_SQLITE_ERROR"),
      errcode: z.number().int(),
    })
    .transform((failure) => failure.errcode),
  z
    .object({
      code: z.string().startsWith("SQLITE_"),
      errno: z.number().int(),
    })
    .transform((failure) => failure.errno),
]);
const sqlitePrimaryCodeMask = 0xff;

/** Decode the maintained drivers' structured result codes before sanitizing. */
export function privateSqliteFailureCode(
  cause: unknown,
): PrivateSqliteFailureCode | undefined {
  const parsed = sqliteFailureSchema.safeParse(cause);
  if (!parsed.success) return undefined;
  switch (parsed.data & sqlitePrimaryCodeMask) {
    case 5:
      return "busy";
    case 6:
      return "locked";
    case 11:
      return "corrupt";
    case 26:
      return "not_a_database";
    default:
      return "other";
  }
}
