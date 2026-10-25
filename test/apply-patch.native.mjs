import { directSandbox } from "@fungi.computer/mycelium/testing";
import { fauxModel } from "@fungi.computer/mule/testing";
import { z } from "zod";
import { Buffer } from "node:buffer";
const { AbortController, Response } = globalThis;
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
  symlink,
  link,
  rm,
  access,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Knapsack } from "@fungi.computer/knapsack";
import { Mycelium } from "@fungi.computer/mycelium";
import { Shiitake } from "@fungi.computer/shiitake";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createPrivateInvocationFilesPort } from "../dist/private-invocation-files.js";
import {
  createPrivateLocalTools,
  createPrivateLocalRuntimeHost,
} from "../dist/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../dist/private-sqlite-owner.js";
import { createLocalSandboxControls } from "../dist/private-local-sandbox.js";
import { verifyLocalLinuxSandboxPayload } from "../dist/private-local-bwrap.js";
import { nativeDigests } from "../dist/private-local-native-digests.js";
import { sandboxPolicy } from "../dist/private-local-sandbox-policy.js";

const context = () => ({
  executionId: "patch-proof",
  deadlineAt: null,
  signal: new AbortController().signal,
});
const patch = (...lines) =>
  ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

test(
  "packaged native launcher and patch helper in Agent authority are refused before execution",
  { skip: process.platform !== "linux" },
  async (t) => {
    const project = await mkdtemp(join(tmpdir(), "fungi-native-authority-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const folder = join(project, "agent");
    const bin = join(
      folder,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    await mkdir(bin, { recursive: true });
    for (const name of [
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-apply-patch",
    ])
      await copyFile(
        new URL(`../native/bin/${name}`, import.meta.url),
        join(bin, name),
      );
    // Only inspect the matching payload here: no Agent-controlled process starts.
    assert.throws(
      () =>
        verifyLocalLinuxSandboxPayload(
          join(bin, "fungi-bwrap"),
          sandboxPolicy(project, folder),
          nativeDigests[`${process.platform}-${process.arch}`],
        ),
      /Agent project/,
    );

    const previous = process.env.FUNGI_BUNDLED_CLI;
    try {
      process.env.FUNGI_BUNDLED_CLI = join(folder, "fungi.cjs");
      assert.throws(
        () =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            required: () => true,
          }),
        /Agent project/,
      );
      const optional = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        assert.throws(
          () => optional.launch(folder, ["/usr/bin/true"]),
          /Agent project/,
        );
      } finally {
        optional.close();
      }
    } finally {
      if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previous;
    }
    const controls = createLocalSandboxControls({
      project,
      folder: "agent",
      required: () => true,
    });
    t.after(() => controls.close());
    const linkedHelper = join(project, "linked-patch");
    await symlink(join(bin, "fungi-apply-patch"), linkedHelper);
    assert.throws(
      () => controls.launch(folder, [linkedHelper], linkedHelper),
      /Agent project/,
    );
    const siblingAgent = join(project, "sibling-agent");
    await mkdir(siblingAgent);
    const siblingHelper = join(siblingAgent, "fungi-apply-patch");
    await link(join(bin, "fungi-apply-patch"), siblingHelper);
    assert.throws(
      () => controls.launch(folder, [siblingHelper], siblingHelper),
      /Agent project/,
    );
    try {
      process.env.FUNGI_BUNDLED_CLI = join(folder, "fungi.cjs");
      const port = await createPrivateInvocationFilesPort(
        folder,
        undefined,
        controls,
      );
      assert.ok(port.patch);
      await assert.rejects(
        () =>
          port.patch(
            { patch: patch("*** Add File: should-not-exist", "+unsafe") },
            context(),
          ),
        /Agent project/,
      );
      await assert.rejects(access(join(folder, "should-not-exist")));
    } finally {
      if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previous;
    }
    console.log(
      "WRITABLE_NATIVE_PAYLOAD_REFUSED: launcher and Files helper never executed",
    );
  },
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fungi-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await createPrivateInvocationFilesPort(root);
  assert.ok(
    port.patch,
    "Run pnpm --filter @fungi.computer/truffle build:native first",
  );
  const surface = Knapsack.files({ port });
  assert.equal(surface.tools[0]?.descriptor.name, "apply_patch");
  return { root, port, surface };
}

