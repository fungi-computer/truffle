import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import {
  isRetryableProviderRejection,
  type ProviderRejection,
} from "@fungi.computer/mule";

/** Evidence owned by one Local request, never inferred from assistant prose. */
export type ModelFailureInput = Readonly<{
  refusal?: Readonly<{ category: string; message: string }> | undefined;
  upstream?: AssistantMessage | undefined;
  rejection?: ProviderRejection | undefined;
}>;

/** Local retries only a typed transient, never cancellation or a turn refusal. */
export function modelFailureRetryable(failure: ModelFailureInput): boolean {
  return (
    failure.refusal === undefined &&
    failure.upstream?.stopReason !== "aborted" &&
    isRetryableProviderRejection(failure.rejection)
  );
}

/** The one owned wording for a failed Local model request. */
export function modelFailureMessage(
  provider: string,
  failure: ModelFailureInput,
): string {
  const name =
    provider === "anthropic"
      ? "Anthropic"
      : provider === "openai"
        ? "OpenAI"
        : provider;
  if (failure.refusal !== undefined)
    return `${failure.refusal.category}: ${failure.refusal.message}`;
  // Typed subscription evidence wins over all SDK/provider wording.
  if (failure.rejection?.code === "usage-limit-reached") {
    const subscription =
      provider === "anthropic"
        ? " on your Claude subscription"
        : provider === "openai"
          ? " on your ChatGPT subscription"
          : "";
    const resetAt = failure.rejection.resetAt;
    const reset =
      resetAt === undefined
        ? ""
        : `; resets at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(resetAt)}`;
    return `${name} usage limit reached${subscription}${reset}.`;
  }
  if (failure.rejection?.code === "rate-limit")
    return `${name} rate limit reached; try again shortly.`;
  if (failure.rejection?.code === "overloaded")
    return `${name} is overloaded; try again shortly.`;
  if (failure.rejection?.code === "provider_unavailable")
    return `${name} is unavailable; try again shortly.`;
  if (failure.upstream !== undefined) {
    if (isContextOverflow(failure.upstream))
      return `${name} request exceeds the context window; compact the Session or choose another model.`;
  }
  if (failure.rejection?.code === "provider_rejected")
    return `${name} rejected the request (HTTP ${String(failure.rejection.status)}); check your sign-in or choose another model.`;
  return `${name} model request failed; try again.`;
}
