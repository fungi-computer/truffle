import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it, expect, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { waitForAgentTerminal } from "@fungi.computer/shiitake/agent-control";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { LocalSandboxUnavailable } from "../dist/private-local-containment.js";
import type { LocalAgentControlDirectory } from "../dist/private-local-agent-control.js";
import {
  openPrivateLocalRuntimeHost,
  resolvePrivateLocalCreateStore,
} from "../dist/private-local-runtime-host.js";
import { createLocalServiceOwners } from "../dist/private-local-service-owner.js";
import { readPrivateLocalAgentProfile } from "../dist/private-local-session-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.runIf(process.platform === "linux").each([false, true])(
  "a real child inherits its maker's folder and persisted requirement (%s)",
  async (required) => {
    // Outside /tmp: reading the existing host sentinel must succeed before
    // its read-only write refusal can establish the child's folder ceiling.
    const scratch = fileURLToPath(
      new URL("../.botanical/child-ceilings/", import.meta.url),
    );
    await mkdir(scratch, { recursive: true });
    const root = await realpath(await mkdtemp(join(scratch, "project-")));
    roots.push(root);
    const folder = join(root, "agent");
    const home = join(root, "home");
    const bin = join(
      root,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    await Promise.all(
      [folder, home, bin, join(root, ".git")].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    for (const name of [
      "fungi-bwrap",
      "fungi-bwrap.sha256",
      "fungi-seccomp.bpf",
      "fungi-seccomp.bpf.sha256",
      "fungi-apply-patch",
    ])
      await copyFile(
        fileURLToPath(new URL(`../native/bin/${name}`, import.meta.url)),
        join(bin, name),
      );
    await chmod(join(bin, "fungi-bwrap"), 0o700);
    await chmod(join(bin, "fungi-apply-patch"), 0o700);
    vi.stubEnv("FUNGI_BUNDLED_CLI", join(root, "fungi.cjs"));
    const configRoot = capturePrivateLocalConfigRoot(home);
    const models = createModels();
    const faux = fauxProvider({
      provider: "child-sandbox-proof",
      models: [{ id: "child-model" }],
    });
    models.setProvider(faux.provider);
    const outside = join(root, "outside");
    await writeFile(outside, "host sentinel");
    const python = [
      "import errno, pathlib",
      `assert pathlib.Path.cwd() == pathlib.Path(${JSON.stringify(folder)})`,
      `outside = pathlib.Path(${JSON.stringify(outside)})`,
      "assert outside.read_text() == 'host sentinel'",
      "try: outside.write_text('escaped')",
      "except OSError as error: assert error.errno in (errno.EROFS, errno.EACCES)",
      "else: raise AssertionError('child broadened its writable folder')",
      "pathlib.Path('child-only').write_text('contained child')",
    ].join("\n");
    let modelCalls = 0;
    faux.setResponses([
      () => {
        modelCalls += 1;
        return fauxAssistantMessage(
          fauxToolCall("execute", {
            code: `return await env.computers.local.exec(${JSON.stringify({
              executable: "/usr/bin/python3",
              args: ["-c", python],
            })})`,
          }),
          { stopReason: "toolUse" },
        );
      },
      () => {
        modelCalls += 1;
        return fauxAssistantMessage("Child completed");
      },
    ]);
    let owners: ReturnType<typeof createLocalServiceOwners> | undefined;
    try {
      const maker = await openPrivateLocalRuntimeHost(
        {
          invocationRoot: root,
          configRoot,
          folder: "agent",
          requireSandbox: required,
          providerId: "child-sandbox-proof",
          modelId: "child-model",
        },
        models,
      );
      const makerId = maker.agentId;
      const makerDatabase = maker.databasePath;
      await maker.close();
      let directory: LocalAgentControlDirectory | undefined;
      owners = createLocalServiceOwners(
        (options) => {
          directory ??= options.agentControl;
          // No fixture default for folder or requirement: the real creator
          // profile and service owner alone must supply the child's ceiling.
          return openPrivateLocalRuntimeHost(options, models);
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        configRoot,
      );
      const selectedMaker = await owners.select({
        invocationRoot: root,
        databasePath: makerDatabase,
        sessionId: "main",
      });
      selectedMaker.release();
      if (directory === undefined) throw new Error("Local directory missing");
      const child = await directory.create(
        {
          requestId: "child-ceiling",
          createdBy: makerId,
          model: {
            providerId: "child-sandbox-proof",
            modelId: "child-model",
          },
        },
        new AbortController().signal,
      );
      const store = await resolvePrivateLocalCreateStore(root, "child-ceiling");
      expect(child.agentId).not.toBe(makerId);
      expect(readPrivateLocalAgentProfile(store.databasePath)).toMatchObject({
        createdBy: makerId,
        folder: "agent",
        requireSandbox: required,
      });
      const selectedChild = await owners.select({
        invocationRoot: root,
        databasePath: store.databasePath,
      });
      try {
        const accepted = await selectedChild.session.command({
          type: "prompt",
          requestId: "child-computer",
          delivery: "followUp",
          text: "Run the child Computer proof.",
        });
        const terminal = await waitForAgentTerminal(
          selectedChild.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        );
        expect(terminal).toMatchObject({ outcome: "completed" });
        expect(await readFile(join(folder, "child-only"), "utf8")).toBe(
          "contained child",
        );
        expect(await readFile(outside, "utf8")).toBe("host sentinel");
        expect(modelCalls).toBe(2);
      } finally {
        selectedChild.release();
      }
      await owners.close();
      await rm(join(bin, "fungi-bwrap"));
      const reopening = openPrivateLocalRuntimeHost(
        { invocationRoot: root, databasePath: store.databasePath, configRoot },
        models,
      );
      if (required) {
        await expect(reopening).rejects.toBeInstanceOf(LocalSandboxUnavailable);
        await expect(reopening).rejects.toMatchObject({
          reason: { kind: "missing" },
        });
      } else {
        const reopened = await reopening;
        try {
          expect(reopened.sandboxStatus()).toMatchObject({
            state: "unavailable",
            requireSandbox: false,
            reason: { kind: "missing" },
          });
        } finally {
          await reopened.close();
        }
      }
      expect(modelCalls).toBe(2);
    } finally {
      await owners?.close();
    }
  },
);
