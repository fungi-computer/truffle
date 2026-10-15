import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, posix, relative, resolve, sep } from "node:path";
import process from "node:process";
import { RpcTarget, newWebSocketRpcSession } from "@fungi.computer/capnweb";
import {
  importSeamSigner,
  seamHeader,
  signSeamRequest,
  unsignedPayload,
  type SeamSigner,
} from "@fungi.computer/seam";

/**
 * A member's folder as an execution backend of a Team Computer.
 *
 * Local runs the same `computerd` 0.2.1 as the Computer container image,
 * built from vendored source and run under the user's Node in shim mode, with its shim mount rooted at the chosen folder, and dials out to
 * the Hub. The Computer then syncs and runs commands against this folder with
 * the library's own push/pull, exactly as it does against a container.
 *
 * `computerd` names files by their absolute path on this machine. The Hub
 * must only ever see `/workspace/...`, so Local serves the Hub a
 * `WorkspaceRPC` of its own that forwards to `computerd` and translates paths
 * at this one boundary. Entries outside the folder never cross it.
 */

/** The Computer-side root every backend's files live under. */
export const computerWorkspaceRoot = "/workspace";

export type ChangeCursor = { rev: number; path: string | null };
export type ChangeEntry =
  | {
      kind: "file";
      rev: number;
      path: string;
      mode: number;
      mtime: number;
      size: number;
      chunks: { hash: Uint8Array; size: number }[];
    }
  | { kind: "dir"; rev: number; path: string; mode: number; mtime: number }
  | {
      kind: "symlink";
      rev: number;
      path: string;
      target: string;
      mode: number;
      mtime: number;
    }
  | { kind: "delete"; rev: number; path: string };
export type BlobObject = { hash: Uint8Array; bytes: Uint8Array };
export type ExecEvent =
  | { id: string; seq: number; name: "stdout" | "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; code: number };
export type FetchChangesInput = { after?: ChangeCursor; ignore?: string[] };
export type ExecInput = {
  source: string;
  cwd?: string;
  id?: string;
  input?: unknown;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: Uint8Array;
};
export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

/** computerd's `WorkspaceRPC`, as `@cloudflare/computer` 0.2.1 speaks it. */
export type ComputerdWorkspaceRpc = {
  sync: {
    push(input: {
      senderRev: number;
      changes: ReadableStream<ChangeEntry>;
    }): Promise<{ rev: number; appliedPushCursor: ChangeCursor }>;
    fetchChanges(input: FetchChangesInput): Promise<{
      currentCursor: ChangeCursor;
      appliedPushCursor: ChangeCursor;
      stream: ReadableStream<ChangeEntry>;
    }>;
    watermarks(): Promise<{
      currentRev: number;
      pushRev: number;
      fetchCursor: ChangeCursor;
    }>;
    readEntry(path: string): Promise<ChangeEntry | null>;
    hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]>;
    /** Synchronous in computerd; a promise across the RPC session. */
    fetchObjects(hashes: Uint8Array[]): Promise<ReadableStream<BlobObject>>;
    pushObjects(objects: ReadableStream<BlobObject>): Promise<void>;
  };
  shell: {
    exec(
      input: ExecInput,
    ): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;
    getExec(input: {
      id: string;
      after?: number | "tail";
    }): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;
    killExec(input: { id: string; signal?: KillSignal }): Promise<void>;
    disposeExec(input: { id: string }): Promise<void>;
  };
};

