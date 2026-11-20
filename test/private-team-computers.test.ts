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
  createPrivateTeamComputer,
  deletePrivateTeamComputer,
  describePrivateTeamComputer,
  listPrivateTeamComputers,
  readPrivateComputerPrices,
  startPrivateTeamComputer,
  stopPrivateTeamComputer,
} from "../src/private-team-computers.js";

type FakeComputerReply =
  | Readonly<{
      computers: readonly { computerId: string; name: string }[];
      nextOffset: number | null;
    }>
  | Readonly<{ state: string; position?: number }>
  | Readonly<{
      kind: string;
      requestId?: string;
      computer?: { computerId: string; name: string; size: string };
    }>
  | Readonly<{ unitsPerUsd: number | string; hourly: Record<string, number> }>;
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

it.each([
  ["running", { state: "running" }, ""],
  [
    "start_failed",
    {
      state: "start_failed",
      reason: "the Computer host refused to start it (HTTP 503)",
    },
    "The Computer didn't start: the Computer host refused to start it (HTTP 503). Try again.",
  ],
  // A Hub from before failures carried their reason.
  [
    "start_failed without a reason",
    { state: "start_failed" },
    "The Computer could not start. Try again.",
  ],
] as const)(
  "follows a start the Hub answered as queued until it is %s",
  async (end, last, failure) => {
    const states: Parameters<
      Parameters<typeof startPrivateTeamComputer>[2]["onState"]
    >[0][] = [];
    let polls = 0;
    let starts = 0;
    await withHub(
      async (options) => {
        const started = startPrivateTeamComputer(endpoint, "cedar", {
          ...options,
          onState: (state) => {
            states.push(state);
          },
        });
        if (end === "running")
          expect(await started).toEqual({ computerId: "a", name: "cedar" });
        else await expect(started).rejects.toThrow(failure);
        expect(states).toEqual([
          { state: "starting" },
          { state: "queued", position: 1 },
          { state: "starting" },
          ...(end === "running" ? [last] : []),
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
          return { state: "queued", position: 1 };
        }
        // The state read asks for a failed start's reason.
        expect(code).toContain('"reason":true');
        polls++;
        return polls === 1 ? { state: "starting" } : last;
      },
    );
  },
);

it("follows a start the Hub answered as still starting until it runs", async () => {
  const states: Parameters<
    Parameters<typeof startPrivateTeamComputer>[2]["onState"]
  >[0][] = [];
  let polls = 0;
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
      expect(states.at(-1)).toEqual({ state: "running" });
    },
    (code) => {
      if (code.includes("computers.list"))
        return {
          computers: [{ computerId: "a", name: "cedar" }],
          nextOffset: null,
        };
      if (code.includes("computers.start")) return { state: "starting" };
      polls++;
      return polls < 3 ? { state: "starting" } : { state: "running" };
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

it("describes one Computer by name or id with its real state and never starts it", async () => {
  const calls: string[] = [];
  await withHub(
    async (options) => {
      expect(
        await describePrivateTeamComputer(endpoint, "cedar", options),
      ).toEqual({
        computerId: "a",
        name: "cedar",
        size: "small",
        state: "sleeping",
      });
      expect(
        await describePrivateTeamComputer(endpoint, "b", options),
      ).toMatchObject({
        name: "birch",
      });
      await expect(
        describePrivateTeamComputer(endpoint, "elm", options),
      ).rejects.toThrow("No Computer named elm in this Team.");
      expect(calls.some((code) => code.includes("computers.start"))).toBe(
        false,
      );
    },
    (code) => {
      calls.push(code);
      if (code.includes("computers.list"))
        return {
          computers: [
            { computerId: "a", name: "cedar", size: "small" },
            { computerId: "b", name: "birch", size: "default" },
          ],
          nextOffset: null,
        };
      return { state: "sleeping" };
    },
  );
});

it("creates a Computer through the Team control door with one request id and optional name and size", async () => {
  const codes: string[] = [];
  await withHub(
    async (options) => {
      expect(
        await createPrivateTeamComputer(
          endpoint,
          { name: "cedar", size: "small", requestId: "req-1" },
          options,
        ),
      ).toEqual({
        kind: "created",
        requestId: "req-1",
        computer: { computerId: "a", name: "cedar", size: "small" },
      });
      // Nothing omitted is sent: the Hub names it, picks the default size and
      // mints the request id.
      await createPrivateTeamComputer(endpoint, {}, options);
      expect(codes).toEqual([
        'return await computers.create({"requestId":"req-1","name":"cedar","size":"small"});',
        "return await computers.create({});",
      ]);
      // A refusal is data, not a throw.
      expect(
        await createPrivateTeamComputer(
          endpoint,
          { requestId: "req-3" },
          options,
        ),
      ).toEqual({ kind: "denied", requestId: "req-3" });
    },
    (code) => {
      codes.push(code);
      if (code.includes("req-3")) return { kind: "denied", requestId: "req-3" };
      return {
        kind: "created",
        requestId: code.includes("req-1") ? "req-1" : "minted-by-hub",
        computer: { computerId: "a", name: "cedar", size: "small" },
      };
    },
  );
});

it("stops the Computer a name selects through the control door and returns the Hub's answer as data", async () => {
  const codes: string[] = [];
  await withHub(
    async (options) => {
      expect(await stopPrivateTeamComputer(endpoint, "cedar", options)).toEqual(
        {
          computerId: "a",
          name: "cedar",
          kind: "stopped",
        },
      );
      await expect(
        stopPrivateTeamComputer(endpoint, "elm", options),
      ).rejects.toThrow("No Computer named elm in this Team.");
      expect(codes.filter((code) => code.includes("computers.stop"))).toEqual([
        'return await computers.stop({"computerId":"a"});',
      ]);
    },
    (code) => {
      codes.push(code);
      if (code.includes("computers.list"))
        return {
          computers: [{ computerId: "a", name: "cedar" }],
          nextOffset: null,
        };
      return { kind: "stopped" };
    },
  );
});

it("deletes by the confirmed id with the confirmed name as the handle, without reading the directory again", async () => {
  const codes: string[] = [];
  await withHub(
    async (options) => {
      expect(
        await deletePrivateTeamComputer(
          endpoint,
          { computerId: "a", name: "cedar" },
          options,
        ),
      ).toEqual({ computerId: "a", name: "cedar", kind: "deleted" });
      // A refusal (a rename or a replacement since the question) is data.
      expect(
        await deletePrivateTeamComputer(
          endpoint,
          { computerId: "b", name: "cedar" },
          options,
        ),
      ).toEqual({ computerId: "b", name: "cedar", kind: "mismatch" });
      // Only the delete reached the Hub: no listing could rename the target.
      expect(codes).toEqual([
        'return await computers.delete({"computerId":"a","confirmHandle":"cedar"});',
        'return await computers.delete({"computerId":"b","confirmHandle":"cedar"});',
      ]);
    },
    (code) => {
      codes.push(code);
      return { kind: code.includes('"b"') ? "mismatch" : "deleted" };
    },
  );
});

it("reads each size's hourly price from the Hub, and nothing from a host without prices", async () => {
  const prices = {
    unitsPerUsd: 100_000,
    hourly: { small: 1_500, default: 3_000, large: 6_000 },
  };
  const codes: string[] = [];
  await withHub(
    async (options) => {
      expect(await readPrivateComputerPrices(endpoint, options)).toEqual(
        prices,
      );
      expect(codes).toEqual(["return await computers.prices({});"]);
    },
    (code) => {
      codes.push(code);
      return prices;
    },
  );
  // An Oyster or an older Hub has no prices operation: the call fails there.
  await withHub(
    async (options) => {
      expect(
        await readPrivateComputerPrices(endpoint, options),
      ).toBeUndefined();
    },
    () => {
      throw new Error("computers.prices is not a function");
    },
  );
  await withHub(
    async (options) => {
      await expect(
        readPrivateComputerPrices(endpoint, options),
      ).rejects.toThrow("The Hub returned an invalid Computer price response.");
    },
    () => ({ unitsPerUsd: "lots", hourly: {} }),
  );
});
