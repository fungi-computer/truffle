import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const variables = ["FUNGI_BUNDLED_BUILD_ID", "PATH"] as const;

/**
 * Make this test process the installed fungi client: a disposable prefix whose
 * `fungi` launcher sits beside a cli.js hashing to this process's build ID.
 * Only the installed client may replace a service of another version.
 * The launcher is never run; the installed-build reader keys on its name.
 */
export async function becomeCurrentInstalledClient(home: string) {
  const bin = join(home, "installed", "bin");
  const dist = join(home, "installed", "dist");
  await mkdir(bin, { recursive: true });
  await mkdir(dist, { recursive: true });
  const launcher = join(dist, "fungi.cjs");
  await writeFile(
    launcher,
    '#!/usr/bin/env node\nthrow new Error("fixture launcher is never run");\n',
    { mode: 0o755 },
  );
  await writeFile(join(dist, "cli.js"), "// the installed build\n");
  await symlink(launcher, join(bin, "fungi"));
  const previous = new Map(variables.map((name) => [name, process.env[name]]));
  process.env.FUNGI_BUNDLED_BUILD_ID = createHash("sha256")
    .update(await readFile(join(dist, "cli.js")))
    .digest("hex");
  process.env.PATH = `${bin}:${previous.get("PATH") ?? "/usr/bin:/bin"}`;
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}
