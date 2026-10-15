import { FungiSignInRequiredError } from "./private-fungi-auth-error.js";
import { createRequire } from "node:module";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { Mycelium, type CapabilitySource } from "@fungi.computer/mycelium";
import { z } from "zod";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";

const localPackage = z
  .looseObject({ version: z.string().min(1) })
  .parse(createRequire(import.meta.url)("../package.json"));

/** The MCP client identity Local reports to the Hub. */
export const fungiMcpClientInfo = Object.freeze({
  name: "fungi-local",
  version: localPackage.version,
});

/**
 * Fetch rejects (rather than resolving with an HTTP status) only when the Hub
 * was not reached. Keep TypeError, which the maintained SDK treats as a
 * network failure, and name the origin the person has to reach.
 */
class FungiMcpUnreachableError extends TypeError {
  constructor(origin: string, cause: unknown) {
    super(
      `Can't reach ${origin}${cause instanceof Error ? ` (${cause.message})` : ""}. Check your connection and try again.`,
      { cause },
    );
    this.name = "FungiMcpUnreachableError";
  }
}

// SDK UnauthorizedContext carries the Response, not the rejected request token.
// Pair them at the transport seam so late concurrent 401s cannot select a newer token.
const rejectedAccess = new WeakMap<Response, string>();
export function rejectedFungiMcpAccess(response: Response): string | undefined {
  return rejectedAccess.get(response);
}

export function fungiMcpReachableFetch(
  endpoint: URL,
  fetchImpl: FetchLike = fetch,
): FetchLike {
  return async (url, init) => {
    try {
      const response = await fetchImpl(url, init);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (response.status === 401 && authorization?.startsWith("Bearer "))
        rejectedAccess.set(response, authorization.slice(7));
      return response;
    } catch (cause) {
      if (init?.signal?.aborted === true) throw cause;
      throw new FungiMcpUnreachableError(endpoint.origin, cause);
    }
  };
}

/** Host-held selection and credentials; neither enters the model's arguments. */
export type PrivateFungiMcpConnectionOptions = Readonly<{
  endpoint: URL;
  authProvider: AuthProvider | OAuthClientProvider;
  /** The maintained transport's fetch seam, also used by the local caller proof. */
  fetch?: FetchLike;
}>;

/**
 * Add the existing Fungi MCP execute door to a Local run's capability scope.
 * The remote server selects and authorizes permitted Team Computers per request.
 * Computer discovery and operations remain inside the maintained execute door.
 */
export function createPrivateFungiMcpConnection(
  options: PrivateFungiMcpConnectionOptions,
): CapabilitySource {
  const endpoint = parseFungiMcpEndpoint(options.endpoint);
  const fetch = fungiMcpReachableFetch(endpoint, options.fetch);

  return {
    id: "fungi-mcp",
    acquire: async ({ signal }) => {
      signal.throwIfAborted();
      const client = new Client(fungiMcpClientInfo);
      const transportOptions: StreamableHTTPClientTransportOptions = {
        authProvider: options.authProvider,
        fetch,
        requestInit: { redirect: "error" },
      };
      const transport = new StreamableHTTPClientTransport(
        endpoint,
        transportOptions,
      );
      try {
        await client.connect(transport, { signal });
        signal.throwIfAborted();
        return {
          snapshot: {
            version: "fungi-mcp-execute-v1",
            modules: [
              Mycelium.module({
                id: "fungi-mcp",
                name: "fungiMcp",
                description: "The explicitly connected Fungi MCP server.",
                operations: {
                  execute: Mycelium.operation({
                    replay: "unsafe",
                    description:
                      "Execute JavaScript on the connected Fungi MCP server. Discover permitted Team Computer operations with await forage.search({query: 'read'}) and await forage.describe({path: 'files.read'}). Explicitly return the result. Returns the original MCP content and isError; it does not run on the local machine.",
                    input: z.strictObject({ code: z.string() }),
                    execute: async (input, context) => {
                      try {
                        return z
                          .json()
                          .parse(
                            await client.callTool(
                              { name: "execute", arguments: input },
                              { signal: context.signal },
                            ),
                          );
                      } catch (cause) {
                        // Report uncertainty as a failed MCP result so the caller
                        // can distinguish it from a successful remote result.
                        // Replaying arbitrary JavaScript here could duplicate work.
                        const httpFailure = z
                          .looseObject({ status: z.number() })
                          .safeParse(cause);
                        if (
                          httpFailure.success &&
                          httpFailure.data.status !== 401
                        )
                          throw cause;
                        // A 401 is the Hub refusing before execution: the
                        // outcome is known, and reconnecting will not help.
                        if (
                          cause instanceof UnauthorizedError ||
                          cause instanceof FungiSignInRequiredError ||
                          (httpFailure.success &&
                            httpFailure.data.status === 401)
                        )
                          return {
                            content: [
                              {
                                type: "text",
                                text: `Fungi MCP refused this call because its sign-in or Team key is missing, expired or revoked; the code did not run. Run fungi login --fungi-mcp ${endpoint.href} or use a current key.`,
                              },
                            ],
                            isError: true,
                          };
                        return {
                          content: [
                            {
                              type: "text",
                              text: "Fungi MCP connection was interrupted during an operation; outcome unknown. Reconnect and inspect Computer state before retrying.",
                            },
                          ],
                          isError: true,
                        };
                      }
                    },
                  }),
                },
              }),
            ],
          },
          release: () => client.close(),
        };
      } catch (error) {
        await client.close();
        if (
          error instanceof UnauthorizedError ||
          error instanceof FungiSignInRequiredError ||
          z.object({ status: z.literal(401) }).safeParse(error).success
        )
          throw new Error(
            `Fungi MCP sign-in is missing, expired or revoked; run fungi login --fungi-mcp ${endpoint.href}`,
            { cause: error },
          );
        throw error;
      }
    },
  };
}