async function direct(tool, text, id = "call_patch") {
  const prepared = await Effect.runPromise(
    tool.prepare({
      type: "toolCall",
      id,
      name: "apply_patch",
      arguments: { patch: text },
    }),
  );
  const parts = Array.from(
    await Effect.runPromise(Stream.runCollect(prepared.execute())),
  );
  assert.equal(parts.length, 1);
  return parts[0].result;
}

test(
  "packaged helper outside the project stays file-scoped and read-only",
  { skip: process.platform !== "linux" },
  async () => {
    const project = await mkdtemp(join(tmpdir(), "fungi-patch-project-"));
    // This regression must exercise Linux's private /tmp even when the caller
    // chooses an unmasked TMPDIR for its other test scratch.
    const prefix = await mkdtemp(join("/tmp", "fungi-patch-prefix-"));
    const folder = join(project, "agent");
    const bin = join(
      prefix,
      "node_modules",
      "@fungi.computer",
      `spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
    const executable = join(bin, "fungi-apply-patch");
    const sibling = join(bin, "private-sibling");
    const previous = process.env.FUNGI_BUNDLED_CLI;
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    const runtime = join(prefix, "runtime");
    let controls;
    try {
      await mkdir(folder);
      await mkdir(bin, { recursive: true });
      await mkdir(runtime, { mode: 0o700 });
      process.env.XDG_RUNTIME_DIR = runtime;
      // Install the real built payload at a separate npm-shaped prefix. Both
      // prefix and project are in /tmp, but only the selected folder is writable.
      for (const name of [
        "fungi-apply-patch",
        "fungi-bwrap",
        "fungi-seccomp.bpf",
      ]) {
        await copyFile(
          new URL(`../native/bin/${name}`, import.meta.url),
          join(bin, name),
        );
      }
      await writeFile(sibling, "private sibling\n");
      assert.equal(await readFile(sibling, "utf8"), "private sibling\n");
      const before = await readFile(executable);
      process.env.FUNGI_BUNDLED_CLI = join(prefix, "fungi.cjs");
      controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => true,
      });
      const port = await createPrivateInvocationFilesPort(
        folder,
        undefined,
        controls,
      );
      assert.ok(port.patch, "The installed native engine must be offered");
      const result = await direct(
        Knapsack.files({ port }).tools[0],
        patch(
          "*** Add File: sandboxed-patch.txt",
          "+native patch inside bwrap",
        ),
      );
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(
        await readFile(join(folder, "sandboxed-patch.txt"), "utf8"),
        "native patch inside bwrap\n",
      );
      assert.throws(
        () => controls.launch(folder, ["/usr/bin/true"], bin),
        /Packaged fungi-apply-patch is not a regular file/,
      );

      // Exercise the same file allowance with an OS read/write probe, not the
      // patch engine's own path checks. A directory bind would fail this test.
      const command = controls.launch(
        folder,
        [
          "/usr/bin/python3",
          "-c",
          [
            "import errno, os, pathlib, sys",
            "helper, sibling = map(pathlib.Path, sys.argv[1:])",
            "assert helper.read_bytes()[:4] == b'\\x7fELF'",
            "assert os.listdir(helper.parent) == [helper.name]",
            "assert not list(helper.parents[2].glob('payload-*/fungi-bwrap'))",
            "try: sibling.read_bytes()",
            "except FileNotFoundError: pass",
            "else: raise AssertionError('helper sibling became readable')",
            "try: helper.write_bytes(b'overwritten')",
            "except OSError as error: assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), error",
            "else: raise AssertionError('helper became writable')",
          ].join("\n"),
          executable,
          sibling,
        ],
        executable,
      );
      assert.ok(
        command?.seccompFilter,
        "No bare fallback may qualify this proof",
      );
      assert.ok(
        command.executable.startsWith(join(runtime, "fungi", "native")),
      );
      assert.notEqual(command.executable, join(bin, "fungi-bwrap"));
      const stagedLauncher = await stat(command.executable);
      assert.equal(stagedLauncher.nlink, 1);
      assert.equal(stagedLauncher.mode & 0o777, 0o500);
      assert.equal(
        (await stat(dirname(command.executable))).mode & 0o777,
        0o700,
      );
      // After admission a hardlink can still rewrite the installed inode.
      // Only the independently staged, checked bytes may be executed.
      const originalLauncher = await readFile(join(bin, "fungi-bwrap"));
      const rewriteAlias = join(folder, "launcher-hardlink");
      await link(join(bin, "fungi-bwrap"), rewriteAlias);
      await writeFile(rewriteAlias, "BENIGN_CHANGED_AFTER_ADMISSION");
      const filter = join(project, "filter.bpf");
      await writeFile(filter, command.seccompFilter);
      const fd = openSync(filter, "r");
      try {
        const probe = spawnSync(command.executable, [...command.args], {
          cwd: folder,
          env: command.environment,
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "pipe", fd],
        });
        assert.equal(probe.error, undefined);
        assert.equal(probe.status, 0, probe.stderr);
      } finally {
        closeSync(fd);
      }
      assert.throws(
        () => controls.launch(folder, ["/usr/bin/true"]),
        (cause) =>
          cause?.name === "LocalSandboxUnavailable" &&
          cause.reason?.kind === "digest-mismatch",
      );
      await writeFile(rewriteAlias, originalLauncher);
      assert.deepEqual(await readFile(executable), before);
      assert.equal(await readFile(sibling, "utf8"), "private sibling\n");
      await rm(executable);
      assert.throws(
        () => controls.launch(folder, [executable], executable),
        (cause) =>
          cause?.name === "LocalSandboxUnavailable" &&
          cause.reason?.kind === "missing-artifact",
      );
      console.log(
        "PACKAGED_HELPER_SANDBOX_OK: native patch; sibling hidden; helper read-only",
      );
    } finally {
      controls?.close();
      if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previous;
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      await rm(prefix, { recursive: true });
      await rm(project, { recursive: true });
    }
  },
);

test("direct and execute Files share native add/update/move/delete and preserve text", async (t) => {
  const { root, surface } = await fixture(t);
  const content = "quotes: ' \" ` $(touch should-not-exist) \\";
  const result = await direct(
    surface.tools[0],
    patch("*** Add File: nested/a.txt", `+${content}`),
  );
  assert.equal(result.isError, false);
  assert.equal(
    await readFile(join(root, "nested/a.txt"), "utf8"),
    content + "\n",
  );
  await assert.rejects(access(join(root, "should-not-exist")));
  await writeFile(join(root, "crlf.txt"), "before\r\ncontext\r\n");
  const text = patch(
    "*** Update File: crlf.txt",
    "*** Move to: moved.txt",
    "@@",
    "-before",
    "+after",
    " context",
    "*** Delete File: nested/a.txt",
  );
  const runtime = await Mycelium.make({
    modules: [surface.module],
    sandbox: directSandbox((bindings) => bindings.files.patch({ patch: text })),
  });
  const lease = await runtime.acquire();
  t.after(async () => {
    await lease.release();
    await runtime.close();
  });
  const prepared = await Effect.runPromise(
    lease.executeTool.prepare({
      type: "toolCall",
      id: "execute-patch",
      name: "execute",
      arguments: { code: "return await files.patch(...)" },
    }),
  );
  const parts = Array.from(
    await Effect.runPromise(Stream.runCollect(prepared.execute())),
  );
  assert.equal(JSON.parse(parts[0].result.content[0].text).status, "completed");
  assert.equal(
    await readFile(join(root, "moved.txt"), "utf8"),
    "after\r\ncontext\r\n",
  );
  await assert.rejects(access(join(root, "crlf.txt")));
  await assert.rejects(access(join(root, "nested/a.txt")));
});

test("native preflight rejects outside paths, move escapes, symlinks, oversized and mismatched edits", async (t) => {
  const { root, port } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "fungi-patch-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "keep.txt"), "original\n");
  await symlink(outside, join(root, "link"));
  await link(join(outside, "keep.txt"), join(root, "hardlink.txt"));
  await writeFile(join(root, "keep.txt"), "original\n");
  const attempts = [
    patch("*** Update File: hardlink.txt", "@@", "-original", "+modified"),
    patch(
      "*** Update File: keep.txt",
      "*** Move to: moved.txt",
      "@@",
      "-original",
      "+modified",
      "*** Add File: moved.txt",
      "+collision",
    ),
    patch(
      "*** Add File: should-not-write.txt",
      "+x",
      `*** Delete File: ${outside}/keep.txt`,
    ),
    patch(
      "*** Update File: keep.txt",
      `*** Move to: ${outside}/moved.txt`,
      "@@",
      "-original",
      "+modified",
    ),
    patch("*** Update File: link/keep.txt", "@@", "-original", "+modified"),
    patch("*** Add File: ../escape.txt", "+x"),
    patch(
      "*** Add File: should-not-write.txt",
      "+x",
      "*** Update File: keep.txt",
      "@@",
      "-mismatch",
      "+modified",
    ),
  ];
  for (const text of attempts) {
    const result = await port.patch({ patch: text }, context());
    assert.equal(result.status, "failed", result.stderr);
    assert.notEqual(result.stderr, "");
    if (text.includes("Update File: hardlink.txt")) {
      assert.match(result.stderr, /hardlink\.txt/u);
      assert.match(result.stderr, /private copy.*retry/u);
      assert.equal(
        await readFile(join(outside, "keep.txt"), "utf8"),
        "original\n",
      );
      assert.equal(
        await readFile(join(root, "hardlink.txt"), "utf8"),
        "original\n",
      );
    }
  }
  await assert.rejects(
    port.patch({ patch: "x".repeat(128 * 1024 + 1) }, context()),
    /128 KiB/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    port.patch(
      { patch: patch("*** Add File: cancelled.txt", "+x") },
      { executionId: "cancel", deadlineAt: null, signal: controller.signal },
    ),
  );
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "original\n");
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "original\n");
  await assert.rejects(access(join(root, "should-not-write.txt")));
  await assert.rejects(access(join(root, "cancelled.txt")));
});

