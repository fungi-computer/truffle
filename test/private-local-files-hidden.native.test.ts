import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { waitForAgentSettlement } from "@fungi.computer/shiitake/agent-control";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const synthetic = "synthetic hidden record";
const observedSchema = z.object({
  child: z.object({ stdout: z.string() }),
  direct: z.object({ content: z.string() }).or(z.object({ error: z.string() })),
  pointer: z
    .object({ content: z.string() })
    .or(z.object({ error: z.string() })),
  list: z.array(z.string()).or(z.object({ error: z.string() })),
});

/** The Agent's code: the sandboxed child, then the host Files reads. */
function proofSource(hidden: string): string {
  const python = [
    "import os, pathlib",
    `hidden = pathlib.Path(${JSON.stringify(hidden)})`,
    "try: seen = hidden.read_text()",
    "except OSError: seen = None",
    "pathlib.Path('child-wrote').write_text('ordinary')",
    "os.symlink(str(hidden), 'pointer')",
    "print('denied' if seen is None else 'read', end='')",
  ].join("\n");
  const read = (path: string) =>
    `await env.computers.local.files.read({ path: ${JSON.stringify(path)} }).then((file) => ({ content: file.content }), (error) => ({ error: String(error) }))`;
  return [
    `const child = await env.computers.local.exec(${JSON.stringify({
      executable: "/usr/bin/python3",
      args: ["-c", python],
    })});`,
    `const direct = ${read(".config/fungi/dummy-credential")};`,
    `const pointer = ${read("pointer")};`,
    `const list = await env.computers.local.files.list({ path: ".config/fungi" }).then((listed) => JSON.stringify(listed).includes("dummy-credential") ? ["dummy-credential"] : [], (error) => ({ error: String(error) }));`,
    "return { child: { stdout: child.stdout }, direct, pointer, list };",
  ].join("\n");
}

// Boots a real Workspace runtime host with the verified fungi-bwrap payload;
// sized like the sibling child-ceiling proof (2 s idle, >5 s under gate load).
it.runIf(process.platform === "linux")(
  "Workspace Files reads keep the sandbox's hidden Fungi records hidden",
  async () => {
    // Outside /tmp: the sandbox mounts a private /tmp over the host's.
    const scratch = fileURLToPath(
      new URL("../.botanical/files-hidden/", import.meta.url),
    );
    await mkdir(scratch, { recursive: true });
    // The selected project is the fixture HOME, so the hidden credential
    // directory lies inside the Files root as well as under the child's mask.
    const home = await realpath(await mkdtemp(join(scratch, "home-")));
    const hostInstall = await realpath(
      await mkdtemp(join(scratch, "host-install-")),
    );
    roots.push(home, hostInstall);
    const hiddenDirectory = join(home, ".config", "fungi");
    const hidden = join(hiddenDirectory, "dummy-credential");
    const bin = join(
      hostInstall,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    await Promise.all(
      [hiddenDirectory, bin].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(hidden, synthetic);
    for (const name of [
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-seccomp-workspace.bpf",
      "fungi-apply-patch",
    ])
      await copyFile(
        fileURLToPath(new URL(`../native/bin/${name}`, import.meta.url)),
        join(bin, name),
      );
    await chmod(join(bin, "fungi-bwrap"), 0o700);
    await chmod(join(bin, "fungi-apply-patch"), 0o700);
    vi.stubEnv("FUNGI_BUNDLED_CLI", join(hostInstall, "fungi.cjs"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    const models = createModels();
    const faux = fauxProvider({
      provider: "files-hidden-proof",
      models: [{ id: "files-hidden-model" }],
    });
    models.setProvider(faux.provider);
    let observed: unknown;
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall("execute", { code: proofSource(hidden) }),
          { stopReason: "toolUse" },
        ),
      (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult" && last.content[0]?.type === "text")
          observed = JSON.parse(last.content[0].text);
        return fauxAssistantMessage("Proof completed");
      },
    ]);
    const host = await openPrivateLocalRuntimeHost(
      {
        invocationRoot: home,
        configRoot: capturePrivateLocalConfigRoot(home),
        mode: "workspace",
        providerId: "files-hidden-proof",
        modelId: "files-hidden-model",
      },
      models,
    );
    try {
      expect(host.sandboxStatus()).toMatchObject({
        mode: "workspace",
        available: true,
      });
      const accepted = await host.session.command({
        type: "prompt",
        requestId: "files-hidden",
        delivery: "followUp",
        text: "Run the hidden-record proof.",
      });
      const { terminal } = await waitForAgentSettlement(
        host.session,
        accepted.commandId,
        5_000,
        new AbortController().signal,
      );
      expect(terminal).toMatchObject({ outcome: "completed" });
    } finally {
      await host.close();
    }
    const result = observedSchema.parse(observed);
    // The child is denied the record, yet writes ordinary selected entries.
    expect(result.child.stdout).toBe("denied");
    // The host Files port must keep the same boundary, directly or via an
    // Agent-authored in-root symlink.
    expect(result.direct).not.toHaveProperty("content");
    expect(result.pointer).not.toHaveProperty("content");
    expect(result.list).not.toEqual(["dummy-credential"]);
  },
  20_000,
);
