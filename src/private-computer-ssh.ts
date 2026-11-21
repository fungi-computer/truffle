import {
  extractWWWAuthenticateParams,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  freshFungiAccess,
  fungiMcpTeamEndpoint,
} from "./private-fungi-account.js";

// The Hub's SSH doors for one Team Computer, as `fungi computer ssh` uses them:
//
//   POST /api/teams/TEAM/computers/ID/ssh/certificate
//     body  { "publicKey": "ssh-ed25519 BASE64..." }
//     reply { "certificate": one OpenSSH certificate line,
//             "hostKey": "ssh-ed25519 BASE64...",
//             "hostKeyAlias": "ID.computer.fungi" }
//   GET  /api/teams/TEAM/computers/ID/ssh
//     a WebSocket; binary frames carry the raw SSH stream
//
// Both take the saved Local OAuth login as a bearer token. Local's tokens are
// not DPoP-bound, so no proof header exists to send.
// Each value reaches a local file or an ssh argument, so each is one plain line.
const mintSchema = z.strictObject({
  certificate: z
    .string()
    .max(16_384)
    .regex(/^ssh-ed25519-cert-v01@openssh\.com [A-Za-z0-9+/=]+( [^\r\n]*)?$/u),
  hostKey: z
    .string()
    .max(4_096)
    .regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/u),
  hostKeyAlias: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u),
});
export type ComputerSshMint = z.output<typeof mintSchema>;

export type ComputerSshOptions = Readonly<{
  credentialPath?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}>;

/** Just what the pipe needs of a WebSocket, so tests can supply a fake one. */
export type SshSocket = Readonly<{
  send: (data: Uint8Array) => void;
  close: (code: number, reason: string) => void;
  onOpen: (listener: () => void) => void;
  onMessage: (listener: (data: Uint8Array) => void) => void;
  onClose: (listener: () => void) => void;
  onError: (listener: () => void) => void;
}>;
export type SshSocketFactory = (
  url: URL,
  headers: Readonly<Record<string, string>>,
) => SshSocket;

const defaultSocket: SshSocketFactory = (url, headers) => {
  const target = new URL(url);
  target.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Bun and Node's undici WebSocket accept handshake headers here.
  const socket = new WebSocket(target, { headers });
  socket.binaryType = "arraybuffer";
  return {
    send: (data) => {
      socket.send(data);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
    onOpen: (listener) => {
      socket.addEventListener("open", () => {
        listener();
      });
    },
    onMessage: (listener) => {
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer)
          listener(new Uint8Array(event.data));
      });
    },
    onClose: (listener) => {
      socket.addEventListener("close", () => {
        listener();
      });
    },
    onError: (listener) => {
      socket.addEventListener("error", () => {
        listener();
      });
    },
  };
};

function route(rawEndpoint: string, computerId: string, suffix: string) {
  const { endpoint, teamId } = fungiMcpTeamEndpoint(rawEndpoint);
  return {
    endpoint,
    url: new URL(
      `/api/teams/${encodeURIComponent(teamId)}/computers/${encodeURIComponent(computerId)}/${suffix}`,
      endpoint.origin,
    ),
  };
}

