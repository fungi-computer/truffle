import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { waitForAgentSettlement } from "@fungi.computer/shiitake/agent-control";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { sandboxUnavailableReasonSchema } from "../dist/private-local-containment.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";
import {
  readServiceRecord,
  serviceDirectory,
  type ServiceRecord,
} from "../dist/private-local-service-discovery.js";
import { runPrivateLocalService } from "../dist/private-local-service-listener.js";
import {
  createPrivateLocalServiceManager,
  LocalSandboxUnavailable,
} from "../dist/private-local-service.js";

it.skipIf(process.platform !== "linux")(
  "real Local selection returns 409 for a project containing host files and the SDK preserves typed refusal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-sandbox-service-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const runtime = join(root, "runtime");
    const bin = join(
      project,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(home);
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(bin, { recursive: true });
    for (const name of [
      "fungi-apply-patch",
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-seccomp-workspace.bpf",
    ])
      await copyFile(
        join(import.meta.dir, "..", "native", "bin", name),
        join(bin, name),
      );
    const previousEnvironment = new Map(
      [
        "HOME",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "FUNGI_BUNDLED_CLI",
      ].map((key) => [key, process.env[key]]),
    );
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = runtime;
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_CACHE_HOME = join(home, "cache");
    process.env.XDG_DATA_HOME = join(home, "data");
    process.env.FUNGI_BUNDLED_CLI = join(project, "fungi.cjs");
    const configRoot = capturePrivateLocalConfigRoot(home);
    const directory = await serviceDirectory(configRoot.serviceDirectory);
    const sentinel = join(project, "computer-executed");
    const models = createModels();
    const faux = fauxProvider({
      provider: "sandbox-http-proof",
      models: [{ id: "sandbox-model" }],
    });
    models.setProvider(faux.provider);
    let modelCalls = 0;
    faux.setResponses([
      () => {
        modelCalls += 1;
        return fauxAssistantMessage(
          fauxToolCall("execute", {
            code: 'return await env.computers.local.exec({ command: "printf executed > computer-executed" })',
          }),
          { stopReason: "toolUse" },
        );
      },
      () => {
        modelCalls += 1;
        return fauxAssistantMessage("Computer completed");
      },
    ]);
    const modes: ("read-only" | "workspace" | "full-access" | undefined)[] = [];
    const running = runPrivateLocalService(
      directory,
      (options) => {
        modes.push(options.mode);
        return openPrivateLocalRuntimeHost(
          {
            ...options,
            configRoot,
            providerId: "sandbox-http-proof",
            modelId: "sandbox-model",
          },
          models,
        );
      },
      undefined,
      undefined,
      undefined,
      undefined,
      configRoot,
    );
    try {
      let record: ServiceRecord | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        record = await readServiceRecord(directory);
        if (record !== undefined) break;
        await delay(10);
      }
      assert.ok(record, "Owned Local listener did not register");
      const response = await fetch(
        `${record.baseUrl}/service/${record.serviceId}/select`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invocationRoot: project,
            clientPath: "/usr/bin:/bin",
            mode: "workspace",
          }),
        },
      );
      const responseBody: unknown = await response.json();
      expect({ status: response.status, body: responseBody }).toMatchObject({
        status: 409,
        body: {
          code: "sandbox_unavailable",
          reason: { kind: "install" },
        },
      });
      const body = z
        .strictObject({
          code: z.literal("sandbox_unavailable"),
          reason: sandboxUnavailableReasonSchema,
        })
        .parse(responseBody);
      expect(body.reason.kind).toBe("install");
      // A refused first selection must not reserve an Agent id or open an
      // empty SQLite file that the next selection mistakes for an old store.
      await assert.rejects(access(join(project, ".fungi", "agents")), {
        code: "ENOENT",
      });
      const manager = createPrivateLocalServiceManager({ directory, home });
      const refused = manager.connect({
        invocationRoot: project,
        mode: "workspace",
      });
      await assert.rejects(refused, LocalSandboxUnavailable);
      await assert.rejects(refused, { reason: body.reason });
      await assert.rejects(access(join(project, ".fungi", "agents")), {
        code: "ENOENT",
      });
      expect(modes).toEqual(["workspace", "workspace"]);
      expect(modelCalls).toBe(0);
      await assert.rejects(access(sentinel), { code: "ENOENT" });

      // Full access is an explicit, persistent choice, not an optional
      // sandbox retry. It does not grant sandboxed access to host files.
      const permitted = await manager.connect({
        invocationRoot: project,
        mode: "full-access",
      });
      try {
        expect(await permitted.sandboxStatus()).toEqual({
          mode: "full-access",
          available: true,
        });
        const accepted = await permitted.session.command({
          type: "prompt",
          requestId: "sandbox-http-fallback",
          delivery: "followUp",
          text: "Run the Computer sentinel command.",
        });
        const terminal = await waitForAgentSettlement(
          permitted.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal);
        expect(terminal).toMatchObject({ outcome: "completed" });
        await access(sentinel);
        expect(modes).toEqual(["workspace", "workspace", "full-access"]);
      } finally {
        await permitted.close();
      }
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      try {
        await running;
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) Reflect.deleteProperty(process.env, key);
          else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
