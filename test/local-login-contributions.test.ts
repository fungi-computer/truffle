import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalAuthCli } from "../src/auth-cli.js";
import { localLoginProviders } from "../src/local-login.js";
import {
  LocalExtensionError,
  loginsLoadTimeoutMs,
  localExtensions,
} from "../src/local-extensions.js";
import { openPrivateModels } from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import {
  fixtureProvider,
  loginExtensionEntry,
  seedLoginExtension,
} from "./login-extension-fixture.js";

let home: string;
let credentialPath: string;
let reported: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-login-contributions-"));
  credentialPath = join(home, ".config", "fungi", "credentials.json");
  reported = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const open = (
  providers: readonly Provider[] = [fixtureProvider()],
  path: string = credentialPath,
) =>
  openPrivateModels(path, {
    providers,
    report: (error) => {
      reported.push(error.message);
    },
  });

const subscription = {
  providerId: "fixture",
  method: "subscription",
} as const;

const method = (models: Awaited<ReturnType<typeof open>>) =>
  localLoginProviders(models.getProviders())
    .find((provider) => provider.id === "fixture")
    ?.methods.map((one) => `${one.kind}: ${one.label}`);

/** A package whose `./logins` entry is the given module text. */
async function writeEntry(name: string, text: string) {
  const directory = join(home, "packages", name);
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "logins.mjs");
  await writeFile(entry, text);
  return entry;
}

const interaction = (answer = "browser"): AuthInteraction => ({
  signal: AbortSignal.timeout(5_000),
  prompt: () => Promise.resolve(answer),
  notify: () => undefined,
});

describe("an extension filling an empty login slot", () => {
  it("fills the empty subscription slot and labels it from the extension", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    const models = await open();
    expect(method(models)).toEqual([
      "api_key: Fixture API key",
      "subscription: Fixture subscription · from login-fixture",
    ]);
    expect(reported).toEqual([]);
  });

  it("leaves the slot empty when the extension is installed but not enabled", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
      enabled: false,
    });
    expect(method(await open())).toEqual(["api_key: Fixture API key"]);
  });

  it("opens with no extension records at all, creating none", async () => {
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    await expect(
      readFile(join(home, ".fungi", "extensions", "installed.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(reported).toEqual([]);
  });

  it("signs in through fungi login and stores the credential under the provider", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    const models = await open();
    const notices: string[] = [];
    await runLocalAuthCli(
      ["login", "--provider", "fixture", "--auth-type", "oauth"],
      {
        models,
        interaction: {
          ...interaction(),
          notify: (event) => {
            if (event.type === "info") notices.push(event.message);
          },
        },
      },
    );
    expect(notices).toEqual(["Fixture login complete."]);
    const stored =
      await createPrivateCredentialStore(credentialPath).read("fixture");
    expect(stored).toMatchObject({
      type: "oauth",
      access: "fixture-access",
      fixtureMethod: "browser",
    });
    let status = "";
    const statusOutput = new PassThrough();
    statusOutput.on("data", (chunk: Buffer) => {
      status += chunk.toString();
    });
    await runLocalAuthCli(["status", "--provider", "fixture"], {
      models,
      output: statusOutput,
    });
    expect(status).toContain("signed in (subscription)");
  });

  it("is found by fungi login itself, from the home of the credential path", async () => {
    const entry = await writeEntry(
      "deepseek-login",
      `export default () => [{
        providerId: "deepseek",
        method: "subscription",
        oauth: {
          name: "Deepseek plan",
          login: async () => ({
            type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600000,
          }),
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      }];`,
    );
    await seedLoginExtension(home, {
      id: "deepseek-login",
      entry,
      logins: [{ providerId: "deepseek", method: "subscription" }],
    });
    // No collection is supplied: the CLI opens its own over Pi's real
    // providers, where `deepseek` has an API key login and no subscription one.
    await runLocalAuthCli(
      ["login", "--provider", "deepseek", "--auth-type", "oauth"],
      {
        credentialPath,
        output: new PassThrough(),
        interaction: interaction(),
      },
    );
    expect(
      await createPrivateCredentialStore(credentialPath).read("deepseek"),
    ).toMatchObject({ type: "oauth", access: "a" });
  });

  it("fills an empty API key slot and labels it too", async () => {
    const entry = await writeEntry(
      "keyed",
      `export default () => [{
        providerId: "fixture-oauth-only",
        method: "api_key",
        apiKey: {
          name: "Keyed",
          login: async () => ({ type: "api_key", key: "k" }),
          resolve: async () => undefined,
        },
      }];`,
    );
    await seedLoginExtension(home, {
      id: "keyed",
      entry,
      logins: [{ providerId: "fixture-oauth-only", method: "api_key" }],
    });
    const oauthOnly: Provider = {
      ...fixtureProvider("fixture-oauth-only"),
      auth: {
        oauth: {
          name: "Built-in sign-in",
          login: () => Promise.reject(new Error("not used")),
          refresh: () => Promise.reject(new Error("not used")),
          toAuth: () => Promise.reject(new Error("not used")),
        },
      },
    };
    const models = await open([oauthOnly]);
    expect(
      localLoginProviders(models.getProviders())
        .find((provider) => provider.id === "fixture-oauth-only")
        ?.methods.map((one) => one.label),
    ).toEqual(["Keyed · from keyed", "Built-in sign-in"]);
  });
});

