import * as Schema from "effect/Schema";
import type { z } from "zod";
import { parseShiitakeError } from "@fungi.computer/shiitake/client";
import {
  agentScheduleRowSchema,
  type AgentScheduleRow,
  type AgentScheduleTarget,
} from "@fungi.computer/shiitake-extensions/schedules";
import { readBoundedResponse } from "./private-bounded-response.js";
import {
  localScheduleControlInputSchema,
  localScheduleListInputSchema,
  localSchedulePageSchema,
  type LocalSchedulePage,
} from "./private-local-schedules.js";
import type {
  PrivateLocalServiceRequestOptions,
  PrivateLocalServiceStatus,
} from "./private-local-service-contract.js";

// A page has at most 64 prompts of 256 KiB, including JSON escaping and metadata.
// This is a wire budget, not a limit on retained records or future occurrences.
const maximumResponseBytes = 128 * 1024 * 1024;

type ScheduleRequest =
  | z.output<typeof localScheduleListInputSchema>
  | z.output<typeof localScheduleControlInputSchema>;

/** A private, folder-bound owner capability; it contains no public URL or grant. */
export type PrivateLocalScheduleCapability = Readonly<{
  list(
    input?: Omit<
      z.input<typeof localScheduleListInputSchema>,
      "invocationRoot"
    >,
    options?: PrivateLocalServiceRequestOptions,
  ): Promise<LocalSchedulePage>;
  pause(
    target: AgentScheduleTarget,
    options?: PrivateLocalServiceRequestOptions,
  ): Promise<AgentScheduleRow>;
  delete(
    target: AgentScheduleTarget,
    options?: PrivateLocalServiceRequestOptions,
  ): Promise<AgentScheduleRow>;
}>;

/** Only a native private service client creates this capability for its person. */
export function createPrivateLocalScheduleCapability(
  invocationRoot: string,
  start: (
    options?: PrivateLocalServiceRequestOptions,
  ) => Promise<PrivateLocalServiceStatus>,
): PrivateLocalScheduleCapability {
  async function call<A>(
    operation: "list" | "pause" | "delete",
    input: ScheduleRequest,
    output: Schema.Decoder<A>,
    options: PrivateLocalServiceRequestOptions = {},
  ): Promise<A> {
    options.signal?.throwIfAborted();
    const service = await start(options);
    const request: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
    };
    if (options.signal !== undefined) request.signal = options.signal;
    const response = await fetch(
      `${service.baseUrl}/service/${service.serviceId}/schedules/${operation}`,
      request,
    );
    const body = await readBoundedResponse(
      response,
      maximumResponseBytes,
      `Private Local schedule ${operation}`,
    );
    if (!response.ok) {
      let failure;
      try {
        failure = parseShiitakeError(body);
      } catch (cause) {
        throw new Error(
          `Private Local schedule ${operation} failed (${String(response.status)})`,
          { cause },
        );
      }
      throw failure;
    }
    return Schema.decodeUnknownSync(output, { onExcessProperty: "error" })(
      JSON.parse(body),
    );
  }
  return {
    list: (input = {}, options) =>
      call(
        "list",
        localScheduleListInputSchema.parse({ ...input, invocationRoot }),
        localSchedulePageSchema,
        options,
      ),
    pause: (target, options) =>
      call(
        "pause",
        localScheduleControlInputSchema.parse({ invocationRoot, target }),
        agentScheduleRowSchema,
        options,
      ),
    delete: (target, options) =>
      call(
        "delete",
        localScheduleControlInputSchema.parse({ invocationRoot, target }),
        agentScheduleRowSchema,
        options,
      ),
  };
}
