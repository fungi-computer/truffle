import * as Redacted from "effect/Redacted";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { privateSqliteFailureCode } from "./private-sqlite-failure.js";
import { z } from "zod";

const listenerFailureSchema = z.object({
  _tag: z.literal("MuleError"),
  phase: z.literal("listener"),
  cause: z.instanceof(ShiitakeError),
});

export type LocalFailureMetadata = Readonly<{
  source: "local-runtime";
  operation: string;
  failureKind: "Error" | "NonErrorThrown";
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
  const metadata: LocalFailureMetadata = {
    source: "local-runtime",
    operation,
    failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
  };
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
