import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  enrollPrivateLocalMesh,
  localMeshJoinSchema,
} from "../src/private-local-mesh-enrollment.js";
import {
  createLocalMachineEnrollmentAccount,
  signOutOwnedFungiAccount,
} from "../src/private-fungi-account.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";

/**
 * Node ignores a listener's promise. `void` keeps a failed assertion inside
 * the handler an unhandled rejection that Vitest reports, as before.
 */
const serve = (
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
) =>
  createServer((request, response) => {
    void handler(request, response);
  });

const closed = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolve();
      else reject(cause);
    });
  });

it("joins without OAuth, sends the Oyster key once, and reopens only the device enrollment", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-enrollment-"));
  const credentialPath = join(root, "credentials.json");
  const key = "oyk_fixture_machine_enroll_only";
  const requests: { path: string; authorization: string | undefined }[] = [];
  // Local HTTP contract control; actual standalone route proof belongs to the
  // joined Oyster-owned native fixture, not this independent response producer.
  const server = serve(async (request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
    });
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        kind: "joined",
        scopeId: "owner-agents",
        deviceId: "device",
        agents: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const input = {
    origin,
    kind: "oyster-key" as const,
    key,
    invocationRoot: root,
    machineLabel: "Local",
    agents: [],
  };
  const options = {
    credentialPath,
    account: createLocalMachineEnrollmentAccount(credentialPath),
  };
  try {
    const expected = {
      state: "enrolled",
      deviceId: "device",
      agents: [],
    };
    await expect(enrollPrivateLocalMesh(input, options)).resolves.toEqual(
      expected,
    );
    expect(requests).toEqual([
      {
        path: "/local/mesh/join",
        authorization: `Bearer ${key}`,
      },
    ]);
    const persisted = await readFile(credentialPath, "utf8");
    expect(persisted).not.toContain(key);
    expect(persisted).not.toContain('"type":"oauth"');
    expect(await createPrivateCredentialStore(credentialPath).list()).toEqual(
      [],
    );
    const accounts = await options.account.read();
    expect(accounts).toEqual([
      {
        kind: "oyster",
        origin,
        enrollments: [
          expect.objectContaining({
            state: "enrolled",
            deviceId: "device",
            scopeId: "owner-agents",
          }),
        ],
      },
    ]);
    const [enrolled] = accounts[0]?.enrollments ?? [];
    expect(enrolled).toHaveProperty("privateKey", expect.any(String));
    expect(enrolled).toHaveProperty("publicKey", expect.any(String));
    const replayed = await enrollPrivateLocalMesh(input, options);
    expect(replayed).toEqual(expected);
    expect(JSON.stringify(replayed)).not.toContain(key);
    expect(requests).toHaveLength(1);
    expect(await readFile(credentialPath, "utf8")).toBe(persisted);
  } finally {
    await closed(server);
    await rm(root, { recursive: true, force: true });
  }
});

