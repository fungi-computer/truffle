/// <reference types="bun-types" />

import { serve } from "bun";
import { dispatchPrivateLocalRequest } from "./private-local-http-dispatch.js";
import {
  newBunWebSocketRpcHandler,
  type RpcTarget,
} from "@fungi.computer/capnweb";

import type { PrivateLocalShiitakeServer } from "./private-local-shiitake-host.js";
import {
  openPrivateLocalShiitakeWorkerBatch,
  type PrivateLocalShiitakeWorkerBatch,
  type PrivateLocalShiitakeWorkerInput,
} from "./private-local-shiitake-host.js";

type PrivateLoopbackListener = Readonly<{
  hostname: "127.0.0.1" | "::1";
  port: number;
}>;

function parsePrivateLoopbackListener(value: string): PrivateLoopbackListener {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    throw new Error(
      "Private local Shiitake listener requires loopback HTTP with an explicit port",
    );
  return {
    hostname: url.hostname === "127.0.0.1" ? "127.0.0.1" : "::1",
    port,
  };
}

/** Retained native Bun listener, now owned beside the persistent Local service. */
export function openPrivateLocalBunServer(
  fetch: (request: Request) => Response | Promise<Response>,
  listenAddress?: string,
  auth?: Readonly<{
    path: string;
    admit: (request: Request) => boolean;
    createTarget: () => RpcTarget;
  }>,
): PrivateLocalShiitakeServer {
  const listener =
    listenAddress === undefined
      ? { hostname: "127.0.0.1" as const, port: 0 }
      : parsePrivateLoopbackListener(listenAddress);
  // A model retry can leave SSE quiet, and command admission/cancellation can
  // await owner cleanup. Bun's socket-idle clock must not sever either while
  // the handler is pending. Restore its ordinary idle limit for finite replies.
  const dispatch = async (
    request: Request,
    server: { timeout: (request: Request, seconds: number) => void },
  ) => {
    return dispatchPrivateLocalRequest(request, server, fetch);
  };
  const server =
    auth === undefined
      ? serve({ ...listener, fetch: dispatch })
      : serve<unknown>({
          ...listener,
          websocket: newBunWebSocketRpcHandler(auth.createTarget),
          fetch(request, server) {
            if (new URL(request.url).pathname === auth.path) {
              if (!auth.admit(request))
                return new Response(null, { status: 403 });
              if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
                return new Response(null, { status: 426 });
              if (server.upgrade(request, { data: undefined })) return;
              return new Response(null, { status: 400 });
            }
            return dispatch(request, server);
          },
        });
  return Object.freeze({
    baseUrl: server.url.origin,
    close: () => server.stop(true),
  });
}

/** Retained static worker server; persistent service callers use the manager. */
export async function openPrivateLocalBunShiitakeWorkerBatch(
  inputs: readonly PrivateLocalShiitakeWorkerInput[],
  listenAddress: string,
): Promise<PrivateLocalShiitakeWorkerBatch> {
  // Validate the native listener before any Local owner opens its store.
  parsePrivateLoopbackListener(listenAddress);
  return openPrivateLocalShiitakeWorkerBatch(inputs, (fetch) =>
    openPrivateLocalBunServer(fetch, listenAddress),
  );
}
/// <reference types="bun-types" />
