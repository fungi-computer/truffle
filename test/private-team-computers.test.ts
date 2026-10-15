import { privateFungiAccountOAuthProvider } from "../src/private-fungi-account.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FetchLike,
  InitializeResult,
  ListToolsResult,
  CallToolResult,
} from "@modelcontextprotocol/client";
import {
  listPrivateTeamComputers,
  startPrivateTeamComputer,
} from "../src/private-team-computers.js";

type FakeComputerReply =
  | Readonly<{
      computers: readonly { computerId: string; name: string }[];
      nextOffset: number | null;
    }>
  | Readonly<{ state: string; position?: number }>;
const endpoint = "https://hub.test/api/teams/team-1/mcp";
async function withHub(
  run: (options: { credentialPath: string; fetch: FetchLike }) => Promise<void>,
  execute: (code: string) => FakeComputerReply | Promise<FakeComputerReply>,
) {
  const root = await mkdtemp(join(tmpdir(), "team-computers-"));
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
  const hubFetch: FetchLike = async (input, init) => {
    const request = new Request(input.toString(), init);
    expect(request.url).toBe(endpoint);
    expect(request.headers.get("Authorization")).toBe(
      "Bearer fixture-team-access",
    );
    if (request.method !== "POST") return new Response(null, { status: 202 });
    const message = z
      .object({
        method: z.string(),
        id: z.union([z.string(), z.number()]).optional(),
        params: z.unknown().optional(),
      })
      .parse(await request.json());
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: InitializeResult | ListToolsResult | CallToolResult;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-hub", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "execute",
            description: "Team control",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
        ],
      };
    else if (message.method === "tools/call") {
      const call = z
        .object({
          name: z.literal("execute"),
          arguments: z.strictObject({ code: z.string() }),
        })
        .parse(message.params);
      result = {
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify(await execute(call.arguments.code)),
          },
        ],
      };
    } else throw new Error(`Unexpected MCP method: ${message.method}`);
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  try {
    await run({
      credentialPath: join(root, "credentials.json"),
      fetch: hubFetch,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("follows empty scoped directory pages and reads all four real states without starting", async () => {
  const calls: string[] = [];
  await withHub(
    async (options) => {
      expect(await listPrivateTeamComputers(endpoint, options)).toEqual([
        { computerId: "a", name: "cedar", state: "running" },
        { computerId: "b", name: "birch", state: "sleeping" },
        { computerId: "c", name: "elm", state: "queued", position: 3 },
        { computerId: "d", name: "oak", state: "starting" },
      ]);
      expect(calls.some((code) => code.includes("computers.start"))).toBe(
        false,
      );
    },
    (code) => {
      calls.push(code);
      if (code.includes("computers.list"))
        return code.includes('"offset":0')
          ? { computers: [], nextOffset: 100 }
          : {
              computers: [
                { computerId: "a", name: "cedar" },
                { computerId: "b", name: "birch" },
                { computerId: "c", name: "elm" },
                { computerId: "d", name: "oak" },
              ],
              nextOffset: null,
            };
      if (code.includes('"a"')) return { state: "running" };
      if (code.includes('"b"')) return { state: "sleeping" };
      if (code.includes('"c"')) return { state: "queued", position: 3 };
      return { state: "starting" };
    },
  );
});

it("reports changing queue positions while one start waits, then confirms running", async () => {
  const boot = Promise.withResolvers<FakeComputerReply>();
  const states: Parameters<
    Parameters<typeof startPrivateTeamComputer>[2]["onState"]
  >[0][] = [];
  let polls = 0;
  let starts = 0;
  await withHub(
    async (options) => {
      expect(
        await startPrivateTeamComputer(endpoint, "cedar", {
          ...options,
          onState: (state) => {
            states.push(state);
          },
        }),
      ).toEqual({ computerId: "a", name: "cedar" });
      expect(states).toEqual([
        { state: "starting" },
        { state: "queued", position: 2 },
        { state: "queued", position: 1 },
        { state: "running" },
      ]);
      expect(starts).toBe(1);
    },
    (code) => {
      if (code.includes("computers.list"))
        return {
          computers: [{ computerId: "a", name: "cedar" }],
          nextOffset: null,
        };
      if (code.includes("computers.start")) {
        starts++;
        return boot.promise;
      }
      polls++;
      if (polls === 2) boot.resolve({ state: "running" });
      return { state: "queued", position: polls === 1 ? 2 : 1 };
    },
  );
});

it("rejects malformed queue state and non-advancing pagination", async () => {
  await withHub(
    async (options) => {
      await expect(listPrivateTeamComputers(endpoint, options)).rejects.toThrow(
        "invalid Computer response",
      );
    },
    (code) =>
      code.includes("computers.list")
        ? { computers: [{ computerId: "a", name: "cedar" }], nextOffset: null }
        : { state: "queued", position: 0 },
  );
  await withHub(
    async (options) => {
      await expect(listPrivateTeamComputers(endpoint, options)).rejects.toThrow(
        "page cursor",
      );
    },
    () => ({ computers: [], nextOffset: 0 }),
  );
});

it("does not start a missing name or accept a non-running start confirmation", async () => {
  let starts = 0;
  await withHub(
    async (options) => {
      await expect(
        startPrivateTeamComputer(endpoint, "missing", {
          ...options,
          onState: () => undefined,
        }),
      ).rejects.toThrow("No Computer named missing");
      expect(starts).toBe(0);
      await expect(
        startPrivateTeamComputer(endpoint, "a", {
          ...options,
          onState: () => undefined,
        }),
      ).rejects.toThrow("did not confirm");
    },
    (code) => {
      if (code.includes("computers.list"))
        return {
          computers: [{ computerId: "a", name: "cedar" }],
          nextOffset: null,
        };
      starts++;
      return { state: "sleeping" };
    },
  );
});
