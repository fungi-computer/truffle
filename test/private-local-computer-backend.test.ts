import { expect, it } from "vitest";
import {
  FolderCwdError,
  FolderPathMap,
  FolderWorkspaceRpc,
  type ComputerdWorkspaceRpc,
} from "../src/private-local-computer-backend.js";

const root = "/home/member/project";

it("maps only the folder and /workspace onto each other", () => {
  const paths = new FolderPathMap(root);
  expect(paths.toComputer(root)).toBe("/workspace");
  expect(paths.toComputer(`${root}/src/a.ts`)).toBe("/workspace/src/a.ts");
  // The folder's ancestors and siblings never reach the Hub.
  expect(paths.toComputer("/home/member")).toBeUndefined();
  expect(paths.toComputer("/home/member/project-other/x")).toBeUndefined();
  expect(paths.toLocal("/workspace")).toBe(root);
  expect(paths.toLocal("/workspace/src/a.ts")).toBe(`${root}/src/a.ts`);
  expect(paths.toLocal("/workspace/../etc/passwd")).toBeUndefined();
  expect(paths.toLocal("/notes.md")).toBeUndefined();
});

function entries<T>(values: readonly T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

it("translates sync entries both ways and drops what is outside the folder", async () => {
  const pushed: string[] = [];
  const remote: ComputerdWorkspaceRpc = {
    sync: {
      push: async (input) => {
        for (const entry of await collect(input.changes))
          pushed.push(entry.path);
        return { rev: 2, appliedPushCursor: { rev: 1, path: null } };
      },
      fetchChanges: (input) => {
        expect(input.after).toEqual({ rev: 3, path: `${root}/a.txt` });
        return Promise.resolve({
          currentCursor: { rev: 4, path: null },
          appliedPushCursor: { rev: 1, path: null },
          stream: entries([
            { kind: "dir" as const, rev: 1, path: "/home", mode: 0, mtime: 0 },
            { kind: "delete" as const, rev: 4, path: `${root}/b.txt` },
          ]),
        });
      },
      watermarks: () =>
        Promise.resolve({
          currentRev: 4,
          pushRev: 0,
          fetchCursor: { rev: 1, path: null },
        }),
      readEntry: () => Promise.resolve(null),
      hasObjects: (hashes) => Promise.resolve(hashes),
      fetchObjects: () => Promise.resolve(entries([])),
      pushObjects: () => Promise.resolve(),
    },
    shell: {
      exec: (input) =>
        Promise.resolve({ id: input.cwd ?? "none", events: entries([]) }),
      getExec: (input) =>
        Promise.resolve({ id: input.id, events: entries([]) }),
      killExec: () => Promise.resolve(),
      disposeExec: () => Promise.resolve(),
    },
  };
  const folder = new FolderWorkspaceRpc(remote, root);
  await folder.sync.push({
    senderRev: 1,
    changes: entries([
      { kind: "delete" as const, rev: 1, path: "/workspace/c.txt" },
      { kind: "delete" as const, rev: 1, path: "/outside.txt" },
    ]),
  });
  expect(pushed).toEqual([`${root}/c.txt`]);
  const fetched = await folder.sync.fetchChanges({
    after: { rev: 3, path: "/workspace/a.txt" },
  });
  expect((await collect(fetched.stream)).map(({ path }) => path)).toEqual([
    "/workspace/b.txt",
  ]);
  expect(
    (await folder.shell.exec({ source: "pwd", cwd: "/workspace/src" })).id,
  ).toBe(`${root}/src`);
  await expect(
    folder.shell.exec({ source: "pwd", cwd: "/etc" }),
  ).rejects.toThrow(FolderCwdError);
});
