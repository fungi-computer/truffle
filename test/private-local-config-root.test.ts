import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { createLocalSkillSource } from "../src/local-skill-source.js";
import { localExtensions } from "../src/local-extensions.js";

it("passes captured A through the existing leaf parameters after ambient HOME becomes B", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "fungi-config-contract-"));
  const previousHome = process.env.HOME;
  const homeA = join(temporary, "a");
  const homeB = join(temporary, "b");
  const project = join(temporary, "project");
  try {
    await mkdir(project);
    for (const home of [homeA, homeB]) {
      const skill = join(home, ".agents", "skills", "selected");
      await mkdir(skill, { recursive: true });
      await writeFile(
        join(skill, "SKILL.md"),
        `---\nname: selected\ndescription: Selected home\n---\n${home}`,
      );
    }
    process.env.HOME = homeA;
    const root = capturePrivateLocalConfigRoot();
    process.env.HOME = homeB;

    expect(root).toEqual({
      home: homeA,
      credentialPath: join(homeA, ".config", "fungi", "credentials.json"),
      serviceDirectory: join(homeA, ".fungi", "service"),
    });
    // Capture is path selection, not a credential read or service startup.
    await expect(access(root.serviceDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const credentials = createPrivateCredentialStore(root.credentialPath);
    await credentials.modify("synthetic", () =>
      Promise.resolve({ type: "api_key", key: "disposable" }),
    );
    expect(await credentials.read("synthetic")).toEqual({
      type: "api_key",
      key: "disposable",
    });
    await expect(
      access(join(homeB, ".config", "fungi", "credentials.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const skills = createLocalSkillSource({ cwd: project, home: root.home });
    const signal = new AbortController().signal;
    expect((await skills.read("selected", undefined, signal)).content).toBe(
      homeA,
    );
    expect(localExtensions({ home: root.home }).root).toBe(
      join(homeA, ".fungi", "extensions"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each(["", "relative/home"])("refuses a non-absolute home %j", (home) => {
  expect(() => capturePrivateLocalConfigRoot(home)).toThrow(/absolute/);
});
