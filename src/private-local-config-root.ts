import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveDefaultCredentialPath } from "./private-file-credential-store.js";

/**
 * The host's selected user home, not an Agent Home or an invocation Files jail.
 * Pass these values through the existing home/path parameters. Capture once at
 * the outer host/client boundary, before awaiting or constructing lazy owners;
 * later opens, reloads and exec launches must not select ambient HOME again.
 *
 * PATH remains the existing per-client/per-Session choice. Neither this value
 * nor an exec child inherits the rest of the host environment.
 */
export type PrivateLocalConfigRoot = Readonly<{
  home: string;
  credentialPath: string;
  serviceDirectory: string;
}>;

/**
 * Select paths without reading credentials, creating directories or starting a
 * service. Keep this capture independent of service/discovery owners, which
 * consume its paths. Explicit path overrides remain the caller's responsibility;
 * there is no settings registry, fallback chain or alternate storage format.
 */
export function capturePrivateLocalConfigRoot(
  home: string = homedir(),
): PrivateLocalConfigRoot {
  if (!isAbsolute(home))
    throw new Error("Local configuration home must be absolute");
  const selected = resolve(home);
  return Object.freeze({
    home: selected,
    credentialPath: resolveDefaultCredentialPath(selected),
    serviceDirectory: join(selected, ".fungi", "service"),
  });
}
