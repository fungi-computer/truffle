import { RpcTarget, newMessagePortRpcSession } from "@fungi.computer/capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrivateLocalAuthTarget,
  runPrivateLocalAuthRemote,
  type PrivateLocalAuthEndpoint,
} from "../src/private-local-auth-rpc.js";
import type { runLocalAuthCli } from "../src/auth-cli.js";

/** An endpoint whose cancel is refused while its run ends as soon as it is asked to. */
class RefusingEndpoint extends RpcTarget implements PrivateLocalAuthEndpoint {
  #ended = Promise.withResolvers<never>();
  cancel(): void {
    queueMicrotask(() => {
      this.#ended.reject(new Error("Authentication cancelled"));
    });
    throw new Error("cancel exploded");
  }
  run(): Promise<never> {
    return this.#ended.promise;
  }
  signOutFungi(): Promise<never> {
    throw new Error("Provider cancellation must not invoke account logout");
  }
}

function connect(endpoint: RpcTarget) {
  const channel = new MessageChannel();
  newMessagePortRpcSession(channel.port2, endpoint);
  const remote = newMessagePortRpcSession<PrivateLocalAuthEndpoint>(
    channel.port1,
  );
  return {
    remote,
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ending a sign-in the human dismissed", () => {
  it("is a calm cancel: nothing is reported or printed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const waiting: typeof runLocalAuthCli = (_args, options) =>
      new Promise((_resolve, reject) => {
        options?.interaction?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
        options?.interaction?.notify({ type: "info", message: "Waiting" });
      });
    const { remote, close } = connect(
      new PrivateLocalAuthTarget(waiting, () => {
        throw new Error("Provider auth must not invoke account logout");
      }),
    );
    const reported: unknown[] = [];
    const dismiss = new AbortController();
    const running = runPrivateLocalAuthRemote(
      remote,
      { command: "login" },
      {
        signal: dismiss.signal,
        prompt: () => Promise.resolve(""),
        notify: () => {
          dismiss.abort();
        },
      },
      (cause) => reported.push(cause),
    );
    await expect(running).rejects.toThrow(/Authentication cancelled/u);
    close();
    expect(reported).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a cancel the service really refused, with its cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { remote, close } = connect(new RefusingEndpoint());
    const reported: unknown[] = [];
    const dismiss = new AbortController();
    const running = runPrivateLocalAuthRemote(
      remote,
      { command: "login" },
      {
        signal: dismiss.signal,
        prompt: () => Promise.resolve(""),
        notify: () => undefined,
      },
      (cause) => reported.push(cause),
    );
    dismiss.abort();
    await expect(running).rejects.toThrow();
    close();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ message: "cancel exploded" });
    expect(warn).not.toHaveBeenCalled();
  });
});
