import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { runTrackerGitCredential } from "../src/tracker-git-credential.js";

const capability = `fgit_${"a".repeat(64)}`;
const input = (text: string) => Readable.from([Buffer.from(text)]);
const remote = "https://publisher.test/git/tracker/tracker-repo.git";
const request =
  "protocol=https\nhost=publisher.test\npath=git/tracker/tracker-repo.git\n\n";
function fixture() {
  const stdout = { write: vi.fn() };
  const access = vi.fn(() => Promise.resolve("disposable-login"));
  const fetcher = vi.fn(() =>
    Promise.resolve(
      Response.json({
        remote,
        capability,
        permission: "write",
        expiresAt: Date.now() + 305_000,
      }),
    ),
  );
  const run = (text = request, action = "get") =>
    runTrackerGitCredential(
      {
        action,
        hub: "https://hub.test",
        teamId: "team-a",
        stdin: input(text),
        stdout,
      },
      { access, fetch: fetcher },
    );
  return { run, stdout, access, fetcher };
}

it("exchanges the login only at its trusted Hub and emits only the Git protocol, tolerating server clock skew", async () => {
  const { run, stdout, fetcher } = fixture();
  await run();
  expect(fetcher).toHaveBeenCalledWith(
    new URL("https://hub.test/api/teams/team-a/git/tracker/credential"),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer disposable-login" },
    }),
  );
  expect(stdout.write).toHaveBeenCalledOnce();
  expect(stdout.write.mock.calls[0]?.[0]).toMatch(
    /^username=fungi\npassword=fgit_[a-f0-9]{64}\npassword_expiry_utc=\d+\n\n$/u,
  );
});
it("never gives a capability to a different host or repository and never caches store/erase", async () => {
  const { run, stdout, access } = fixture();
  await run(request.replace("publisher.test", "attacker.test"));
  await run(request.replace("tracker-repo", "foreign"));
  await run(`password=${capability}\n\n`, "store");
  await run(`password=${capability}\n\n`, "erase");
  expect(stdout.write).not.toHaveBeenCalled();
  expect(access).toHaveBeenCalledTimes(2);
});
it("sanitizes malformed fields, schema errors, network failures and oversized input", async () => {
  const { run, stdout, fetcher } = fixture();
  fetcher.mockImplementation(() => Promise.reject(new Error(capability)));
  await expect(run()).rejects.toThrow("Tracker Git unavailable.");
  fetcher.mockImplementation(() =>
    Promise.resolve(Response.json({ capability, remote })),
  );
  await expect(run()).rejects.toThrow("Tracker Git unavailable.");
  await expect(
    run(
      request.replace(
        "host=publisher.test",
        "host=publisher.test\nhost=attacker.test",
      ),
    ),
  ).rejects.toThrow("Tracker Git unavailable.");
  await expect(run("x".repeat(8193))).rejects.toThrow(
    "Tracker Git unavailable.",
  );
  expect(stdout.write).not.toHaveBeenCalled();
});

it("discovers only the configured non-secret remote without reading Git stdin", async () => {
  const { run, stdout } = fixture();
  await run("not Git input", "remote");
  expect(stdout.write).toHaveBeenCalledExactlyOnceWith(`${remote}\n`);
});
