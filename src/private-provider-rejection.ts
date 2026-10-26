import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import type { ProviderRejection } from "@fungi.computer/mule";

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
    failure.rejection?.code === "provider_unavailable"
  );
}

/** The one owned wording for a failed Local model request. */
export function modelFailureMessage(
  provider: string,
  failure: ModelFailureInput,
): string {
  if (failure.refusal !== undefined)
    return `${failure.refusal.category}: ${failure.refusal.message}`;
  // Typed subscription evidence wins over all SDK/provider wording.
  if (failure.rejection?.code === "usage-limit-reached")
    return `${provider} usage limit reached (usage-limit-reached). Check ChatGPT Settings > Usage, then try again later.`;
  if (modelFailureRetryable(failure))
    return `${provider} service unavailable. Try again shortly.`;
  if (failure.upstream !== undefined) {
    if (isContextOverflow(failure.upstream))
      return `${provider} request exceeds the context window. Compact the Session or choose another model.`;
  }
  if (failure.rejection?.code === "provider_rejected")
    return `${provider} rejected the model request (${failure.rejection.code}, HTTP ${String(failure.rejection.status)}). Check /login or choose another model with /model.`;
  return `${provider} model request failed without a provider rejection. Retry the request.`;
}
