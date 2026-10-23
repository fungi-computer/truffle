import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsecuredJWT } from "jose";
import { expect, it } from "vitest";
import { createPrivateModels } from "../src/local-models.js";
import { runLocalAuthCli } from "../src/auth-cli.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { CredentialActivationError } from "../src/subscription-activation.js";
import { prepareSubscriptionIdentity } from "../src/subscription-identity.js";
import { readOpenAIPerson } from "../src/private-openai-claims.js";
import { fixtureChatGPTProvider } from "./fixture-chatgpt-provider.js";
import { openAIAccessToken } from "./openai-fixtures.js";

async function metadata(path: string) {
  return stat(path).then(
    (value) => ({ size: value.size, mtimeMs: value.mtimeMs }),
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
}

it.each([
  {
    name: "issuer and subject",
    access: openAIAccessToken("fixture-openai-person"),
    accepted: true,
  },
  { name: "malformed access", access: "not-a-jwt", accepted: false },
  {
    name: "missing subject",
    access: new UnsecuredJWT({ iss: "https://auth.openai.com" }).encode(),
    accepted: false,
  },
  {
    name: "missing issuer",
    access: new UnsecuredJWT({ sub: "fixture-openai-person" }).encode(),
    accepted: false,
  },
])(
  "ChatGPT login uses only $name at our provider seam",
  async ({ access, accepted }) => {
    const real = capturePrivateLocalConfigRoot().credentialPath;
    const paths = [real, real + ".device-id"];
    const before = await Promise.all(paths.map(metadata));
    const home = await mkdtemp(join(tmpdir(), "fungi-fixture-login-"));
    const path = join(home, "credentials.json");
    try {
      const models = createPrivateModels(path, {
        providers: [fixtureChatGPTProvider(access)],
      });
      const outcome = await runLocalAuthCli(
        ["login", "--provider", "openai", "--auth-type", "oauth"],
        {
          models,
          getDeviceId: () => Promise.resolve("fixture-device"),
          interaction: {
            signal: AbortSignal.timeout(5_000),
            notify: () => undefined,
            prompt: () => Promise.reject(new Error("Fixture must not prompt")),
          },
        },
      ).then(
        () => "completed",
        (error: unknown) =>
          error instanceof CredentialActivationError
            ? error.category
            : "unexpected",
      );
      expect(outcome).toBe(accepted ? "completed" : "identity-unavailable");
      const saved = await createPrivateCredentialStore(path).read("openai");
      if (accepted) {
        expect(
          saved?.type === "oauth" && readOpenAIPerson(saved.access),
        ).toEqual({
          kind: "person",
          iss: "https://auth.openai.com",
          sub: "fixture-openai-person",
        });
        expect(Object.hasOwn(saved ?? {}, "accountId")).toBe(false);
        expect(Object.hasOwn(saved ?? {}, "id_token")).toBe(false);
        await prepareSubscriptionIdentity("openai", { credentialPath: path });
      } else expect(saved === undefined).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
      expect(await Promise.all(paths.map(metadata))).toEqual(before);
    }
  },
);
