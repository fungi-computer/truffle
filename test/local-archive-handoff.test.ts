import { Shiitake } from "@fungi.computer/shiitake";
import {
  defineExtension,
  ExtensionId,
  type ExtensionGrantV0,
  type RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { localArchiveHandoff } from "../src/local-archive-handoff.js";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

const installedId = ExtensionId.make("installed-compactor");

/** An installed extension that owns the compaction handoff slot. */
const installed: RosteredExtensionV0 = defineExtension({
  id: installedId,
  version: "1.0.0",
}).define({
  compaction: () => ({
    consume: () => ({ type: "discarded_by_policy" as const }),
  }),
});
const installedGrant: ExtensionGrantV0 = {
  id: installedId,
  capabilities: ["compaction_handoff"],
};

function open(
  roster: readonly RosteredExtensionV0[],
  grants: readonly ExtensionGrantV0[],
) {
  const database = new DatabaseSync(":memory:");
  return Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: { roster, grants },
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: () => Promise.resolve({ revision: "d1", text: "Answer." }),
    },
    model: {
      acquire: () => Promise.reject(new Error("no model is needed")),
    },
  });
}

describe("Local Zookeeper slot (D1)", () => {
  it("installs Zookeeper when no installed extension holds the handoff", () => {
    const reports: string[] = [];
    const archive = localArchiveHandoff("/store", [], (operation) => {
      reports.push(operation);
    });
    expect(archive.roster).toHaveLength(1);
    expect(archive.grants.map(({ capabilities }) => capabilities)).toEqual([
      ["compaction_handoff"],
    ]);
    expect(reports).toEqual([]);
  });

  it("skips Zookeeper with a logged diagnostic when an installed extension holds the slot", () => {
    const reports: { operation: string; cause: unknown }[] = [];
    const archive = localArchiveHandoff(
      "/store",
      [installedGrant],
      (operation, cause) => {
        reports.push({ operation, cause });
      },
    );
    expect(archive).toEqual({ roster: [], grants: [] });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.operation).toBe("local-zookeeper-skipped");
    const cause = reports[0]?.cause;
    expect(cause).toBeInstanceOf(Error);
    if (cause instanceof Error)
      expect(cause.message).toContain("installed-compactor");
  });

  it("opens the Agent with the installed holder and Zookeeper skipped, never a startup failure", async () => {
    const archive = localArchiveHandoff(
      "/store",
      [installedGrant],
      () => undefined,
    );
    const agent = await open(
      [...archive.roster, installed],
      [...archive.grants, installedGrant],
    );
    await agent.close();
  });

  it("would fail to open if Zookeeper kept the slot beside the installed holder", async () => {
    const unskipped = localArchiveHandoff("/store", [], () => undefined);
    await expect(
      open(
        [...unskipped.roster, installed],
        [...unskipped.grants, installedGrant],
      ),
    ).rejects.toThrow("Compaction handoff slot is already owned");
  });
});
