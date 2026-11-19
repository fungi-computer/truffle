import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";

/** The fixture package: a fake provider's subscription sign-in. */
export const loginExtensionDirectory = fileURLToPath(
  new URL("./fixtures/login-extension", import.meta.url),
);
export const loginExtensionEntry = join(loginExtensionDirectory, "logins.mjs");

/**
 * A fake provider with an API key login and no subscription login: the empty
 * slot an extension may fill. Veil has not reviewed its id, so the policy
 * lets an extension fill a slot there.
 */
export function fixtureProvider(id = "fixture"): Provider {
  return {
    ...fauxProvider({ provider: id }).provider,
    name: "Fixture",
    auth: {
      apiKey: {
        name: "Fixture API key",
        login: () => Promise.resolve({ type: "api_key", key: "fixture-key" }),
        resolve: () => Promise.resolve(undefined),
      },
    },
  };
}

export type SeededLogin = Readonly<{
  providerId: string;
  method: "subscription" | "api_key";
}>;

const installedFile = z.object({
  extensions: z.record(z.string(), z.unknown()),
});
const activationsFile = z.object({
  projects: z.record(z.string(), z.unknown()),
  agents: z.record(z.string(), z.unknown()),
  logins: z.record(z.string(), z.string()),
});

async function readOr<T>(path: string, empty: T, schema: z.ZodType<T>) {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return empty;
    throw cause;
  }
}

/**
 * Write the records `fungi extension add` and `enable logins` would, for a
 * package whose `./logins` entry is `entry`. The records are the owner's
 * documented files; no package manager or network is involved.
 */
export async function seedLoginExtension(
  home: string,
  input: Readonly<{
    id: string;
    entry: string;
    logins: readonly SeededLogin[];
    enabled?: boolean;
  }>,
) {
  const root = join(home, ".fungi", "extensions");
  await mkdir(root, { recursive: true });
  const installed = await readOr(
    join(root, "installed.json"),
    { extensions: {} },
    installedFile,
  );
  installed.extensions[input.id] = {
    current: "1.0.0",
    revisions: {
      "1.0.0": {
        name: `fungi-${input.id}`,
        version: "1.0.0",
        source: input.entry,
        resolution: `file:${input.entry}`,
        commit: null,
        directory: dirname(input.entry),
        capabilities: [],
        terminals: [],
        host: null,
        client: null,
        skills: null,
        logins: input.logins,
        loginsEntry: input.entry,
      },
    },
  };
  const activations = await readOr(
    join(root, "activations.json"),
    { projects: {}, agents: {}, logins: {} },
    activationsFile,
  );
  if (input.enabled !== false) activations.logins[input.id] = "1.0.0";
  await writeFile(
    join(root, "installed.json"),
    `${JSON.stringify(installed, null, 2)}\n`,
  );
  await writeFile(
    join(root, "activations.json"),
    `${JSON.stringify(activations, null, 2)}\n`,
  );
}
