import type { Json } from "effect/Schema";
import type { Lease, MyceliumOptions, Runtime } from "@fungi.computer/mycelium";

/** The parsed JSON text of the execute tool's one result part. */
export function execute(
  lease: Lease,
  code: string,
  signal?: AbortSignal,
): Promise<Json>;
export function openRuntime(options: MyceliumOptions): Promise<Runtime>;
export function closeRuntime(runtime: Runtime, lease: Lease): Promise<void>;
export function ownedWorkerdProcesses(): Promise<
  { processId: number; parentId: number; executable: string }[]
>;