test("unified diff without an Update File header gives an executable format example", async (t) => {
  const { root, surface } = await fixture(t);
  await writeFile(join(root, "retry.txt"), "old line\n");
  for (const text of [
    patch("@@ -1 +1 @@", "-old line", "+new line"),
    "--- a/retry.txt\n+++ b/retry.txt\n@@ -1 +1 @@\n-old line\n+new line\n",
  ]) {
    const result = await direct(surface.tools[0], text);
    assert.equal(result.isError, true);
    const failure = JSON.parse(result.content[0].text);
    const expected = patch(
      "*** Update File: path/to/file.txt",
      "@@",
      "-old line",
      "+new line",
    ).trimEnd();
    assert.ok(failure.stderr.includes(expected), failure.stderr);
    assert.match(failure.stderr, /Do not use unified-diff line numbers/u);
    assert.equal(failure.exitCode, 24);
    assert.equal(
      (failure.stderr.match(/Expected patch format:/gu) ?? []).length,
      1,
    );
    assert.equal(await readFile(join(root, "retry.txt"), "utf8"), "old line\n");
    const retry = await direct(
      surface.tools[0],
      expected.replace("path/to/file.txt", "retry.txt"),
    );
    assert.equal(retry.isError, false);
    assert.equal(await readFile(join(root, "retry.txt"), "utf8"), "new line\n");
    await writeFile(join(root, "retry.txt"), "old line\n");
  }
});

