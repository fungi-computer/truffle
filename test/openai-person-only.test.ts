import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { retainSubscriptionIdentity } from "../src/subscription-identity.js";
import { openAIAccessToken } from "./openai-fixtures.js";

it("OpenAI refresh does not carry workspace metadata into the person's new grant", async () => {
  const next: OAuthCredential = {
    type: "oauth",
    access: openAIAccessToken("fixture-person"),
    refresh: "fixture-refresh",
    expires: Date.now() + 3_600_000,
  };
  const oauth: OAuthAuth = {
    name: "Fixture ChatGPT",
    login: () => Promise.resolve(next),
    refresh: () => Promise.resolve(next),
    toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
  };
  const refreshed = await retainSubscriptionIdentity(oauth, "openai").refresh(
    { ...next, accountId: "fixture-workspace" },
    new AbortController().signal,
  );
  expect(Object.hasOwn(refreshed, "accountId")).toBe(false);
});
