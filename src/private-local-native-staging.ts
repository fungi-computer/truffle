import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localLinuxSandboxPayload,
  verifiedNativePatchHelper,
  LocalBwrapUnavailable,
  type NativeSourceReader,
} from "./private-local-bwrap.js";
import {
  assertHostOwnedNativeFile,
  UnsafeNativePayload,
  type LinuxSandboxProfile,
} from "./private-local-sandbox-policy.js";

function within(root: string, path: string) {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`);
}

/** The same metadata-independent package path selects the verified source and Files caller. */
export function packagedPatchPath() {
  if (process.env.FUNGI_BUNDLED_CLI) {
    const name = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
    try {
      const paths = createRequire(process.env.FUNGI_BUNDLED_CLI).resolve.paths(
        name,
      );
      const packageRoot = paths
        ?.map((directory) => join(directory, name))
        .find((candidate) => lstatSync(candidate, { throwIfNoEntry: false }));
      if (packageRoot !== undefined)
        return join(packageRoot, "bin", "fungi-apply-patch");
      throw new Error("Native package not installed");
    } catch (cause) {
      throw new LocalBwrapUnavailable(
        "install",
        `Missing ${name}/bin/fungi-apply-patch; reinstall Fungi.`,
        { cause },
      );
    }
  }
  return fileURLToPath(
    new URL("../native/bin/fungi-apply-patch", import.meta.url),
  );
}

/** One verified private copy for the service's lifetime, not for each command. */
export function createNativePayloadStaging(
  project: string,
  readNativeSource: NativeSourceReader = readFileSync,
) {
  const patchSource = packagedPatchPath();
  assertHostOwnedNativeFile(project, dirname(dirname(patchSource)));
  const patchBytes = verifiedNativePatchHelper(
    patchSource,
    project,
    readNativeSource,
  );
  const linux =
    process.platform === "linux"
      ? localLinuxSandboxPayload(project, readNativeSource)
      : undefined;
  const installDirectories = [
    dirname(patchSource),
    ...(linux === undefined ? [] : [dirname(linux.sourcePath)]),
  ].flatMap((source) => [resolve(source), realpathSync(source)]);
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime ?? join(userInfo().homedir, ".local", "state");
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(base))
    throw new UnsafeNativePayload(
      "Native staging needs an absolute runtime directory and POSIX user.",
    );
  if (runtime !== undefined) {
    const metadata = lstatSync(runtime, { throwIfNoEntry: false });
    if (
      metadata === undefined ||
      !metadata.isDirectory() ||
      metadata.uid !== uid ||
      (metadata.mode & 0o077) !== 0
    )
      throw new UnsafeNativePayload(
        "XDG_RUNTIME_DIR must be a private directory owned by this user.",
      );
  }
  const root = join(base, "fungi");
  const projectRoot = realpathSync(project);
  if (within(projectRoot, resolve(root)))
    throw new UnsafeNativePayload(
      "Host native staging cannot live inside the Agent project.",
    );
  let directory: string | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const actual = realpathSync(root);
    if (within(projectRoot, actual))
      throw new UnsafeNativePayload(
        "Host native staging resolves inside the Agent project.",
      );
    const metadata = lstatSync(actual);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== uid ||
      (metadata.mode & 0o077) !== 0
    )
      throw new UnsafeNativePayload(
        "Host native staging root must be private and owned by this user.",
      );
    const staged = mkdtempSync(join(actual, "native-"));
    directory = staged;
    const boundaries = [staged, ...installDirectories];
    const stage = (label: string, bytes: Uint8Array, mode: number) => {
      const target = join(staged, label);
      writeFileSync(target, bytes, { flag: "wx", mode });
      return target;
    };
    const patch = stage("fungi-apply-patch", patchBytes, 0o500);
    const bwrap = linux && stage("fungi-bwrap", linux.executableBytes, 0o500);
    const seccomp = linux && stage("fungi-seccomp.bpf", linux.seccomp, 0o400);
    const workspace =
      linux &&
      stage("fungi-seccomp-workspace.bpf", linux.seccompWorkspace, 0o400);
    let closed = false;
    return {
      admitProject: (nextProject: string) => {
        if (closed) throw new Error("Native staging owner is closed");
        const next = realpathSync(nextProject);
        for (const source of boundaries)
          if (within(next, source))
            throw new UnsafeNativePayload(
              "Native files must be outside the Agent project.",
            );
      },
      patch: (path: string) => {
        if (closed) throw new Error("Native staging owner is closed");
        if (resolve(path) !== resolve(patchSource))
          throw new LocalBwrapUnavailable(
            "install",
            "Native patch helper changed; restart Fungi.",
          );
        return patch;
      },
      linux: (profile: LinuxSandboxProfile) => {
        if (closed) throw new Error("Native staging owner is closed");
        if (linux === undefined || bwrap === undefined)
          throw new LocalBwrapUnavailable(
            "install",
            "No packaged Linux sandbox; reinstall Fungi.",
          );
        return {
          executable: bwrap,
          seccompFilter:
            profile.mode === "workspace"
              ? linux.seccompWorkspace
              : linux.seccomp,
        };
      },
      probeFilter: (bytes: Uint8Array) => {
        if (closed) throw new Error("Native staging owner is closed");
        if (bytes === linux?.seccomp && seccomp !== undefined) return seccomp;
        if (bytes === linux?.seccompWorkspace && workspace !== undefined)
          return workspace;
        throw new LocalBwrapUnavailable(
          "install",
          "Unknown native filter; restart Fungi.",
        );
      },
      close: () => {
        if (closed) return;
        closed = true;
        rmSync(staged, { recursive: true });
      },
    };
  } catch (cause) {
    if (directory !== undefined) rmSync(directory, { recursive: true });
    if (
      cause instanceof UnsafeNativePayload ||
      cause instanceof LocalBwrapUnavailable
    )
      throw cause;
    throw new LocalBwrapUnavailable(
      "install",
      "Cannot copy verified native files into the private runtime directory; reinstall Fungi.",
      { cause },
    );
  }
}

export type NativePayloadStaging = ReturnType<
  typeof createNativePayloadStaging
>;
