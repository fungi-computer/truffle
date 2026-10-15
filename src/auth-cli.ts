#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import { linearAuthInteraction } from "./linear-auth.js";
export { linearAuthInteraction } from "./linear-auth.js";
import { parseArgs } from "node:util";
import type {
  AuthInteraction,
  AuthType,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { localLoginProviders } from "./local-login.js";
import { createPrivateModels } from "./local-models.js";
import { createPrivateCredentialStore } from "./private-file-credential-store.js";
export { maximumCredentialStringLength as localAuthInputLimit } from "./private-file-credential-store.js";

export type LocalAuthModels = Pick<
  Models,
  "checkAuth" | "getProviders" | "login" | "logout"
>;

/** Typed provider configuration returned to local status callers. */
export type LocalAuthStatus =
  | Readonly<{
      providerId: string;
      providerName: string;
      state: "unconfigured";
    }>
  | Readonly<{
      providerId: string;
      providerName: string;
      state: "configured";
      type: AuthType;
    }>;
export type LocalAuthResult =
  | Readonly<{ kind: "completed" }>
  | Readonly<{
      kind: "status";
      providers: readonly LocalAuthStatus[];
    }>;
export type SignalProcess = {
  once(signal: NodeJS.Signals, listener: () => void): void;
  removeListener(signal: NodeJS.Signals, listener: () => void): void;
};

export type LocalAuthCliOptions = {
  models?: LocalAuthModels;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  signals?: SignalProcess;
  interaction?: AuthInteraction;
  /** Stable host identity for Pi's ChatGPT sign-in. Defaults to the local store's. */
  getDeviceId?: () => Promise<string>;
};

type Command =
  | { type: "help" }
  | { type: "login"; provider?: string; authType?: AuthType; method?: string }
  | { type: "status"; provider?: string }
  | { type: "logout"; provider?: string };
type AuthMethodOption = { id: AuthType; label: string };

function usage(): string {
  return "Usage: fungi-local-auth <login|status|logout> [--provider <id>] [--auth-type oauth|api_key] [--method <id>]";
}

function parseAuthType(value: string | undefined): AuthType | undefined {
  if (value === undefined) return undefined;
  if (value === "oauth" || value === "api_key") return value;
  throw new Error("--auth-type must be oauth or api_key");
}

function writeMessage(
  output: NodeJS.WritableStream,
  interaction: AuthInteraction | undefined,
  message: string,
): void {
  if (interaction !== undefined) interaction.notify({ type: "info", message });
  else output.write(`${message}\n`);
}

function providerLabel(provider: Provider): string {
  return provider.name === provider.id
    ? provider.name
    : `${provider.name} (${provider.id})`;
}

/**
 * Interactive login methods for one provider, from the same registry the
 * Whistle/TUI picker uses (`localLoginProviders`), so Pi's labels and which
 * methods count as interactive are decided in exactly one place.
 */
function authMethodOptions(provider: Provider): readonly AuthMethodOption[] {
  const [entry] = localLoginProviders([provider]);
  if (entry === undefined) return [];
  return entry.methods.map((method) => ({
    id:
      method.kind === "subscription"
        ? ("oauth" as const)
        : ("api_key" as const),
    label: method.label,
  }));
}

/** Whether `provider` declares `requested` at all, interactive or not. */
function declaresAuthType(provider: Provider, requested: AuthType): boolean {
  return requested === "oauth"
    ? provider.auth.oauth !== undefined
    : provider.auth.apiKey !== undefined;
}

function terminalInteraction(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): AuthInteraction {
  const cli = new Cli({
    brand: "fungi-local-auth",
    input: input instanceof Readable ? input : Readable.from(input),
    output:
      output instanceof Writable
        ? output
        : new Writable({
            write(chunk: string | Uint8Array, _encoding, callback) {
              output.write(chunk);
              callback();
            },
          }),
  });
  return linearAuthInteraction(cli.interactive, cli);
}

function interactionFor(
  signal: AbortSignal,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  supplied?: AuthInteraction,
  method?: string,
  // Known once `login()` resolves the provider, before Pi's own login()
  // runs; stamped onto a forwarded `auth_url` event so linear-auth.ts can
  // head it "Sign in to <provider>" instead of a bare "Sign in".
  providerLabel?: string,
): AuthInteraction {
  let methodOverride = method;
  return {
    signal,
    prompt: async (prompt) => {
      if (prompt.type === "select" && methodOverride !== undefined) {
        const selected = prompt.options.find(
          (option) => option.id === methodOverride,
        );
        if (selected === undefined)
          throw new Error(`Pi auth did not offer method ${methodOverride}`);
        methodOverride = undefined;
        return selected.id;
      }
      signal.throwIfAborted();
      const promptSignal =
        prompt.signal === undefined
          ? signal
          : AbortSignal.any([signal, prompt.signal]);
      return (supplied ?? terminalInteraction(input, output)).prompt({
        ...prompt,
        signal: promptSignal,
      });
    },
    notify: (event) => {
      const augmented =
        providerLabel === undefined || event.type !== "auth_url"
          ? event
          : { ...event, providerLabel };
      if (supplied === undefined)
        terminalInteraction(input, output).notify(augmented);
      else supplied.notify(augmented);
    },
  };
}

async function chooseProvider(
  providers: readonly Provider[],
  requested: string | undefined,
  signal: AbortSignal,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  supplied?: AuthInteraction,
): Promise<Provider> {
  if (requested !== undefined) {
    const provider = providers.find((candidate) => candidate.id === requested);
    if (provider === undefined)
      throw new Error(`Unknown provider: ${requested}`);
    return provider;
  }
  const id = await interactionFor(signal, input, output, supplied).prompt({
    type: "select",
    message: "Choose a provider",
    options: providers.map((provider) => ({
      id: provider.id,
      label: providerLabel(provider),
    })),
  });
  const provider = providers.find((candidate) => candidate.id === id);
  if (provider === undefined) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

async function chooseAuthType(
  provider: Provider,
  requested: AuthType | undefined,
  signal: AbortSignal,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  supplied?: AuthInteraction,
): Promise<AuthType> {
  if (requested !== undefined) {
    if (!declaresAuthType(provider, requested))
      throw new Error(
        `${providerLabel(provider)} does not offer ${requested} login`,
      );
    return requested;
  }
  const options = authMethodOptions(provider);
  if (options.length === 0) {
    // No interactive method (e.g. an ambient-only API key): fall through to
    // api_key so login() can explain why, the same as an explicit request.
    if (provider.auth.apiKey !== undefined) return "api_key";
    throw new Error(`${providerLabel(provider)} has no login method`);
  }
  if (options.length === 1) {
    const only = options[0];
    if (only === undefined) throw new Error("No login method is available");
    return only.id;
  }
  const id = await interactionFor(signal, input, output, supplied).prompt({
    type: "select",
    message: `Choose login method for ${providerLabel(provider)}`,
    options,
  });
  const selected = options.find((option) => option.id === id);
  if (selected === undefined) throw new Error(`Unknown login method: ${id}`);
  return selected.id;
}

async function login(
  models: LocalAuthModels,
  command: Extract<Command, { type: "login" }>,
  signal: AbortSignal,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  getDeviceId: () => Promise<string>,
  supplied?: AuthInteraction,
): Promise<void> {
  const provider = await chooseProvider(
    models.getProviders(),
    command.provider,
    signal,
    input,
    output,
    supplied,
  );
  const authType = await chooseAuthType(
    provider,
    command.authType,
    signal,
    input,
    output,
    supplied,
  );
  if (authType === "api_key" && provider.auth.apiKey?.login === undefined) {
    const message = `${providerLabel(provider)} uses ambient credentials; configure its environment or provider settings. No credential was changed.`;
    writeMessage(output, supplied, message);
    throw new Error(message);
  }
  const interaction = interactionFor(
    signal,
    input,
    output,
    supplied,
    command.method,
    provider.name,
  );
  // Sign in with ChatGPT needs a stable installation UUID in its authorize
  // URL (`ext_agent_host_id`); pass it at this one call site, the way Pi's
  // own coding-agent does, instead of patching Pi's `models.login`. Pi's
  // option is synchronous, so resolve our (async, disk-backed) device ID
  // first and hand it a closure over the resolved value.
  if (provider.id === "openai" && authType === "oauth") {
    signal.throwIfAborted();
    const deviceId = await getDeviceId();
    signal.throwIfAborted();
    await models.login(provider.id, authType, interaction, {
      getDeviceId: () => deviceId,
    });
  } else {
    await models.login(provider.id, authType, interaction);
  }
  writeMessage(output, supplied, `${providerLabel(provider)} login complete.`);
}

async function status(
  models: LocalAuthModels,
  providerId: string | undefined,
  signal: AbortSignal,
  output: NodeJS.WritableStream,
  interaction?: AuthInteraction,
): Promise<LocalAuthResult> {
  const providers = models.getProviders();
  const selected =
    providerId === undefined
      ? providers
      : providers.filter((provider) => provider.id === providerId);
  if (selected.length === 0)
    throw new Error(`Unknown provider: ${providerId ?? "(all providers)"}`);
  const statuses: LocalAuthStatus[] = [];
  for (const provider of selected) {
    const checked = await models.checkAuth(provider.id, { signal });
    const providerStatus: LocalAuthStatus =
      checked === undefined
        ? {
            providerId: provider.id,
            providerName: provider.name,
            state: "unconfigured",
          }
        : {
            providerId: provider.id,
            providerName: provider.name,
            state: "configured",
            type: checked.type,
          };
    statuses.push(providerStatus);
    writeMessage(
      output,
      interaction,
      `${providerLabel(provider)}: ${providerStatus.state === "unconfigured" ? "unconfigured" : `configured (${providerStatus.type})`}`,
    );
  }
  return {
    kind: "status",
    providers: Object.freeze(
      statuses.map((providerStatus) => Object.freeze(providerStatus)),
    ),
  };
}

async function runCommand(
  command: Exclude<Command, { type: "help" }>,
  models: LocalAuthModels,
  signal: AbortSignal,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  getDeviceId: () => Promise<string>,
  interaction?: AuthInteraction,
): Promise<LocalAuthResult> {
  if (command.type === "status")
    return status(models, command.provider, signal, output, interaction);
  if (command.type === "login") {
    await login(
      models,
      command,
      signal,
      input,
      output,
      getDeviceId,
      interaction,
    );
    return { kind: "completed" };
  }
  const provider = await chooseProvider(
    models.getProviders(),
    command.provider,
    signal,
    input,
    output,
    interaction,
  );
  await models.logout(provider.id, { signal });
  writeMessage(
    output,
    interaction,
    `${providerLabel(provider)} logout complete.`,
  );
  return { kind: "completed" };
}

function parseCommand(argv: readonly string[]): Command {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      provider: { type: "string" },
      "auth-type": { type: "string" },
      method: { type: "string" },
    },
  });
  const command = parsed.positionals[0] ?? "help";
  if (parsed.values.help === true || command === "help")
    return { type: "help" };
  if (parsed.positionals.length !== 1) throw new Error(usage());
  const provider = parsed.values.provider;
  const method = parsed.values.method;
  const authType = parseAuthType(parsed.values["auth-type"]);
  if (command === "login") {
    const result: Extract<Command, { type: "login" }> = { type: "login" };
    if (provider !== undefined) result.provider = provider;
    if (authType !== undefined) result.authType = authType;
    if (method !== undefined)
      result.method = method === "device-code" ? "device_code" : method;
    return result;
  }
  if (method !== undefined || authType !== undefined)
    throw new Error("--auth-type and --method apply only to login");
  if (command === "status" || command === "logout") {
    const result: Extract<Command, { type: "status" | "logout" }> = {
      type: command,
    };
    if (provider !== undefined) result.provider = provider;
    return result;
  }
  throw new Error(usage());
}

