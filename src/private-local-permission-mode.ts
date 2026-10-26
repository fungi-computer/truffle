import { z } from "zod";

export const localPermissionModeSchema = z.enum([
  "read-only",
  "workspace",
  "full-access",
]);
export type LocalPermissionMode = z.output<typeof localPermissionModeSchema>;

const rank = {
  "read-only": 0,
  workspace: 1,
  "full-access": 2,
} satisfies Record<LocalPermissionMode, number>;

export function modeWithinCeiling(
  candidate: LocalPermissionMode,
  creator: LocalPermissionMode,
): boolean {
  return rank[candidate] <= rank[creator];
}

/** Levi's 2026-10-25 Q1 decision: default Workspace when the host sandbox probe passes, else Full access. */
export function defaultLocalPermissionMode(
  sandboxAvailable: boolean,
): LocalPermissionMode {
  return sandboxAvailable ? "workspace" : "full-access";
}
