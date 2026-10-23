import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  createPrivateModels,
  createPrivateCredentialStore,
} from "@fungi.computer/truffle";
import { runLocalAuthCli } from "@fungi.computer/truffle/auth";
import { UnsecuredJWT, decodeJwt } from "jose";
const { AbortSignal } = globalThis;

// This file is copied into an empty, external npm consumer. No workspace imports,
// OAuth callback server, provider HTTP requests, or real credential paths.
const path = join(process.cwd(), "fixture-credentials.json");
const provider = builtinProviders().find((entry) => entry.id === "openai");
assert.ok(provider?.auth.oauth);
const access = new UnsecuredJWT({
  iss: "https://auth.openai.com",
  sub: "fixture-packed-person",
}).encode();
let logins = 0;
const grant = {
  type: "oauth",
  access,
  refresh: "fixture-packed-refresh",
  expires: Date.now() + 3_600_000,
};
const models = createPrivateModels(path, {
  providers: [
    {
      ...provider,
      auth: {
        oauth: {
          name: "Fixture ChatGPT",
          isSubscription: true,
          login: () => {
            logins++;
            return Promise.resolve(grant);
          },
          refresh: () => Promise.resolve(grant),
          toAuth: (credential) =>
            Promise.resolve({ apiKey: credential.access }),
        },
      },
    },
  ],
});
await runLocalAuthCli(
  ["login", "--provider", "openai", "--auth-type", "oauth"],
  {
    models,
    getDeviceId: () => Promise.resolve("fixture-packed-device"),
    interaction: {
      signal: AbortSignal.timeout(5_000),
      notify: () => undefined,
      prompt: () => Promise.reject(new Error("Fixture must not prompt")),
    },
  },
);
assert.equal(logins, 1);
const stored = await createPrivateCredentialStore(path).read("openai");
assert.ok(stored?.type === "oauth");
const person = decodeJwt(stored.access);
assert.equal(person.iss, "https://auth.openai.com");
assert.equal(person.sub, "fixture-packed-person");
assert.equal(Object.hasOwn(stored, "accountId"), false);
assert.equal(Object.hasOwn(stored, "id_token"), false);
console.log(
  "Packed Truffle: fixture sign-in stores access-token issuer + subject",
);
