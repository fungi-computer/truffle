import { z } from "zod";
import { createProvider, type FetchFunction } from "@earendil-works/pi-ai";
import {
  createFungiAccountOAuth,
  fungiAccountTeam,
  readFungiAccountStatus,
} from "./private-fungi-account.js";
import { fungiHostedModels } from "./private-fungi-model-catalog.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import {
  assertFungiModelsEnabled,
  createFungiModelApi,
  fungiModelFetch,
} from "./private-fungi-model-api.js";

/** The selected account Team owns the endpoint; the Hub owns the live model catalog. */
export function createFungiModelProvider(
  input: { credentialPath?: string; fetch?: FetchFunction } = {},
) {
  const options = {
    ...input,
    credentialPath:
      input.credentialPath ?? capturePrivateLocalConfigRoot().credentialPath,
  };
  const oauth = createFungiAccountOAuth(options);
  return createProvider<"openai-completions">({
    id: "fungi",
    name: "Fungi",
    auth: { oauth },
    models: [],
    api: createFungiModelApi(async (baseUrl) => {
      const status = await readFungiAccountStatus(options);
      if (status?.team === undefined)
        throw new Error("Sign in to Fungi to use models");
      const currentBase = `${status.issuer}/api/v1/teams/${encodeURIComponent(status.team.teamId)}`;
      if (currentBase !== baseUrl)
        throw new Error(
          "Fungi account changed before dispatch. Retry for your selected Team.",
        );
      return status.team.name;
    }, options.credentialPath),
    async fetchModels(context) {
      assertFungiModelsEnabled();
      if (context.credential?.type !== "oauth")
        throw new Error("Sign in to Fungi to use models");
      const auth = await oauth.toAuth(context.credential);
      if (auth.baseUrl === undefined || auth.apiKey === undefined)
        throw new Error("Choose a Team and sign in to Fungi to use models");
      const team = fungiAccountTeam(context.credential);
      const response = await fungiModelFetch(
        auth.baseUrl,
        team.name,
        options.fetch,
        options.credentialPath,
      )(`${auth.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${auth.apiKey}` },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        const body: unknown = await response.json();
        // The transport owns the curated refusal; Pi returns this failure to its caller.
        const refusal = z
          .object({ error: z.object({ message: z.string() }) })
          .parse(body).error.message;
        throw new Error(refusal);
      }
      return fungiHostedModels(await response.json(), auth.baseUrl);
    },
  });
}
