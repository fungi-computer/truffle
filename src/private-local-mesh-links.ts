import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  PostEnvelope,
  PostDeliveryResult,
} from "@fungi.computer/carrier/post";
import {
  createMachineLinkPostChannel,
  MachineLinkPostUnavailable,
  machineLinkAudience,
  machineLinkDialUrl,
} from "@fungi.computer/seam/machine-link-protocol";
import {
  importSeamSigner,
  signSeamRequest,
  seamHeader,
  unsignedPayload,
} from "@fungi.computer/seam";
import { createLocalMachineEnrollmentAccount } from "./private-fungi-account.js";
import type {
  LocalMachineEnrollment,
  MachineEnrollmentAuthority,
} from "./private-local-mesh-record.js";
import { logEvent } from "./log-event.js";

export type EnrolledLocalMachine = Extract<
  LocalMachineEnrollment,
  { state: "enrolled" }
> & { authority: MachineEnrollmentAuthority };
export const localMeshLinkKey = (record: EnrolledLocalMachine) =>
  JSON.stringify([
    record.authority.kind,
    record.authority.origin,
    record.scopeId,
    record.deviceId,
  ]);
type Channel = ReturnType<typeof createMachineLinkPostChannel>;
type ServiceLink = {
  record: EnrolledLocalMachine;
  stop: AbortController;
  done: Promise<"stopped">;
  channel: Channel | undefined;
};

/**
 * Service-owned native I/O only. The account owns pins, Carrier owns retry
 * custody, and the addressed runtime owns acceptance. No mail is queued here.
 */