/** Bidirectional path mapping between the folder and `/workspace`. */
export class FolderPathMap {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** A folder path as the Computer names it, or undefined outside the folder. */
  toComputer(localPath: string): string | undefined {
    const inside = relative(this.#root, localPath);
    if (inside === "") return computerWorkspaceRoot;
    if (inside.startsWith("..") || resolve(this.#root, inside) !== localPath)
      return undefined;
    return posix.join(computerWorkspaceRoot, ...inside.split(sep));
  }

  /** A Computer path on this machine, or undefined outside `/workspace`. */
  toLocal(computerPath: string): string | undefined {
    const normalized = posix.normalize(computerPath);
    if (normalized === computerWorkspaceRoot) return this.#root;
    if (!normalized.startsWith(`${computerWorkspaceRoot}/`)) return undefined;
    return resolve(
      this.#root,
      ...normalized.slice(computerWorkspaceRoot.length + 1).split("/"),
    );
  }
}

function mapCursor(
  cursor: ChangeCursor,
  map: (path: string) => string | undefined,
): ChangeCursor {
  // A cursor path outside the mapping can only name the folder's ancestors,
  // which computerd creates once at startup; the revision alone orders it.
  if (cursor.path === null) return cursor;
  const path = map(cursor.path);
  return path === undefined
    ? { rev: cursor.rev, path: null }
    : { rev: cursor.rev, path };
}

function mapEntries(
  stream: ReadableStream<ChangeEntry>,
  map: (path: string) => string | undefined,
): ReadableStream<ChangeEntry> {
  return stream.pipeThrough(
    new TransformStream<ChangeEntry, ChangeEntry>({
      transform(entry, controller) {
        const path = map(entry.path);
        if (path !== undefined) controller.enqueue({ ...entry, path });
      },
    }),
  );
}

class FolderSync extends RpcTarget {
  readonly #remote: ComputerdWorkspaceRpc["sync"];
  readonly #paths: FolderPathMap;

  constructor(remote: ComputerdWorkspaceRpc["sync"], paths: FolderPathMap) {
    super();
    this.#remote = remote;
    this.#paths = paths;
  }

  async push(input: {
    senderRev: number;
    changes: ReadableStream<ChangeEntry>;
  }) {
    return await this.#remote.push({
      senderRev: input.senderRev,
      changes: mapEntries(input.changes, (path) => this.#paths.toLocal(path)),
    });
  }

  async fetchChanges(input: FetchChangesInput) {
    const request: FetchChangesInput = {};
    if (input.after !== undefined)
      request.after = mapCursor(input.after, (path) =>
        this.#paths.toLocal(path),
      );
    if (input.ignore !== undefined)
      request.ignore = input.ignore.flatMap(
        (path) => this.#paths.toLocal(path) ?? [],
      );
    const toComputer = (path: string) => this.#paths.toComputer(path);
    const result = await this.#remote.fetchChanges(request);
    return {
      currentCursor: mapCursor(result.currentCursor, toComputer),
      appliedPushCursor: mapCursor(result.appliedPushCursor, toComputer),
      stream: mapEntries(result.stream, toComputer),
    };
  }

  async watermarks() {
    const marks = await this.#remote.watermarks();
    return {
      currentRev: marks.currentRev,
      pushRev: marks.pushRev,
      fetchCursor: mapCursor(marks.fetchCursor, (path) =>
        this.#paths.toComputer(path),
      ),
    };
  }

  async readEntry(path: string) {
    const local = this.#paths.toLocal(path);
    if (local === undefined) return null;
    const entry = await this.#remote.readEntry(local);
    return entry === null ? null : { ...entry, path };
  }

  async hasObjects(hashes: Uint8Array[]) {
    return await this.#remote.hasObjects(hashes);
  }

  async fetchObjects(hashes: Uint8Array[]) {
    return await this.#remote.fetchObjects(hashes);
  }

  async pushObjects(objects: ReadableStream<BlobObject>) {
    await this.#remote.pushObjects(objects);
  }
}

/** A command's working directory outside the folder is refused, not widened. */
export class FolderCwdError extends Error {
  constructor(cwd: string) {
    super(`Working directory is outside this machine's folder: ${cwd}`);
    this.name = "FolderCwdError";
  }
}

class FolderShell extends RpcTarget {
  readonly #remote: ComputerdWorkspaceRpc["shell"];
  readonly #paths: FolderPathMap;

  constructor(remote: ComputerdWorkspaceRpc["shell"], paths: FolderPathMap) {
    super();
    this.#remote = remote;
    this.#paths = paths;
  }

  async exec(input: ExecInput) {
    const request: ExecInput = { ...input };
    if (input.cwd !== undefined) {
      const cwd = this.#paths.toLocal(input.cwd);
      if (cwd === undefined) throw new FolderCwdError(input.cwd);
      request.cwd = cwd;
    }
    return await this.#remote.exec(request);
  }

  async getExec(input: { id: string; after?: number | "tail" }) {
    return await this.#remote.getExec(input);
  }

  async killExec(input: { id: string; signal?: KillSignal }) {
    await this.#remote.killExec(input);
  }

  async disposeExec(input: { id: string }) {
    await this.#remote.disposeExec(input);
  }
}

/** The `WorkspaceRPC` the Hub's Workspace sees for this folder. */
export class FolderWorkspaceRpc extends RpcTarget {
  readonly #sync: FolderSync;
  readonly #shell: FolderShell;

  constructor(remote: ComputerdWorkspaceRpc, root: string) {
    super();
    const paths = new FolderPathMap(root);
    this.#sync = new FolderSync(remote.sync, paths);
    this.#shell = new FolderShell(remote.shell, paths);
  }

  // capnweb reaches only methods and getters of an RpcTarget.
  get sync(): FolderSync {
    return this.#sync;
  }

  get shell(): FolderShell {
    return this.#shell;
  }
}

/** One running computerd rooted at a folder, reachable on loopback only. */
export type LocalComputerd = Readonly<{
  port: number;
  stop: () => Promise<void>;
}>;

const listeningLine = /computerd listening on [^:]+:(\d+) /;
/** computerd 0.2.1, built from vendored source by the Cordyceps package. */
const bundledCli = process.env.FUNGI_BUNDLED_CLI;
const computerdBundle =
  bundledCli === undefined
    ? createRequire(import.meta.url).resolve("@fungi.computer/cordyceps/cli")
    : resolve(dirname(bundledCli), "internal/computerd.cjs");
const minimumNode = [22, 13] as const;

/** Thrown when this machine has no Node new enough to run computerd. */
export class ComputerdNodeError extends Error {
  constructor(found: string) {
    super(
      `Attaching a folder runs computerd under Node ${minimumNode.join(".")} or newer; found ${found}. Install Node from https://nodejs.org or set FUNGI_NODE to its path.`,
    );
    this.name = "ComputerdNodeError";
  }
}

/**
 * The Node that runs computerd: FUNGI_NODE, else this process when it is
 * Node, else `node` on the PATH (the fungi CLI itself runs on Bun). The
 * same bundle and shim mode run on Linux and macOS; nothing native loads.
 */
export function resolveComputerdNode(): string {
  const node =
    process.env.FUNGI_NODE ??
    ("bun" in process.versions ? "node" : process.execPath);
  const probe = spawnSync(node, ["-p", "process.versions.node"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  const version = probe.status === 0 ? probe.stdout.trim() : "";
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (
    major < minimumNode[0] ||
    (major === minimumNode[0] && minor < minimumNode[1])
  )
    throw new ComputerdNodeError(version === "" ? "none" : version);
  return node;
}
const loopbackPreload = fileURLToPath(
  new URL("../computerd-loopback.cjs", import.meta.url),
);

/**
 * Start computerd for `root`. It gets a scrubbed environment: the executable
 * search path, a home, a locale and a terminal type, never this process's
 * ambient variables or credentials.
 */
export async function startLocalComputerd(
  options: Readonly<{
    root: string;
    /** Defaults to {@link resolveComputerdNode}. */
    node?: string;
    startTimeoutMs?: number;
  }>,
): Promise<LocalComputerd> {
  const environment = {
    PORT: "0",
    MOUNT_POINT: options.root,
    FUSE_MOUNT: "shim",
    HOME: options.root,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
    NODE_OPTIONS: `--require ${JSON.stringify(loopbackPreload)}`,
    NODE_NO_WARNINGS: "1",
  } satisfies Record<string, string>;
  const child: ChildProcess = spawn(
    options.node ?? resolveComputerdNode(),
    [computerdBundle],
    {
      cwd: options.root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await new Promise<number>((resolvePort, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`computerd did not start: ${output.slice(-500)}`));
    }, options.startTimeoutMs ?? 20_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = listeningLine.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`computerd exited (${String(code)}): ${output.slice(-500)}`),
      );
    });
  });
  return {
    port,
    stop: async () => {
      const running = () => child.exitCode === null;
      if (!running()) return;
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((done) => setTimeout(done, 5_000)),
      ]);
      if (running()) child.kill("SIGKILL");
    },
  };
}

