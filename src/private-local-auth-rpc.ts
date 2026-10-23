import type {
  AuthInteraction,
  AuthPrompt,
  AuthEvent,
} from "@earendil-works/pi-ai";
import { RpcTarget, type RpcStub } from "@fungi.computer/capnweb";
import { z } from "zod";
import {
  fungiAccountLogoutRequestSchema,
  fungiAccountLogoutResultSchema,
  type FungiAccountLogoutRequest,
  type FungiAccountLogoutResult,
} from "./private-fungi-service-logout.js";
import {
  LocalAuthRefusal,
  localAuthInputLimit,
  runLocalAuthCli,
  type LocalAuthResult,
} from "./auth-cli.js";
import { openAIIdentityDetailSchema } from "./private-openai-claims.js";
import { CredentialActivationError } from "./subscription-activation.js";
import { OpenAIIdentityUnavailable } from "./subscription-identity.js";

const requestSchema = z.object({
  command: z.enum(["login", "logout", "status"]),
  provider: z.string().optional(),
  authType: z.enum(["oauth", "api_key"]).optional(),
  method: z.string().optional(),
});
export type PrivateLocalAuthRequest = z.infer<typeof requestSchema>;
const authStatusSchema = z.discriminatedUnion("state", [
  z.object({
    providerId: z.string(),
    providerName: z.string(),
    state: z.literal("unconfigured"),
  }),
  z.object({
    providerId: z.string(),
    providerName: z.string(),
    state: z.literal("configured"),
    type: z.enum(["oauth", "api_key"]),
  }),
]);
const authResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({
    kind: z.literal("status"),
    providers: z.array(authStatusSchema),
  }),
]);

// Only Pi's serializable presentation crosses RPC; AbortSignals stay local.
const promptSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    type: z.literal("secret"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    type: z.literal("manual_code"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.object({
    type: z.literal("select"),
    message: z.string(),
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
]);
export type AuthPromptRequest = z.infer<typeof promptSchema>;

const linkSchema = z.object({ url: z.string(), label: z.string().optional() });
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("info"),
    message: z.string(),
    links: z.array(linkSchema).optional(),
  }),
  z.object({ type: z.literal("progress"), message: z.string() }),
  z.object({
    type: z.literal("auth_url"),
    url: z.string(),
    instructions: z.string().optional(),
  }),
  z.object({
    type: z.literal("device_code"),
    userCode: z.string(),
    verificationUri: z.string(),
    intervalSeconds: z.number().optional(),
    expiresInSeconds: z.number().optional(),
  }),
]);
const answerSchema = z.string().max(localAuthInputLimit);

/**
 * The closed set of failures that cross the service. Provider errors can
 * contain credential material, so no free text, cause or provider message
 * crosses: only a fixed category, HTTP status, or missing-person claim NAMES.
 */
const localAuthFailureSchema = z.discriminatedUnion("category", [
  z.strictObject({
    category: z.literal("identity-unavailable"),
    detail: openAIIdentityDetailSchema.optional(),
  }),
  z.strictObject({ category: z.literal("callback-port-in-use") }),
  z.strictObject({ category: z.literal("oauth-state-mismatch") }),
  z.strictObject({
    category: z.literal("token-exchange-rejected"),
    status: z.number().int().min(100).max(599),
  }),
  z.strictObject({ category: z.literal("cancelled") }),
  z.strictObject({ category: z.literal("no-key-entered") }),
  z.strictObject({ category: z.literal("unknown") }),
]);
type LocalAuthFailureCategory = z.output<typeof localAuthFailureSchema>;
/** What one auth RPC operation returns: a result or a typed failure. */
export type LocalAuthWireResult = z.output<typeof wireResultSchema>;
const wireResultSchema = z.union([
  authResultSchema,
  z.strictObject({
    kind: z.literal("failed"),
    failure: localAuthFailureSchema,
  }),
]);

/** Pi 1.3.0's fixed error prefixes; never retain a provider body suffix. */
const callbackPortInUse = /^Port \d+ is in use\b/u;
const oauthStateMismatch = "OAuth state mismatch";
const openAITokenRequestFailed =
  /^OpenAI OAuth token request failed \(([1-5]\d{2})\)/u;

function classifyFailure(
  cause: unknown,
  aborted: boolean,
): LocalAuthFailureCategory {
  if (aborted) return { category: "cancelled" };
  if (cause instanceof LocalAuthRefusal) return { category: "no-key-entered" };
  if (cause instanceof OpenAIIdentityUnavailable)
    return { category: "identity-unavailable", detail: cause.detail };
  if (
    cause instanceof CredentialActivationError &&
    cause.category === "identity-unavailable"
  )
    return { category: "identity-unavailable" };
  if (cause instanceof Error) {
    const tokenRequest = openAITokenRequestFailed.exec(cause.message);
    if (tokenRequest !== null)
      return {
        category: "token-exchange-rejected",
        status: Number(tokenRequest[1]),
      };
  }
  if (cause instanceof Error && callbackPortInUse.test(cause.message))
    return { category: "callback-port-in-use" };
  if (cause instanceof Error && cause.message === oauthStateMismatch)
    return { category: "oauth-state-mismatch" };
  return { category: "unknown" };
}

