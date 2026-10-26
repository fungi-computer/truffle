import { z } from "zod";
import type {
  ShiitakeSession,
  SessionSnapshot,
} from "@fungi.computer/shiitake";
import type { PrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  openPrivateLocalShiitakeWorkerBatch,
  type PrivateLocalShiitakeServer,
} from "../src/private-local-shiitake-host.js";

const openedBatches: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openedBatches.splice(0).map((batch) => batch.close()));
});

function fakeSession(label: string) {
  const snapshot: SessionSnapshot & { label: string } = {
    pending: { total: 0, prompts: [], hasMore: false },
    sessionId: "main",
    cursor: null,
    hasMore: false,
    messages: [],
    terminals: [],
    activity: {
      queue: { state: "idle" },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    },
    extensions: {},
    attention: [],
    toolOutput: [],
    progress: null,
    label,
  };
  const session: ShiitakeSession = {
    address: "fixture://" + label,
    readSettlement: () =>
      Promise.reject(new Error("settlement is unused in this routing proof")),
    withdraw: () =>
      Promise.reject(new Error("withdraw is unused in this routing proof")),
    latestPending: () =>
      Promise.reject(
        new Error("pending lookup is unused in this routing proof"),
      ),
    read: () => Promise.resolve(snapshot),
    command: (): Promise<never> =>
      Promise.reject(new Error("command is unused in this routing proof")),
    send: () =>
      Promise.reject(new Error("send is unused in this routing proof")),
    cancel: () =>
      Promise.reject(new Error("cancel is unused in this routing proof")),
    extension: () => ({
      call: () =>
        Promise.reject(new Error("extension is unused in this routing proof")),
    }),
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    },
    subscribe: () => {
      throw new Error("subscribe is unused in this routing proof");
    },
    watch: () =>
      Promise.reject(new Error("watch is not part of this routing proof")),
    abort: () => Promise.resolve(),
  };
  return session;
}

function owner(name: string, closed: string[]): PrivateLocalRuntimeHost {
  const fixture: PrivateLocalRuntimeHost = {
    presentApproval: () =>
      Promise.reject(
        new Error("approval binding is unused in this routing proof"),
      ),
    prepareReload: () => Promise.reject(new Error("Unexpected fixture reload")),
    setModel: () => Promise.reject(new Error("Unexpected model write")),
    pendingDelegation: () => Promise.resolve(undefined),
    idle: () =>
      Promise.reject(new Error("idle is unused in this routing proof")),
    setArchived: () => {
      throw new Error("Unexpected archive write");
    },
    setMode: () => {
      throw new Error("Unexpected sandbox requirement write");
    },
    sandboxStatus: () => ({ mode: "workspace", available: true }),
    assertModelReady: () =>
      Promise.reject(new Error("Unexpected model admission")),
    agentId: "fixture-" + name,
    name: "fake-agent",
    bindSessionPath: () => {
      throw new Error("bindSessionPath is unused in this routing proof");
    },
    effectiveModel: () =>
      Promise.reject(
        new Error("effectiveModel is unused in this routing proof"),
      ),
    listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
    createSession: () =>
      Promise.reject(
        new Error("createSession is unused in this routing proof"),
      ),
    deleteSession: () =>
      Promise.reject(
        new Error("deleteSession is unused in this routing proof"),
      ),
    extensions: {
      list: () => Promise.resolve([]),
      call: () =>
        Promise.reject(
          new Error("extension call is unused in this routing proof"),
        ),
      resume: () =>
        Promise.reject(new Error("resume is unused in this routing proof")),
    },
    databasePath: "/tmp/" + name + ".sqlite",
    session: fakeSession(name),
    getSession: () => fixture.session,
    close: () => {
      closed.push(name);
      return Promise.resolve();
    },
    acceptMail: () =>
      Promise.reject(new Error("mail is not part of this routing proof")),
    readSettlement: () =>
      Promise.reject(new Error("settlement is not part of this routing proof")),
  };
  return fixture;
}

