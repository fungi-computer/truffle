import * as Redacted from "effect/Redacted";

export type LocalFailureMetadata = Readonly<{
  source: "local-runtime";
  operation: string;
  failureKind: "Error" | "NonErrorThrown";
}>;

/** The only persistable projection of a caught Local failure. */
export function localFailureMetadata(
  operation: string,
  cause: unknown,
): LocalFailureMetadata {
  return {
    source: "local-runtime",
    operation,
    failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
  };
}

/** Retain the original Local failure without printing exception or input text. */
export function logEvent(operation: string, cause: unknown) {
  globalThis.console.error(
    JSON.stringify(localFailureMetadata(operation, cause)),
    Redacted.make(cause),
  );
}
