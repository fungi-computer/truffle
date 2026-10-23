import type {
  ExtensionGrantV0,
  RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import {
  zookeeperCompaction,
  zookeeperCompactionGrant,
} from "@fungi.computer/zookeeper";

import { logEvent } from "./log-event.js";
import { localArchiveWriter } from "./local-session-archives.js";

/** What the Local roster gains for the compaction archive. */
export type LocalArchiveHandoff = Readonly<{
  roster: readonly RosteredExtensionV0[];
  grants: readonly ExtensionGrantV0[];
}>;

/**
 * Zookeeper's compaction handoff over files beside the Agent store. An
 * installed extension the owner chose keeps the single `compaction_handoff`
 * slot: Zookeeper is then skipped and the skip is reported, never a failure.
 */
export function localArchiveHandoff(
  storeDirectory: string,
  installedGrants: readonly ExtensionGrantV0[],
  report: (operation: string, cause: unknown) => void = logEvent,
): LocalArchiveHandoff {
  const holder = installedGrants.find(({ capabilities }) =>
    capabilities.includes("compaction_handoff"),
  );
  if (holder !== undefined) {
    report(
      "local-zookeeper-skipped",
      new Error(
        `Installed extension ${holder.id} holds the compaction handoff; Zookeeper archives are off for this Agent`,
      ),
    );
    return { roster: [], grants: [] };
  }
  return {
    roster: [
      zookeeperCompaction({ writer: localArchiveWriter(storeDirectory) }),
    ],
    grants: [zookeeperCompactionGrant],
  };
}