test("a mismatched hunk reports the file and nearby actual lines", async (t) => {
  const { root, port, surface } = await fixture(t);
  await writeFile(join(root, "mismatch.txt"), "alpha\nbeta\ngamma\n");
  const result = await port.patch(
    {
      patch: patch(
        "*** Update File: mismatch.txt",
        "@@",
        " alpha",
        "-beto",
        "+fixed",
        " gamma",
      ),
    },
    context(),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "mismatch");
  assert.match(result.stderr, /mismatch\.txt/u);
  assert.match(result.stderr, /Expected.*beto/su);
  assert.match(result.stderr, /2: beta/u);
  assert.match(
    result.stderr,
    /Expected patch format:[\s\S]*\*\*\* Begin Patch\n\*\*\* Update File: mismatch.txt\n@@\n-old line\n\+new line\n\*\*\* End Patch/u,
  );
  assert.doesNotMatch(result.stderr, /CorrectnessError|ComputeReplacements/u);
  const modelResult = await direct(
    surface.tools[0],
    patch("*** Update File: mismatch.txt", "@@", "-beto", "+fixed"),
    "mismatch-model-call",
  );
  assert.equal(JSON.parse(modelResult.content[0].text).error.kind, "mismatch");
  assert.equal(
    await readFile(join(root, "mismatch.txt"), "utf8"),
    "alpha\nbeta\ngamma\n",
  );
  await writeFile(join(root, "long.txt"), `${"a".repeat(1_000)}\n`);
  const long = await port.patch(
    {
      patch: patch(
        "*** Update File: long.txt",
        "@@",
        `-${"b".repeat(1_000)}`,
        "+fixed",
      ),
    },
    context(),
  );
  assert.equal(long.error?.kind, "mismatch");
  assert.ok(long.stderr.length < 1_000, "mismatch preview stays bounded");
  assert.match(long.stderr, /…/u);
});

