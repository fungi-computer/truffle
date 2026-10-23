// The real Local service, built runtime hosts and the real workerd sandbox in
// a disposable HOME. Two scripted models: the parent delegates once with
// `agents.send` and then answers the child's reply; the child answers.
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeHost from "@fungi.computer/shiitake/node";
import * as mail from "../../dist/private-local-mail.js";

// Rehearse a restart after the first retry becomes due, without sleeping.
// This process owns its clock; no live service or persisted row is changed.
if (process.argv[6] === "resume-reply") {
  const now = Date.now;
  const dueAt = z.coerce.number().int().positive().parse(process.argv[7]);
  const offset = Math.max(0, dueAt - now());
  Date.now = () => now() + offset;
}

// Hold only the test-owned child's provider. At shutdown, pause an empty
// outbox observation until real reconciliation has published the reply and
// advanced its cursor. No runtime/SQL answer is fabricated.
const holdCompletion = process.argv[6] === "hold-completion";
const openingChild = new AsyncLocalStorage<boolean>();
const childDatabases = new WeakSet<object>();
const completion = Promise.withResolvers<undefined>();
const reconciled = Promise.withResolvers<undefined>();
const realMailRoom = mail.createPrivateLocalMailRoom;
const realPendingMail = mail.hasPrivateLocalPendingMail;
const realNodeHost = nodeHost.nodeRuntimeHost;
let stopping = false;
let released = false;
const release = () => {
  released = true;
  completion.resolve(undefined);
};
if (holdCompletion) {
  process.on("SIGTERM", () => {
    stopping = true;
  });
  await mock.module("../../dist/private-local-mail.js", () => ({
    ...mail,
    createPrivateLocalMailRoom: (
      ...args: Parameters<typeof mail.createPrivateLocalMailRoom>
    ) => {
      if (openingChild.getStore() === true) childDatabases.add(args[0]);
      return realMailRoom(...args);
    },
    hasPrivateLocalPendingMail: async (
      database: Parameters<typeof mail.hasPrivateLocalPendingMail>[0],
    ) => {
      const pending = await realPendingMail(database);
      if (stopping && childDatabases.has(database) && !released) {
        if (pending) throw new Error("Expected the held child's empty outbox");
        release();
        await reconciled.promise;
      }
      return pending;
    },
  }));
  await mock.module("@fungi.computer/shiitake/node", () => ({
    ...nodeHost,
    nodeRuntimeHost: (...args: Parameters<typeof nodeHost.nodeRuntimeHost>) => {
      const host = realNodeHost(...args);
      const isChild = openingChild.getStore() === true;
      return {
        ...host,
        runtime: {
          bind: (input: Parameters<typeof host.runtime.bind>[0]) =>
            host.runtime.bind({
              ...input,
              pendingWork: async () => {
                const work = await input.pendingWork();
                if (isChild && released && !work.pending)
                  reconciled.resolve(undefined);
                return work;
              },
            }),
        },
      };
    },
  }));
}

// Delegation executes in the built sandbox worker bundle.
const { runPrivateLocalService } =
  await import("../../dist/private-local-service-listener.js");
const { openPrivateLocalRuntimeHost } =
  await import("../../dist/private-local-runtime-host.js");
const { serviceDirectory } =
  await import("../../dist/private-local-service-discovery.js");

const [directory, sweepMs, parentPath, childAgentId] = z
  .tuple([
    z.string().min(1),
    z.coerce.number().int().positive(),
    z.string().min(1),
    z.string().min(1),
  ])
  .parse(process.argv.slice(2, 6));

const models = createModels();
const parent = fauxProvider({
  provider: "faux-parent",
  models: [{ id: "parent-model", name: "Parent" }],
});
const child = fauxProvider({
  provider: "faux-child",
  models: [{ id: "child-model", name: "Child" }],
});
parent.setResponses([
  fauxAssistantMessage(
    fauxToolCall("execute", {
      code: `async () => agents.send({ agentId: ${JSON.stringify(childAgentId)}, sessionId: "main", requestId: "find-answer", text: "Find the answer", delivery: "followUp" })`,
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("Delegated; waiting"),
  fauxAssistantMessage("Reply received"),
]);
if (process.argv[6] === "resume-reply")
  parent.setResponses([fauxAssistantMessage("Reply received")]);
child.setResponses([
  async () => {
    if (holdCompletion) {
      process.send?.("child-held");
      await completion.promise;
    }
    return fauxAssistantMessage("Child result");
  },
]);
models.setProvider(parent.provider);
models.setProvider(child.provider);

await runPrivateLocalService(
  await serviceDirectory(directory),
  async (options) => {
    const isParent = options.databasePath === parentPath;
    const host = await openingChild.run(!isParent, () =>
      openPrivateLocalRuntimeHost(
        {
          ...options,
          providerId: isParent ? "faux-parent" : "faux-child",
          modelId: isParent ? "parent-model" : "child-model",
        },
        models,
      ),
    );
    return {
      ...host,
      close: async () => {
        // With settlement-first ordering the still-running child is busy,
        // so its outbox isn't read. Let that admitted job finish during close.
        if (holdCompletion && !isParent && stopping && !released) {
          release();
          await reconciled.promise;
        }
        await host.close();
      },
    };
  },
  undefined,
  undefined,
  sweepMs,
);
if (process.connected) process.disconnect();
