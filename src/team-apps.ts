import { decodeGillRefusal } from "@fungi.computer/agar/gills";
import { EventSource } from "eventsource";
import {
  createShiitakeClient,
  type ShiitakeSession,
} from "@fungi.computer/shiitake/client";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
  appDirectoryResponseSchema,
  type AppDirectory,
} from "@fungi.computer/oyster/shell/app-directory";
import {
  createGillClient,
  type GillRequest,
  type GillReply,
} from "@fungi.computer/gills";
import {
  fungiAccountFetch,
  readFungiAccountStatus,
  type FungiAccountTeam,
} from "./private-fungi-account.js";

/** A selected Team's App reads. Credentials and selectors remain Local-owned. */
export type LocalTeamApps = Readonly<{
  team: FungiAccountTeam;
  openSession: (
    target: Readonly<{ agentId: string; sessionId: string }>,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{ session: ShiitakeSession; close: () => Promise<void> }>
  >;
  surfaceUrl: (surfaceId: string, signal?: AbortSignal) => Promise<URL>;
  read: (signal?: AbortSignal) => Promise<AppDirectory>;
  requestGill: (
    surfaceId: string,
    selectors: GillRequest,
    signal?: AbortSignal,
  ) => Promise<GillReply>;
}>;

/** Pin this view to the saved account and Team; a later switch retires it. */
export async function openLocalTeamApps(
  options: Readonly<{ credentialPath?: string; fetch?: FetchLike }> = {},
): Promise<LocalTeamApps> {
  const account = await readFungiAccountStatus(options);
  if (account?.team === undefined)
    throw new Error("Sign in to Fungi and choose a Team to view its Apps");
  const team = account.team;
  const selectedIssuer = account.issuer;
  const issuer = new URL(account.issuer).origin;
  const prefix = `/api/teams/${encodeURIComponent(team.teamId)}`;
  const transport = fungiAccountFetch(issuer, options);
  async function stillSelected() {
    const current = await readFungiAccountStatus(options);
    if (
      current?.issuer !== selectedIssuer ||
      current.team?.teamId !== team.teamId
    )
      throw new Error("The selected Fungi Team changed; reopen the App pane");
  }
  async function read(signal?: AbortSignal): Promise<AppDirectory> {
    await stillSelected();
    const response = await transport(`${issuer}${prefix}/local/apps`, {
      signal: signal ?? null,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `App directory refused with HTTP ${String(response.status)}`,
      );
    }
    const raw: unknown = await response.json();
    await stillSelected();
    signal?.throwIfAborted();
    return appDirectoryResponseSchema.parse(raw);
  }
  return {
    team,
    read,
    async surfaceUrl(surfaceId, signal) {
      const directory = await read(signal);
      const app = directory.apps.find((item) => item.surfaceId === surfaceId);
      if (
        app?.availability !== "available" ||
        app.surface === null ||
        app.releaseId === null
      )
        throw new Error("That App is not available in the selected Team");
      const url = new URL(app.surfacePath, issuer);
      if (url.origin !== issuer)
        throw new Error("The App surface is not on the selected Hub");
      url.searchParams.set("authorityVersion", String(app.authorityVersion));
      url.searchParams.set("releaseId", app.releaseId);
      url.searchParams.set("surfaceRoute", app.surface.stableRoute);
      await stillSelected();
      return url;
    },
    async openSession(target, signal) {
      await stillSelected();
      signal.throwIfAborted();
      const fetch = Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          await stillSelected();
          signal.throwIfAborted();
          return transport(input, {
            ...init,
            signal: AbortSignal.any([
              signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      class AccountEvents extends EventSource {
        constructor(url: string) {
          super(url, { fetch });
        }
      }
      const agent = createShiitakeClient({
        baseUrl: `${issuer}${prefix}/local/agents/${encodeURIComponent(target.agentId)}`,
        fetch,
        eventSource: AccountEvents,
      });
      try {
        const session = agent.session(target.sessionId);
        await session.read();
        await stillSelected();
        signal.throwIfAborted();
        return { session, close: agent.close };
      } catch (cause) {
        await agent.close();
        throw new Error("The selected Team Session could not be opened", {
          cause,
        });
      }
    },
    async requestGill(surfaceId, selectors, signal) {
      const directory = await read(signal);
      const app = directory.apps.find((item) => item.surfaceId === surfaceId);
      const declaration = app?.gills.find(
        (item) => item.id === selectors.viewId,
      );
      if (
        app === undefined ||
        declaration === undefined ||
        app.availability !== "available" ||
        app.releaseId === null
      )
        throw new Error("That Gill is not available in the selected Team");
      const address =
        app.address.kind === "default"
          ? `default/${encodeURIComponent(app.address.appId)}`
          : encodeURIComponent(app.address.installationId);
      const endpoint = new URL(`${prefix}/apps/${address}/gills`, issuer);
      endpoint.searchParams.set(
        "authorityVersion",
        String(app.authorityVersion),
      );
      endpoint.searchParams.set("releaseId", app.releaseId);
      if (app.surface !== null)
        endpoint.searchParams.set("surfaceRoute", app.surface.stableRoute);
      await stillSelected();
      const response = await createGillClient({
        decodeRefusal: decodeGillRefusal,
        endpoint: endpoint.href,
        fetch: transport,
        declaration,
      }).request(selectors, signal);
      await stillSelected();
      signal?.throwIfAborted();
      return response;
    },
  };
}