test("unified diff without an Update File header returns the dialect and current hunk lines", async (t) => {
  const { root, port } = await fixture(t);
  await writeFile(join(root, "format.txt"), "one\nfresh value\nthree\n");
  const result = await port.patch(
    {
      patch: patch(
        "--- a/format.txt",
        "+++ b/format.txt",
        "@@ -2 +2 @@",
        "-stale value",
        "+new value",
      ),
    },
    context(),
  );
  assert.equal(result.status, "failed");
  assert.match(
    result.stderr,
    /Expected patch format:[\s\S]*\*\*\* Update File:/u,
  );
  assert.match(result.stderr, /2: fresh value/u);
  assert.equal(
    await readFile(join(root, "format.txt"), "utf8"),
    "one\nfresh value\nthree\n",
  );
  const bare = await port.patch(
    { patch: patch("@@", "-old", "+new") },
    context(),
  );
  assert.match(bare.stderr, /\*\*\* Begin Patch\n\*\*\* Update File:/u);
});

test("a later anchored hunk failure reports its current lines and can be retried", async (t) => {
  const { root, port } = await fixture(t);
  await writeFile(
    join(root, "anchors.txt"),
    "first\nsecond\nactual anchor\nvalue\n",
  );
  const rejected = await port.patch(
    {
      patch: patch(
        "*** Update File: anchors.txt",
        "@@",
        "-first",
        "+FIRST",
        "@@ stale anchor",
        "-value",
        "+VALUE",
      ),
    },
    context(),
  );
  assert.equal(rejected.error?.kind, "mismatch");
  assert.match(rejected.stderr, /3: actual anchor/u);
  assert.match(rejected.stderr, /4: value/u);
  assert.equal(
    await readFile(join(root, "anchors.txt"), "utf8"),
    "first\nsecond\nactual anchor\nvalue\n",
  );
  const retried = await port.patch(
    {
      patch: patch(
        "*** Update File: anchors.txt",
        "@@",
        "-first",
        "+FIRST",
        "@@ actual anchor",
        "-value",
        "+VALUE",
      ),
    },
    context(),
  );
  assert.equal(retried.status, "completed");
  assert.equal(
    await readFile(join(root, "anchors.txt"), "utf8"),
    "FIRST\nsecond\nactual anchor\nVALUE\n",
  );
});