/** Where one attached backend dials. */
export type LocalBackendTarget = Readonly<{
  hubOrigin: string;
  teamId: string;
  computerId: string;
  backendId: string;
  deviceId: string;
  /** The device's Ed25519 private key, base64 PKCS#8. Never sent. */
  privateKey: string;
}>;

export type LocalBackendStatus =
  | Readonly<{ kind: "connecting" }>
  | Readonly<{ kind: "online" }>
  | Readonly<{ kind: "offline"; retryInMs: number; reason: string }>
  | Readonly<{ kind: "refused" }>;

function dialUrl(target: LocalBackendTarget): URL {
  return new URL(
    `/api/teams/${encodeURIComponent(target.teamId)}/computers/${encodeURIComponent(target.computerId)}/backends/${encodeURIComponent(target.backendId)}/connect`,
    target.hubOrigin,
  );
}

async function signedDialHeader(
  signer: SeamSigner,
  target: LocalBackendTarget,
  url: URL,
): Promise<string> {
  return await signSeamRequest(
    signer,
    `fungi-local-backend:${target.computerId}:${target.backendId}`,
    "GET",
    url.href,
    unsignedPayload,
  );
}

/** A signed plain GET: 426 while attached, 404 once detached. */
async function probeDial(
  url: URL,
  signer: SeamSigner,
  target: LocalBackendTarget,
): Promise<
  | { kind: "reachable"; status: number }
  | { kind: "unavailable"; cause: unknown }