/** Fixed wording per category; the dialog shows exactly this. */
function failureText(failure: LocalAuthFailureCategory): string {
  switch (failure.category) {
    case "identity-unavailable": {
      const detail = failure.detail;
      if (detail === undefined)
        return "Sign-in could not establish the account identity (identity-unavailable). Nothing was saved.";
      const auth =
        detail.authClaimNames === undefined
          ? ""
          : "; auth claims: " + (detail.authClaimNames.join(", ") || "none");
      return (
        "OpenAI sign-in did not identify the person (identity-unavailable: " +
        detail.claim +
        " " +
        detail.problem +
        "; claims: " +
        (detail.claimNames.join(", ") || "none") +
        auth +
        "). Nothing was saved."
      );
    }
    case "callback-port-in-use":
      return "The sign-in callback port is in use, probably by another sign-in or the Codex CLI. Close it and try again.";
    case "oauth-state-mismatch":
      return "The sign-in redirect did not belong to this attempt. Start the sign-in again.";
    case "token-exchange-rejected":
      return `OpenAI refused the sign-in token exchange (HTTP ${String(failure.status)}).`;
    case "cancelled":
      return "Authentication cancelled";
    case "no-key-entered":
      return new LocalAuthRefusal().message;
    case "unknown":
      return "Local authentication failed";
  }
}

/** The client-side error for one typed failure; its message is fixed text. */
class LocalAuthFailure extends Error {
  constructor(readonly failure: LocalAuthFailureCategory) {
    super(failureText(failure));
    this.name = "LocalAuthFailure";
  }
}

class AuthPromptTarget extends RpcTarget {
  #controller = new AbortController();
  #result: Promise<{ value: string } | { failed: true; cause: unknown }>;
  constructor(prompt: AuthPromptRequest, interaction: AuthInteraction) {
    super();
    const signal =
      interaction.signal === undefined
        ? this.#controller.signal
        : AbortSignal.any([this.#controller.signal, interaction.signal]);
    this.#result = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        const request: AuthPrompt =
          prompt.type === "select"
            ? {
                type: "select",
                message: prompt.message,
                signal,
                options: prompt.options.map((option) =>
                  option.description === undefined
                    ? { id: option.id, label: option.label }
                    : {
                        id: option.id,
                        label: option.label,
                        description: option.description,
                      },
                ),
              }
            : { type: prompt.type, message: prompt.message, signal };
        if (
          request.type !== "select" &&
          prompt.type !== "select" &&
          prompt.placeholder !== undefined
        )
          request.placeholder = prompt.placeholder;
        return interaction.prompt(request);
      })
      .then(
        (value) => ({ value: answerSchema.parse(value) }),
        (cause: unknown) => ({ failed: true, cause }),
      );
  }
  async result(): Promise<string> {
    const result = await this.#result;
    if ("failed" in result)
      throw new Error("Authentication prompt cancelled or failed", {
        cause: result.cause,
      });
    return result.value;
  }
  cancel(): void {
    this.#controller.abort();
  }
  [Symbol.dispose](): void {
    this.cancel();
  }
}

