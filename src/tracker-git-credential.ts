import { parse } from "node:querystring";
import { z } from "zod";
import { freshFungiAccess } from "./private-fungi-account.js";

const fields = z.object({
  protocol: z.literal("https"),
  host: z.string().min(1),
  path: z.string().min(1),
});
const lease = z.strictObject({
  remote: z.url({ protocol: /^https$/ }),
  capability: z.string().regex(/^fgit_[0-9a-f]{64}$/u),
  expiresAt: z.number().int().positive(),
  permission: z.enum(["read", "write"]),
});

async function readBounded(input: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > 8192) throw new Error("Credential input too large");
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n\n");
    if (end !== -1) return text.slice(0, end);
  }
  return text + decoder.decode();
}

/** Git's get/store/erase protocol. Only the existing Botanical login is stored;
 * a minted capability lives in this call and Git's credential response. */
export async function runTrackerGitCredential(
  input: Readonly<{
    action: string;
    hub: string;
    teamId: string;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(value: string): void };
  }>,
  owners: {
    access?: typeof freshFungiAccess;
    fetch?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
  } = {},
): Promise<void> {
  try {
    if (!["get", "store", "erase", "remote"].includes(input.action))
      throw new Error("Invalid action");
    // Store and erase are intentionally silent: this helper has no Git cache.
    if (input.action === "store" || input.action === "erase") return;
    const values =
      input.action === "remote"
        ? null
        : fields.parse(
            parse(await readBounded(input.stdin), "\n", "=", {
              maxKeys: 32,
              decodeURIComponent: (value) => value,
            }),
          );
    const hub = new URL(input.hub);
    if (
      hub.protocol !== "https:" ||
      hub.username ||
      hub.password ||
      hub.search ||
      hub.hash ||
      hub.pathname !== "/"
    )
      throw new Error("Invalid Hub origin");
    const teamId = z.string().min(1).max(256).parse(input.teamId);
    const signal = AbortSignal.timeout(30_000);
    const access = await (owners.access ?? freshFungiAccess)(hub, { signal });
    const response = await (owners.fetch ?? fetch)(
      new URL(
        `/api/teams/${encodeURIComponent(teamId)}/git/tracker/credential`,
        hub,
      ),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${access}` },
        redirect: "error",
        signal,
      },
    );
    if (!response.ok || response.body === null)
      throw new Error("Credential exchange refused");
    const granted = lease.parse(JSON.parse(await readBounded(response.body)));
    const remote = new URL(granted.remote);
    if (
      remote.username ||
      remote.password ||
      remote.search ||
      remote.hash ||
      granted.expiresAt <= Date.now()
    )
      return;
    if (values === null) {
      // Discover the configured remote through the same admitted exchange;
      // the unused five-minute capability is never emitted or cached.
      input.stdout.write(`${remote.href}\n`);
      return;
    }
    if (remote.host !== values.host || remote.pathname !== `/${values.path}`)
      return;
    input.stdout.write(
      `username=fungi\npassword=${granted.capability}\npassword_expiry_utc=${String(Math.floor(granted.expiresAt / 1000))}\n\n`,
    );
  } catch {
    // Neither schema-decode details, OAuth failures nor transport text may
    // expose supplied credentials through the CLI's top-level error boundary.
    throw new Error(
      "Tracker Git unavailable. Check the remote, Team consent and Fungi login with git:tracker access.",
    );
  }
}