> {
  try {
    const response = await fetch(url, {
      headers: { [seamHeader]: await signedDialHeader(signer, target, url) },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { kind: "reachable", status: response.status };
  } catch (cause) {
    return { kind: "unavailable", cause };
  }
}

function openSocket(url: URL, header: string): Promise<WebSocket> {
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolveSocket, reject) => {
    // Bun and Node's undici WebSocket accept handshake headers here.
    const socket = new WebSocket(wsUrl, { headers: { [seamHeader]: header } });
    socket.addEventListener(
      "open",
      () => {
        resolveSocket(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        reject(new Error("Hub refused or dropped the connection"));
      },
      { once: true },
    );
  });
}

/**
 * Keep one attached folder connected until `signal` aborts: dial out, serve
 * the folder over the socket, and redial with backoff whenever it drops. A
 * Hub that refuses the dial (a detached backend) stops the loop.
 */
export async function runLocalComputerBackend(
  options: Readonly<{
    target: LocalBackendTarget;
    root: string;
    computerdPort: number;
    signal: AbortSignal;
    onStatus?: ((status: LocalBackendStatus) => void) | undefined;
    /** Consecutive 404 refusals before the backend counts as detached. */
    refusedLimit?: number;
  }>,
): Promise<"stopped" | "refused"> {
  const signer = await importSeamSigner(
    `${options.target.deviceId}:${options.target.privateKey}`,
  );
  const computerd = newWebSocketRpcSession<ComputerdWorkspaceRpc>(
    `ws://127.0.0.1:${String(options.computerdPort)}/ws`,
  );
  const remote: ComputerdWorkspaceRpc = computerd;
  const folder = new FolderWorkspaceRpc(remote, options.root);
  const url = dialUrl(options.target);
  let delay = 500;
  let refused = 0;
  const stopped = () => options.signal.aborted;
  try {
    while (!options.signal.aborted) {
      options.onStatus?.({ kind: "connecting" });
      // Settle the folder into computerd's store before the Computer pushes,
      // so its push overwrites or deletes every offline folder edit it
      // conflicts with instead of racing the shim's next disk poll.
      await settleFolder(remote);
      let socket: WebSocket;
      try {
        socket = await openSocket(
          url,
          await signedDialHeader(signer, options.target, url),
        );
      } catch (error) {
        // A detached backend's dial is refused with 404; anything else is
        // this machine or the Hub being unreachable, retried indefinitely.
        const probe = await probeDial(url, signer, options.target);
        if (probe.kind === "reachable" && probe.status === 404) {
          refused += 1;
          if (refused >= (options.refusedLimit ?? 2)) {
            options.onStatus?.({ kind: "refused" });
            return "refused";
          }
        } else refused = 0;
        options.onStatus?.({
          kind: "offline",
          retryInMs: delay,
          reason:
            probe.kind === "unavailable"
              ? `Dial probe unavailable: ${probe.cause instanceof Error ? probe.cause.message : String(probe.cause)}`
              : error instanceof Error
                ? error.message
                : String(error),
        });
        await sleep(delay, options.signal);
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      refused = 0;
      delay = 500;
      const session = newWebSocketRpcSession(socket, folder);
      options.onStatus?.({ kind: "online" });
      await new Promise<void>((closed) => {
        const done = () => {
          closed();
        };
        socket.addEventListener("close", done, { once: true });
        socket.addEventListener("error", done, { once: true });
        options.signal.addEventListener(
          "abort",
          () => {
            socket.close(1000, "Local stopped");
            done();
          },
          { once: true },
        );
      });
      try {
        session[Symbol.dispose]();
      } catch (cause) {
        console.error("Local Computer backend operation unavailable", cause);

        // The session already ended with its socket.
      }
      if (!stopped())
        options.onStatus?.({
          kind: "offline",
          retryInMs: delay,
          reason: "connection closed",
        });
    }
    return "stopped";
  } finally {
    computerd[Symbol.dispose]();
  }
}

/** A fetch makes computerd's shim reconcile the folder into its store now. */
async function settleFolder(remote: ComputerdWorkspaceRpc): Promise<void> {
  const settled = await remote.sync.fetchChanges({
    after: { rev: Number.MAX_SAFE_INTEGER, path: null },
  });
  await settled.stream.cancel();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

export type { FolderSync, FolderShell };
