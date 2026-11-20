import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  callFungiMcpControl,
  fungiMcpTeamEndpoint,
} from "./private-fungi-account.js";

const stateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.enum(["running", "sleeping", "starting"]) }),
  z.strictObject({
    state: z.literal("start_failed"),
    reason: z.string().min(1).max(1_024).exactOptional(),
  }),
  z.strictObject({
    state: z.literal("queued"),
    position: z.number().int().positive(),
  }),
]);
const computerSchema = z.looseObject({
  computerId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
});
const sizeSchema = z.enum(["small", "default", "large"]);
const creationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("created"),
    requestId: z.string(),
    computer: z.strictObject({
      computerId: z.string().min(1).max(256),
      name: z.string().min(1).max(256),
      size: sizeSchema,
    }),
  }),
  z.strictObject({
    kind: z.enum(["uncertain", "denied", "conflict", "invalid"]),
    requestId: z.string(),
  }),
]);
const stopSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stopped") }),
  z.strictObject({ kind: z.enum(["denied", "busy", "uncertain"]) }),
]);
const deletionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("deleted") }),
  z.strictObject({
    kind: z.enum(["denied", "mismatch", "unsupported", "uncertain"]),
  }),
]);
export type ComputerStop = z.output<typeof stopSchema>;
export type ComputerDeletion = z.output<typeof deletionSchema>;
export type ComputerSize = z.output<typeof sizeSchema>;
type CreationRequest = {
  name?: string;
  size?: ComputerSize;
  requestId?: string;
};
export type ComputerCreation = z.output<typeof creationSchema>;
const pageSchema = z.looseObject({
  computers: z.array(computerSchema).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type ComputerState = z.output<typeof stateSchema>;
export type Options = Readonly<{
  credentialPath?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}>;

async function control<T extends z.ZodType>(
  endpoint: URL,
  operation: "list" | "state" | "start" | "create" | "stop" | "delete",
  input:
    | Readonly<{ computerId: string }>
    | Readonly<{ computerId: string; confirmHandle: string }>
    | Readonly<{ limit: number; offset: number }>
    | Readonly<CreationRequest>,
  schema: T,
  options: Options,
): Promise<z.output<T>> {
  options.signal?.throwIfAborted();
  const text = await callFungiMcpControl(
    endpoint,
    operation === "state"
      ? // A Hub from before `reason` refuses the key; ask it plainly instead.
        `try { return await computers.state(${JSON.stringify({ ...input, reason: true })}); } catch { return await computers.state(${JSON.stringify(input)}); }`
      : `return await computers.${operation}(${JSON.stringify(input)});`,
    { ...options, timeoutMs: operation === "start" ? 30 * 60 * 1_000 : 60_000 },
  );
  options.signal?.throwIfAborted();
  if (text === undefined)
    throw new Error(
      "The Hub did not complete Computer control. Check your Team login and access, then retry.",
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The Hub returned an invalid Computer response.");
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error("The Hub returned an invalid Computer response.");
  return result.data;
}

async function directory(endpoint: URL, options: Options) {
  const computers: z.output<typeof computerSchema>[] = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await control(
      endpoint,
      "list",
      { limit: 100, offset },
      pageSchema,
      options,
    );
    computers.push(...page.computers);
    if (page.nextOffset === null) return computers;
    if (page.nextOffset <= offset)
      throw new Error("The Hub returned an invalid Computer page cursor.");
    offset = page.nextOffset;
  }
  throw new Error(
    "This Team has too many Computer pages to list in one command.",
  );
}

/** The one Computer a name or id selects, or the plain reason none does. */
function selectComputer(
  computers: readonly z.output<typeof computerSchema>[],
  name: string,
) {
  const matches = computers.filter(
    (computer) => computer.computerId === name || computer.name === name,
  );
  const computer = matches[0];
  if (computer === undefined || matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `No Computer named ${name} in this Team.`
        : `Computer ${name} is ambiguous; use its id.`,
    );
  return computer;
}

/** Team directory and real runtime liveness, using Local's existing authenticated MCP transport. */
export async function listPrivateTeamComputers(
  rawEndpoint: string,
  input: Options = {},
) {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  const computers = await directory(endpoint, options);
  const rows = [];
  for (const computer of computers)
    rows.push({
      ...computer,
      ...(await control(
        endpoint,
        "state",
        { computerId: computer.computerId },
        stateSchema,
        options,
      )),
    });
  return rows;
}

/** Await admission while reporting live queue positions. Ctrl-C stops the local wait. */
export async function startPrivateTeamComputer(
  rawEndpoint: string,
  name: string,
  input: Options & Readonly<{ onState: (state: ComputerState) => void }>,
) {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  const computer = selectComputer(await directory(endpoint, options), name);
  options.onState({ state: "starting" });
  const polling = new AbortController();
  const signal =
    options.signal === undefined
      ? polling.signal
      : AbortSignal.any([options.signal, polling.signal]);
  const request = control(
    endpoint,
    "start",
    { computerId: computer.computerId },
    stateSchema,
    { ...options, signal },
  );
  // Observe rejection immediately while the independently authenticated status call is in flight.
  const completion = request.then(
    (state) => ({ state }),
    (error: unknown) => ({ error }),
  );
  // A full host answers the start with its queue place, and a booting one
  // with "starting"; the Hub keeps that start and runs it, so watch the
  // state until it runs.
  let watching = false;
  try {
    for (;;) {
      if (watching) await delay(1_000, undefined, { signal });
      const outcome = watching
        ? undefined
        : await Promise.race([
            completion,
            delay(1_000, undefined, { signal }).then(() => undefined),
          ]);
      if (outcome !== undefined) {
        if ("error" in outcome) throw outcome.error;
        if (outcome.state.state === "running") {
          options.onState(outcome.state);
          return computer;
        }
        // "starting": the host admitted it and still boots it.
        if (
          outcome.state.state !== "queued" &&
          outcome.state.state !== "starting"
        )
          throw new Error("The Hub did not confirm that the Computer started.");
        watching = true;
        options.onState(outcome.state);
        continue;
      }
      const state = await control(
        endpoint,
        "state",
        { computerId: computer.computerId },
        stateSchema,
        { ...options, signal },
      );
      if (state.state === "start_failed")
        throw new Error(
          state.reason === undefined
            ? "The Computer could not start. Try again."
            : `The Computer didn't start: ${state.reason}. Try again.`,
        );
      options.onState(state);
      if (watching && state.state === "running") return computer;
    }
  } finally {
    polling.abort();
  }
}

/** The Computer a name or id selects, with its live runtime state and no wake. */
export async function describePrivateTeamComputer(
  rawEndpoint: string,
  name: string,
  input: Options = {},
) {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  const computer = selectComputer(await directory(endpoint, options), name);
  return {
    ...computer,
    ...(await control(
      endpoint,
      "state",
      { computerId: computer.computerId },
      stateSchema,
      options,
    )),
  };
}

/**
 * Create a Computer. The answer always carries the `requestId` the Hub used:
 * to settle an uncertain attempt, pass that `requestId` back with the original
 * name and size, and the Hub answers it instead of making a second Computer.
 */
export async function createPrivateTeamComputer(
  rawEndpoint: string,
  creation: Readonly<{
    name?: string | undefined;
    size?: ComputerSize | undefined;
    requestId?: string | undefined;
  }>,
  input: Options = {},
): Promise<ComputerCreation> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  const request: CreationRequest = {};
  if (creation.requestId !== undefined) request.requestId = creation.requestId;
  if (creation.name !== undefined) request.name = creation.name;
  if (creation.size !== undefined) request.size = creation.size;
  return await control(endpoint, "create", request, creationSchema, options);
}

/** Stop one Computer now; its files are kept. The Hub answers who may. */
export async function stopPrivateTeamComputer(
  rawEndpoint: string,
  name: string,
  input: Options = {},
): Promise<Readonly<{ computerId: string; name: string }> & ComputerStop> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  const computer = selectComputer(await directory(endpoint, options), name);
  return {
    computerId: computer.computerId,
    name: computer.name,
    ...(await control(
      endpoint,
      "stop",
      { computerId: computer.computerId },
      stopSchema,
      options,
    )),
  };
}

