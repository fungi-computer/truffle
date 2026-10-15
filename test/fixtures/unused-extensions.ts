import type { AgentExtensionControls } from "@fungi.computer/shiitake";

/** Reject every extension call in fixtures that exercise only local ownership. */
export const unusedExtensions: AgentExtensionControls = {
  list: () => Promise.resolve([]),
  resume: () =>
    Promise.reject(new Error("Extensions are unused by this fixture")),
  call: () =>
    Promise.reject(new Error("Extensions are unused by this fixture")),
};
