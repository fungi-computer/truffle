import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  sandboxUnavailableReasonSchema,
  type LocalSandbox,
} from "./private-local-containment.js";
import type { LocalSandboxLaunch } from "./private-invocation-computer.js";
import type { LocalSandboxWrites } from "./private-invocation-files.js";
import {
  protectedSandboxPaths,
  resolveAgentFolder,
  sandboxPolicy,
} from "./private-local-sandbox-policy.js";

/** Availability is not a hostile-program security or an approval status. */
export const sandboxStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    requireSandbox: z.boolean(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    requireSandbox: z.boolean(),
    reason: sandboxUnavailableReasonSchema,
  }),
]);
export type LocalSandboxStatus = z.output<typeof sandboxStatusSchema>;

export type LocalSandboxControls = LocalSandboxWrites &
  Readonly<{
    assertReady(): void;
    status(): LocalSandboxStatus;
    close(): void;
  }>;

function contains(root: string, path: string) {
  const within = relative(root, path);
  return (
    !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)
  );
}

/**
 * Native Local owns the live requirement; the adapter owns only preparation.
 * Every consumer calls this authority immediately before launching or writing.
 */
export function createLocalSandboxControls(
  input: Readonly<{
    project: string;
    folder: string;
    required(): boolean;
  }>,
): LocalSandboxControls {
  const required = input.required();
  const folder = resolveAgentFolder(input.project, input.folder);
  const initial = establishLocalSandbox({
    project: input.project,
    folder: folder.absolute,
  });
  let sandbox: LocalSandbox | undefined =
    initial.state === "ready" ? initial.sandbox : undefined;
  let unavailable =
    initial.state === "unavailable" ? initial.reason : undefined;
  if (unavailable !== undefined) {
    if (unavailable.kind === "invalid-folder")
      throw new Error(unavailable.message);
    if (required) throw new LocalSandboxUnavailable(unavailable);
  }
  let closed = false;
  const assertFolder = () => {
    if (closed) throw new Error("Local sandbox owner is closed");
    const current = resolveAgentFolder(input.project, input.folder);
    if (current.absolute !== folder.absolute)
      throw new Error("Local Agent folder authority changed while open");
  };
  const launch: LocalSandboxLaunch = (cwd, argv) => {
    assertFolder();
    if (sandbox === undefined) {
      const admission = establishLocalSandbox({
        project: input.project,
        folder: folder.absolute,
      });
      if (admission.state === "ready") sandbox = admission.sandbox;
      else unavailable = admission.reason;
    }
    if (sandbox !== undefined) {
      try {
        const command = sandbox.command(cwd, argv);
        unavailable = undefined;
        return command;
      } catch (cause) {
        if (!(cause instanceof LocalSandboxUnavailable)) throw cause;
        unavailable = cause.reason;
      }
    }
    if (unavailable === undefined)
      throw new Error("Local sandbox preparation produced no result");
    if (unavailable.kind === "invalid-folder")
      throw new Error(unavailable.message);
    if (input.required()) throw new LocalSandboxUnavailable(unavailable);
    // No executable has started. Only this owner admits the bare fallback.
    return undefined;
  };
  const assertReady = () => {
    launch(folder.absolute, ["/usr/bin/true"]);
  };
  return {
    launch,
    assertReady,
    assertWrite: (path) => {
      assertReady();
      const target = resolve(path);
      const policy = sandboxPolicy(input.project, folder.absolute);
      if (
        !contains(policy.writableRoot, target) ||
        protectedSandboxPaths(policy.readOnly).some((protectedPath) =>
          contains(protectedPath, target),
        ) ||
        protectedSandboxPaths(policy.immovable).includes(target)
      )
        throw new Error("Files write targets a protected Local path");
    },
    status: () => {
      if (closed) throw new Error("Local sandbox owner is closed");
      return unavailable === undefined
        ? { state: "available", requireSandbox: input.required() }
        : {
            state: "unavailable",
            requireSandbox: input.required(),
            reason: unavailable,
          };
    },
    close: () => {
      if (closed) return;
      closed = true;
      sandbox?.close();
    },
  };
}
