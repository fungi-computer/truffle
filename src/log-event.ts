import * as Redacted from "effect/Redacted";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { privateSqliteFailureCode } from "./private-sqlite-failure.js";
import { z } from "zod";

const tagSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/);
const failureCodeSchema = z.object({ code: tagSchema });
const genericFailureNames: ReadonlySet<string> = new Set(["Error", ""]);

/** A content-free label for a caught failure, or undefined when it has none. */
function failureTag(cause: unknown): string | undefined {
  if (cause instanceof ShiitakeError) return `${cause.boundary}:${cause.cause}`;
  if (!(cause instanceof Error)) return undefined;
  const code = failureCodeSchema.safeParse(cause);
  if (code.success) return code.data.code;
  if (genericFailureNames.has(cause.name)) return undefined;
  const name = tagSchema.safeParse(cause.name);
  return name.success ? name.data : undefined;
}

const listenerFailureSchema = z.object({
  _tag: z.literal("MuleError"),
  phase: z.literal("listener"),
  cause: z.instanceof(ShiitakeError),
});

export type LocalFailureMetadata = Readonly<{
  source: "local-runtime";
  operation: string;
  failureKind: "Error" | "NonErrorThrown";
  /**
   * Which failure this was: a Shiitake `boundary:cause`, a system error code
   * such as `ECONNRESET`, or the error class name. Closed charset and length,
   * never the message, which can hold session or input text.
   */
  failureTag?: string;
  /** Closed, content-free diagnostics for the Mule listener's store failure. */
  recorderCause?: string;
  sqliteCause?: string;
}>;

/** The only persistable projection of a caught Local failure. */
export function localFailureMetadata(
  operation: string,
  cause: unknown,
): LocalFailureMetadata {
  const underlying =
    cause instanceof ShiitakeError ? cause.underlying : undefined;
  const base: LocalFailureMetadata = {
    source: "local-runtime",
    operation,
    failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
  };
  const tag = failureTag(cause);
  const metadata: LocalFailureMetadata =
    tag === undefined ? base : { ...base, failureTag: tag };
  const parsed = listenerFailureSchema.safeParse(underlying);
  if (!parsed.success) return metadata;
  const store = parsed.data.cause;
  const recorderCause = `${store.boundary}:${store.cause}`;
  const sqlite = privateSqliteFailureCode(store.underlying);
  if (sqlite === undefined) return { ...metadata, recorderCause };
  return { ...metadata, recorderCause, sqliteCause: sqlite };
}

/** Retain the original Local failure without printing exception or input text. */
export function logEvent(operation: string, cause: unknown) {
  globalThis.console.error(
    JSON.stringify(localFailureMetadata(operation, cause)),
    Redacted.make(cause),
  );
}