class AuthPresenterTarget extends RpcTarget {
  #interaction: AuthInteraction;
  constructor(interaction: AuthInteraction) {
    super();
    this.#interaction = interaction;
  }
  openPrompt(request: AuthPromptRequest): AuthPromptTarget {
    return new AuthPromptTarget(promptSchema.parse(request), this.#interaction);
  }
  notify(event: AuthEvent): void {
    const parsed = eventSchema.parse(event);
    let decoded: AuthEvent;
    switch (parsed.type) {
      case "info":
        decoded = { type: parsed.type, message: parsed.message };
        if (parsed.links !== undefined)
          decoded.links = parsed.links.map((link) =>
            link.label === undefined
              ? { url: link.url }
              : { url: link.url, label: link.label },
          );
        break;
      case "progress":
        decoded = parsed;
        break;
      case "auth_url":
        decoded = { type: parsed.type, url: parsed.url };
        if (parsed.instructions !== undefined)
          decoded.instructions = parsed.instructions;
        break;
      case "device_code":
        decoded = {
          type: parsed.type,
          userCode: parsed.userCode,
          verificationUri: parsed.verificationUri,
        };
        if (parsed.intervalSeconds !== undefined)
          decoded.intervalSeconds = parsed.intervalSeconds;
        if (parsed.expiresInSeconds !== undefined)
          decoded.expiresInSeconds = parsed.expiresInSeconds;
        break;
    }
    this.#interaction.notify(decoded);
  }
}

/** The auth-only RPC door shared by its producer and remote client. */
export type PrivateLocalAuthEndpoint = RpcTarget & {
  cancel(): void;
  signOutFungi(
    input: FungiAccountLogoutRequest,
  ): Promise<FungiAccountLogoutResult>;
  run(
    input: PrivateLocalAuthRequest,
    presenter: RpcStub<AuthPresenterTarget>,
  ): Promise<LocalAuthWireResult>;
};
/** One transient connection runs one provider or Fungi-account operation. */
export class PrivateLocalAuthTarget
  extends RpcTarget
  implements PrivateLocalAuthEndpoint
{
  #controller = new AbortController();
  #used = false;
  #run: typeof runLocalAuthCli;
  #signOutAccount: (
    input: FungiAccountLogoutRequest,
  ) => Promise<FungiAccountLogoutResult>;
  constructor(
    run: typeof runLocalAuthCli,
    signOutAccount: (
      input: FungiAccountLogoutRequest,
    ) => Promise<FungiAccountLogoutResult>,
  ) {
    super();
    this.#run = run;
    this.#signOutAccount = signOutAccount;
  }
  async signOutFungi(
    input: FungiAccountLogoutRequest,
  ): Promise<FungiAccountLogoutResult> {
    if (this.#used) throw new Error("Authentication connection already used");
    this.#used = true;
    return fungiAccountLogoutResultSchema.parse(
      await this.#signOutAccount(fungiAccountLogoutRequestSchema.parse(input)),
    );
  }
  cancel(): void {
    this.#controller.abort();
  }
  [Symbol.dispose](): void {
    this.cancel();
  }
  async run(
    input: PrivateLocalAuthRequest,
    presenter: RpcStub<AuthPresenterTarget>,
  ): Promise<LocalAuthWireResult> {
    if (this.#used) throw new Error("Authentication connection already used");
    this.#used = true;
    presenter.onRpcBroken(() => {
      this.cancel();
    });
    const request = requestSchema.parse(input);
    const args: string[] = [request.command];
    if (request.provider !== undefined)
      args.push("--provider", request.provider);
    if (request.authType !== undefined)
      args.push("--auth-type", request.authType);
    if (request.method !== undefined) args.push("--method", request.method);
    const signal = this.#controller.signal;
    try {
      const result = await this.#run(args, {
        interaction: {
          signal,
          notify: (event) => {
            void presenter.notify(event).catch((cause: unknown) => {
              console.warn(
                "Local authentication presenter notification failed",
                cause instanceof Error ? cause.name : "NonError",
              );
              this.cancel();
            });
          },
          prompt: async (request) => {
            const promptSignal =
              request.signal === undefined
                ? signal
                : AbortSignal.any([signal, request.signal]);
            promptSignal.throwIfAborted();
            const pending = presenter.openPrompt(promptSchema.parse(request));
            const cancel = () => {
              void pending.cancel().catch((cause: unknown) => {
                console.warn(
                  "Local authentication prompt cancellation failed",
                  cause instanceof Error ? cause.name : "NonError",
                );
                this.cancel();
              });
            };
            promptSignal.addEventListener("abort", cancel, { once: true });
            try {
              if (promptSignal.aborted) cancel();
              return answerSchema.parse(await pending.result());
            } finally {
              promptSignal.removeEventListener("abort", cancel);
              pending[Symbol.dispose]();
            }
          },
        },
      });
      return authResultSchema.parse(result);
    } catch (cause) {
      return {
        kind: "failed",
        failure: classifyFailure(cause, signal.aborted),
      };
    } finally {
      this.cancel();
    }
  }
}

/**
 * Takes ownership of a dedicated auth RPC connection, never the Session client.
 * A cancel the caller asked for is awaited before the connection is released,
 * so an ordinary cancel is never cut off by its own teardown; a cancel that
 * genuinely fails is handed to `reportCleanupFailure` with its cause.
 */
export async function runPrivateLocalAuthRemote(
  remote: RpcStub<PrivateLocalAuthEndpoint>,
  request: PrivateLocalAuthRequest,
  interaction: AuthInteraction,
  reportCleanupFailure: (cause: unknown) => void,
): Promise<LocalAuthResult> {
  const controller = new AbortController();
  const signal =
    interaction.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, interaction.signal]);
  const presenter = new AuthPresenterTarget({ ...interaction, signal });
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation = (async () => {
      await remote.cancel();
    })();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = wireResultSchema.parse(await remote.run(request, presenter));
    if (result.kind === "failed") throw new LocalAuthFailure(result.failure);
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    controller.abort();
    try {
      const [cancelled] = await Promise.allSettled([cancellation]);
      if (cancelled.status === "rejected")
        reportCleanupFailure(cancelled.reason);
    } finally {
      remote[Symbol.dispose]();
    }
  }
}

export type { AuthPresenterTarget, AuthPromptTarget };
