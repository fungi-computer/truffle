import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  acquireServiceLock,
  readLiveServiceStatus,
  readServiceRegistration,
  serviceDirectory,
  serviceOwnerIsLive,
} from "./private-local-service-discovery.js";

export const fungiAccountLogoutRequestSchema = z.strictObject({
  credentialPath: z.string().min(1),
  endpoint: z.string().optional(),
});
export type FungiAccountLogoutRequest = z.infer<
  typeof fungiAccountLogoutRequestSchema
>;
export const fungiAccountLogoutResultSchema = z.strictObject({
  kind: z.enum(["not-logged-in", "removed", "revoked"]),
  message: z.string(),
  unconfirmedComputers: z.array(
    z.strictObject({ name: z.string(), url: z.string() }),
  ),
});
/** A logout outcome: never a remote-revocation claim the issuer didn't confirm. */
export type FungiAccountLogoutResult = Readonly<{
  kind: "not-logged-in" | "removed" | "revoked";
  message: string;
  unconfirmedComputers: readonly Readonly<{ name: string; url: string }>[];
}>;

/** The one auth RPC this client calls on the running service. */
type FungiAccountLogoutTarget = Readonly<{
  signOutFungi(
    input: FungiAccountLogoutRequest,
  ): Promise<FungiAccountLogoutResult>;
}>;

/**
 * Route a logout to the running Local account owner. It never starts,
 * upgrades, stops or replaces a service. With no service, the caller's own
 * offline clear runs under the ordinary startup lock, so a service cannot
 * start between proving its absence and the store mutation. A live owner
 * that cannot be reached fails closed.
 */
export async function signOutFungiThroughLocalService(
  endpoint: string | URL | undefined,
  options: {
    credentialPath: string;
    directory: string;
    fetch?: FetchLike;
    clearOffline: (
      endpoint: string | URL | undefined,
      input: { credentialPath: string; fetch?: FetchLike },
    ) => Promise<FungiAccountLogoutResult>;
  },
): Promise<FungiAccountLogoutResult> {
  const { clearOffline, directory: requested, ...input } = options;
  const directory = await serviceDirectory(requested);
  const release = await acquireServiceLock(directory, "startup");
  try {
    const registration = await readServiceRegistration(directory);
    const owned = await serviceOwnerIsLive(directory);
    if (registration?.kind !== "current") {
      if (owned)
        throw new Error("The running Local account owner is unavailable");
      return await clearOffline(endpoint, input);
    }
    const probe = await readLiveServiceStatus(registration.record);
    if (probe.kind !== "running") {
      if (owned || probe.kind === "unavailable")
        throw new Error("The running Local account owner is unavailable");
      return await clearOffline(endpoint, input);
    }
    const service = probe.service;
    const url = new URL(`${service.baseUrl}/service/${service.serviceId}/auth`);
    url.protocol = "ws:";
    const socket = new WebSocket(url);
    const remote = newWebSocketRpcSession<FungiAccountLogoutTarget>(socket);
    try {
      const request: FungiAccountLogoutRequest = {
        credentialPath: input.credentialPath,
      };
      if (endpoint !== undefined) request.endpoint = endpoint.toString();
      return fungiAccountLogoutResultSchema.parse(
        await remote.signOutFungi(request),
      );
    } finally {
      remote[Symbol.dispose]();
      socket.close();
    }
  } finally {
    await release();
  }
}
