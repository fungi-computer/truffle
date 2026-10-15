import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  loginIdentity,
  pendingLogouts,
} from "../src/private-fungi-pending-logouts.js";

it("reports unusable family identity without exposing the token", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(
      loginIdentity("https://hub.test", "fixture-opaque-token"),
    ).toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toBe(
      JSON.stringify({
        source: "local-runtime",
        operation: "fungi-account.pending-revoke-identity",
        failureKind: "Error",
      }),
    );
  } finally {
    report.mockRestore();
  }
});

it("retains the latest logout when the private journal fills, reporting oldest eviction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pending-logout-cap-"));
  const credentialPath = join(root, "credentials.json");
  const journal = pendingLogouts(credentialPath);
  const identity = {
    issuer: "https://hub.test",
    userId: "account-a",
    loginId: "latest-login",
  };
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (let index = 0; index < 128; index += 1)
      await journal.remember(
        { ...identity, loginId: `old-${String(index)}` },
        [],
      );
    await journal.remember(identity, []);
    const records = await journal.forAccount(identity);
    expect(records).toHaveLength(128);
    expect(records[0]?.loginId).toBe("old-1");
    expect(records.at(-1)?.loginId).toBe("latest-login");
    expect(report).toHaveBeenCalledOnce();
    expect(String(report.mock.calls[0]?.[0])).toContain(
      "pending-logout-evicted",
    );
    expect(
      (await stat(`${credentialPath}.pending-logouts.json`)).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await readFile(`${credentialPath}.pending-logouts.json`)).byteLength,
    ).toBeLessThan(256 * 1024);
  } finally {
    report.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
