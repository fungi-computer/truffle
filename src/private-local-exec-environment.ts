/**
 * The only host variables a Local exec child receives besides its selected
 * PATH and HOME. Exec runs as the host's own user, so that user's session
 * locator variables are not a secret and are what `systemd-run --user`,
 * `loginctl` and other user-service tools need to find the user manager.
 * Every other host variable, credentials included, stays out.
 */
export type PrivateLocalExecEnvironment = {
  PATH: string;
  HOME: string;
  XDG_RUNTIME_DIR?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
};

export function privateLocalExecEnvironment(
  executionPath: string,
  host: NodeJS.ProcessEnv & { HOME: string },
): PrivateLocalExecEnvironment {
  const environment: PrivateLocalExecEnvironment = {
    PATH: executionPath,
    HOME: host.HOME,
  };
  if (host.XDG_RUNTIME_DIR) environment.XDG_RUNTIME_DIR = host.XDG_RUNTIME_DIR;
  if (host.DBUS_SESSION_BUS_ADDRESS)
    environment.DBUS_SESSION_BUS_ADDRESS = host.DBUS_SESSION_BUS_ADDRESS;
  return environment;
}
