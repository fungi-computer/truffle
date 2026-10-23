import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { z } from "zod";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { OysterMcpKeyRejectedError } from "../src/private-oyster-mcp-auth.js";
import {
  fungiMcpReachableFetch,
  createPrivateFungiMcpConnection,
} from "../src/private-fungi-mcp-connection.js";
import { readFungiMcpSelection } from "../src/private-fungi-mcp-selection.js";
import { fungiMcpSelectionSchema } from "../src/private-fungi-mcp-selection-schema.js";

it("distinguishes an Oyster key refusal from the SDK's generic unauthorized error", () => {
  expect(new OysterMcpKeyRejectedError()).toBeInstanceOf(UnauthorizedError);
  expect(new UnauthorizedError()).not.toBeInstanceOf(OysterMcpKeyRejectedError);
});

it("selects an Oyster bearer from private custody without Hub OAuth", async () => {
  const root = await mkdtemp(join(tmpdir(), "oyster-mcp-auth-"));
  try {
    const credentialPath = join(root, "credentials.json");
    await createPrivateCredentialStore(credentialPath).modify(
      "oyster-mcp:https://oyster.test",
      () =>
        Promise.resolve({ type: "api_key", key: "oyk_disposable-test-key" }),
    );
    const parsed = fungiMcpSelectionSchema.parse({
      endpoint: "https://oyster.test/mcp",
      authentication: "oyster-key",
    });
    const connection = readFungiMcpSelection(parsed, { credentialPath });
    expect("token" in connection.authProvider).toBe(true);
    if (!("token" in connection.authProvider))
      throw new Error("Expected static bearer authentication");
    expect(await connection.authProvider.token()).toBe(
      "oyk_disposable-test-key",
    );
    await expect(
      connection.authProvider.onUnauthorized?.({
        response: new Response(null, { status: 401 }),
        serverUrl: connection.endpoint,
        fetchFn: fetch,
      }),
    ).rejects.toMatchObject({ name: "OysterMcpKeyRejectedError" });
    let requests = 0;
    const source = createPrivateFungiMcpConnection({
      ...connection,
      fetch: (_url, init) => {
        requests += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer oyk_disposable-test-key",
        );
        return Promise.resolve(new Response(null, { status: 401 }));
      },
    });
    await expect(
      source.acquire({
        signal: new AbortController().signal,
        invalidate: () => undefined,
      }),
    ).rejects.toMatchObject({ name: "OysterMcpKeyRejectedError" });
    expect(requests).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a revoked static bearer fails with the maintained SDK's typed unauthorized error", async () => {
  let requests = 0;
  const source = createPrivateFungiMcpConnection({
    endpoint: new URL("https://oyster.test/mcp"),
    authProvider: {
      token: () => Promise.resolve("oyk_disposable-revoked-key"),
    },
    fetch: (url, init) => {
      requests += 1;
      expect(String(url)).toBe("https://oyster.test/mcp");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer oyk_disposable-revoked-key",
      );
      expect(init?.redirect).toBe("error");
      return Promise.resolve(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer error="invalid_token", resource_metadata="https://other.test/oauth"',
          },
        }),
      );
    },
  });
  await expect(
    source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    }),
  ).rejects.toBeInstanceOf(UnauthorizedError);
  expect(requests).toBe(1);
});

it("permits the selected origin's bearer request with redirect:error", async () => {
  let calls = 0;
  const endpoint = new URL("https://oyster.test/mcp");
  const guarded = fungiMcpReachableFetch(endpoint, (url, init) => {
    calls += 1;
    expect(String(url)).toBe(endpoint.href);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer oyk_disposable-test-key",
    );
    expect(init?.redirect).toBe("error");
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const response = await guarded(endpoint, {
    headers: { authorization: "Bearer oyk_disposable-test-key" },
  });
  expect(response.status).toBe(204);
  expect(calls).toBe(1);
});

it("native fetch refuses a redirect before the bearer reaches another origin", async () => {
  let destinationRequests = 0;
  const destination = createServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(204).end();
  });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const address = z.object({ port: z.number() }).parse(destination.address());
  let sourceAuthorization: string | undefined;
  const source = createServer((request, response) => {
    sourceAuthorization = request.headers.authorization;
    response
      .writeHead(307, {
        location: `http://127.0.0.1:${String(address.port)}/stolen`,
      })
      .end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  try {
    const sourceAddress = z
      .object({ port: z.number() })
      .parse(source.address());
    const endpoint = new URL(
      `http://127.0.0.1:${String(sourceAddress.port)}/mcp`,
    );
    await expect(
      fungiMcpReachableFetch(endpoint)(endpoint, {
        headers: { authorization: "Bearer oyk_disposable-test-key" },
        redirect: "follow",
      }),
    ).rejects.toThrow();
    expect(sourceAuthorization).toBe("Bearer oyk_disposable-test-key");
    expect(destinationRequests).toBe(0);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        source.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
      new Promise<void>((resolve, reject) =>
        destination.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
    ]);
  }
});

it.each([
  "https://other.test/mcp",
  "https://oyster.test:444/mcp",
  "http://oyster.test/mcp",
])(
  "refuses a bearer request to %s before invoking the transport",
  async (target) => {
    let calls = 0;
    const guarded = fungiMcpReachableFetch(
      new URL("https://oyster.test/mcp"),
      () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    );
    await expect(
      guarded(target, {
        headers: { authorization: "Bearer oyk_disposable-test-key" },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  },
);