/**
 * Delete the one Computer the person confirmed, by its id, sending the name they
 * were shown as the Hub's `confirmHandle`. Nothing here reads the directory
 * again: a Computer renamed or replaced after the question was asked fails the
 * Hub's check ("mismatch" or "denied") instead of being deleted in its place.
 */
export async function deletePrivateTeamComputer(
  rawEndpoint: string,
  confirmed: Readonly<{ computerId: string; name: string }>,
  input: Options = {},
): Promise<Readonly<{ computerId: string; name: string }> & ComputerDeletion> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  return {
    computerId: confirmed.computerId,
    name: confirmed.name,
    ...(await control(
      endpoint,
      "delete",
      { computerId: confirmed.computerId, confirmHandle: confirmed.name },
      deletionSchema,
      options,
    )),
  };
}

const pricesSchema = z.strictObject({
  unitsPerUsd: z.number().int().positive(),
  hourly: z.strictObject({
    small: z.number().int().nonnegative(),
    default: z.number().int().nonnegative(),
    large: z.number().int().nonnegative(),
  }),
});
export type ComputerPrices = z.output<typeof pricesSchema>;

/**
 * What each Computer size costs an hour awake, from the Hub's price book, or
 * undefined when this host has none to give (an Oyster, or an older Hub).
 */
export async function readPrivateComputerPrices(
  rawEndpoint: string,
  input: Options = {},
): Promise<ComputerPrices | undefined> {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const { endpoint } = fungiMcpTeamEndpoint(rawEndpoint);
  options.signal?.throwIfAborted();
  const text = await callFungiMcpControl(
    endpoint,
    "return await computers.prices({});",
    { ...options, timeoutMs: 30_000 },
  );
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The Hub returned an invalid Computer price response.");
  }
  const result = pricesSchema.safeParse(value);
  if (!result.success)
    throw new Error("The Hub returned an invalid Computer price response.");
  return result.data;
}
