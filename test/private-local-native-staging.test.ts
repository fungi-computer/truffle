import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";
import { createLocalSandboxControls } from "../src/private-local-sandbox.js";

it.runIf(process.platform === "linux")(
  "Files fallback reads the installed helper once per use and keeps one staged copy per sandbox",
  async () => {
    const project = mkdtempSync(join(tmpdir(), "fungi-native-read-project-"));
    const install = mkdtempSync(join(tmpdir(), "fungi-native-read-install-"));
    const runtime = mkdtempSync(join(tmpdir(), "fungi-native-read-runtime-"));
    const previousCli = process.env.FUNGI_BUNDLED_CLI;
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    let sourceReads = 0;
    let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
    try {
      const folder = join(project, "agent");
      mkdirSync(folder);
      const packageName = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
      const packageRoot = join(install, "node_modules", packageName);
      const bin = join(packageRoot, "bin");
      mkdirSync(bin, { recursive: true });
      const helper = join(bin, "fungi-apply-patch");
      copyFileSync(
        fileURLToPath(
          new URL("../native/bin/fungi-apply-patch", import.meta.url),
        ),
        helper,
      );
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: packageName,
          exports: { "./bin/fungi-apply-patch": "./bin/fungi-apply-patch" },
        }),
      );
      const cli = join(install, "cli.cjs");
      writeFileSync(cli, "");
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.XDG_RUNTIME_DIR = runtime;
      controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
        platform: "unsupported",
        readNativePatchSource: (path) => {
          if (path === helper) sourceReads += 1;
          return readFileSync(path);
        },
      });
      expect(controls.status().state).toBe("unavailable"); // Unsupported backend.
      const port = await createPrivateInvocationFilesPort(
        folder,
        undefined,
        controls,
      );
      if (port.patch === undefined)
        throw new Error("Fixture helper must be installed");
      for (let invocation = 1; invocation <= 2; invocation += 1) {
        const result = await port.patch(
          {
            patch: `*** Begin Patch\n*** Add File: ${String(invocation)}.txt\n+verified\n*** End Patch\n`,
          },
          {
            executionId: `native-read-${String(invocation)}`,
            signal: new AbortController().signal,
            deadlineAt: null,
          },
        );
        expect(result.status).toBe("completed");
        // Each use rechecks the installed bytes; Files must not read them again.
        expect(sourceReads).toBe(invocation);
        const [run] = readdirSync(join(runtime, "fungi", "native"));
        if (run === undefined) throw new Error("Private run must exist");
        expect(readdirSync(join(runtime, "fungi", "native", run))).toHaveLength(
          1,
        );
      }
    } finally {
      controls?.close();
      if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previousCli;
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      for (const path of [project, install, runtime])
        rmSync(path, { recursive: true });
    }
  },
);
