import * as Redacted from "effect/Redacted";

/** Retain the original Local failure without printing exception or input text. */
export function logEvent(operation: string, cause: unknown) {
  globalThis.console.error(
    JSON.stringify({
      source: "local-runtime",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
    Redacted.make(cause),
  );
}
