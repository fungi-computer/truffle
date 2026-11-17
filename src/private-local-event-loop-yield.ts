import { performance } from "node:perf_hooks";

/**
 * Longest a model stream may keep the service's event loop before timers run.
 * The watchdog heartbeat is a timer: events from a provider that arrive faster
 * than they are processed would otherwise drain as microtasks for as long as
 * the buffer lasts, starving the heartbeat, aborts and every other stream.
 */
const eventLoopSliceMs = 8;

let sliceStartedAt = performance.now();

/**
 * Await between provider events. Resolves at once while the current slice has
 * time left; otherwise it hands the loop a timers turn first. All streams
 * share one slice because the loop they share is one resource. After an idle
 * gap the first event yields once, which costs one timer hop and restarts
 * the slice.
 */
export function yieldToEventLoop(): Promise<void> {
  if (performance.now() - sliceStartedAt < eventLoopSliceMs)
    return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      sliceStartedAt = performance.now();
      resolve();
    }, 0);
  });
}
