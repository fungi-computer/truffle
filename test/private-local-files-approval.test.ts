import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { edit } from "@fungi.computer/knapsack";
import { afterEach, expect, it } from "vitest";
import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";

const message = "Read-only mode: switch to Workspace to edit";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(mode: "read-only" | "workspace") {
  const root = await mkdtemp(join(tmpdir(), "fungi-files-refusal-"));
  const database = new DatabaseSync(":memory:");
  cleanups.push(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: "local", id: "files-refusal" },
    now: Date.now,
  });
  const port = await createPrivateInvocationFilesPort(
    root,
    undefined,
    undefined,
    () => mode,
  );
  const context = (id: string) => ({
    executionId: id,
    deadlineAt: null,
    signal: new AbortController().signal,
  });
  return { root, database, ledger, port, context };
}

it.each(["patch", "edit", "write"] as const)(
  "Read-only Files %s refuses without touching files or staging an approval",
  async (kind) => {
    const { root, database, ledger, port, context } =
      await fixture("read-only");
    await writeFile(join(root, "note.txt"), "before\n");
    if (kind === "edit") {
      for (const path of ["note.txt", "missing.txt"])
        expect(
          await edit(
            port,
            { path, oldText: "before", newText: "after" },
            context(kind),
          ),
        ).toEqual({
          status: "failed",
          error: { kind: "read-only", path, message },
        });
    } else {
      if (port.patch === undefined) throw new Error("Native patch unavailable");
      const patch =
        kind === "write"
          ? "*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch\n"
          : "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch\n";
      await expect(port.patch({ patch }, context(kind))).rejects.toMatchObject({
        name: "ReadOnlyFilesRefusal",
        message,
      });
    }
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("before\n");
    await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    expect(ledger.pendingHandoffs()).toEqual([]);
    expect(
      database.prepare("SELECT count(*) AS total FROM approval_records").get(),
    ).toMatchObject({ total: 0 });
  },
);

it("Workspace edit and patch still write without creating an approval", async () => {
  const { root, database, ledger, port, context } = await fixture("workspace");
  await writeFile(join(root, "note.txt"), "before\n");
  expect(
    await edit(
      port,
      { path: "note.txt", oldText: "before", newText: "after" },
      context("edit"),
    ),
  ).toMatchObject({ path: "note.txt" });
  if (port.patch === undefined) throw new Error("Native patch unavailable");
  expect(
    await port.patch(
      {
        patch: "*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch\n",
      },
      context("write"),
    ),
  ).toMatchObject({ status: "completed" });
  expect(await readFile(join(root, "note.txt"), "utf8")).toBe("after\n");
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
  expect(ledger.pendingHandoffs()).toEqual([]);
  expect(
    database.prepare("SELECT count(*) AS total FROM approval_records").get(),
  ).toMatchObject({ total: 0 });
});
