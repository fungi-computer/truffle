import type {
  AuthInteraction,
  AuthPrompt,
  AuthEvent,
} from "@earendil-works/pi-ai";
import { RpcTarget, type RpcStub } from "@fungi.computer/capnweb";
import { z } from "zod";
import {
  localAuthInputLimit,
  runLocalAuthCli,
  type LocalAuthResult,
} from "./auth-cli.js";

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
  run(
    input: PrivateLocalAuthRequest,
    presenter: RpcStub<AuthPresenterTarget>,
  ): Promise<LocalAuthResult>;
};
/** One transient connection runs one operation through the existing Pi owner. */
export class PrivateLocalAuthTarget
  extends RpcTarget
  implements PrivateLocalAuthEndpoint
{
  #controller = new AbortController();
  #used = false;
  #run: typeof runLocalAuthCli;
  constructor(run: typeof runLocalAuthCli = runLocalAuthCli) {
    super();
    this.#run = run;
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
  ): Promise<LocalAuthResult> {
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
    } catch {
      // Provider errors can contain credential material; do not serialize them.
      throw new Error(
        signal.aborted
          ? "Authentication cancelled"
          : "Local authentication failed",
      );
    } finally {
      this.cancel();
    }
  }
}

/** Takes ownership of a dedicated auth RPC connection, never the Session client. */
export async function runPrivateLocalAuthRemote(
  remote: RpcStub<PrivateLocalAuthEndpoint>,
  request: PrivateLocalAuthRequest,
  interaction: AuthInteraction,
): Promise<LocalAuthResult> {
  const controller = new AbortController();
  const signal =
    interaction.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, interaction.signal]);
  const presenter = new AuthPresenterTarget({ ...interaction, signal });
  const cancel = () => {
    void remote.cancel().catch((cause: unknown) => {
      console.warn(
        "Local authentication cancellation failed",
        cause instanceof Error ? cause.name : "NonError",
      );
      remote[Symbol.dispose]();
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = await remote.run(request, presenter);
    return authResultSchema.parse(result);
  } finally {
    signal.removeEventListener("abort", cancel);
    controller.abort();
    remote[Symbol.dispose]();
  }
}

export type { AuthPresenterTarget, AuthPromptTarget };
