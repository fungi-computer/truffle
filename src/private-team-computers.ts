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
  operation: "list" | "state" | "start",
  input:
    | Readonly<{ computerId: string }>
    | Readonly<{ limit: number; offset: number }>,
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
  const computers = await directory(endpoint, options);
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
