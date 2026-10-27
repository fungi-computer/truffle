import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionCapabilityV0 } from "@fungi.computer/shiitake/extensions";
import { z } from "zod";

/** One vocabulary for installed declarations and the activation reader. */
export const capabilities = [
  "state",
  "attention",
  "settled",
  "send",
  "timers",
  "commands",
  "projection",
  "run_tools",
  "files",
  "prompt",
  "compaction_handoff",
] as const satisfies readonly ExtensionCapabilityV0[];

export const activationsSchema = z.strictObject({
  projects: z.record(z.string(), z.record(z.string(), z.string())),
  agents: z.record(
    z.string(),
    z.record(
      z.string(),
      z.strictObject({
        revision: z.string(),
        capabilities: z.array(z.enum(capabilities)),
        /** The opt-in to the revision's skills folder; separate from tools. */
        skills: z.boolean(),
      }),
    ),
  ),
});

/** Only refused activations belong to the home upgrader, not installed.json. */
export async function incompatibleLocalExtensionActivations(
  home: string,
): Promise<readonly string[]> {
  const path = join(resolve(home), ".fungi", "extensions", "activations.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    )
      return [];
    throw cause;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof SyntaxError) return [path];
    throw cause;
  }
  return activationsSchema.safeParse(value).success ? [] : [path];
}