test("unified diff diagnostics cannot read outside the invocation root", async (t) => {
  const { root, port } = await fixture(t);
  const outside = join(root, "..", "outside-preview.txt");
  await writeFile(outside, "OUTSIDE_FIXTURE_CONTENT\n");
  t.after(() => rm(outside, { force: true }));
  const rejected = await port.patch(
    {
      patch: [
        `--- ${outside}`,
        `+++ ${outside}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    },
    context(),
  );
  assert.equal(rejected.status, "failed");
  assert.doesNotMatch(rejected.stderr, /OUTSIDE_FIXTURE_CONTENT/u);
  assert.match(rejected.stderr, /outside.*root/u);
});

test("a small patch updates a file larger than the Files read bound", async (t) => {
  const { root, port } = await fixture(t);
  const path = join(root, "large.txt");
  const original = `BEFORE\n${"filler line\n".repeat(12_000)}`;
  assert.ok(Buffer.byteLength(original) > 128 * 1024);
  await writeFile(path, original);

  const result = await port.patch(
    { patch: patch("*** Update File: large.txt", "@@", "-BEFORE", "+AFTER") },
    context(),
  );

  assert.equal(result.status, "completed", result.stderr);
  assert.equal(
    await readFile(path, "utf8"),
    original.replace("BEFORE", "AFTER"),
  );
  assert.equal(result.truncated, false);
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);

  const oversizedDelete = await port.patch(
    { patch: patch("*** Delete File: large.txt") },
    context(),
  );
  assert.equal(oversizedDelete.status, "failed");
  assert.match(oversizedDelete.stderr, /128 KiB edit bound/);
  assert.equal(
    await readFile(path, "utf8"),
    original.replace("BEFORE", "AFTER"),
  );
});

test("actual Local Shiitake run exposes apply_patch and records its result", async (t) => {
  const { root } = await fixture(t);
  const tools = await createPrivateLocalTools(root);
  const faux = fauxModel([]);
  const next = Promise.withResolvers();
  faux.setResponses([
    (request) => {
      assert.ok(
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.toolsAdded?.some((tool) => tool.name === "apply_patch"),
        ),
      );
      return fauxAssistantMessage(
        fauxToolCall("apply_patch", {
          patch: patch("*** Add File: session.txt", "+durable tool result"),
        }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      next.resolve(request);
      return fauxAssistantMessage("done");
    },
  ]);
  const db = new DatabaseSync(join(root, "session.sqlite"));
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(db),
    extensions: tools.extensions,
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: async () => ({
        revision: "patch-test",
        text: "Apply the requested patch.",
      }),
    },
    model: {
      acquire: async () => ({
        model: faux.model,
        stream: faux.stream,
        release: () => Promise.resolve(),
      }),
    },
    tools: tools.tools,
  });
  try {
    await agent.session("patch-session").command({
      type: "prompt",
      requestId: "patch-request",
      delivery: "followUp",
      text: "Create session.txt",
    });
    const request = await next.promise;
    const result = request.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolName === "apply_patch",
    );
    assert.ok(result);
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).status, "completed");
    const snapshot = await agent.session("patch-session").read();
    assert.ok(
      snapshot.messages.some(
        (entry) =>
          entry.value.role === "toolResult" &&
          entry.value.toolName === "apply_patch",
      ),
    );
    assert.equal(
      await readFile(join(root, "session.txt"), "utf8"),
      "durable tool result\n",
    );
  } finally {
    await agent.close();
    db.close();
  }
});

test("installed OpenAI Pi adapter streams raw patch and replays matching custom result", async (t) => {
  const { root, surface } = await fixture(t);
  const provider = openaiProvider();
  const model = provider
    .getModels()
    .find((model) => model.id === "gpt-6-astra");
  assert.ok(model?.compat?.supportsOpenAIGrammarTools);
  const text = patch(
    "*** Add File: raw.txt",
    "+raw text reached the native engine",
  );
  const requests = [];
  const item = {
    type: "custom_tool_call",
    id: "ctc_patch",
    call_id: "call_patch",
    name: "apply_patch",
    input: text,
  };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_patch", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, input: "" },
    },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      delta: text.slice(0, 30),
    },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      delta: text.slice(30),
    },
    {
      type: "response.custom_tool_call_input.done",
      output_index: 0,
      input: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_patch",
        status: "completed",
        output: [item],
        usage,
      },
    },
  ];
  const token = [
    "synthetic",
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" },
      }),
    ).toString("base64url"),
    "synthetic",
  ].join(".");
  const options = {
    apiKey: token,
    transport: "sse",
    fetch: Object.assign(
      async (_url, init) => {
        const payload = z
          .union([z.string(), z.instanceof(Uint8Array)])
          .parse(init.body);
        const body =
          payload instanceof Uint8Array
            ? zstdDecompressSync(payload).toString("utf8")
            : payload;
        requests.push(JSON.parse(body));
        const selected =
          requests.length === 1
            ? events
            : [
                {
                  type: "response.completed",
                  response: {
                    id: "resp_done",
                    status: "completed",
                    output: [],
                    usage,
                  },
                },
              ];
        return new Response(
          selected
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      {
        preconnect: () => {
          throw new Error("No live network in patch proof");
        },
      },
    ),
  };
  const tool = surface.tools[0];
  const tools = {
    role: "system",
    content: "",
    toolsAdded: [tool.descriptor],
    timestamp: 0,
  };
  const first = await provider
    .streamSimple(model, { messages: [tools] }, options)
    .result();
  assert.equal(first.stopReason, "toolUse", JSON.stringify(first));
  assert.equal(requests[0].tools[0].type, "custom");
  const call = first.content.find((part) => part.type === "toolCall");
  assert.deepEqual(call.arguments, { patch: text });
  const result = await direct(tool, call.arguments.patch, call.id);
  const replay = await provider
    .streamSimple(
      model,
      {
        messages: [
          tools,
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            isError: result.isError,
            timestamp: Date.now(),
          },
        ],
      },
      options,
    )
    .result();
  assert.notEqual(replay.stopReason, "error", JSON.stringify(replay));
  assert.ok(
    requests[1].input.some(
      (item) =>
        item.type === "custom_tool_call" &&
        item.call_id === "call_patch" &&
        item.input === text,
    ),
  );
  assert.ok(
    requests[1].input.some(
      (item) =>
        item.type === "custom_tool_call_output" &&
        item.call_id === "call_patch",
    ),
  );
  await provider
    .streamSimple(
      {
        ...model,
        compat: { ...model.compat, supportsOpenAIGrammarTools: false },
      },
      { messages: [tools] },
      options,
    )
    .result();
  assert.equal(requests[2].tools[0].type, "function");
  assert.equal(
    await readFile(join(root, "raw.txt"), "utf8"),
    "raw text reached the native engine\n",
  );
});
