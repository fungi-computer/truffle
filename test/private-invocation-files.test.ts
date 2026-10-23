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
import { PhotonImage } from "@cf-wasm/photon/node";
import type { InvocationContext } from "@fungi.computer/mycelium";
import {
  Knapsack,
  listInputSchema,
  globInputSchema,
  grepInputSchema,
  type FileToolName,
} from "@fungi.computer/knapsack";
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

/** The real schema fills the defaults a model leaves out. */
function listIn(
  port: Awaited<ReturnType<typeof createPrivateInvocationFilesPort>>,
  input: z.input<typeof listInputSchema>,
  context: InvocationContext,
) {
  return port.list(listInputSchema.parse(input), context);
}

function globIn(
  port: Awaited<ReturnType<typeof createPrivateInvocationFilesPort>>,
  input: z.input<typeof globInputSchema>,
  context: InvocationContext,
) {
  return port.glob(globInputSchema.parse(input), context);
}

function grepIn(
  port: Awaited<ReturnType<typeof createPrivateInvocationFilesPort>>,
  input: z.input<typeof grepInputSchema>,
  context: InvocationContext,
) {
  return port.grep(grepInputSchema.parse(input), context);
}

async function directText(
  root: string,
  name: FileToolName,
  args: {
    path: string;
    offset?: number;
    limit?: number;
    pattern?: string;
    include?: string;
  },
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
  return content.text;
}

