import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux").each([
  ["no bus address or runtime directory", undefined],
  ["runtime directory without a bus socket", "absent-runtime"],
  ["explicit missing bus socket", "explicit-missing"],
])(
  "uses a warned 0600 file without Secret Service (%s), once per process",
  async (_scenario, busScenario) => {
    const home = await mkdtemp(join(tmpdir(), "oyster-no-secret-service-"));
    const credentialPath = join(home, ".config", "fungi", "credentials.json");
    try {
      const script = `
      import { saveOysterMcpKey, oysterMcpKeyAuth } from './src/private-oyster-mcp-auth.ts';
      import { Readable } from 'node:stream';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const key = Buffer.concat(chunks).toString('utf8').trim();
      const endpoint = new URL('https://oyster.test/mcp');
      const path = process.env.OYSTER_PROOF_PATH;
      await saveOysterMcpKey(endpoint, Readable.from([Buffer.from(key)]), { credentialPath: path });
      const auth = oysterMcpKeyAuth(endpoint, { credentialPath: path });
      if (await auth.token() !== key || await auth.token() !== key)
        throw new Error('Oyster key was not read back from file custody');
    `;
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          input: "oyk_disposable-fallback-key\n",
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_RUNTIME_DIR:
              busScenario === "absent-runtime"
                ? join(home, "absent-runtime")
                : undefined,
            DBUS_SESSION_BUS_ADDRESS:
              busScenario === "explicit-missing"
                ? `unix:path=${join(home, "absent-bus")}`
                : undefined,
            OYSTER_PROOF_PATH: credentialPath,
            HEAVY: "/tmp/botanical-absent-heavy",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.split("OS keychain unavailable").length - 1).toBe(1);
      expect(result.stderr).toContain(JSON.stringify(credentialPath));
      expect(result.stderr).toContain("Linux Secret Service");
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(credentialPath, "utf8"))).toHaveProperty(
        "oyster-mcp:https://oyster.test",
        {
          type: "api_key",
          key: "oyk_disposable-fallback-key",
        },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
