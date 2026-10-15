import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import {
  ModelPreferenceSchema,
  type ModelPreference,
} from "@fungi.computer/shiitake/model-preference";

const settingsSchema = Schema.Struct({
  lastManualModel: ModelPreferenceSchema,
});
const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(settingsSchema),
  { onExcessProperty: "error" },
);

/** Reads Local's per-person remembered model; a Session switch never writes it. */
export function createLocalModelSettings(
  path = join(homedir(), ".config", "fungi", "shiitake.json"),
) {
  return {
    read: async (): Promise<ModelPreference | null> => {
      try {
        const text = await readFile(path, "utf8");
        if (text.length > 4096)
          throw new Error("Local model settings exceed their bound");
        return decodeSettings(text).lastManualModel;
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return null;
        throw new Error("Local model settings are invalid or unreadable", {
          cause,
        });
      }
    },
  };
}