export async function runLocalAuthCli(
  argv: readonly string[],
  options: LocalAuthCliOptions = {},
): Promise<LocalAuthResult> {
  const output = options.output ?? process.stdout;
  const command = parseCommand(argv);
  if (command.type === "help") {
    output.write(`${usage()}\n`);
    return { kind: "completed" };
  }
  const controller = new AbortController();
  const signals = options.signals ?? process;
  const abort = () => {
    controller.abort();
  };
  signals.once("SIGINT", abort);
  signals.once("SIGTERM", abort);
  const getDeviceId =
    options.getDeviceId ?? (() => createPrivateCredentialStore().getDeviceId());
  try {
    return await runCommand(
      command,
      options.models ?? createPrivateModels(),
      options.interaction?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.interaction.signal]),
      options.input ?? process.stdin,
      output,
      getDeviceId,
      options.interaction,
    );
  } finally {
    signals.removeListener("SIGINT", abort);
    signals.removeListener("SIGTERM", abort);
  }
}

if (import.meta.main) {
  const cli = new Cli({ brand: "fungi-local-auth" });
  if (cli.interactive) cli.welcome("Provider login for your local agents.");
  runLocalAuthCli(process.argv.slice(2), {
    interaction: linearAuthInteraction(cli.interactive, cli),
  }).catch((cause: unknown) => {
    // Provider messages can contain credentials; keep the diagnostic bounded.
    process.stderr.write(
      `Local authentication command failed (${cause instanceof Error ? cause.name : "NonError"}).\n`,
    );
    process.exitCode = 1;
  });
}
