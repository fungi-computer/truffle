import type { PrivateLocalEffectiveModel } from "../../src/private-local-effective-model.js";
import type { PrivateLocalRuntimeHost } from "../../src/private-local-runtime-host.js";

/**
 * This fixture has an available model; unexpected model and archive writes
 * still fail.
 */
export const fixtureModelControls: Pick<
  PrivateLocalRuntimeHost,
  | "setModel"
  | "setArchived"
  | "setRequireSandbox"
  | "sandboxStatus"
  | "assertModelReady"
  | "prepareReload"
> = {
  prepareReload: () => Promise.reject(new Error("Unexpected fixture reload")),
  setArchived: () => {
    throw new Error("Unexpected fixture Agent archive write");
  },
  setRequireSandbox: () => {
    throw new Error("Unexpected fixture sandbox requirement write");
  },
  sandboxStatus: () => ({ state: "available", requireSandbox: false }),
  setModel: () =>
    Promise.reject(new Error("Unexpected fixture Agent model write")),
  assertModelReady: (_sessionId, signal) => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
};

/** Deterministic secret-free descriptor for service fixture owners. */
export function fixtureEffectiveModel(
  _sessionId: string,
  signal: AbortSignal,
): Promise<PrivateLocalEffectiveModel> {
  signal.throwIfAborted();
  return Promise.resolve({
    agentName: "Shiitake",
    providerId: "fixture",
    providerName: "Fixture",
    modelId: "fixture-model",
    modelName: "Fixture Model",
    credential: { kind: "api_key", source: "TEST_API_KEY" },
    label: "Shiitake · Fixture Model · TEST_API_KEY",
  });
}

/**
 * This fixture owner takes no mail and holds no pending work, so the service
 * may release it once idle; any unexpected delivery fails loudly.
 */
export const fixtureMailControls: Pick<
  PrivateLocalRuntimeHost,
  "acceptMail" | "readSettlement" | "pendingDelegation" | "idle"
> = {
  idle: () => Promise.resolve(true),
  pendingDelegation: () => Promise.resolve(undefined),
  acceptMail: () => Promise.reject(new Error("Unexpected fixture mail")),
  readSettlement: () =>
    Promise.reject(new Error("Unexpected fixture settlement read")),
};
