import { performance } from "node:perf_hooks";
import { expect, it } from "bun:test";
import { gc } from "bun";
import { heapStats } from "bun:jsc";
import { createModels, type Credential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createPrivateLocalModelSource } from "../src/private-local-runtime-host.js";

/**
 * Six children streaming a large tool call at once, through Local's real model
 * adapter and Pi's real Responses decoder, with the response already buffered.
 * The event loop must keep serving timers: the service watchdog's heartbeat is
 * one, and it ends the service after 30 seconds without a beat.
 *
 * The arguments stay an incomplete JSON object, as in the captured 2026-11-16
 * stall: two chunks of whitespace repeating 2,007 times each. Pi 1.3.0 re-parsed
 * the whole growing prefix on every delta: quadratic work that allocated
 * millions of short-lived strings (3.8M heap strings and +430 MB RSS in 30 s were
 * observed in the incident). Pi 1.5 parses each delta once, so the same stream
 * must stay inside the string and RSS bounds below.
 */
const children = 6;
const chunkPairs = 450;
/** Far under the watchdog's 30,000 ms; the unpaced stream reaches seconds. */
const maximumTimerGapMs = 500;
const sampleMs = 10;
/** Live heap strings above the quiet baseline, sampled while streaming. */
const maximumStringGrowth = 150_000;
/** Resident growth while six children stream. */
const maximumRssGrowthBytes = 120 * 1024 * 1024;

function responsesBody(): string {
  const call = {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_fixture",
    name: "execute",
    arguments: "",
  };
  const deltas = [
    '{"code":',
    ...Array.from({ length: chunkPairs }, () => [
      " ".repeat(128),
      `${" ".repeat(28)}\n`,
    ]).flat(),
  ];
  return [
    { type: "response.output_item.added", output_index: 0, item: call },
    ...deltas.map((delta) => ({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: '{"code":"fixture"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: '{"code":"fixture"}' },
    },
    {
      type: "response.completed",
      response: { status: "completed", output: [] },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

it("six children streaming a tool call do not starve the service's timers", async () => {
  const credential: Credential = { type: "api_key", key: "sk-fixture-only" };
  const models = createModels({
    credentials: {
      read: () => Promise.resolve(credential),
      list: () => Promise.resolve([{ providerId: "openai", type: "api_key" }]),
      modify: (_provider, change) => change(credential),
      delete: () => Promise.resolve(),
    },
  });
  models.setProvider(openaiProvider());
  const model = models
    .getModels("openai")
    .find((candidate) => candidate.api === "openai-responses");
  if (model === undefined) throw new Error("Fixture Responses model missing");
  const body = responsesBody();
  gc(true);
  const baselineStrings = heapStats().objectTypeCounts.string ?? 0;
  const baselineRss = process.memoryUsage.rss();
  let peakStrings = baselineStrings;
  let peakRss = baselineRss;

  let maxGapMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previous);
    previous = now;
    peakStrings = Math.max(
      peakStrings,
      heapStats().objectTypeCounts.string ?? 0,
    );
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, sampleMs);
  try {
    const stopReasons = await Promise.all(
      Array.from({ length: children }, async (_, index) => {
        const lease = await createPrivateLocalModelSource(
          models,
          "openai",
          model.id,
          `lag-${String(index)}`,
        ).acquire({
          sessionId: `lag-${String(index)}`,
          preference: null,
          signal: new AbortController().signal,
        });
        try {
          const stream = lease.stream;
          if (stream === undefined)
            throw new Error("Expected the Local model stream");
          const events = await stream(
            lease.model,
            { messages: [] },
            {
              apiKey: "sk-fixture-only",
              fetch: Object.assign(
                () =>
                  Promise.resolve(
                    new Response(body, {
                      headers: { "content-type": "text/event-stream" },
                    }),
                  ),
                globalThis.fetch,
              ),
            },
          );
          for await (const event of events) {
            if (event.type === "error") throw new Error("Stream failed");
          }
          return (await events.result()).stopReason;
        } finally {
          await lease.release();
        }
      }),
    );
    // A starved timer never ticks, so also count the wait still in progress.
    maxGapMs = Math.max(maxGapMs, performance.now() - previous);
    expect(stopReasons).toEqual(
      Array.from({ length: children }, () => "toolUse"),
    );
  } finally {
    clearInterval(timer);
  }
  console.log(
    JSON.stringify({
      event: "stream-lag",
      maxGapMs,
      stringGrowth: peakStrings - baselineStrings,
      rssGrowthMiB: Math.round((peakRss - baselineRss) / 1024 / 1024),
    }),
  );
  expect(maxGapMs).toBeLessThan(maximumTimerGapMs);
  expect(peakStrings - baselineStrings).toBeLessThan(maximumStringGrowth);
  expect(peakRss - baselineRss).toBeLessThan(maximumRssGrowthBytes);
}, 60_000);
