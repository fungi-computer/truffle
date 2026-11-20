import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { privateFungiAccountOAuthProvider } from "../src/private-fungi-account.js";
import {
  mintPrivateComputerSshCertificate,
  pipePrivateComputerSsh,
  type SshSocket,
} from "../src/private-computer-ssh.js";

const endpoint = "https://hub.test/api/teams/team-1/mcp";
const certificateUrl =
  "https://hub.test/api/teams/team-1/computers/computer%201/ssh/certificate";
const sshUrl = "https://hub.test/api/teams/team-1/computers/computer%201/ssh";
// Random per run: a literal key-shaped string would trip the secret scan.
const blob = () => randomBytes(24).toString("base64");
const publicKey = `ssh-ed25519 ${blob()} fungi`;
const answer = {
  certificate: `ssh-ed25519-cert-v01@openssh.com ${blob()} user:u team:t`,
  hostKey: `ssh-ed25519 ${blob()}`,
  hostKeyAlias: "computer1.computer.fungi",
};

async function signedIn() {
  const root = await mkdtemp(join(tmpdir(), "computer-ssh-"));
  const credentialPath = join(root, "credentials.json");
  const provider = privateFungiAccountOAuthProvider({
    endpoint: new URL(endpoint),
    credentialPath,
  });
  await provider.saveClientInformation({
    client_id: "fixture-local",
    redirect_uris: ["http://127.0.0.1/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  await provider.saveTokens({
    access_token: "fixture-team-access",
    refresh_token: "fixture-team-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  });
  return {
    credentialPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("mints a certificate for the public key alone, with the saved login as bearer", async () => {
  const { credentialPath, cleanup } = await signedIn();
  try {
    const requests: {
      url: string;
      method: string;
      auth: string | null;
      body: unknown;
    }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push({
        url: request.url,
        method: request.method,
        auth: request.headers.get("Authorization"),
        body: await request.json(),
      });
      return Response.json(answer);
    };
    expect(
      await mintPrivateComputerSshCertificate(
        endpoint,
        "computer 1",
        publicKey,
        { credentialPath, fetch },
      ),
    ).toEqual(answer);
    expect(requests).toEqual([
      {
        url: certificateUrl,
        method: "POST",
        auth: "Bearer fixture-team-access",
        body: { publicKey },
      },
    ]);
  } finally {
    await cleanup();
  }
});

it("names the cause of each Hub refusal, and refuses an answer that is not plain lines", async () => {
  const { credentialPath, cleanup } = await signedIn();
  try {
    const refuse =
      (status: number): FetchLike =>
      () =>
        Promise.resolve(new Response(null, { status }));
    const mint = (fetch: FetchLike) =>
      mintPrivateComputerSshCertificate(endpoint, "computer 1", publicKey, {
        credentialPath,
        fetch,
      });
    await expect(mint(refuse(403))).rejects.toThrow(
      "You can't get an SSH certificate on this Computer. SSH needs a Team member who can run commands on it.",
    );
    await expect(mint(refuse(404))).rejects.toThrow(
      "The Hub has no such Computer in this Team.",
    );
    await expect(mint(refuse(409))).rejects.toThrow(
      "The Computer isn't running. Start it with fungi computers start <name>, then retry.",
    );
    // The Hub's hosted-only refusal is a 409 whose body says so.
    await expect(
      mint(() =>
        Promise.resolve(
          Response.json(
            {
              error:
                "SSH needs a hosted Computer; this one runs only on a member's own machine",
            },
            { status: 409 },
          ),
        ),
      ),
    ).rejects.toThrow(
      "SSH needs a hosted Computer; this one runs only on a member's own machine.",
    );
    await expect(mint(refuse(503))).rejects.toThrow(
      "The Hub can't check your access to this Computer right now. Try again in a moment.",
    );
    await expect(mint(refuse(426))).rejects.toThrow(
      "The Hub answered without opening the SSH connection. Retry.",
    );
    await expect(mint(refuse(502))).rejects.toThrow(
      "The Hub could not get an SSH certificate: HTTP 502.",
    );
    // A newline in the host key would add a known_hosts line of the Hub's choosing.
    await expect(
      mint(() =>
        Promise.resolve(
          Response.json({
            ...answer,
            hostKey: `${answer.hostKey}\nevil ssh-ed25519 ${blob()}`,
          }),
        ),
      ),
    ).rejects.toThrow("The Hub returned an invalid SSH certificate response.");
    await expect(
      mint(() =>
        Promise.resolve(
          Response.json({ ...answer, hostKeyAlias: "-oProxyCommand=x" }),
        ),
      ),
    ).rejects.toThrow("The Hub returned an invalid SSH certificate response.");
  } finally {
    await cleanup();
  }
});

function fakeSocket() {
  const sent: Uint8Array[] = [];
  const created: { url: URL; headers: Readonly<Record<string, string>> }[] = [];
  const open: (() => void)[] = [];
  const message: ((data: Uint8Array) => void)[] = [];
  const close: (() => void)[] = [];
  const error: (() => void)[] = [];
  const socket: SshSocket = {
    send: (data) => {
      sent.push(data);
    },
    close: () => {
      for (const listener of close) listener();
    },
    onOpen: (listener) => {
      open.push(listener);
    },
    onMessage: (listener) => {
      message.push(listener);
    },
    onClose: (listener) => {
      close.push(listener);
    },
    onError: (listener) => {
      error.push(listener);
    },
  };
  return {
    sent,
    created,
    open: () => {
      for (const listener of open) listener();
    },
    message: (data: Uint8Array) => {
      for (const listener of message) listener(data);
    },
    close: () => {
      for (const listener of close) listener();
    },
    error: () => {
      for (const listener of error) listener();
    },
    factory: (url: URL, headers: Readonly<Record<string, string>>) => {
      created.push({ url, headers });
      return socket;
    },
  };
}

it("pipes raw bytes between the streams and the Hub's SSH socket, authenticated by the saved login", async () => {
  const { credentialPath, cleanup } = await signedIn();
  try {
    const fake = fakeSocket();
    const input = new PassThrough();
    const output = new PassThrough();
    const received: Buffer[] = [];
    output.on("data", (chunk: Buffer) => received.push(chunk));
    const piped = pipePrivateComputerSsh(
      endpoint,
      "computer 1",
      { input, output },
      { credentialPath, socket: fake.factory },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.created).toEqual([
      {
        url: new URL(sshUrl),
        headers: { Authorization: "Bearer fixture-team-access" },
      },
    ]);
    fake.open();
    input.write(Buffer.from("SSH-2.0-client\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Buffer.concat(fake.sent).toString()).toBe("SSH-2.0-client\r\n");
    fake.message(new TextEncoder().encode("SSH-2.0-server\r\n"));
    expect(Buffer.concat(received).toString()).toBe("SSH-2.0-server\r\n");
    // ssh closing its end closes the socket, and the pipe ends cleanly.
    input.end();
    await piped;
  } finally {
    await cleanup();
  }
});

it("says why the Hub refused an SSH connection that never opened", async () => {
  const { credentialPath, cleanup } = await signedIn();
  try {
    const fake = fakeSocket();
    const fetch: FetchLike = (input, init) => {
      const request = new Request(input.toString(), init);
      expect(request.url).toBe(sshUrl);
      expect(request.headers.get("Authorization")).toBe(
        "Bearer fixture-team-access",
      );
      return Promise.resolve(new Response(null, { status: 403 }));
    };
    const piped = pipePrivateComputerSsh(
      endpoint,
      "computer 1",
      { input: new PassThrough(), output: new PassThrough() },
      { credentialPath, socket: fake.factory, fetch },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.error();
    // The socket also closes after a refused handshake; the cause still wins.
    fake.close();
    await expect(piped).rejects.toThrow("You can't open SSH on this Computer.");
  } finally {
    await cleanup();
  }
});
