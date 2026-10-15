import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { sleep } from "bun";
import { runPrivateLocalService } from "../src/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import {
  serviceDirectory,
  readServiceRecord,
} from "../src/private-local-service-discovery.js";
import type { runLocalAuthCli } from "../src/auth-cli.js";

async function withService(
  runAuth: typeof runLocalAuthCli,
  body: (
    manager: ReturnType<typeof createPrivateLocalServiceManager>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "fungi-auth-rpc-"));
  const directory = await serviceDirectory(root);
  const manager = createPrivateLocalServiceManager({ directory });
  const running = runPrivateLocalService(
    directory,
    () => {
      throw new Error("Auth must not open a Session owner");
    },
    () => Promise.resolve([]),
    runAuth,
  );
  const settled = Promise.allSettled([running]);
  const behaviour = await Promise.allSettled([
    (async () => {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await readServiceRecord(directory)) {
          ready = true;
          break;
        }
        await sleep(10);
      }
      assert.equal(ready, true);
      await body(manager);
    })(),
  ]);
  const stopped = await Promise.allSettled([manager.stop()]);
  const service = await settled;
  const removed = await Promise.allSettled([
    rm(root, { recursive: true, force: true }),
  ]);
  const failures: unknown[] = [];
  for (const result of [...behaviour, ...stopped, ...service, ...removed]) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Local auth proof or service teardown failed",
    );
}

test("native service auth carries Pi prompts without opening or stopping Session owners", async () => {
  const notifications: string[] = [];
  await withService(
    async (args, options) => {
      assert.deepEqual(args, ["login", "--provider", "synthetic"]);
      const interaction = options?.interaction;
      assert.ok(interaction);
      const answer = await interaction.prompt({
        type: "secret",
        message: "Fixture secret",
      });
      assert.equal(answer, "synthetic-only");
      interaction.notify({ type: "info", message: "Completed" });
      return { kind: "completed" as const };
    },
    async (manager) => {
      const before = await manager.status();
      await manager.auth(
        { command: "login", provider: "synthetic" },
        {
          prompt: (request) => {
            assert.equal(request.type, "secret");
            return Promise.resolve("synthetic-only");
          },
          notify: (event) => {
            if (event.type === "info") notifications.push(event.message);
          },
        },
      );
      assert.deepEqual(await manager.status(), before);
      assert.deepEqual(notifications, ["Completed"]);
    },
  );
});

test("native auth status crosses the service as typed provider state", async () => {
  await withService(
    (args) => {
      assert.deepEqual(args, ["status"]);
      return Promise.resolve({
        kind: "status" as const,
        providers: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            state: "unconfigured" as const,
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            state: "configured" as const,
            type: "api_key" as const,
          },
        ],
      });
    },
    async (manager) => {
      const statuses = await manager.auth(
        { command: "status" },
        { prompt: () => Promise.resolve(""), notify: () => undefined },
      );
      assert.deepEqual(statuses, {
        kind: "status",
        providers: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            state: "unconfigured",
          },
          {
            providerId: "anthropic",
            providerName: "Anthropic",
            state: "configured",
            type: "api_key",
          },
        ],
      });
    },
  );
});

test("cancelling an auth dialog aborts its remote operation and leaves the service alive", async () => {
  const started = Promise.withResolvers<undefined>();
  let providerAborted = false;
  await withService(
    async (_args, options) => {
      const interaction = options?.interaction;
      assert.ok(interaction);
      try {
        await interaction.prompt({ type: "manual_code", message: "Waiting" });
      } finally {
        providerAborted = interaction.signal?.aborted === true;
      }
      return { kind: "completed" as const };
    },
    async (manager) => {
      const abort = new AbortController();
      const operation = manager.auth(
        { command: "login" },
        {
          signal: abort.signal,
          prompt: (request) =>
            new Promise<string>((_resolve, reject) => {
              assert.ok(request.signal);
              request.signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("Cancelled fixture prompt"));
                },
                { once: true },
              );
              started.resolve(undefined);
            }),
          notify: () => undefined,
        },
      );
      const rejected = assert.rejects(operation, /Authentication cancelled/u);
      await started.promise;
      abort.abort();
      await rejected;
      assert.equal(providerAborted, true);
      assert.ok(await manager.status());
    },
  );
});
