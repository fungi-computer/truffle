import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, relative, isAbsolute, resolve } from "node:path";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import { readBoundedResponse } from "./private-bounded-response.js";
import { fungiAccountFetch } from "./private-fungi-account.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";
import {
  listPrivateLocalAgentStores,
  readPrivateLocalAgentProfile,
} from "./private-local-session-discovery.js";
import {
  machineBindingSchema,
  localMachineEnrollmentSchema,
  type LocalMachineEnrollment,
  type LocalMachineEnrollmentAccount,
} from "./private-local-mesh-record.js";

const id = z.string().min(1).max(256);
const joinCommon = z.strictObject({
  origin: z.url(),
  invocationRoot: z.string().min(1).max(4096),
  machineLabel: z.string().trim().min(1).max(256),
  agents: z
    .array(id)
    .max(256)
    .refine((agents) => new Set(agents).size === agents.length),
});
export const localMeshJoinSchema = z.discriminatedUnion("kind", [
  joinCommon.extend({ kind: z.literal("oauth"), teamId: id }),
  joinCommon.extend({
    kind: z.literal("oyster-key"),
    key: z.string().startsWith("oyk_").min(5).max(4096),
  }),
]);
const responseSchema = z.strictObject({
  kind: z.literal("joined"),
  deviceId: id,
  agents: z.array(machineBindingSchema).max(256),
});
const oysterResponseSchema = responseSchema.extend({ scopeId: id });
const requests = defineIdFamily({
  family: "local-machine-enrollment",
  version: 1,
  kinds: { join: { prefix: "machine_join" } },
});

function deviceKey() {
  const pair = generateKeyPairSync("ed25519");
  const jwk = z
    .object({ x: z.string() })
    .parse(pair.publicKey.export({ format: "jwk" }));
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
}

/**
 * Persist the device pin before authenticated enrollment I/O. This is enrollment
 * only: it does not report a socket, command Accepted or connected mesh.
 */
export async function enrollPrivateLocalMesh(
  raw: z.infer<typeof localMeshJoinSchema>,
  options: {
    account: LocalMachineEnrollmentAccount;
    credentialPath: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
  },
) {
  const input = localMeshJoinSchema.parse(raw);
  const endpoint = parseFungiMcpEndpoint(input.origin);
  if (endpoint.pathname !== "/")
    throw new Error("Mesh enrollment needs an origin");
  const origin = endpoint.origin;
  const authority = {
    kind: input.kind === "oauth" ? ("oauth" as const) : ("oyster" as const),
    origin,
  };
  if (input.kind === "oauth") {
    const saved = await options.account.read();
    if (
      !saved.some(
        (record) => record.kind === "oauth" && record.origin === origin,
      )
    )
      throw new Error("Sign in to this Fungi issuer before joining a machine");
  }
  const invocationRoot = await realpath(resolve(input.invocationRoot));
  const stores = await listPrivateLocalAgentStores(invocationRoot);
  const selected = input.agents.map((localAgentId) => {
    const databasePath = stores.find(
      (path) => basename(dirname(path)) === localAgentId,
    );
    if (databasePath === undefined)
      throw new Error("The selected Agent is not active in this project");
    const within = relative(invocationRoot, databasePath);
    if (isAbsolute(within) || within === ".." || within.startsWith("../"))
      throw new Error("The selected Agent is outside this project");
    const profile = readPrivateLocalAgentProfile(databasePath);
    return { localAgentId, databasePath, name: profile.name ?? localAgentId };
  });
  const proposed: LocalMachineEnrollment = {
    state: "pending",
    requestId: requests.join.generate(),
    target:
      input.kind === "oauth"
        ? { kind: "oauth", teamId: input.teamId }
        : { kind: "oyster" },
    invocationRoot,
    machineLabel: input.machineLabel,
    ...deviceKey(),
    agents: selected,
  };
  let chosen: LocalMachineEnrollment | undefined;
  await options.account.update(authority, (current) => {
    const prior = current.find(
      (record) =>
        JSON.stringify(record.target) === JSON.stringify(proposed.target),
    );
    if (prior !== undefined) {
      if (
        prior.invocationRoot !== invocationRoot ||
        prior.machineLabel !== input.machineLabel ||
        JSON.stringify(prior.agents) !== JSON.stringify(selected)
      )
        throw new Error(
          "This scope already has another machine enrollment intent",
        );
      chosen = prior;
      return [...current];
    }
    chosen = proposed;
    return [...current, proposed];
  });
  if (chosen === undefined)
    throw new Error("The credential owner did not persist an enrollment");
  const record = chosen;
  if (record.state === "enrolled")
    return {
      state: "enrolled",
      deviceId: record.deviceId,
      agents: record.bindings,
    };
  const url = new URL(
    input.kind === "oauth"
      ? `/api/teams/${encodeURIComponent(input.teamId)}/local/mesh/join`
      : "/local/mesh/join",
    origin,
  );
  // Only OAuth owns refresh/retry. An Oyster key is ephemeral enrollment
  // authority; neither the credential owner nor later Seam dials receive it.
  const request =
    input.kind === "oauth"
      ? fungiAccountFetch(origin, options)
      : (options.fetch ?? globalThis.fetch);
  const headers = new Headers({ "content-type": "application/json" });
  if (input.kind === "oyster-key")
    headers.set("Authorization", `Bearer ${input.key}`);
  const init: RequestInit = {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({
      requestId: record.requestId,
      machineLabel: record.machineLabel,
      publicKey: record.publicKey,
      // Local directory selectors and database paths remain private.
      agents: record.agents.map(({ name }) => ({ name })),
    }),
  };
  if (options.signal !== undefined) init.signal = options.signal;
  let response: Response;
  try {
    response = await request(url, init);
  } finally {
    if (input.kind === "oyster-key") {
      // Release Local-owned references before decoding/storing the response.
      // This cannot erase immutable string bytes or caller/fetch-owned copies.
      headers.delete("Authorization");
      input.key = "";
    }
  }
  if (!response.ok)
    throw new Error(
      `Machine enrollment refused with HTTP ${String(response.status)}`,
    );
  const payload: unknown = JSON.parse(
    await readBoundedResponse(response, 64 * 1024, "Machine enrollment"),
  );
  const result =
    input.kind === "oauth"
      ? { ...responseSchema.parse(payload), scopeId: input.teamId }
      : oysterResponseSchema.parse(payload);
  if (
    result.agents.length !== record.agents.length ||
    result.agents.some((binding, index) => binding.selection !== index) ||
    new Set(result.agents.map((binding) => binding.agentId)).size !==
      result.agents.length
  )
    throw new Error("Machine enrollment does not match the selected Agent set");
  const enrolled = localMachineEnrollmentSchema.parse({
    ...record,
    state: "enrolled",
    deviceId: result.deviceId,
    scopeId: result.scopeId,
    bindings: result.agents,
  });
  await options.account.update(authority, (current) => {
    const matching = current.find(
      (candidate) => candidate.requestId === record.requestId,
    );
    if (matching === undefined)
      throw new Error("Machine enrollment was removed before acknowledgment");
    if (
      matching.state === "enrolled" &&
      (matching.deviceId !== result.deviceId ||
        matching.scopeId !== result.scopeId ||
        JSON.stringify(matching.bindings) !== JSON.stringify(result.agents))
    )
      throw new Error("Home changed an acknowledged machine enrollment");
    return current.map((candidate) =>
      candidate.requestId === record.requestId ? enrolled : candidate,
    );
  });
  return {
    state: "enrolled",
    deviceId: result.deviceId,
    agents: result.agents,
  };
}
