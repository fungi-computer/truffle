import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLocalAuthCli } from "../src/auth-cli.js";
import {
  inactiveSubscriptionNotice,
  localLoginProviders,
} from "../src/local-login.js";
import { openPrivateModels } from "../src/local-models.js";
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { acquireSubscriptionTurn } from "../src/subscription-turn.js";
import { seedLoginExtension } from "./login-extension-fixture.js";

/**
 * A person who signed in with the Claude subscription before Fungi stopped
 * including that sign-in. Their record must survive untouched, be reported
 * honestly while nothing serves it, and work again, with its account identity,
 * once an installed extension fills the slot.
 */
let home: string;
let credentialPath: string;
let reported: string[];

const saved = {
  type: "oauth",
  access: "saved-access",
  refresh: "saved-refresh",
  expires: 0,
  accountId: "saved-account",
  // A real grant identity is the sha256 of the refresh token that first signed in.
  fungiAnthropicGrant: createHash("sha256")
    .update("first-refresh")
    .digest("hex"),
} as const;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-claude-migration-"));
  credentialPath = join(home, ".config", "fungi", "credentials.json");
  reported = [];
  await createPrivateCredentialStore(credentialPath).modify("anthropic", () =>
    Promise.resolve(saved),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const open = () =>
  openPrivateModels(credentialPath, {
    report: (error) => {
      reported.push(error.message);
    },
  });
const bytes = () => readFile(credentialPath, "utf8");

async function status(provider = "anthropic") {
  let text = "";
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  const result = await runLocalAuthCli(["status", "--provider", provider], {
    credentialPath,
    output,
  });
  return { text, result };
}

/** An extension whose sign-in is a fake Anthropic OAuth; no network, no Pi. */
async function installFakeClaudeExtension() {
  const directory = join(home, "packages", "fake-claude");
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "logins.mjs");
  await writeFile(
    entry,
    `export default () => [{
      providerId: "anthropic",
      method: "subscription",
      oauth: {
        name: "Fake Claude plan",
        isSubscription: true,
        login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000 }),
        refresh: async () => ({ type: "oauth", access: "refreshed-access", refresh: "refreshed-refresh", expires: Date.now() + 3600000 }),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    }];`,
  );
  await seedLoginExtension(home, {
    id: "fake-claude",
    entry,
    logins: [{ providerId: "anthropic", method: "subscription" }],
  });
}

describe("without an extension", () => {
  it("keeps the saved record byte for byte and says it is inactive", async () => {
    const before = await bytes();
    const models = await open();
    expect(await models.checkAuth("anthropic")).toBeUndefined();
    const { text, result } = await status();
    expect(text).toBe(`Anthropic (anthropic): ${inactiveSubscriptionNotice}\n`);
    expect(result).toMatchObject({
      kind: "status",
      providers: [{ providerId: "anthropic", state: "inactive" }],
    });
    // The login picker offers the API key, and no subscription sign-in.
    expect(
      localLoginProviders(models.getProviders())
        .find((provider) => provider.id === "anthropic")
        ?.methods.map((method) => method.kind),
    ).toEqual(["api_key"]);
    // A turn is refused with the same honest wording, and writes nothing.
    await expect(
      acquireSubscriptionTurn(models, "anthropic", AbortSignal.timeout(5_000)),
    ).rejects.toThrow(inactiveSubscriptionNotice);
    expect(await bytes()).toBe(before);
  });

  it("is refused by a runtime host opened from the home, with the same wording, writing nothing", async () => {
    const before = await bytes();
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    const host = await openPrivateLocalRuntimeHost({
      invocationRoot: project,
      configRoot: capturePrivateLocalConfigRoot(home),
    });
    try {
      await expect(
        host.effectiveModel("main", AbortSignal.timeout(5_000)),
      ).rejects.toThrow(`Anthropic: ${inactiveSubscriptionNotice}`);
    } finally {
      await host.close();
    }
    expect(await bytes()).toBe(before);
  });

  it("explains a requested subscription sign-in instead of saying it is not offered", async () => {
    await expect(
      runLocalAuthCli(
        ["login", "--provider", "anthropic", "--auth-type", "oauth"],
        {
          credentialPath,
          output: new PassThrough(),
          interaction: {
            signal: AbortSignal.timeout(5_000),
            prompt: () => Promise.reject(new Error("must not prompt")),
            notify: () => undefined,
          } satisfies AuthInteraction,
        },
      ),
    ).rejects.toThrow(
      "Anthropic (anthropic): Fungi does not include Claude subscription sign-in; an installed extension may provide it. Enable one with fungi extension enable logins <id>.",
    );
  });

  it("lets the person log out of a kept sign-in", async () => {
    const output = new PassThrough();
    await runLocalAuthCli(["logout"], {
      credentialPath,
      output,
      interaction: {
        signal: AbortSignal.timeout(5_000),
        prompt: (prompt) =>
          Promise.resolve(
            prompt.type === "select" ? (prompt.options[0]?.id ?? "") : "",
          ),
        notify: () => undefined,
      },
    });
    expect(
      await createPrivateCredentialStore(credentialPath).read("anthropic"),
    ).toBeUndefined();
  });

  it("reports no inactive line once a different credential replaces it", async () => {
    await createPrivateCredentialStore(credentialPath).modify("anthropic", () =>
      Promise.resolve({ type: "api_key", key: "sk-replacement" }),
    );
    const { text } = await status();
    expect(text).toBe("Anthropic (anthropic): signed in (API key)\n");
  });
});

describe("with an extension that supplies the slot", () => {
  it("is signed in again, keeps the saved identity through a refresh, and turns run", async () => {
    await installFakeClaudeExtension();
    const models = await open();
    expect(reported).toEqual([]);
    expect(
      localLoginProviders(models.getProviders())
        .find((provider) => provider.id === "anthropic")
        ?.methods.map((method) => `${method.kind}: ${method.label}`),
    ).toEqual([
      "api_key: Anthropic API key",
      "subscription: Fake Claude plan · from fake-claude",
    ]);
    const { text } = await status();
    expect(text).toBe("Anthropic (anthropic): signed in (subscription)\n");
    // The saved record expired, so asking for auth runs the extension's own
    // refresh, wrapped by Fungi's identity retention.
    const turn = await acquireSubscriptionTurn(
      models,
      "anthropic",
      AbortSignal.timeout(5_000),
    );
    try {
      await expect(turn.models.getAuth("anthropic")).resolves.toMatchObject({
        auth: { apiKey: "refreshed-access" },
      });
    } finally {
      await turn.release();
    }
    expect(
      await createPrivateCredentialStore(credentialPath).read("anthropic"),
    ).toMatchObject({
      type: "oauth",
      access: "refreshed-access",
      accountId: "saved-account",
      fungiAnthropicGrant: saved.fungiAnthropicGrant,
    });
  });
});
