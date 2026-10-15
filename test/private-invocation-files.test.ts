import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type { InvocationContext } from "@fungi.computer/mycelium";
import { Knapsack, type FileToolName } from "@fungi.computer/knapsack";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `fungi-local-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function invocation(signal = new AbortController().signal): InvocationContext {
  return { executionId: "local-files-proof", deadlineAt: null, signal };
}

async function direct(
  root: string,
  name: FileToolName,
  args: { path: string; offset?: number; limit?: number; pattern?: string },
) {
  const surface = Knapsack.files({
    port: await createPrivateInvocationFilesPort(root),
  });
  const tool = surface.tools.find((entry) => entry.descriptor.name === name);
  if (tool === undefined) throw new Error(`Missing ${name}`);
  const prepared = await Effect.runPromise(
    tool.prepare({
      type: "toolCall",
      id: name,
      name,
      arguments: args,
    }),
  );
  const [part] = await Effect.runPromise(Stream.runCollect(prepared.execute()));
  if (part?.type !== "result") throw new Error("Missing direct result");
  const [content] = part.result.content;
  if (content?.type !== "text") throw new Error("Missing direct text");
  return z.unknown().parse(JSON.parse(content.text));
}

describe("private invocation Files port", () => {
  it("confines direct read-only calls to the captured root and pages or caps results", async () => {
    const root = await temporaryDirectory("direct-files");
    const outside = await temporaryDirectory("direct-outside");
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, join(root, "escape.txt"));
    await writeFile(join(root, "page.txt"), "abcdefghij");
    await writeFile(join(root, "one.txt"), "needle\nneedle\n");
    await writeFile(join(root, "two.txt"), "needle\n");
    for (const name of ["read", "list", "glob", "grep"] as const) {
      const args =
        name === "read"
          ? { path: "escape.txt", limit: 4 }
          : name === "list"
            ? { path: "../direct-outside" }
            : { path: outside, pattern: name === "glob" ? "*.txt" : "needle" };
      await expect(direct(root, name, args)).rejects.toThrow(
        "outside the invocation root",
      );
    }
    await expect(
      direct(root, "read", { path: "page.txt", limit: 4 }),
    ).resolves.toMatchObject({
      content: "abcd",
      nextOffset: 4,
      truncated: true,
    });
    const listed = z
      .object({ entries: z.array(z.unknown()), truncated: z.boolean() })
      .parse(await direct(root, "list", { path: ".", limit: 1 }));
    expect(listed.entries).toHaveLength(1);
    expect(listed.truncated).toBe(true);
    const globbed = z
      .object({ matches: z.array(z.unknown()), truncated: z.boolean() })
      .parse(
        await direct(root, "glob", {
          path: ".",
          pattern: "*.txt",
          limit: 1,
        }),
      );
    expect(globbed.matches).toHaveLength(1);
    expect(globbed.truncated).toBe(true);
    const grepped = z
      .object({ matches: z.array(z.unknown()), truncated: z.boolean() })
      .parse(
        await direct(root, "grep", {
          path: ".",
          pattern: "needle",
          limit: 1,
        }),
      );
    expect(grepped.matches).toHaveLength(1);
    expect(grepped.truncated).toBe(true);
  });

  it("reads bounded UTF-8 pages through relative, absolute, and in-root symlink paths", async () => {
    const root = await temporaryDirectory("files-read");
    const path = join(root, "page.txt");
    await writeFile(path, "abcédef");
    await symlink("page.txt", join(root, "page-link.txt"));
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.read({ path: "page.txt", offset: 0, limit: 4 }, invocation()),
    ).resolves.toEqual({
      path: "page.txt",
      content: "abc",
      offset: 0,
      nextOffset: 3,
      truncated: true,
    });
    await expect(
      port.read({ path, offset: 3, limit: 4 }, invocation()),
    ).resolves.toMatchObject({
      path,
      content: "éde",
      offset: 3,
      nextOffset: 7,
      truncated: true,
    });
    await expect(
      port.read({ path: "page-link.txt", offset: 7, limit: 4 }, invocation()),
    ).resolves.toMatchObject({
      path: "page-link.txt",
      content: "f",
      nextOffset: null,
      truncated: false,
    });
  });

  it("rejects relative, absolute, and symlink paths that resolve outside the captured root", async () => {
    const root = await temporaryDirectory("files-root");
    const outside = await temporaryDirectory("files-outside");
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(root, "escape.txt"));
    await symlink(outside, join(root, "escape-directory"));
    const port = await createPrivateInvocationFilesPort(root);

    for (const path of ["../outside.txt", outsideFile, "escape.txt"]) {
      await expect(
        port.read({ path, offset: 0, limit: 4 }, invocation()),
      ).rejects.toThrow("outside the invocation root");
    }
    await expect(
      port.glob(
        { path: "escape-directory", pattern: "*.txt", limit: 10 },
        invocation(),
      ),
    ).rejects.toThrow("outside the invocation root");
  });

  it("caps list, glob, and grep after collecting one truncation witness", async () => {
    const root = await temporaryDirectory("files-search");
    await mkdir(join(root, "nested"));
    await Promise.all([
      writeFile(join(root, "one.txt"), "needle one\nneedle two\n"),
      writeFile(join(root, "two.txt"), "Needle three\n"),
      writeFile(join(root, "nested", "three.txt"), "needle four\n"),
    ]);
    const port = await createPrivateInvocationFilesPort(root);

    const listed = await port.list({ path: ".", limit: 2 }, invocation());
    expect(listed.entries).toHaveLength(2);
    expect(listed.truncated).toBe(true);

    const globbed = await port.glob(
      { path: ".", pattern: "**/*.txt", limit: 2 },
      invocation(),
    );
    expect(globbed.matches).toHaveLength(2);
    expect(globbed.truncated).toBe(true);

    const grepped = await port.grep(
      {
        path: ".",
        pattern: "needle\\s+(one|two|three|four)",
        regex: true,
        ignoreCase: true,
        limit: 2,
      },
      invocation(),
    );
    expect(grepped.matches).toHaveLength(2);
    expect(grepped.matches.every(({ line }) => line > 0)).toBe(true);
    expect(grepped.truncated).toBe(true);
    await expect(
      port.grep(
        {
          path: ".",
          pattern: "(needle)\\1",
          regex: true,
          ignoreCase: false,
          limit: 2,
        },
        invocation(),
      ),
    ).rejects.toThrow("Files grep pattern is not supported by RE2");
  });

  it("greps one directly addressed regular file", async () => {
    const root = await temporaryDirectory("files-grep-file");
    await writeFile(join(root, "direct.txt"), "miss\nneedle here\n");
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.grep(
        {
          path: "direct.txt",
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({
      path: "direct.txt",
      matches: [{ path: "direct.txt", line: 2, text: "needle here" }],
      truncated: false,
    });
  });

  it("omits a terminal newline without hiding genuine blank lines", async () => {
    const root = await temporaryDirectory("files-grep-lines");
    await Promise.all([
      writeFile(join(root, "terminal.txt"), "alpha\n"),
      writeFile(join(root, "blank.txt"), "alpha\n\nomega\n"),
    ]);
    const port = await createPrivateInvocationFilesPort(root);
    const grepBlankLines = (path: string) =>
      port.grep(
        {
          path,
          pattern: "^$",
          regex: true,
          ignoreCase: false,
          limit: 10,
        },
        invocation(),
      );

    await expect(grepBlankLines("terminal.txt")).resolves.toEqual({
      path: "terminal.txt",
      matches: [],
      truncated: false,
    });
    await expect(grepBlankLines("blank.txt")).resolves.toEqual({
      path: "blank.txt",
      matches: [{ path: "blank.txt", line: 2, text: "" }],
      truncated: false,
    });
  });

  it("searches an explicitly addressed in-root directory symlink", async () => {
    const root = await temporaryDirectory("files-search-link");
    await mkdir(join(root, "target"));
    await writeFile(join(root, "target", "inside.txt"), "linked needle\n");
    await symlink("target", join(root, "linked"));
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.glob({ path: "linked", pattern: "*.txt", limit: 10 }, invocation()),
    ).resolves.toEqual({
      path: "linked",
      matches: [join("linked", "inside.txt")],
      truncated: false,
    });
    await expect(
      port.grep(
        {
          path: "linked",
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 10,
        },
        invocation(),
      ),
    ).resolves.toEqual({
      path: "linked",
      matches: [
        {
          path: join("linked", "inside.txt"),
          line: 1,
          text: "linked needle",
        },
      ],
      truncated: false,
    });
  });

  it("traverses logical directory aliases while stopping physical cycles", async () => {
    const root = await temporaryDirectory("files-search-aliases");
    await mkdir(join(root, "target"));
    await writeFile(join(root, "target", "inside.txt"), "inside\n");
    await Promise.all([
      symlink("target", join(root, "a")),
      symlink("target", join(root, "b")),
      symlink(".", join(root, "cycle")),
    ]);
    const port = await createPrivateInvocationFilesPort(root);

    const result = await port.glob(
      { path: ".", pattern: "**/*.txt", limit: 10 },
      invocation(),
    );

    expect(result.path).toBe(".");
    expect(result.matches.toSorted()).toEqual([
      join("a", "inside.txt"),
      join("b", "inside.txt"),
      join("target", "inside.txt"),
    ]);
    expect(result.truncated).toBe(false);
  });

  it("keeps useful directory grep results while reporting unreadable text coverage", async () => {
    const root = await temporaryDirectory("files-grep-incomplete");
    await Promise.all([
      writeFile(join(root, "00-oversized.txt"), Buffer.alloc(128 * 1_024 + 1)),
      writeFile(join(root, "01-invalid.txt"), Buffer.from([0xff])),
      writeFile(join(root, "99-match.txt"), "a useful needle\n"),
    ]);
    await writeFile(join(root, "02-unreadable.txt"), "unreadable needle\n");
    await chmod(join(root, "02-unreadable.txt"), 0o000);
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.grep(
        {
          path: ".",
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({
      path: ".",
      matches: [{ path: "99-match.txt", line: 1, text: "a useful needle" }],
      truncated: true,
    });
  });

  it("keeps direct oversized, invalid UTF-8, and unreadable failures explicit", async () => {
    const root = await temporaryDirectory("files-grep-direct-failures");
    await Promise.all([
      writeFile(join(root, "oversized.txt"), Buffer.alloc(128 * 1_024 + 1)),
      writeFile(join(root, "invalid.txt"), Buffer.from([0xff])),
      writeFile(join(root, "unreadable.txt"), "needle\n"),
    ]);
    await chmod(join(root, "unreadable.txt"), 0o000);
    const port = await createPrivateInvocationFilesPort(root);
    const grep = (path: string) =>
      port.grep(
        {
          path,
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 10,
        },
        invocation(),
      );

    await expect(grep("oversized.txt")).rejects.toThrow(
      "Files path exceeds the 131072-byte bound",
    );
    await expect(grep("invalid.txt")).rejects.toThrow(
      "Files path is not valid UTF-8",
    );
    await expect(grep("unreadable.txt")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("reports incomplete glob and grep coverage when candidate work is exhausted", async () => {
    const root = await temporaryDirectory("files-scan-candidates");
    await Promise.all(
      Array.from({ length: 257 }, async (_, index) =>
        writeFile(join(root, `${String(index).padStart(3, "0")}.txt`), ""),
      ),
    );
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.glob(
        { path: ".", pattern: "never-match", limit: 256 },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", matches: [], truncated: true });
    await expect(
      port.grep(
        {
          path: ".",
          pattern: "never-match",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", matches: [], truncated: true });
  });

  it("reports incomplete grep coverage when aggregate read work is exhausted", async () => {
    const root = await temporaryDirectory("files-scan-bytes");
    const content = Buffer.alloc(70 * 1_024, "x");
    await Promise.all([
      writeFile(join(root, "one.txt"), content),
      writeFile(join(root, "two.txt"), content),
    ]);
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.grep(
        {
          path: ".",
          pattern: "never-match",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", matches: [], truncated: true });
  });

  it("observes cancellation before bounded list, glob, and grep work", async () => {
    const root = await temporaryDirectory("files-abort-enumeration");
    await writeFile(join(root, "one.txt"), "needle\n");
    const port = await createPrivateInvocationFilesPort(root);
    const aborted = AbortSignal.abort(new Error("synthetic Files abort"));

    await expect(
      port.list({ path: ".", limit: 1 }, invocation(aborted)),
    ).rejects.toThrow("synthetic Files abort");
    await expect(
      port.glob({ path: ".", pattern: "*.txt", limit: 1 }, invocation(aborted)),
    ).rejects.toThrow("synthetic Files abort");
    await expect(
      port.grep(
        {
          path: ".",
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 1,
        },
        invocation(aborted),
      ),
    ).rejects.toThrow("synthetic Files abort");
  });

  it("rejects unsupported filesystem nodes in a shallow list", async () => {
    const root = await temporaryDirectory("files-list-socket");
    const socketPath = join(root, "unsupported.sock");
    const server = createServer();
    const listening = Promise.withResolvers<undefined>();
    server.once("error", listening.reject);
    server.listen(socketPath, () => {
      listening.resolve(undefined);
    });
    await listening.promise;
    const port = await createPrivateInvocationFilesPort(root);

    try {
      await expect(
        port.grep(
          {
            path: "unsupported.sock",
            pattern: "needle",
            regex: false,
            ignoreCase: false,
            limit: 10,
          },
          invocation(),
        ),
      ).rejects.toThrow("Files path is not a file or directory");
      await expect(
        port.list({ path: ".", limit: 10 }, invocation()),
      ).rejects.toThrow("Files path has an unsupported filesystem type");
    } finally {
      await new Promise<undefined>((resolveClose) => {
        server.close(() => {
          resolveClose(undefined);
        });
      });
    }
  });

  it("preserves an in-root symlink and target mode during atomic replacement", async () => {
    const root = await temporaryDirectory("files-replace-link");
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "before");
    await chmod(target, 0o640);
    await symlink("target.txt", link);
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      port.replace(
        { path: "link.txt", expectedContent: "before", content: "after" },
        invocation(),
      ),
    ).resolves.toEqual({ path: "link.txt", bytes: 5 });
    await expect(readFile(target, "utf8")).resolves.toBe("after");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const listed = await port.list({ path: ".", limit: 10 }, invocation());
    expect(listed.entries.find(({ name }) => name === "link.txt")?.type).toBe(
      "symlink",
    );
  });

  it("reports an observed external edit conflict without overwriting it", async () => {
    const root = await temporaryDirectory("files-external-edit");
    const path = join(root, "target.txt");
    await writeFile(path, "observed");
    const port = await createPrivateInvocationFilesPort(root);
    await writeFile(path, "external");

    await expect(
      port.replace(
        {
          path: "target.txt",
          expectedContent: "observed",
          content: "replacement",
        },
        invocation(),
      ),
    ).rejects.toMatchObject({
      name: "FilesEditError",
      reason: "conflict",
      path: "target.txt",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("external");
  });

  it("serializes this host's competing replacements and exposes one whole file", async () => {
    const root = await temporaryDirectory("files-serialized-edit");
    const path = join(root, "target.txt");
    await writeFile(path, "before");
    const port = await createPrivateInvocationFilesPort(root);

    const replacements = await Promise.allSettled([
      port.replace(
        { path: "target.txt", expectedContent: "before", content: "first" },
        invocation(),
      ),
      port.replace(
        { path: "target.txt", expectedContent: "before", content: "second" },
        invocation(),
      ),
    ]);

    expect(
      replacements.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      replacements.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(path, "utf8"));
  });

  it("does not start an already-aborted replacement", async () => {
    const root = await temporaryDirectory("files-abort-replace");
    const path = join(root, "target.txt");
    await writeFile(path, "before");
    const port = await createPrivateInvocationFilesPort(root);
    const aborted = AbortSignal.abort(new Error("synthetic replace abort"));

    await expect(
      port.replace(
        { path: "target.txt", expectedContent: "before", content: "after" },
        invocation(aborted),
      ),
    ).rejects.toThrow("synthetic replace abort");
    await expect(readFile(path, "utf8")).resolves.toBe("before");
  });
});
