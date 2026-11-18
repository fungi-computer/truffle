import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
// The ordinary build bundles workerd's entrypoint; source imports cannot execute it.
import {
  openPrivateLocalRuntimeHost,
  type PrivateLocalRuntimeHost,
} from "../dist/private-local-runtime-host.js";

it("refuses a prompt holding a key this machine stores, and stores nothing of it", async () => {
  const area = await mkdtemp(join(tmpdir(), "fungi-local-secret-intake-"));
  const configRoot = capturePrivateLocalConfigRoot(join(area, "home"));
  await mkdir(configRoot.home, { recursive: true });
  await mkdir(join(area, "project"));
  const project = await realpath(join(area, "project"));
  // No public pattern knows this shape: only the stored-key fingerprints can.
  const storedKey = `local-vault-canary-${crypto.randomUUID()}`;
  await createPrivateCredentialStore(configRoot.credentialPath).modify(
    "anthropic",
    () => Promise.resolve({ type: "api_key", key: storedKey }),
  );
  const faux = fauxProvider({
    provider: "secret-intake-fixture",
    models: [{ id: "probe", name: "Secret intake probe" }],
  });
  faux.setResponses([fauxAssistantMessage("Keep keys in /login.")]);
  const models = createModels();
  models.setProvider(faux.provider);
  let host: PrivateLocalRuntimeHost | undefined;
  try {
    host = await openPrivateLocalRuntimeHost(
      {
        invocationRoot: project,
        configRoot,
        providerId: "secret-intake-fixture",
        modelId: "probe",
      },
      models,
    );
    await expect(
      host.session.send(`use ${storedKey} for the deploy`, {
        requestId: "pasted",
      }),
    ).rejects.toMatchObject({
      boundary: "contract",
      cause: "secret_in_prompt",
    });
    // A prompt that only talks about keys is an ordinary prompt.
    const accepted = await host.session.send("Where do API keys go?", {
      requestId: "talk",
    });
    expect(accepted.status).toBe("accepted");
    const directory = dirname(host.databasePath);
    await host.close();
    host = undefined;
    const stored = await Promise.all(
      (await readdir(directory)).map((name) =>
        readFile(join(directory, name)).then(
          (bytes) => bytes.toString("latin1"),
          () => "",
        ),
      ),
    );
    expect(stored.join("\n")).not.toContain(storedKey);
  } finally {
    await host?.close();
    await rm(area, { recursive: true, force: true });
  }
}, 30_000);
