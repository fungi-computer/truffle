import { logEvent } from "../src/log-event.js";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createModels,
  createProvider,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileCredentialStore,
  createPrivateCredentialStore,
  resolveDefaultCredentialPath,
} from "../src/private-file-credential-store.js";

const providerId = "synthetic-provider";
const initialCredential: OAuthCredential = {
  type: "oauth",
  refresh: "synthetic-refresh",
  access: "synthetic-access",
  expires: 0,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await stopLiveProcesses();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function credentialPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-credentials-"));
  temporaryDirectories.push(directory);
  return join(directory, "credentials.json");
}

function oauthProvider(
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>,
) {
  return createProvider({
    id: providerId,
    name: "Synthetic provider",
    auth: {
      oauth: {
        name: "Synthetic OAuth",
        login: () => Promise.resolve(initialCredential),
        refresh: async (credential) => await refresh(credential),
        toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
    models: [],
    api: {
      stream() {
        throw new Error("Synthetic provider stream is not used by auth tests");
      },
      streamSimple() {
        throw new Error("Synthetic provider stream is not used by auth tests");
      },
    },
  });
}

async function seed(store: ReturnType<typeof createPrivateCredentialStore>) {
  await store.modify(providerId, () => Promise.resolve(initialCredential));
}

type RunningStoreProcess = {
  readonly child: ChildProcess;
  readonly events: string;
  readonly stderr: () => string;
};

const liveProcesses = new Set<RunningStoreProcess>();

function runBuiltStoreProcess(
  path: string,
  events: string,
  label: string,
  delay: number,
): ChildProcess {
  // Import the built store module itself, not the package barrel: the barrel
  // loads workerd, MCP, and runtime-host code whose startup cost scales with
  // machine load and has nothing to do with the lock under test.
  const entry = pathToFileURL(
    resolve("dist/private-file-credential-store.js"),
  ).href;
  const program = `
    import { appendFile } from "node:fs/promises";
    const { createPrivateCredentialStore } = await import(${JSON.stringify(entry)});
    const [credentialPath, eventPath, processLabel, pause] = process.argv.slice(1);
    const store = createPrivateCredentialStore(credentialPath);
    await store.modify(${JSON.stringify(providerId)}, async (current) => {
      await appendFile(eventPath, processLabel + ":entered:" + (current?.access ?? "missing") + "\\n");
      process.stdout.write("entered\\n");
      await new Promise((done) => setTimeout(done, Number(pause)));
      await appendFile(eventPath, processLabel + ":leaving\\n");
      return {
        type: "oauth",
        refresh: "synthetic-" + processLabel + "-refresh",
        access: "synthetic-" + processLabel + "-access",
        expires: Date.now() + 10 * 60_000,
      };
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      program,
      path,
      events,
      label,
      String(delay),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr.on("data", (data: Buffer) => {
    stderr.push(data.toString());
  });
  const running = { child, events, stderr: () => stderr.join("") };
  liveProcesses.add(running);
  child.once("close", () => {
    liveProcesses.delete(running);
  });
  return child;
}

/**
 * A child still running at teardown means the test's own bound expired. Record
 * its phases, then stop it before its temporary directory is removed.
 */
async function stopLiveProcesses(): Promise<void> {
  await Promise.all(
    [...liveProcesses].map(async ({ child, events, stderr }) => {
      const closed = new Promise((done) => child.once("close", done));
      await recordProcessFailure(events, stderr(), "running-at-teardown");
      child.kill("SIGKILL");
      await closed;
    }),
  );
}

async function recordProcessFailure(
  events: string,
  stderr: string,
  reason: string,
): Promise<void> {
  let phases = "<event log unavailable>";
  try {
    phases = await readFile(events, "utf8");
  } catch (cause) {
    logEvent("credential-proof.read-events", cause);
  }
  const report = `reason=${reason}\nstderr=${stderr || "<empty>"}\nphases=${phases}`;
  await appendFile(`${events}.failure`, report);
  const directory = resolve(".botanical", "local-credential-failures");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${String(Date.now())}-${String(process.pid)}.log`),
    report,
    {
      mode: 0o600,
    },
  );
}

/** Settles on the child's own exit state; the test timeout bounds the wait. */
function waitForProcess(child: ChildProcess, events: string): Promise<void> {
  return new Promise((resolveProcess, reject) => {
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", (error) => {
      void recordProcessFailure(
        events,
        stderr,
        `error:${error.message}`,
      ).finally(() => {
        reject(error);
      });
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      void recordProcessFailure(events, stderr, `exit:${String(code)}`).finally(
        () => {
          reject(new Error(`Synthetic credential process failed: ${stderr}`));
        },
      );
    });
  });
}