describe("private local Shiitake worker batch", () => {
  it("routes named workers through one server and closes each owner once", async () => {
    const closed: string[] = [];
    const alpha = owner("alpha", closed);
    const beta = owner("beta", closed);
    let serverOpens = 0;
    let serverCloses = 0;
    let fetch: ((request: Request) => Response | Promise<Response>) | undefined;
    const openServer = (
      handler: (request: Request) => Response | Promise<Response>,
    ): PrivateLocalShiitakeServer => {
      serverOpens += 1;
      fetch = handler;
      return {
        baseUrl: "http://127.0.0.1:43210",
        close: () => {
          serverCloses += 1;
          return Promise.resolve();
        },
      };
    };
    const batch = await openPrivateLocalShiitakeWorkerBatch(
      [
        { name: "alpha", owner: { invocationRoot: "/tmp/alpha" } },
        { name: "beta", owner: { invocationRoot: "/tmp/beta" } },
      ],
      openServer,
      (input) =>
        Promise.resolve(input.invocationRoot.endsWith("alpha") ? alpha : beta),
    );
    openedBatches.push(batch);
    expect(serverOpens).toBe(1);
    expect(batch.baseUrl).toBe("http://127.0.0.1:43210");
    expect(
      batch.workers.map(({ name, routePath, databasePath }) => ({
        name,
        routePath,
        databasePath,
      })),
    ).toEqual([
      {
        name: "alpha",
        routePath: "/workers/alpha",
        databasePath: "/tmp/alpha.sqlite",
      },
      {
        name: "beta",
        routePath: "/workers/beta",
        databasePath: "/tmp/beta.sqlite",
      },
    ]);
    if (fetch === undefined) throw new Error("Expected server fetch");
    const alphaResponse = await fetch(
      new Request("http://127.0.0.1:43210/workers/alpha/sessions/main"),
    );
    const betaResponse = await fetch(
      new Request("http://127.0.0.1:43210/workers/beta/sessions/main"),
    );
    expect(alphaResponse.status).toBe(200);
    expect(betaResponse.status).toBe(200);
    const alphaBody = z
      .object({ label: z.string() })
      .parse(await alphaResponse.json());
    const betaBody = z
      .object({ label: z.string() })
      .parse(await betaResponse.json());
    expect(alphaBody.label).toBe("alpha");
    expect(betaBody.label).toBe("beta");
    await batch.close();
    await batch.close();
    expect(serverCloses).toBe(1);
    expect(closed).toEqual(["alpha", "beta"]);
  });

  it("returns 404 for an unknown worker without dispatching a known owner", async () => {
    const closed: string[] = [];
    let reads = 0;
    const known = owner("alpha", closed);
    const session = known.session;
    const counted = {
      ...known,
      getSession: () => ({
        ...session,
        read: () => {
          reads += 1;
          return session.read();
        },
      }),
    };
    let fetch: ((request: Request) => Response | Promise<Response>) | undefined;
    const batch = await openPrivateLocalShiitakeWorkerBatch(
      [{ name: "alpha", owner: { invocationRoot: "/tmp/alpha" } }],
      (handler) => {
        fetch = handler;
        return { baseUrl: "http://invalid", close: () => Promise.resolve() };
      },
      () => Promise.resolve(counted),
    );
    openedBatches.push(batch);
    if (fetch === undefined) throw new Error("Expected server fetch");
    const response = await fetch(
      new Request("http://invalid/workers/unknown/sessions/main"),
    );
    expect(response.status).toBe(404);
    expect(reads).toBe(0);
  });

  it("validates route identities before opening any owner", async () => {
    let opens = 0;
    const openServer = () => {
      opens += 1;
      return { baseUrl: "http://invalid", close: () => Promise.resolve() };
    };
    await expect(
      openPrivateLocalShiitakeWorkerBatch(
        [
          { name: "same", owner: { invocationRoot: "/tmp/one" } },
          { name: "same", owner: { invocationRoot: "/tmp/two" } },
        ],
        openServer,
        () => Promise.reject(new Error("owner must not open")),
      ),
    ).rejects.toThrow(
      /Duplicate private local Shiitake worker route identity/u,
    );
    expect(opens).toBe(0);
  });

  it("closes every opened owner when the server fails to open", async () => {
    const closed: string[] = [];
    await expect(
      openPrivateLocalShiitakeWorkerBatch(
        [
          { name: "alpha", owner: { invocationRoot: "/tmp/alpha" } },
          { name: "beta", owner: { invocationRoot: "/tmp/beta" } },
        ],
        () => {
          throw new Error("server open failed");
        },

        (input) =>
          Promise.resolve(
            owner(
              input.invocationRoot.endsWith("alpha") ? "alpha" : "beta",
              closed,
            ),
          ),
      ),
    ).rejects.toThrow("server open failed");
    expect(closed).toEqual(["alpha", "beta"]);
  });

  it("retains server close failure while closing every owner once", async () => {
    const closed: string[] = [];
    let serverCloses = 0;
    const batch = await openPrivateLocalShiitakeWorkerBatch(
      [
        { name: "alpha", owner: { invocationRoot: "/tmp/alpha" } },
        { name: "beta", owner: { invocationRoot: "/tmp/beta" } },
      ],
      () => ({
        baseUrl: "http://invalid",
        close: () => {
          serverCloses += 1;
          return Promise.reject(new Error("server close failed"));
        },
      }),
      (input) =>
        Promise.resolve(
          owner(
            input.invocationRoot.endsWith("alpha") ? "alpha" : "beta",
            closed,
          ),
        ),
    );
    await expect(batch.close()).rejects.toThrow("server close failed");
    await expect(batch.close()).rejects.toThrow("server close failed");
    expect(serverCloses).toBe(1);
    expect(closed).toEqual(["alpha", "beta"]);
  });

  it("cleans acquired owners when a later owner fails", async () => {
    const closed: string[] = [];
    await expect(
      openPrivateLocalShiitakeWorkerBatch(
        [
          { name: "alpha", owner: { invocationRoot: "/tmp/alpha" } },
          { name: "beta", owner: { invocationRoot: "/tmp/beta" } },
        ],
        () => ({ baseUrl: "http://invalid", close: () => Promise.resolve() }),
        (input) => {
          if (input.invocationRoot.endsWith("beta"))
            return Promise.reject(new Error("beta owner failed"));

          return Promise.resolve(owner("alpha", closed));
        },
      ),
    ).rejects.toThrow("beta owner failed");
    expect(closed).toEqual(["alpha"]);
  });
});