async function direct(
  root: string,
  name: "read",
  args: { path: string; offset?: number; limit?: number },
) {
  return z.unknown().parse(JSON.parse(await directText(root, name, args)));
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
    const outsideCalls: readonly [
      FileToolName,
      Parameters<typeof directText>[2],
    ][] = [
      ["read", { path: "escape.txt", limit: 4 }],
      ["list", { path: "../direct-outside" }],
      ["glob", { path: outside, pattern: "*.txt" }],
      ["grep", { path: outside, pattern: "needle" }],
    ];
    for (const [name, args] of outsideCalls) {
      await expect(directText(root, name, args)).rejects.toThrow(
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
    const listed = await directText(root, "list", { path: ".", limit: 1 });
    expect(listed.split("\n")).toHaveLength(2);
    expect(listed).toContain("[truncated: result limit reached");
    const globbed = await directText(root, "glob", {
      path: ".",
      pattern: "*.txt",
      limit: 1,
    });
    expect(globbed.split("\n")).toHaveLength(2);
    expect(globbed).toContain("[truncated: result limit reached");
    const grepped = await directText(root, "grep", {
      path: ".",
      pattern: "needle",
      limit: 1,
    });
    expect(grepped.split("\n")).toHaveLength(2);
    expect(grepped).toMatch(/^[a-z]+\.txt:1: needle\n\[truncated/u);
  });

  it("shrinks png, jpeg, gif and webp files to JPEG image parts and refuses broken or oversized images", async () => {
    const root = await temporaryDirectory("files-image");
    const port = await createPrivateInvocationFilesPort(root);
    // Banded noise: busy enough to stay above 512 KiB as a PNG, smooth
    // enough to fit the budget at 512 px.
    const pixels = new Uint8Array(1_200 * 900 * 4);
    for (let index = 0; index < pixels.length; index += 1)
      pixels[index] =
        index % 4 === 3
          ? 255
          : (Math.floor(index / 4 / 1_200) * 37 +
              (index % 4) * 91 +
              ((index * 13) % 7)) %
            256;
    const source = new PhotonImage(pixels, 1_200, 900);
    const images = {
      "a.png": source.get_bytes(),
      "b.jpg": source.get_bytes_jpeg(95),
      "c.gif": Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
      "d.webp": source.get_bytes_webp(),
    };
    source.free();
    // Above the 512 KiB the model may receive: only the shrink makes it readable.
    expect(images["a.png"].byteLength).toBeGreaterThan(512 * 1_024);
    for (const [name, bytes] of Object.entries(images)) {
      await writeFile(join(root, name), bytes);
      const read = await port.read(
        { path: name, offset: 0, limit: 4 },
        invocation(),
      );
      if (!("image" in read)) throw new Error(`${name} was not an image`);
      expect(read.image.mimeType).toBe("image/jpeg");
      expect(read.image.bytes).toBeLessThanOrEqual(100 * 1_024);
      const fitted = PhotonImage.new_from_byteslice(
        Buffer.from(read.image.data, "base64"),
      );
      expect(Math.max(fitted.get_width(), fitted.get_height())).toBe(
        name === "c.gif" ? 1 : 512,
      );
      fitted.free();
    }
    await writeFile(join(root, "gif.txt"), "GIF8 is the start of this text");
    await expect(
      port.read({ path: "gif.txt", offset: 0, limit: 4 }, invocation()),
    ).resolves.toMatchObject({ content: "GIF8", truncated: true });
    const result = await direct(root, "read", { path: "a.png", limit: 4 });
    expect(result).toMatchObject({ mimeType: "image/jpeg" });
    const signature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(
      join(root, "broken.png"),
      Buffer.concat([signature, Buffer.alloc(64)]),
    );
    await expect(
      port.read({ path: "broken.png", offset: 0, limit: 4 }, invocation()),
    ).rejects.toThrow(
      "Image broken.png could not be decoded. Refusing to read it.",
    );
    await writeFile(
      join(root, "big.png"),
      Buffer.concat([signature, Buffer.alloc(16 * 1_024 * 1_024)]),
    );
    await expect(
      port.read({ path: "big.png", offset: 0, limit: 4 }, invocation()),
    ).rejects.toThrow(
      `Image big.png is ${String(16 * 1_024 * 1_024 + 8)} bytes; the read limit is ${String(16 * 1_024 * 1_024)} bytes. Refusing to read it.`,
    );
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
      globIn(
        port,
        { path: "escape-directory", pattern: "*.txt", limit: 10 },
        invocation(),
      ),
    ).rejects.toThrow("outside the invocation root");
  });

  it("caps one-level, name and content searches after collecting one truncation witness", async () => {
    const root = await temporaryDirectory("files-search");
    await mkdir(join(root, "nested"));
    await Promise.all([
      writeFile(join(root, "one.txt"), "needle one\nneedle two\n"),
      writeFile(join(root, "two.txt"), "Needle three\n"),
      writeFile(join(root, "nested", "three.txt"), "needle four\n"),
    ]);
    const port = await createPrivateInvocationFilesPort(root);

    const listed = await listIn(port, { path: ".", limit: 2 }, invocation());
    expect(listed.results).toHaveLength(2);
    expect(listed.truncated).toBe("limit");

    const globbed = await globIn(
      port,
      { path: ".", pattern: "**/*.txt", limit: 2 },
      invocation(),
    );
    expect(globbed.results).toHaveLength(2);
    expect(globbed.truncated).toBe("limit");

    const grepped = await grepIn(
      port,
      {
        path: ".",
        pattern: "needle\\s+(one|two|three|four)",
        regex: true,
        ignoreCase: true,
        limit: 2,
      },
      invocation(),
    );
    expect(grepped.results).toHaveLength(2);
    expect(grepped.results.every(({ line }) => (line ?? 0) > 0)).toBe(true);
    expect(grepped.truncated).toBe("limit");
    await expect(
      grepIn(
        port,
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
      grepIn(
        port,
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
      results: [{ path: "direct.txt", line: 2, text: "needle here" }],
      truncated: null,
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
      grepIn(
        port,
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
      results: [],
      truncated: null,
    });
    await expect(grepBlankLines("blank.txt")).resolves.toEqual({
      path: "blank.txt",
      results: [{ path: "blank.txt", line: 2, text: "" }],
      truncated: null,
    });
  });

  it("searches an explicitly addressed in-root directory symlink", async () => {
    const root = await temporaryDirectory("files-search-link");
    await mkdir(join(root, "target"));
    await writeFile(join(root, "target", "inside.txt"), "linked needle\n");
    await symlink("target", join(root, "linked"));
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      globIn(
        port,
        { path: "linked", pattern: "*.txt", limit: 10 },
        invocation(),
      ),
    ).resolves.toEqual({
      path: "linked",
      results: [{ path: join("linked", "inside.txt"), type: "file" }],
      truncated: null,
    });
    await expect(
      grepIn(
        port,
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
      results: [
        {
          path: join("linked", "inside.txt"),
          line: 1,
          text: "linked needle",
        },
      ],
      truncated: null,
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

    const result = await globIn(
      port,
      { path: ".", pattern: "**/*.txt", limit: 10 },
      invocation(),
    );

    expect(result.path).toBe(".");
    expect(result.results.map(({ path }) => path).toSorted()).toEqual([
      join("a", "inside.txt"),
      join("b", "inside.txt"),
      join("target", "inside.txt"),
    ]);
    expect(result.truncated).toBeNull();
  });

  it("keeps useful directory grep results past oversized, invalid and unreadable files without calling that truncation", async () => {
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
      grepIn(
        port,
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
      results: [{ path: "99-match.txt", line: 1, text: "a useful needle" }],
      truncated: null,
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
      grepIn(
        port,
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

  it("truncated is true when the scan's candidate bound cuts glob and grep", async () => {
    const root = await temporaryDirectory("files-scan-candidates");
    await Promise.all(
      Array.from({ length: 11 }, async (_, index) =>
        writeFile(join(root, `${String(index).padStart(3, "0")}.txt`), ""),
      ),
    );
    const port = await createPrivateInvocationFilesPort(root, {
      candidates: 10,
      bytes: 1_024,
    });

    await expect(
      globIn(
        port,
        { path: ".", pattern: "never-match", limit: 256 },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", results: [], truncated: "scan" });
    await expect(
      grepIn(
        port,
        {
          path: ".",
          pattern: "never-match",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", results: [], truncated: "scan" });
  });

  it("truncated is true when the scan's byte bound cuts grep", async () => {
    const root = await temporaryDirectory("files-scan-bytes");
    const content = Buffer.alloc(70, "x");
    await Promise.all([
      writeFile(join(root, "one.txt"), content),
      writeFile(join(root, "two.txt"), content),
    ]);
    const port = await createPrivateInvocationFilesPort(root, {
      candidates: 100,
      bytes: 100,
    });

    await expect(
      grepIn(
        port,
        {
          path: ".",
          pattern: "never-match",
          regex: false,
          ignoreCase: false,
          limit: 256,
        },
        invocation(),
      ),
    ).resolves.toEqual({ path: ".", results: [], truncated: "scan" });
  });

  it("truncated is false when every result fits and no scan bound is hit", async () => {
    const root = await temporaryDirectory("files-not-truncated");
    await writeFile(join(root, "a.txt"), "needle\n");
    await writeFile(join(root, "b.txt"), "needle\n");
    const port = await createPrivateInvocationFilesPort(root);

    await expect(
      listIn(port, { path: ".", limit: 2 }, invocation()),
    ).resolves.toMatchObject({ truncated: null });
    await expect(
      globIn(port, { path: ".", pattern: "*.txt", limit: 2 }, invocation()),
    ).resolves.toMatchObject({ truncated: null });
    await expect(
      grepIn(
        port,
        {
          path: ".",
          pattern: "needle",
          regex: false,
          ignoreCase: false,
          limit: 2,
        },
        invocation(),
      ),
    ).resolves.toMatchObject({ truncated: null });
  });

  describe("find in a real repository", () => {
    async function repository() {
      const root = await temporaryDirectory("files-real-repo");
      await mkdir(join(root, ".git", "objects"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "needle ref\n");
      await writeFile(join(root, ".gitignore"), "node_modules/\n*.log\n");
      await mkdir(join(root, "node_modules", "dep"), { recursive: true });
      await Promise.all(
        Array.from({ length: 300 }, async (_, index) =>
          writeFile(
            join(root, "node_modules", "dep", `file-${String(index)}.js`),
            "needle in dependency\n",
          ),
        ),
      );
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "target.ts"), "const needle = 1;\n");
      await writeFile(join(root, "src", "other.md"), "a needle in prose\n");
      await writeFile(join(root, "src", "debug.log"), "needle log\n");
      return await createPrivateInvocationFilesPort(root);
    }
    const paths = (found: { results: readonly { path: string }[] }) =>
      found.results.map(({ path }) => path).toSorted();

    it("lists one level without search arguments", async () => {
      const port = await repository();

      const root = await listIn(port, { path: "." }, invocation());
      expect(root).toMatchObject({ path: ".", truncated: null });
      expect(root.results).toEqual(
        expect.arrayContaining([
          { path: ".gitignore", type: "file" },
          { path: "src", type: "directory" },
        ]),
      );
      expect(paths(root)).toEqual([".gitignore", "src"]);
      expect(paths(await listIn(port, { path: "src" }, invocation()))).toEqual([
        "src/other.md",
        "src/target.ts",
      ]);
    });

    it("globs paths from the root", async () => {
      const port = await repository();

      await expect(
        globIn(port, { path: ".", pattern: "**/*.ts" }, invocation()),
      ).resolves.toEqual({
        path: ".",
        results: [{ path: "src/target.ts", type: "file" }],
        truncated: null,
      });
    });

    it("greps a string past a 300-file gitignored tree", async () => {
      const port = await repository();

      const found = await grepIn(
        port,
        { path: ".", pattern: "needle" },
        invocation(),
      );

      expect(found.results).toEqual(
        expect.arrayContaining([
          { path: "src/target.ts", line: 1, text: "const needle = 1;" },
        ]),
      );
      expect(paths(found)).toEqual(["src/other.md", "src/target.ts"]);
      expect(found.truncated).toBeNull();
    });

    it("narrows grep matches with an include glob", async () => {
      const port = await repository();

      await expect(
        grepIn(
          port,
          { path: ".", include: "**/*.md", pattern: "needle" },
          invocation(),
        ),
      ).resolves.toEqual({
        path: ".",
        results: [{ path: "src/other.md", line: 1, text: "a needle in prose" }],
        truncated: null,
      });
    });

    it("never returns gitignored or .git entries from any mode", async () => {
      const port = await repository();

      for (const found of [
        await listIn(port, { path: "." }, invocation()),
        await globIn(port, { path: ".", pattern: "**" }, invocation()),
        await grepIn(port, { path: ".", pattern: "needle" }, invocation()),
        await grepIn(
          port,
          { path: ".", include: "**/*.log", pattern: "needle" },
          invocation(),
        ),
      ]) {
        expect(
          found.results.filter(
            ({ path }) =>
              path.startsWith(".git/") ||
              path === ".git" ||
              path.includes("node_modules") ||
              path.endsWith(".log"),
          ),
        ).toEqual([]);
      }
    });

    it("honors nested .gitignore files, negation and subdirectory starts", async () => {
      const root = await temporaryDirectory("files-nested-ignore");
      await mkdir(join(root, "pkg", "build"), { recursive: true });
      await writeFile(join(root, ".gitignore"), "*.tmp\n");
      await writeFile(join(root, "pkg", ".gitignore"), "build/\n!keep.tmp\n");
      await writeFile(join(root, "pkg", "build", "out.txt"), "needle\n");
      await writeFile(join(root, "pkg", "drop.tmp"), "needle\n");
      await writeFile(join(root, "pkg", "keep.tmp"), "needle\n");
      await writeFile(join(root, "pkg", "src.txt"), "needle\n");
      const port = await createPrivateInvocationFilesPort(root);

      const found = await grepIn(
        port,
        { path: "pkg", pattern: "needle" },
        invocation(),
      );

      expect(paths(found)).toEqual(["pkg/keep.tmp", "pkg/src.txt"]);
    });

    it("caps long matching lines at 500 characters in the tool output", async () => {
      const root = await temporaryDirectory("files-long-line");
      await writeFile(join(root, "wide.txt"), `needle ${"x".repeat(900)}\n`);

      const text = await directText(root, "grep", {
        path: ".",
        pattern: "needle",
      });

      expect(text).toBe(`wide.txt:1: needle ${"x".repeat(493)}…`);
    });
  });

  it("observes cancellation before bounded list, glob, and grep work", async () => {
    const root = await temporaryDirectory("files-abort-enumeration");
    await writeFile(join(root, "one.txt"), "needle\n");
    const port = await createPrivateInvocationFilesPort(root);
    const aborted = AbortSignal.abort(new Error("synthetic Files abort"));

    await expect(
      listIn(port, { path: ".", limit: 1 }, invocation(aborted)),
    ).rejects.toThrow("synthetic Files abort");
    await expect(
      globIn(
        port,
        { path: ".", pattern: "*.txt", limit: 1 },
        invocation(aborted),
      ),
    ).rejects.toThrow("synthetic Files abort");
    await expect(
      grepIn(
        port,
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
        grepIn(
          port,
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
        listIn(port, { path: ".", limit: 10 }, invocation()),
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
    const listed = await listIn(port, { path: ".", limit: 10 }, invocation());
    expect(listed.results.find(({ path }) => path === "link.txt")?.type).toBe(
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