function withCredentials(options: ComputerSshOptions) {
  return {
    ...options,
    credentialPath:
      options.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
}

const refusalSchema = z.object({ error: z.string() });

/** One plain sentence for a Hub refusal, naming its cause. */
async function refusal(
  response: Response,
  doing: string,
  endpoint: string,
): Promise<Error> {
  // A 409 carries one of two reasons in its body; the phrase names the hosted one.
  let body = "";
  let missingComputerScope = false;
  if (response.status === 403) {
    const parsed = refusalSchema.safeParse(
      await response.json().catch((cause: unknown) => {
        if (cause instanceof SyntaxError) return null;
        throw cause;
      }),
    );
    missingComputerScope =
      parsed.success && parsed.data.error.includes("computer:execute");
  } else if (response.status === 409) body = await response.text();
  else await response.body?.cancel();
  if (response.status === 401)
    return new Error(
      `The Hub did not accept your sign-in. Run fungi login --fungi-mcp ${endpoint} and retry.`,
    );
  if (response.status === 403) {
    if (
      extractWWWAuthenticateParams(response).error === "insufficient_scope" ||
      missingComputerScope
    )
      return new Error(
        `This sign-in predates Computer access. Run fungi login --fungi-mcp ${endpoint} and retry.`,
      );
    return new Error(
      `You can't ${doing} on this Computer. SSH needs a Team member who can run commands on it.`,
    );
  }
  if (response.status === 404)
    return new Error("The Hub has no such Computer in this Team.");
  if (response.status === 409)
    return new Error(
      body.includes("SSH needs a hosted Computer")
        ? "SSH needs a hosted Computer; this one runs only on a member's own machine."
        : "The Computer isn't running. Start it with fungi computers start <name>, then retry.",
    );
  if (response.status === 426)
    return new Error(
      "The Hub answered without opening the SSH connection. Retry.",
    );
  if (response.status === 503)
    return new Error(
      "The Hub can't check your access to this Computer right now. Try again in a moment.",
    );
  return new Error(
    `The Hub could not ${doing}: HTTP ${String(response.status)}.`,
  );
}

/**
 * Run `request` with the saved login's bearer token. A 401 refreshes only the
 * refused token and retries once, as the MCP transport does.
 */
async function authorized(
  endpoint: URL,
  options: ReturnType<typeof withCredentials>,
  request: (token: string) => Promise<Response>,
): Promise<Response> {
  const token = await freshFungiAccess(endpoint, options);
  const first = await request(token);
  if (first.status !== 401) return first;
  await first.body?.cancel();
  return await request(
    await freshFungiAccess(endpoint, { ...options, rejectedAccess: token }),
  );
}

/** Ask the Hub for a short-lived certificate for `publicKey` on one Computer. */
export async function mintPrivateComputerSshCertificate(
  rawEndpoint: string,
  computerId: string,
  publicKey: string,
  input: ComputerSshOptions = {},
): Promise<ComputerSshMint> {
  const options = withCredentials(input);
  const { endpoint, url } = route(rawEndpoint, computerId, "ssh/certificate");
  options.signal?.throwIfAborted();
  const fetcher: FetchLike = options.fetch ?? fetch;
  const response = await authorized(endpoint, options, (token) => {
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ publicKey }),
      redirect: "error",
    };
    if (options.signal !== undefined) init.signal = options.signal;
    return fetcher(url, init);
  });
  if (!response.ok)
    throw await refusal(response, "get an SSH certificate", rawEndpoint);
  const parsed = mintSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error("The Hub returned an invalid SSH certificate response.");
  return parsed.data;
}

/**
 * `ssh-proxy`: pipe `input` and `output` to the Computer's SSH door until
 * either side closes. This is the ProxyCommand `ssh` runs; nothing is read from
 * or written to either stream but the raw SSH bytes.
 */
export async function pipePrivateComputerSsh(
  rawEndpoint: string,
  computerId: string,
  streams: Readonly<{
    input: NodeJS.ReadableStream;
    output: Pick<NodeJS.WritableStream, "write">;
  }>,
  input: ComputerSshOptions & Readonly<{ socket?: SshSocketFactory }> = {},
): Promise<void> {
  const options = withCredentials(input);
  const { endpoint, url } = route(rawEndpoint, computerId, "ssh");
  options.signal?.throwIfAborted();
  const token = await freshFungiAccess(endpoint, options);
  const socket = (input.socket ?? defaultSocket)(url, {
    Authorization: `Bearer ${token}`,
  });
  await new Promise<void>((resolve, reject) => {
    let opened = false;
    let probing = false;
    const stop = () => {
      socket.close(1000, "client closed");
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    const forward = (chunk: Uint8Array) => {
      socket.send(chunk);
    };
    socket.onOpen(() => {
      opened = true;
      streams.input.on("data", forward);
      streams.input.on("end", stop);
    });
    socket.onMessage((data) => {
      streams.output.write(data);
    });
    socket.onClose(() => {
      options.signal?.removeEventListener("abort", stop);
      // Stop reading: a live stdin listener would keep the process running.
      streams.input.off("data", forward);
      streams.input.off("end", stop);
      streams.input.pause();
      if (opened) resolve();
      // A refused handshake reports an error first; its probe has the cause.
      else if (!probing)
        reject(
          new Error("The Hub closed the SSH connection before it opened."),
        );
    });
    socket.onError(() => {
      if (opened) {
        resolve();
        return;
      }
      probing = true;
      // The handshake carries no status to a WebSocket client: ask the same
      // door with a plain GET, which answers with the cause.
      const fetcher: FetchLike = options.fetch ?? fetch;
      fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }).then(
        async (response) => {
          reject(await refusal(response, "open SSH", rawEndpoint));
        },
        (cause: unknown) => {
          reject(
            new Error(
              `Couldn't reach the Hub to open SSH: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
        },
      );
    });
  });
}
