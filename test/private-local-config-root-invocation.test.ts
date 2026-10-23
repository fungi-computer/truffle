import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPrivateInvocationComputer } from "../src/private-invocation-computer.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";

it.each(["at construction", "by injection"])(
  "keeps a Computer's selected home A when ambient HOME changes to B before exec (%s)",
  async (selection) => {
    const temporary = await mkdtemp(join(tmpdir(), "fungi-config-root-"));
    const previousHome = process.env.HOME;
    const homeA = join(temporary, "a");
    const homeB = join(temporary, "b");
    const project = join(temporary, "project");
    await Promise.all([homeA, homeB, project].map((path) => mkdir(path)));
    try {
      process.env.HOME = homeA;
      const selected = capturePrivateLocalConfigRoot();
      if (selection === "by injection") process.env.HOME = homeB;
      // This is the real constructor used by createPrivateLocalTools. PATH and
      // the invocation Files jail are separate from the selected host home.
      const computer = await createPrivateInvocationComputer(
        project,
        "/usr/bin:/bin",
        undefined,
        selection === "by injection" ? selected.home : undefined,
      );
      process.env.HOME = homeB;
      const result = z
        .object({ exitCode: z.number(), stdout: z.string() })
        .parse(
          await computer.call(
            "exec",
            {
              executable: process.execPath,
              args: [
                "-e",
                // Refuse any non-disposable HOME even if the implementation
                // regresses: this proof must never write to a person's home.
                `const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
if (!process.argv.slice(1).includes(home)) throw new Error("Not a disposable home");
fs.writeFileSync(path.join(home, "selected"), "selected");
process.stdout.write(home);`,
                homeA,
                homeB,
              ],
            },
            {
              executionId: "config-root-proof",
              deadlineAt: null,
              signal: new AbortController().signal,
            },
          ),
        );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(homeA);
      expect(await readFile(join(homeA, "selected"), "utf8")).toBe("selected");
      await expect(access(join(homeB, "selected"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it("keeps a managed background process in selected home A after ambient HOME becomes B", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "fungi-config-background-"));
  const previousHome = process.env.HOME;
  const homeA = join(temporary, "a");
  const homeB = join(temporary, "b");
  const project = join(temporary, "project");
  const selected = capturePrivateLocalConfigRoot(homeA);
  // Construct under B to prove injection, not just capture of the ambient home.
  process.env.HOME = homeB;
  const processes = createPrivateLocalComputerProcesses(project, selected.home);
  try {
    await Promise.all([homeA, homeB, project].map((path) => mkdir(path)));
    const computer = await createPrivateInvocationComputer(
      project,
      "/usr/bin:/bin",
      processes.scope("selected-root"),
      selected.home,
    );
    const context = {
      executionId: "config-background-proof",
      deadlineAt: null,
      signal: new AbortController().signal,
    };
    const started = z.object({ process: z.object({ id: z.string() }) }).parse(
      await computer.call(
        "exec",
        {
          operation: "start",
          executable: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
if (!process.argv.slice(1).includes(home)) throw new Error("Not a disposable home");
fs.writeFileSync(path.join(home, "selected"), "selected");
process.stdout.write(home);`,
            homeA,
            homeB,
          ],
        },
        context,
      ),
    );
    const waited = z
      .object({
        timedOut: z.boolean(),
        process: z.object({ exitCode: z.number().nullable() }),
      })
      .parse(
        await computer.call(
          "exec",
          {
            operation: "wait",
            id: started.process.id,
            timeoutMs: 5_000,
          },
          context,
        ),
      );
    expect(waited.timedOut).toBe(false);
    expect(waited.process.exitCode).toBe(0);
    const output = z
      .object({ text: z.string() })
      .parse(
        await computer.call(
          "exec",
          { operation: "poll", id: started.process.id },
          context,
        ),
      );
    expect(output.text).toBe(homeA);
    expect(await readFile(join(homeA, "selected"), "utf8")).toBe("selected");
    await expect(access(join(homeB, "selected"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    try {
      await processes.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
