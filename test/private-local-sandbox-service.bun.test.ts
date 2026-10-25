import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { waitForAgentTerminal } from "@fungi.computer/shiitake/agent-control";
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
  "real Local selection returns 409 and the SDK preserves typed sandbox refusal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-sandbox-service-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const bin = join(
      project,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(home);
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "fungi-apply-patch"),
      "#!/bin/sh\nprintf 'Unexpected native patch call' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    const bundledCli = process.env.FUNGI_BUNDLED_CLI;
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
    const requirements: (boolean | undefined)[] = [];
    const running = runPrivateLocalService(
      directory,
      (options) => {
        requirements.push(options.requireSandbox);
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
            requireSandbox: true,
          }),
        },
      );
      const responseBody: unknown = await response.json();
      expect({ status: response.status, body: responseBody }).toMatchObject({
        status: 409,
        body: {
          code: "sandbox_unavailable",
          reason: { kind: "unsafe-native-payload" },
        },
      });
      const body = z
        .strictObject({
          code: z.literal("sandbox_unavailable"),
          reason: sandboxUnavailableReasonSchema,
        })
        .parse(responseBody);
      expect(body.reason.kind).toBe("unsafe-native-payload");
      const manager = createPrivateLocalServiceManager({ directory, home });
      const refused = manager.connect({
        invocationRoot: project,
        requireSandbox: true,
      });
      await assert.rejects(refused, LocalSandboxUnavailable);
      await assert.rejects(refused, { reason: body.reason });
      expect(requirements).toEqual([true, true]);
      expect(modelCalls).toBe(0);
      await assert.rejects(access(sentinel), { code: "ENOENT" });

      // Optional mode can connect, but may not run an in-project native
      // package bare when the Agent triggers a Computer command.
      const permitted = await manager.connect({
        invocationRoot: project,
        requireSandbox: false,
      });
      try {
        expect(await permitted.sandboxStatus()).toEqual({
          state: "unavailable",
          requireSandbox: false,
          reason: body.reason,
        });
        const accepted = await permitted.session.command({
          type: "prompt",
          requestId: "sandbox-http-fallback",
          delivery: "followUp",
          text: "Run the Computer sentinel command.",
        });
        const terminal = await waitForAgentTerminal(
          permitted.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        );
        expect(terminal).toMatchObject({ outcome: "completed" });
        await assert.rejects(access(sentinel), { code: "ENOENT" });
        expect(requirements).toEqual([true, true, false]);
      } finally {
        await permitted.close();
      }
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      try {
        await running;
      } finally {
        if (bundledCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = bundledCli;
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
