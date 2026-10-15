import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchPrivateLocalRequest } from "../src/private-local-http-dispatch.js";

/** The native socket starts with a ten-second idle limit. */
function socketClock(request: Request) {
  const expiry = Promise.withResolvers<never>();
  let timer: ReturnType<typeof setTimeout>;
  const limits: number[] = [];
  const clock = {
    timeout(selected: Request, seconds: number) {
      expect(selected).toBe(request);
      limits.push(seconds);
      clearTimeout(timer);
      if (seconds > 0)
        timer = setTimeout(() => {
          expiry.reject(new Error("socket idle"));
        }, seconds * 1000);
    },
  };
  clock.timeout(request, 10);
  return { clock, expiry: expiry.promise, limits };
}

afterEach(() => vi.useRealTimers());

describe("Local HTTP socket idle policy", () => {
  it("keeps quiet SSE and the first held command alive beyond the native idle boundary", async () => {
    vi.useFakeTimers();
    const release = Promise.withResolvers<undefined>();
    const observation = new Request("http://127.0.0.1/events");
    const command = new Request("http://127.0.0.1/command", { method: "POST" });
    const eventSocket = socketClock(observation);
    const commandSocket = socketClock(command);
    const response = await dispatchPrivateLocalRequest(
      observation,
      eventSocket.clock,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("data: retrying\n\n"),
              );
              void release.promise.then(() => {
                controller.enqueue(
                  new TextEncoder().encode("data: cancelling\n\n"),
                );
                controller.close();
              });
            },
          }),
          { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
        ),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) throw new Error("SSE body missing");
    expect(
      new TextDecoder().decode(
        z.instanceof(Uint8Array).parse((await reader.read()).value),
      ),
    ).toContain("retrying");
    let completed = false;
    const pending = Promise.allSettled([
      Promise.race([reader.read(), eventSocket.expiry]),
      Promise.race([
        dispatchPrivateLocalRequest(command, commandSocket.clock, async () => {
          await release.promise;
          return Response.json({
            status: "accepted",
            commandId: "first-after-error",
          });
        }),
        commandSocket.expiry,
      ]),
    ]).then((result) => {
      completed = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(12_000);
      expect(completed).toBe(false);
      expect(eventSocket.limits).toEqual([10, 0]);
      expect(commandSocket.limits).toEqual([10, 0]);
      release.resolve(undefined);
      const [frame, receipt] = await pending;
      expect(frame.status).toBe("fulfilled");
      if (frame.status !== "fulfilled") throw new Error("SSE frame failed");
      expect(
        new TextDecoder().decode(
          z.instanceof(Uint8Array).parse(frame.value.value),
        ),
      ).toContain("cancelling");
      expect(receipt.status).toBe("fulfilled");
      if (receipt.status !== "fulfilled")
        throw new Error("Command receipt failed");
      expect(await receipt.value.json()).toEqual({
        status: "accepted",
        commandId: "first-after-error",
      });
      expect(commandSocket.limits).toEqual([10, 0, 10]);
      expect(eventSocket.limits).toEqual([10, 0]);
    } finally {
      release.resolve(undefined);
      await pending;
      await reader.cancel();
    }
  });

  it("restores the native idle clock and preserves the same handler failure", async () => {
    vi.useFakeTimers();
    const request = new Request("http://127.0.0.1/command", { method: "POST" });
    const socket = socketClock(request);
    const failure = new Error("owner failed");
    await expect(
      dispatchPrivateLocalRequest(request, socket.clock, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(socket.limits).toEqual([10, 0, 10]);
    const expired = Promise.allSettled([socket.expiry]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await expired).toEqual([
      { status: "rejected", reason: new Error("socket idle") },
    ]);
  });
});
