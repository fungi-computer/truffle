import { z } from "zod";

// Extras reach the native sandbox launcher too; its loader controls stay owned
// by the host rather than loading model-selected code before containment.
const hostOwnedNames = new Set([
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "FUNGI_SANDBOX",
  "FUNGI_SANDBOX_NETWORK_DISABLED",
  "GLIBC_TUNABLES",
  "GCONV_PATH",
  "LOCPATH",
]);
const environmentName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/u)
  .refine(
    (name) =>
      !hostOwnedNames.has(name) &&
      !name.startsWith("LD_") &&
      !name.startsWith("DYLD_"),
    "Host-owned environment variable",
  );

/** Shared admission for shell/direct run and managed start. */
export const privateLocalExecEnvironmentInput = z
  .record(
    environmentName,
    z
      .string()
      .max(1_024)
      .regex(/^[^\0]*$/u, "Environment values cannot contain NUL"),
  )
  .refine((environment) => Object.keys(environment).length <= 64, {
    message: "Exec env accepts at most 64 variables",
  })
  .describe(
    "Up to 64 extra string variables, each at most 1024 UTF-16 code units, with uppercase ASCII names (letters, digits and underscores; no leading digit). Host-owned names, including HOME, PATH, session/sandbox locators and dynamic-loader controls, are refused.",
  );

/**
 * The only host variables a Local exec child receives besides its selected
 * PATH and HOME. Exec runs as the host's own user, so that user's session
 * locator variables are not a secret and are what `systemd-run --user`,
 * `loginctl` and other user-service tools need to find the user manager.
 * Every other host variable, credentials included, stays out.
 */
export type PrivateLocalExecEnvironment = Record<string, string> & {
  PATH: string;
  HOME: string;
  XDG_RUNTIME_DIR?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
};

export function privateLocalExecEnvironment(
  executionPath: string,
  host: NodeJS.ProcessEnv & { HOME: string },
  extra: Readonly<Record<string, string>> = {},
): PrivateLocalExecEnvironment {
  const environment: PrivateLocalExecEnvironment = {
    ...extra,
    PATH: executionPath,
    HOME: host.HOME,
  };
  if (host.XDG_RUNTIME_DIR) environment.XDG_RUNTIME_DIR = host.XDG_RUNTIME_DIR;
  if (host.DBUS_SESSION_BUS_ADDRESS)
    environment.DBUS_SESSION_BUS_ADDRESS = host.DBUS_SESSION_BUS_ADDRESS;
  return environment;
}