/** Settles when the child reports it holds the lock, or exits without it. */
function waitForEntry(child: ChildProcess, events: string): Promise<void> {
  return new Promise((resolveEntry, reject) => {
    let entered = false;
    child.stdout?.once("data", () => {
      entered = true;
      resolveEntry();
    });
    child.once("error", (error) => {
      if (entered) return;
      void recordProcessFailure(
        events,
        "",
        `entry-error:${error.message}`,
      ).finally(() => {
        reject(error);
      });
    });
    child.once("exit", (code) => {
      if (entered) return;
      void recordProcessFailure(
        events,
        "",
        `entry-exit:${String(code)}`,
      ).finally(() => {
        reject(
          new Error("Synthetic credential process exited before entering"),
        );
      });
    });
  });
}

describe("private Pi credential store", () => {
  it("keeps one installation identity across concurrent stores without exposing it as a login", async () => {
    const path = await credentialPath();
    const first = createPrivateCredentialStore(path);
    const second = createPrivateCredentialStore(path);
    const [left, right] = await Promise.all([
      first.getDeviceId(),
      second.getDeviceId(),
    ]);
    expect(left).toBe(right);
    await expect(
      createPrivateCredentialStore(path).getDeviceId(),
    ).resolves.toBe(left);
    await expect(first.list()).resolves.toEqual([]);
    expect((await stat(`${path}.device-id`)).mode & 0o777).toBe(0o600);
  });

  it("treats a missing private file as unconfigured", async () => {
    const store = createPrivateCredentialStore(await credentialPath());

    await expect(store.read(providerId)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.delete(providerId)).resolves.toBeUndefined();
  });

  it("persists synthetic credentials across a new store instance with private modes", async () => {
    const path = await credentialPath();
    const first = createPrivateCredentialStore(path);
    await seed(first);

    const restarted = createPrivateCredentialStore(path);
    await expect(restarted.read(providerId)).resolves.toEqual(
      initialCredential,
    );
    await expect(restarted.list()).resolves.toEqual([
      { providerId, type: "oauth" },
    ]);
    const directory = join(path, "..");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps malformed stored bytes visible", async () => {
    const path = await credentialPath();
    const malformed = "{synthetic-malformed-json";
    await writeFile(path, malformed, { mode: 0o600 });

    await expect(
      createPrivateCredentialStore(path).read(providerId),
    ).rejects.toThrow("Credential store contains malformed JSON");
    await expect(readFile(path, "utf8")).resolves.toBe(malformed);
  });

  it("rejects an oversized private file without changing its bytes", async () => {
    const path = await credentialPath();
    const oversized = Buffer.alloc(256 * 1_024 + 1, "x");
    await writeFile(path, oversized, { mode: 0o600 });

    await expect(
      createPrivateCredentialStore(path).read(providerId),
    ).rejects.toThrow("Credential store exceeds its private file bound");
    // Buffer#equals is a single memcmp; toEqual walks all 256 KiB byte by byte.
    expect((await readFile(path)).equals(oversized)).toBe(true);
  });

  it("treats an inherited provider name as missing until it is stored", async () => {
    const path = await credentialPath();
    const store = createPrivateCredentialStore(path);
    const inheritedProviderId = "toString";

    await expect(store.read(inheritedProviderId)).resolves.toBeUndefined();
    await expect(
      store.modify(inheritedProviderId, (current) => {
        expect(current).toBeUndefined();
        return Promise.resolve(initialCredential);
      }),
    ).resolves.toEqual(initialCredential);
    await expect(store.read(inheritedProviderId)).resolves.toEqual(
      initialCredential,
    );
    await store.delete(inheritedProviderId);
    await expect(store.read(inheritedProviderId)).resolves.toBeUndefined();
  });

  it("releases its lock after callback and atomic-write failures", async () => {
    const path = await credentialPath();
    const store = createPrivateCredentialStore(path);
    await seed(store);

    await expect(
      store.modify(providerId, () =>
        Promise.reject(new Error("synthetic callback failure")),
      ),
    ).rejects.toThrow("synthetic callback failure");
    await expect(store.read(providerId)).resolves.toEqual(initialCredential);

    const failingStore = new FileCredentialStore(path, () =>
      Promise.reject(new Error("synthetic atomic write failure")),
    );
    await expect(
      failingStore.modify(providerId, (current) => Promise.resolve(current)),
    ).rejects.toThrow("synthetic atomic write failure");
    await expect(store.read(providerId)).resolves.toEqual(initialCredential);
  });

  it("surfaces a bounded lock acquisition failure", async () => {
    const path = await credentialPath();
    await mkdir(`${path}.lock`);

    await expect(
      createPrivateCredentialStore(path).modify(providerId, () =>
        Promise.resolve(initialCredential),
      ),
    ).rejects.toMatchObject({ code: "ELOCKED" });
  });

  it("excludes another OS process from the whole modify critical section", async () => {
    const path = await credentialPath();
    const events = `${path}.events`;
    const first = runBuiltStoreProcess(path, events, "first", 150);
    const firstDone = waitForProcess(first, events);
    await waitForEntry(first, events);
    const second = runBuiltStoreProcess(path, events, "second", 0);
    const secondDone = waitForProcess(second, events);

    await Promise.all([firstDone, secondDone]);

    await expect(readFile(events, "utf8")).resolves.toBe(
      "first:entered:missing\n" +
        "first:leaving\n" +
        "second:entered:synthetic-first-access\n" +
        "second:leaving\n",
    );
    await expect(
      createPrivateCredentialStore(path).read(providerId),
    ).resolves.toMatchObject({ access: "synthetic-second-access" });
  }, 60_000);

  it("serializes competing Pi refreshes across independent stores", async () => {
    const path = await credentialPath();
    const firstStore = createPrivateCredentialStore(path);
    const secondStore = createPrivateCredentialStore(path);
    await seed(firstStore);
    const refreshStarted = Promise.withResolvers<undefined>();
    const allowRefresh = Promise.withResolvers<undefined>();
    let refreshes = 0;
    const refresh = async (credential: OAuthCredential) => {
      refreshes += 1;
      refreshStarted.resolve(undefined);
      await allowRefresh.promise;
      return {
        ...credential,
        access: "synthetic-refreshed-access",
        expires: Date.now() + 10 * 60_000,
      };
    };
    const firstModels = createModels({ credentials: firstStore });
    const secondModels = createModels({ credentials: secondStore });
    const provider = oauthProvider(refresh);
    firstModels.setProvider(provider);
    secondModels.setProvider(provider);

    const firstAuth = firstModels.getAuth(providerId);
    await refreshStarted.promise;
    const secondAuth = secondModels.getAuth(providerId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshes).toBe(1);
    allowRefresh.resolve(undefined);

    await expect(firstAuth).resolves.toEqual({
      auth: { apiKey: "synthetic-refreshed-access" },
      source: "OAuth",
    });
    await expect(secondAuth).resolves.toEqual({
      auth: { apiKey: "synthetic-refreshed-access" },
      source: "OAuth",
    });
    expect(refreshes).toBe(1);
  });

  it("serializes Pi logout after a competing Pi refresh", async () => {
    const path = await credentialPath();
    const refreshStore = createPrivateCredentialStore(path);
    const logoutStore = createPrivateCredentialStore(path);
    await seed(refreshStore);
    const refreshStarted = Promise.withResolvers<undefined>();
    const allowRefresh = Promise.withResolvers<undefined>();
    const refresh = async (credential: OAuthCredential) => {
      refreshStarted.resolve(undefined);
      await allowRefresh.promise;
      return {
        ...credential,
        access: "synthetic-delete-race-access",
        expires: Date.now() + 60_000,
      };
    };
    const refreshingModels = createModels({ credentials: refreshStore });
    const logoutModels = createModels({ credentials: logoutStore });
    const provider = oauthProvider(refresh);
    refreshingModels.setProvider(provider);
    logoutModels.setProvider(provider);

    const auth = refreshingModels.getAuth(providerId);
    await refreshStarted.promise;
    let loggedOut = false;
    const logout = logoutModels.logout(providerId).then(() => {
      loggedOut = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loggedOut).toBe(false);
    allowRefresh.resolve(undefined);

    await expect(auth).resolves.toEqual({
      auth: { apiKey: "synthetic-delete-race-access" },
      source: "OAuth",
    });
    await logout;
    await expect(refreshStore.read(providerId)).resolves.toBeUndefined();
  });

  it("resolves the selected default outside the project and accepts only absolute paths", () => {
    expect(resolveDefaultCredentialPath("/synthetic-home")).toBe(
      "/synthetic-home/.config/fungi/credentials.json",
    );
    expect(() =>
      createPrivateCredentialStore("relative/credentials.json"),
    ).toThrow("Private credential path must be absolute");
    expect(() => resolveDefaultCredentialPath("relative-home")).toThrow(
      "Default credential home must be absolute",
    );
  });
});
