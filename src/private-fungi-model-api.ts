import process from "node:process";
import { fungiAccountFetch } from "./private-fungi-account.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import { FungiSignInRequiredError } from "./private-fungi-auth-error.js";
import {
  hasApi,
  type ProviderStreams,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import {
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
  loginAllowed,
  subscriptionKillSwitchFrom,
} from "@fungi.computer/veil/model-credentials";
import { z } from "zod";
import { logEvent } from "./log-event.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";

const refusalSchema = z.object({
  error: z.object({ code: z.string().max(256), message: z.string().max(4096) }),
});

/** Re-check incident policy at dispatch, including in an already-open Local host. */
function fungiModelsEnabled() {
  return loginAllowed(
    {
      providerId: "fungi",
      method: "subscription",
      host: "local",
      scope: "user",
    },
    subscriptionKillSwitchFrom(process.env.FUNGI_SUBSCRIPTION_KILL),
  );
}
export function assertFungiModelsEnabled(): void {
  if (!fungiModelsEnabled())
    throw new Error("Fungi models are paused. Try again later.");
}
function httpRefusal(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, type: "fungi_error" } },
    { status },
  );
}

/** Map Hub refusal codes to actions without returning dependency bodies. */
function modelRefusal(status: number, body: unknown, teamName: string) {
  const refusal = refusalSchema.safeParse(body);
  const code = refusal.success ? refusal.data.error.code : "unavailable";
  let message = refusal.success
    ? refusal.data.error.message
    : "Fungi could not complete this request. Retry shortly.";
  if (["invalid_token", "insufficient_scope"].includes(code) || status === 401)
    message = "Sign in to Fungi again to use models";
  else if (["insufficient_quota", "subscription_required"].includes(code))
    message = `Add credits to ${teamName}`;
  else if (status === 503)
    message =
      code === "paused"
        ? "Fungi models are paused. Try again later."
        : "Fungi is unreachable. Retry shortly.";
  return Response.json(
    { error: { code, message, type: "fungi_error" } },
    { status: status },
  );
}

/** The parsed destination must stay in the selected Team, with no redirect authority. */
function assertModelEndpoint(base: URL, url: URL) {
  if (
    url.origin !== base.origin ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    ![`${base.pathname}/models`, `${base.pathname}/chat/completions`].includes(
      url.pathname,
    )
  )
    throw new Error("Fungi refused a model endpoint outside the selected Team");
}

/** Access tokens can only travel to the selected Team's two inference endpoints. */
export function fungiModelFetch(
  baseUrl: string,
  teamName: string,
  fetchImpl: FetchFunction = globalThis.fetch,
  credentialPath: string = capturePrivateLocalConfigRoot().credentialPath,
): FetchFunction {
  const base = parseFungiMcpEndpoint(baseUrl);
  if (!/^\/api\/v1\/teams\/[^/]+$/u.test(base.pathname))
    throw new Error("Fungi model requests require a selected Team");
  const accountOptions = {
    fetch: fetchImpl,
    credentialPath,
  };
  const accountFetch = fungiAccountFetch(base.origin, accountOptions);
  const transport = async (
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ) => {
    if (!fungiModelsEnabled())
      return httpRefusal(
        503,
        "paused",
        "Fungi models are paused. Try again later.",
      );
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertModelEndpoint(base, url);
    let response: Response;
    try {
      response = await accountFetch(input, { ...init, redirect: "error" });
    } catch (cause) {
      if (init?.signal?.aborted) throw cause;
      if (cause instanceof FungiSignInRequiredError)
        return httpRefusal(
          401,
          "invalid_token",
          "Sign in to Fungi again to use models",
        );
      logEvent("fungi-model.request", cause);
      return httpRefusal(
        503,
        "unavailable",
        "Fungi is unreachable. Retry when your Hub connection returns.",
      );
    }
    if (response.ok) return response;
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      logEvent("fungi-model.refusal", cause);
      return httpRefusal(
        503,
        "unavailable",
        "Fungi is unreachable or returned an unreadable refusal. Retry shortly.",
      );
    }
    return modelRefusal(response.status, body, teamName);
  };
  return Object.assign(transport, { preconnect: fetchImpl.preconnect });
}

/** Pi owns streaming; this adapter owns Fungi's destination, incident policy and refusals. */
export function createFungiModelApi(
  resolveTeamName: (baseUrl: string) => Promise<string>,
  credentialPath: string = capturePrivateLocalConfigRoot().credentialPath,
): ProviderStreams {
  const fetchFor = (
    baseUrl: string,
    fetchImpl: FetchFunction = globalThis.fetch,
  ): FetchFunction =>
    Object.assign(
      async (
        input: Parameters<FetchFunction>[0],
        init?: Parameters<FetchFunction>[1],
      ) => {
        const teamName = await resolveTeamName(baseUrl);
        return fungiModelFetch(
          baseUrl,
          teamName,
          fetchImpl,
          credentialPath,
        )(input, init);
      },
      { preconnect: fetchImpl.preconnect },
    );
  return {
    stream(model, context, options) {
      if (!hasApi(model, "openai-completions"))
        throw new Error("Fungi requires its compatible chat API");
      return stream(model, context, {
        ...options,
        maxRetries: 0,
        fetch: fetchFor(model.baseUrl, options?.fetch),
      });
    },
    streamSimple(model, context, options) {
      if (!hasApi(model, "openai-completions"))
        throw new Error("Fungi requires its compatible chat API");
      return streamSimple(model, context, {
        ...options,
        maxRetries: 0,
        fetch: fetchFor(model.baseUrl, options?.fetch),
      });
    },
  };
}
