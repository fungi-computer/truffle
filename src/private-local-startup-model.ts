import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { type ModelPreference } from "@fungi.computer/shiitake/model-preference";
import { readPrivateLocalAgentProfile } from "./private-local-session-discovery.js";
import { defaultLocalModel } from "./private-local-default-model.js";

/** Which layer decided a startup model: a Session override, the Agent default, or the available login. */
export type LocalStartupModelSource = "session" | "agent" | "available";

/** The one model choice a run or a new chat starts from, before it is checked against its provider. */
export type LocalStartupChoice = Readonly<{
  preference: ModelPreference;
  source: LocalStartupModelSource;
}>;

/** The effective model a new chat of one Agent starts with. */
export type LocalStartupModel = Readonly<{
  providerId: string;
  modelId: string;
  reasoning: ThinkingLevel | undefined;
  source: LocalStartupModelSource;
}>;

/** Validate a requested thinking level against the registered model. */
export function validateLocalReasoning(
  model: Parameters<typeof getSupportedThinkingLevels>[0],
  requested: ThinkingLevel | undefined,
): void {
  if (requested === undefined) return;
  const supported = getSupportedThinkingLevels(model).filter(
    (level) => level !== "off",
  );
  if (!supported.includes(requested))
    throw new Error(
      "Reasoning level " +
        requested +
        " is not supported by " +
        model.provider +
        "/" +
        model.id +
        "; supported levels: " +
        (supported.join(", ") || "none"),
    );
}

/** Local's default is medium, clamped through Pi's model capabilities. */
export function defaultLocalReasoning(
  model: Parameters<typeof getSupportedThinkingLevels>[0],
): ThinkingLevel | undefined {
  const level = clampThinkingLevel(model, "medium");
  return level === "off" ? undefined : level;
}

/**
 * The thinking level a chosen model runs with: the choice's own level, else
 * the opener's level when this model supports it, else Local's default.
 */
export function startupReasoning(
  selected: Model<Api>,
  preference: ModelPreference,
  ownerReasoning?: ThinkingLevel,
): ThinkingLevel | undefined {
  return (
    preference.reasoning ??
    (ownerReasoning !== undefined &&
    getSupportedThinkingLevels(selected).includes(ownerReasoning)
      ? ownerReasoning
      : defaultLocalReasoning(selected))
  );
}

/** Resolve explicit layers without checking logins or discovering models. */
export function resolveKnownLocalStartupChoice(
  input: Readonly<{
    session: ModelPreference | null;
    agent: ModelPreference | null;
  }>,
): LocalStartupChoice | null {
  if (input.session !== null)
    return { preference: input.session, source: "session" };
  if (input.agent !== null) return { preference: input.agent, source: "agent" };
  return null;
}

/**
 * Resolve the explicit choice, or discover the available login. An explicit
 * layer never falls through on an auth failure; the caller reports it.
 */
export async function resolveLocalStartupChoice(
  input: Readonly<{
    models: Models;
    session: ModelPreference | null;
    agent: ModelPreference | null;
    signal: AbortSignal;
  }>,
): Promise<LocalStartupChoice | null> {
  const known = resolveKnownLocalStartupChoice(input);
  if (known !== null) return known;
  const available = await defaultLocalModel(input.models, input.signal);
  return available === null
    ? null
    : { preference: available, source: "available" };
}

/**
 * The model a new chat of the Agent at `databasePath` starts with; no store
 * means a new Agent, which starts from the available login. A store that
 * predates the current schema fails loudly. The landing and a
 * fresh Session both resolve through this chain.
 */
export async function resolveAgentStartupModel(
  input: Readonly<{
    models: Models;
    databasePath: string | undefined;
    signal: AbortSignal;
  }>,
): Promise<LocalStartupModel | null> {
  const agent =
    input.databasePath === undefined
      ? null
      : readPrivateLocalAgentProfile(input.databasePath).model;
  const choice = await resolveLocalStartupChoice({
    models: input.models,
    session: null,
    agent,
    signal: input.signal,
  });
  if (choice === null) return null;
  const { providerId, modelId } = choice.preference;
  const selected = input.models.getModel(providerId, modelId);
  return {
    providerId,
    modelId,
    // A catalog not loaded yet cannot name a level; the run resolves it later.
    reasoning:
      selected === undefined
        ? choice.preference.reasoning
        : startupReasoning(selected, choice.preference),
    source: choice.source,
  };
}
