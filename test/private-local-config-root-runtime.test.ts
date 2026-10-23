import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { localExtensions } from "../src/local-extensions.js";
// The ordinary build bundles workerd's entrypoint; source imports cannot execute it.
import {
  openPrivateLocalRuntimeHost,
  type PrivateLocalRuntimeHost,
} from "../dist/private-local-runtime-host.js";

async function fixture() {
  const area = await mkdtemp(join(tmpdir(), "fungi-config-runtime-"));
  const a = capturePrivateLocalConfigRoot(join(area, "a"));
  const b = capturePrivateLocalConfigRoot(join(area, "b"));
  await Promise.all(
    [a.home, b.home, join(area, "project")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const project = await realpath(join(area, "project"));
  return { area, a, b, project };
}

async function prompt(session: ShiitakeSession, requestId: string) {
  const watch = await session.watch();
  try {
    const accepted = await session.send("Run the synthetic HOME probe", {
      requestId,
    });
    for await (const frame of watch.changes) {
      if (frame.kind !== "update") continue;
      const terminal = frame.terminals.find(
        (entry) => entry.commandId === accepted.commandId,
      );
      if (terminal === undefined) continue;
      expect(terminal.outcome).toBe("completed");
      return;
    }
    throw new Error("HOME probe watch ended without a terminal");
  } finally {
    await watch.close();
  }
}

it.each(["at construction", "by injection"])(
  "keeps the native host's default Models in A (%s)",
  async (selection) => {
    const { area, a, b, project } = await fixture();
    const previousHome = process.env.HOME;
    let host: PrivateLocalRuntimeHost | undefined;
    try {
      await createPrivateCredentialStore(a.credentialPath).modify(
        "anthropic",
        () => Promise.resolve({ type: "api_key", key: "synthetic-a" }),
      );
      await createPrivateCredentialStore(b.credentialPath).modify(
        "unused",
        () => Promise.resolve({ type: "api_key", key: "synthetic-b" }),
      );
      const beforeB = await readFile(b.credentialPath, "utf8");
      process.env.HOME = selection === "by injection" ? b.home : a.home;
      const input =
        selection === "by injection"
          ? { invocationRoot: project, configRoot: a }
          : { invocationRoot: project };
      const opening = openPrivateLocalRuntimeHost(input);
      process.env.HOME = b.home;
      host = await opening;
      // Catalog/auth metadata only: no prompt or provider network request.
      expect(
        await host.effectiveModel("main", new AbortController().signal),
      ).toMatchObject({
        providerId: "anthropic",
        credential: { kind: "api_key" },
      });
      expect(await readFile(b.credentialPath, "utf8")).toBe(beforeB);
    } finally {
      await host?.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(area, { recursive: true, force: true });
    }
  },
  30_000,
);

it("retains HOME A through real host reload and a later Session while PATH changes", async () => {
  const { area, a, b, project } = await fixture();
  const previousHome = process.env.HOME;
  let host: PrivateLocalRuntimeHost | undefined;
  const initialPath = "/toolchain/initial:/usr/bin:/bin";
  const reloadedPath = "/toolchain/reloaded:/usr/bin:/bin";
  try {
    const otherExtensions = join(b.home, ".fungi", "extensions");
    await mkdir(otherExtensions, { recursive: true });
    const invalid = "{not valid JSON";
    await writeFile(join(otherExtensions, "installed.json"), invalid);
    const marker = "native-home-proof";
    const code = `return await env.computers.local.exec(${JSON.stringify({
      executable: process.execPath,
      args: [
        "-e",
        `const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
if (!process.argv.slice(1).includes(home)) throw new Error("Not a disposable HOME");
// Report captured HOME from inside the writable Agent folder, not by writing
// into the host HOME (which may be hidden by private /tmp or read-only).
fs.appendFileSync(path.join(process.cwd(), ${JSON.stringify(marker)}),
  JSON.stringify({home, path: process.env.PATH, root: process.cwd()}) + "\\n");
process.stdout.write(home);`,
        a.home,
        b.home,
      ],
    })});`;
    const faux = fauxProvider({
      provider: "config-root-fixture",
      models: [{ id: "probe", name: "Synthetic HOME probe" }],
    });
    faux.setResponses(
      ["initial", "reloaded", "later-session"].flatMap((label) => [
        fauxAssistantMessage(fauxToolCall("execute", { code }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(label),
      ]),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    process.env.HOME = a.home;
    const opening = openPrivateLocalRuntimeHost(
      {
        invocationRoot: project,
        providerId: "config-root-fixture",
        modelId: "probe",
      },
      models,
    );
    process.env.HOME = b.home;
    host = await opening;
    expect(host.bindSessionPath("main", initialPath)).toBe(true);
    const line = (path: string) =>
      JSON.stringify({ home: a.home, path, root: project }) + "\n";
    await prompt(host.session, "initial");
    await expect(access(join(b.home, marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(a.home, marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(project, marker), "utf8")).toBe(
      line(initialPath),
    );

    const installed = await localExtensions({ home: a.home }).agent(
      dirname(host.databasePath),
      project,
    );
    const prepared = await host.prepareReload({
      installed,
      fungiMcp: undefined,
      clientPath: reloadedPath,
    });
    prepared.commit();
    await prompt(host.session, "after-reload");
    expect(await readFile(join(project, marker), "utf8")).toBe(
      line(initialPath) + line(reloadedPath),
    );
    await prompt(host.getSession("later-session"), "later-session");
    expect(await readFile(join(project, marker), "utf8")).toBe(
      line(initialPath) + line(reloadedPath) + line(reloadedPath),
    );
    await expect(access(join(b.home, marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(a.home, marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(join(otherExtensions, "installed.json"), "utf8"),
    ).toBe(invalid);
  } finally {
    await host?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(area, { recursive: true, force: true });
  }
}, 30_000);