describe("which home's extensions fill a slot", () => {
  it("reads only the home its credential path belongs to", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    // A credential path that is not a home's default belongs to no home, so
    // it can never reach another home's extensions, the real one included.
    expect(
      method(await open([fixtureProvider()], join(home, "creds.json"))),
    ).toEqual(["api_key: Fixture API key"]);
    const other = await mkdtemp(join(tmpdir(), "fungi-other-home-"));
    try {
      expect(
        method(
          await open(
            [fixtureProvider()],
            join(other, ".config", "fungi", "credentials.json"),
          ),
        ),
      ).toEqual(["api_key: Fixture API key"]);
      expect(method(await open())).toHaveLength(2);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    expect(reported).toEqual([]);
  });
});

describe("refusals", () => {
  it("never shadows a login Fungi's own provider already offers", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    const builtIn = {
      ...fixtureProvider(),
      auth: {
        ...fixtureProvider().auth,
        oauth: {
          name: "Built-in sign-in",
          login: () => Promise.reject(new Error("not used")),
          refresh: () => Promise.reject(new Error("not used")),
          toAuth: () => Promise.reject(new Error("not used")),
        },
      },
    } satisfies Provider;
    const models = await open([builtIn]);
    expect(method(models)).toEqual([
      "api_key: Fixture API key",
      "subscription: Built-in sign-in",
    ]);
    expect(reported).toEqual([
      "Extension login-fixture did not fill the fixture subscription login: Fungi already provides this sign-in",
    ]);
  });

  it("adds no provider of its own", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    const models = await open([fixtureProvider("another")]);
    expect(models.getProvider("fixture")).toBeUndefined();
    expect(reported).toEqual([
      "Extension login-fixture did not fill the fixture subscription login: the provider is not available here",
    ]);
  });

  it("refuses both extensions when two claim one slot", async () => {
    for (const id of ["first", "second"])
      await seedLoginExtension(home, {
        id,
        entry: loginExtensionEntry,
        logins: [subscription],
      });
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    expect(reported).toHaveLength(2);
    for (const id of ["first", "second"])
      expect(reported).toContain(
        `Extension ${id} did not fill the fixture subscription login: first and second both claim it, so neither is used`,
      );
  });

  it("refuses a slot Veil forbids an extension, whatever the extension offers", async () => {
    const entry = await writeEntry(
      "openrouter",
      `export default () => [{
        providerId: "openrouter",
        method: "subscription",
        oauth: {
          name: "Not offered",
          login: async () => ({}),
          refresh: async () => ({}),
          toAuth: async () => ({}),
        },
      }];`,
    );
    await seedLoginExtension(home, {
      id: "wants-openrouter",
      entry,
      logins: [{ providerId: "openrouter", method: "subscription" }],
    });
    const openrouter = builtinProviders().find(
      (provider) => provider.id === "openrouter",
    );
    if (openrouter === undefined) throw new Error("Pi has no openrouter");
    const models = await open([openrouter]);
    expect(models.getProvider("openrouter")?.auth.oauth).toBeUndefined();
    expect(reported).toEqual([
      "Extension wants-openrouter did not fill the openrouter subscription login: Fungi does not allow an extension to provide it",
    ]);
  });

  it("applies the subscription kill switch to an extension's login", async () => {
    await seedLoginExtension(home, {
      id: "login-fixture",
      entry: loginExtensionEntry,
      logins: [subscription],
    });
    vi.stubEnv("FUNGI_SUBSCRIPTION_KILL", "fixture");
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    expect(reported).toEqual([
      "Extension login-fixture did not fill the fixture subscription login: Fungi does not allow an extension to provide it",
    ]);
  });

  it("gives a diagnostic and no slot for a module that throws, is missing or lies", async () => {
    const throws = await writeEntry(
      "throws",
      `export default () => { throw new Error("boom"); };`,
    );
    const lies = await writeEntry(
      "lies",
      `export default () => [{
        providerId: "fixture", method: "api_key",
        apiKey: { name: "x", login: async () => ({}), resolve: async () => undefined },
      }];`,
    );
    const notAFactory = await writeEntry("plain", "export default 1;");
    for (const [id, entry] of [
      ["throws", throws],
      ["lies", lies],
      ["plain", notAFactory],
      ["missing", join(home, "packages", "missing", "logins.mjs")],
    ] as const)
      await seedLoginExtension(home, { id, entry, logins: [subscription] });
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    expect(reported.sort()).toEqual([
      "Extension lies contributes fixture api_key but declares fixture subscription",
      "Extension missing logins could not load",
      "Extension plain logins could not load",
      "Extension throws logins could not load",
    ]);
  });

  it("reports damaged extension records and leaves built-in sign-in alone", async () => {
    await mkdir(join(home, ".fungi", "extensions"), { recursive: true });
    await writeFile(
      join(home, ".fungi", "extensions", "activations.json"),
      "{ not json",
    );
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    expect(reported).toEqual([
      "Extension logins could not be read; built-in sign-in is unchanged",
    ]);
  });
});