it("a native cross-origin redirect fails without forwarding the enrollment bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-no-redirect-"));
  const credentialPath = join(root, "credentials.json");
  const key = "oyk_not_for_the_redirect_target";
  let forwarded = 0;
  let sent = 0;
  const target = createServer((_request, response) => {
    forwarded += 1;
    response.end();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(target.address());
  const redirect = `http://127.0.0.1:${String(targetAddress.port)}/must-not-receive-key`;
  const source = serve(async (request, response) => {
    sent += 1;
    expect(request.headers.authorization).toBe(`Bearer ${key}`);
    for await (const chunk of request) void chunk;
    response.writeHead(302, { Location: redirect });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceAddress = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(source.address());
  try {
    const joining = enrollPrivateLocalMesh(
      {
        kind: "oyster-key",
        origin: `http://127.0.0.1:${String(sourceAddress.port)}`,
        key,
        invocationRoot: root,
        machineLabel: "Local",
        agents: [],
      },
      {
        credentialPath,
        account: createLocalMachineEnrollmentAccount(credentialPath),
      },
    );
    await expect(joining).rejects.toThrow("fetch failed");
    const failure = z
      .instanceof(Error)
      .parse(await joining.catch((cause: unknown) => cause));
    expect(String(failure)).not.toContain(key);
    expect(String(failure.cause)).not.toContain(key);
    expect(sent).toBe(1);
    expect(forwarded).toBe(0);
    expect(await readFile(credentialPath, "utf8")).not.toContain(key);
  } finally {
    await Promise.all([source, target].map(closed));
    await rm(root, { recursive: true, force: true });
  }
});

it("does not refresh or log a refused Oyster bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-refused-"));
  const credentialPath = join(root, "credentials.json");
  const key = "oyk_refused_enrollment_key";
  const transport = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 401 })),
  );
  const logging = vi.spyOn(console, "error");
  try {
    await expect(
      enrollPrivateLocalMesh(
        {
          kind: "oyster-key",
          origin: "https://oyster.example",
          key,
          invocationRoot: root,
          machineLabel: "Local",
          agents: [],
        },
        {
          credentialPath,
          account: createLocalMachineEnrollmentAccount(credentialPath),
          fetch: Object.assign(transport, {
            preconnect: globalThis.fetch.preconnect,
          }),
        },
      ),
    ).rejects.toThrow("HTTP 401");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await readFile(credentialPath, "utf8")).not.toContain(key);
    expect(JSON.stringify(logging.mock.calls)).not.toContain(key);
    expect(
      (await createLocalMachineEnrollmentAccount(credentialPath).read())[0]
        ?.enrollments[0]?.state,
    ).toBe("pending");
  } finally {
    logging.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "http://oyster.example",
  "http://localhost.evil.example",
  "http://localhost.",
  "http://127.0.0.2",
  "http://192.168.1.1",
  "https://user:password@oyster.example",
  "https://oyster.example?query=1",
  "https://oyster.example#fragment",
  "https://oyster.example/not-an-origin",
])(
  "refuses an unsafe enrollment origin before storing or sending: %s",
  async (origin) => {
    const root = await mkdtemp(join(tmpdir(), "standalone-origin-"));
    const credentialPath = join(root, "credentials.json");
    const transport = vi.fn();
    try {
      await expect(
        enrollPrivateLocalMesh(
          {
            kind: "oyster-key",
            origin,
            key: "oyk_not_for_this_origin",
            invocationRoot: root,
            machineLabel: "Local",
            agents: [],
          },
          {
            credentialPath,
            account: createLocalMachineEnrollmentAccount(credentialPath),
            fetch: Object.assign(transport, {
              preconnect: globalThis.fetch.preconnect,
            }),
          },
        ),
      ).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect(
        await createLocalMachineEnrollmentAccount(credentialPath).read(),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("an acknowledgment arriving after origin logout cannot restore the device key", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-lost-custody-"));
  const credentialPath = join(root, "credentials.json");
  const origin = "https://oyster.example";
  const entered = Promise.withResolvers<undefined>();
  const response = Promise.withResolvers<Response>();
  const transport = Object.assign(
    () => {
      entered.resolve(undefined);
      return response.promise;
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const account = createLocalMachineEnrollmentAccount(credentialPath);
  try {
    const joining = enrollPrivateLocalMesh(
      {
        kind: "oyster-key",
        origin,
        key: "oyk_once_only",
        invocationRoot: root,
        machineLabel: "Local",
        agents: [],
      },
      { credentialPath, account, fetch: transport },
    );
    const refused = expect(joining).rejects.toThrow(
      "removed before acknowledgment",
    );
    await entered.promise;
    expect(
      (await signOutOwnedFungiAccount(origin, { credentialPath })).kind,
    ).toBe("removed");
    response.resolve(
      Response.json({
        kind: "joined",
        scopeId: "agents",
        deviceId: "device",
        agents: [],
      }),
    );
    await refused;
    expect(await account.read()).toEqual([]);
    expect(
      await createPrivateCredentialStore(
        credentialPath,
      ).readMachineEnrollments(),
    ).toEqual([]);
  } finally {
    response.resolve(new Response(null, { status: 503 }));
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["joined", "refused", "transport-error"] as const)(
  "releases its parsed bearer and transport header when fetch settles: %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "standalone-transient-key-"));
    const credentialPath = join(root, "credentials.json");
    const key = "oyk_transient_join_bearer";
    // These spies deliberately retain the owned DTO/header so their release
    // is observable. This does not claim erasure of immutable JS string bytes
    // or copies held by the caller, fetch implementation or test harness.
    const parsed = vi.spyOn(localMeshJoinSchema, "parse");
    const captured = Promise.withResolvers<Headers>();
    const released = async () => {
      expect((await captured.promise).get("Authorization")).toBeNull();
      expect(parsed.mock.results[0]?.value).toMatchObject({ key: "" });
    };
    const payload = {
      kind: "joined",
      scopeId: "agents",
      deviceId: "device",
      agents: [],
    };
    const reading = vi.fn(
      async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        // The response is available, but its body has not been consumed.
        // Bearer authority must already have been released.
        await released();
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({ pull: reading }, { highWaterMark: 0 }),
      { status: outcome === "refused" ? 401 : 200 },
    );
    const transport: typeof globalThis.fetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        const headers = z.instanceof(Headers).parse(init?.headers);
        expect(headers.get("Authorization")).toBe(`Bearer ${key}`);
        expect(init?.redirect).toBe("error");
        expect(init?.body).not.toContain(key);
        captured.resolve(headers);
        return outcome === "transport-error"
          ? Promise.reject(new Error("fixture transport failure"))
          : Promise.resolve(response);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    try {
      const joining = enrollPrivateLocalMesh(
        {
          kind: "oyster-key",
          origin: "https://oyster.example",
          key,
          invocationRoot: root,
          machineLabel: "Local",
          agents: [],
        },
        {
          credentialPath,
          account: createLocalMachineEnrollmentAccount(credentialPath),
          fetch: transport,
        },
      );
      if (outcome === "joined") {
        await expect(joining).resolves.toMatchObject({ state: "enrolled" });
        expect(reading).toHaveBeenCalledTimes(1);
      } else {
        await expect(joining).rejects.toThrow(
          outcome === "refused" ? "HTTP 401" : "fixture transport failure",
        );
        expect(reading).not.toHaveBeenCalled();
      }
      await released();
      expect(await readFile(credentialPath, "utf8")).not.toContain(key);
    } finally {
      parsed.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("refuses a loopback join body above 64 KiB without storing its acknowledgment", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-response-cap-"));
  const credentialPath = join(root, "credentials.json");
  let beforeResponse = "";
  const payload = JSON.stringify({
    kind: "joined",
    scopeId: "oversized-scope-must-not-be-stored",
    deviceId: "oversized-device-must-not-be-stored",
    agents: [],
  });
  const server = serve(async (request, response) => {
    for await (const chunk of request) void chunk;
    beforeResponse = await readFile(credentialPath, "utf8");
    // Chunked, valid JSON, so neither Content-Length nor the schema supplies
    // the byte fence. The pending intent predates this remote response.
    response.writeHead(200, { "content-type": "application/json" });
    response.write(payload);
    response.end(" ".repeat(64 * 1024 + 1 - Buffer.byteLength(payload)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  const account = createLocalMachineEnrollmentAccount(credentialPath);
  try {
    await expect(
      enrollPrivateLocalMesh(
        {
          kind: "oyster-key",
          origin: `http://127.0.0.1:${String(address.port)}`,
          key: "oyk_bounded_response",
          invocationRoot: root,
          machineLabel: "Local",
          agents: [],
        },
        { credentialPath, account },
      ),
    ).rejects.toThrow("Machine enrollment response is too large");
    expect(beforeResponse).not.toBe("");
    expect(await readFile(credentialPath, "utf8")).toBe(beforeResponse);
    expect(await account.read()).toMatchObject([
      { enrollments: [{ state: "pending" }] },
    ]);
    expect(beforeResponse).not.toContain("oversized-scope-must-not-be-stored");
    expect(beforeResponse).not.toContain("oversized-device-must-not-be-stored");
    expect(beforeResponse).not.toContain("oyk_bounded_response");
  } finally {
    await closed(server);
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "https://oyster.example",
  "http://localhost",
  "http://127.0.0.1",
  "http://[::1]",
])(
  "uses only HTTPS or an exact-loopback HTTP join destination: %s",
  async (origin) => {
    const root = await mkdtemp(join(tmpdir(), "standalone-transport-policy-"));
    const credentialPath = join(root, "credentials.json");
    const transport = vi.fn(
      (url: string | URL | Request, init?: RequestInit) => {
        expect(url instanceof Request ? url.url : url.toString()).toBe(
          `${origin}/local/mesh/join`,
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer oyk_once",
        );
        expect(init?.redirect).toBe("error");
        expect(init?.body).not.toContain("oyk_once");
        return Promise.resolve(
          Response.json({
            kind: "joined",
            scopeId: "agents",
            deviceId: "device",
            agents: [],
          }),
        );
      },
    );
    const account = createLocalMachineEnrollmentAccount(credentialPath);
    try {
      const input = {
        kind: "oyster-key" as const,
        origin,
        key: "oyk_once",
        invocationRoot: root,
        machineLabel: "Local",
        agents: [],
      };
      const options = {
        credentialPath,
        account,
        fetch: Object.assign(transport, {
          preconnect: globalThis.fetch.preconnect,
        }),
      };
      await enrollPrivateLocalMesh(input, options);
      await enrollPrivateLocalMesh(input, options);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(await readFile(credentialPath, "utf8")).not.toContain(input.key);
      expect(await account.read()).toMatchObject([{ kind: "oyster", origin }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