export function createLocalMeshLinks(
  options: {
    credentialPath: string;
    receive: (
      record: EnrolledLocalMachine,
      envelope: PostEnvelope,
    ) => Promise<PostDeliveryResult>;
  },
  timing: Readonly<{
    wait: (ms: number, signal: AbortSignal) => Promise<void>;
    random: () => number;
  }> = {
    wait: (ms, signal) => delay(ms, undefined, { signal }),
    random: Math.random,
  },
) {
  const account = createLocalMachineEnrollmentAccount(options.credentialPath);
  const links = new Map<string, ServiceLink>();
  let stopping = false;
  let refreshing: Promise<void> | undefined;
  const isStopping = () => stopping;

  async function current(record: EnrolledLocalMachine) {
    const saved = await account.read();
    const { authority, ...pin } = record;
    return saved.some(
      (source) =>
        source.kind === authority.kind &&
        source.origin === authority.origin &&
        source.enrollments.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(pin),
        ),
    );
  }

  async function isCurrent(record: EnrolledLocalMachine): Promise<boolean> {
    const link = links.get(localMeshLinkKey(record));
    return (
      link !== undefined &&
      !link.stop.signal.aborted &&
      (await current(link.record))
    );
  }

  // WebSocket's error event does not expose the HTTP upgrade response. A
  // freshly signed plain GET can surface the receiver's upgrade hint. The
  // response is NOT signed: this is diagnostic only, never authority to stop.
  async function upgradeAdvertised(
    record: EnrolledLocalMachine,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const url = machineLinkDialUrl(
        record.authority.origin,
        record.scopeId,
        record.deviceId,
      );
      const signer = await importSeamSigner(
        `${record.deviceId}:${record.privateKey}`,
      );
      const signature = await signSeamRequest(
        signer,
        machineLinkAudience(record.scopeId, record.deviceId),
        "GET",
        url.href,
        unsignedPayload,
      );
      const response = await fetch(url, {
        headers: { [seamHeader]: signature },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      await response.body?.cancel();
      return (
        response.status === 426 &&
        response.headers.get("x-fungi-machine-link-action") === "upgrade fungi"
      );
    } catch {
      return false;
    }
  }

  /** Equal jitter avoids synchronized immediate retries even at the 15 s cap. */
  const retryMs = (failures: number, random: number) => {
    const ceiling = Math.min(15_000, 500 * 2 ** Math.min(failures, 5));
    return Math.floor((ceiling * (1 + random)) / 2);
  };

  async function connection(
    record: EnrolledLocalMachine,
    signal: AbortSignal,
    publish: (channel: Channel | undefined) => void,
  ): Promise<void> {
    const url = machineLinkDialUrl(
      record.authority.origin,
      record.scopeId,
      record.deviceId,
    );
    const signer = await importSeamSigner(
      `${record.deviceId}:${record.privateKey}`,
    );
    const signature = await signSeamRequest(
      signer,
      machineLinkAudience(record.scopeId, record.deviceId),
      "GET",
      url.href,
      unsignedPayload,
    );
    signal.throwIfAborted();
    if (!(await current(record)))
      throw new MachineLinkPostUnavailable({ reason: "closed" });
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: {
        [seamHeader]: signature,
      },
    });
    const channel = createMachineLinkPostChannel({
      limits: {
        maxInFlight: 32,
        maxFrameBytes: 512 * 1024,
        acknowledgmentMs: 10_000,
      },
      send: (frame) => {
        socket.send(frame);
      },
      receive: async (envelope) =>
        (await current(record)) ? options.receive(record, envelope) : "refused",
    });
    let ping: ReturnType<typeof setInterval> | undefined;
    let pong: ReturnType<typeof setTimeout> | undefined;
    let opening: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      socket.close(1000, "service stopping");
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (cause: unknown) => {
          reject(
            cause instanceof Error
              ? cause
              : new Error("Machine link failed", { cause }),
          );
        };
        opening = setTimeout(() => {
          fail(new Error("Machine link upgrade timed out"));
        }, 10_000);
        signal.addEventListener("abort", abort, { once: true });
        socket.addEventListener("error", () => {
          fail(new Error("Machine link native socket failed"));
        });
        socket.addEventListener(
          "close",
          () => {
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(opening);
            publish(channel);
            ping = setInterval(() => {
              void current(record).then((allowed) => {
                if (!allowed) {
                  fail(new MachineLinkPostUnavailable({ reason: "closed" }));
                  return;
                }
                try {
                  socket.send("ping");
                } catch (cause) {
                  reject(new Error("Machine link ping failed", { cause }));
                  return;
                }
                pong = setTimeout(() => {
                  fail(new Error("Machine link pong timed out"));
                }, 10_000);
              }, fail);
            }, 30_000);
          },
          { once: true },
        );
        socket.addEventListener("message", (event) => {
          if (event.data === "pong") {
            clearTimeout(pong);
            return;
          }
          const text = z.string().safeParse(event.data);
          if (!text.success) {
            fail(new Error("Machine link requires text frames"));
            return;
          }
          // EventTarget cannot await a handler. Transfer its actual outcome to
          // the connection's awaited lifetime, never a detached dropped catch.
          void channel.receive(text.data).then(() => undefined, fail);
        });
      });
    } finally {
      publish(undefined);
      signal.removeEventListener("abort", abort);
      clearTimeout(opening);
      clearInterval(ping);
      clearTimeout(pong);
      channel.close();
      socket.close(1000, "connection ended");
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing !== undefined) {
      await refreshing;
      await refresh();
      return;
    }
    const task = (async () => {
      if (isStopping()) return;
      const saved = await account.read();
      const enrolled = saved.flatMap(({ kind, origin, enrollments }) =>
        enrollments.flatMap((record): EnrolledLocalMachine[] =>
          record.state === "enrolled"
            ? [{ ...record, authority: { kind, origin } }]
            : [],
        ),
      );
      for (const [key, link] of links)
        if (
          !enrolled.some(
            (record) =>
              localMeshLinkKey(record) === key &&
              JSON.stringify(record) === JSON.stringify(link.record),
          )
        ) {
          link.stop.abort();
          await link.done;
          links.delete(key);
        }
      if (isStopping()) return;
      for (const record of enrolled) {
        const key = localMeshLinkKey(record);
        if (links.has(key)) continue;
        const stop = new AbortController();
        const stopped = () => stop.signal.aborted;
        const link: ServiceLink = {
          record,
          stop,
          channel: undefined,
          done: (async (): Promise<"stopped"> => {
            let failures = 0;
            let upgradeNotified = false;
            while (!stopped()) {
              try {
                if (!(await current(record))) return "stopped";
                await connection(record, stop.signal, (channel) => {
                  link.channel = channel;
                  if (channel !== undefined) {
                    failures = 0;
                    upgradeNotified = false;
                  }
                });
              } catch (cause) {
                if (stopped()) return "stopped";
                logEvent("mesh-link.connection", cause);
                const advertised = await upgradeAdvertised(record, stop.signal);
                if (stopped()) return "stopped";
                if (advertised) {
                  // A forged refusal can delay a link, not permanently kill it.
                  // Emit once per outage and retry at the bounded cap.
                  if (!upgradeNotified) console.error("upgrade fungi");
                  upgradeNotified = true;
                  failures = 5;
                }
              }
              try {
                await timing.wait(
                  retryMs(failures, timing.random()),
                  stop.signal,
                );
                failures = Math.min(failures + 1, 5);
              } catch (cause) {
                if (stopped()) return "stopped";
                throw cause;
              }
            }
            return "stopped";
          })(),
        };
        links.set(key, link);
      }
    })();
    refreshing = task;
    try {
      await task;
    } finally {
      refreshing = undefined;
    }
  }

  return {
    refresh,
    isCurrent,
    deliver: async (record: EnrolledLocalMachine, envelope: PostEnvelope) => {
      const link = links.get(localMeshLinkKey(record));
      const channel = link?.channel;
      if (channel === undefined || !(await isCurrent(record))) {
        // An unavailable send is Carrier's retry, not authority to retire a
        // service-owned link while its redial is waiting.
        throw new MachineLinkPostUnavailable({ reason: "closed" });
      }
      return await channel.deliver(envelope);
    },
    close: async () => {
      stopping = true;
      try {
        await refreshing;
      } finally {
        for (const link of links.values()) link.stop.abort();
        try {
          await Promise.all([...links.values()].map((link) => link.done));
        } finally {
          links.clear();
        }
      }
    },
  };
}