describe("an extension that never settles", () => {
  const hang = `await new Promise(() => {});
export default () => [];`;

  it("is skipped after the timeout with a typed diagnostic naming it", async () => {
    const entry = await writeEntry("hangs-owner", hang);
    await seedLoginExtension(home, {
      id: "hangs",
      entry,
      logins: [subscription],
    });
    const owner = localExtensions({ home, loginsTimeoutMs: 50 });
    const first = await owner.logins();
    expect(first.contributions).toEqual([]);
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]?.extensionId).toBe("hangs");
    expect(first.diagnostics[0]?.error).toBeInstanceOf(LocalExtensionError);
    expect(first.diagnostics[0]?.error).toMatchObject({ reason: "load" });
    expect(first.diagnostics[0]?.error.message).toBe(
      "Extension hangs logins did not finish loading within 50 ms and are skipped",
    );
    // Already known to hang: skipped at once, not awaited again.
    const started = Date.now();
    expect((await owner.logins()).diagnostics).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(40);
  });

  it("leaves built-in sign-in working and reports the extension", async () => {
    const entry = await writeEntry("hangs-models", hang);
    await seedLoginExtension(home, {
      id: "hangs",
      entry,
      logins: [subscription],
    });
    const models = await open();
    expect(method(models)).toEqual(["api_key: Fixture API key"]);
    expect(reported).toEqual([
      `Extension hangs logins did not finish loading within ${String(loginsLoadTimeoutMs)} ms and are skipped`,
    ]);
    const output = new PassThrough();
    await runLocalAuthCli(
      ["login", "--provider", "fixture", "--auth-type", "api_key"],
      { models, output, interaction: interaction() },
    );
    expect(
      await createPrivateCredentialStore(credentialPath).read("fixture"),
    ).toMatchObject({ type: "api_key", key: "fixture-key" });
  }, 20_000);
});
