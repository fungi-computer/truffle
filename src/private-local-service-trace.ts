import { Buffer } from "node:buffer";
import { z } from "zod";
import type { decodeProviderData } from "@fungi.computer/mule";

/** Selected provider output only; raw response configuration is never serialized. */
export type LocalModelStreamRecord = Readonly<
  {
    requestId: string;
    providerId: string;
    modelId: string;
  } & (
    | { event: "start" | "end" | "error" }
    | { event: "provider_event"; data: ReturnType<typeof decodeProviderData> }
    | {
        event: "text_delta" | "thinking_delta" | "toolcall_delta";
        delta: string;
        contentIndex: number;
      }
  )
>;
export type LocalModelStreamObserver = (record: LocalModelStreamRecord) => void;
export const serviceTraceRecordBytes = 8 * 1024;
export const serviceTraceFileBytes = 4 * 1024 * 1024;

const identitySchema = z.object({
  requestId: z.string().max(256),
  providerId: z.string().max(256),
  modelId: z.string().max(256),
});
const providerTypeSchema = z.string().max(128);
const providerDeltaSchema = z.string();
// The maintained decoder strips every unselected field without traversing it.
// In particular, created/completed responses and their instructions are omitted.
const providerOutputSchema = z.object({
  type: z.enum([
    "response.output_text.delta",
    "response.reasoning_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
  ]),
  delta: providerDeltaSchema.max(serviceTraceRecordBytes),
  output_index: z.number().int().nonnegative().optional(),
  content_index: z.number().int().nonnegative().optional(),
});

export function encodeModelStreamRecord(
  record: LocalModelStreamRecord,
): string {
  const timestamp = new Date().toISOString();
  const identity = identitySchema.safeParse(record);
  const providerType = providerTypeSchema.safeParse(
    record.event === "provider_event" ? record.data.type : undefined,
  );
  const rawDelta = providerDeltaSchema.safeParse(
    record.event === "provider_event" ? record.data.delta : undefined,
  );
  const delta =
    "delta" in record
      ? record.delta
      : rawDelta.success
        ? rawDelta.data
        : undefined;
  const omitted = (
    reason:
      | "record-byte-bound"
      | "identity-byte-bound"
      | "unsupported-provider-event",
  ) =>
    JSON.stringify({
      event: "provider-event-omitted",
      originalEvent: record.event,
      requestId: identity.success ? identity.data.requestId : undefined,
      timestamp,
      reason,
      providerType: providerType.success ? providerType.data : undefined,
      // Length is constant-time. Do not scan an unbounded string to count UTF-8.
      deltaCodeUnits: delta?.length,
    }) + "\n";
  if (!identity.success) return omitted("identity-byte-bound");
  if (delta !== undefined && delta.length > serviceTraceRecordBytes)
    return omitted("record-byte-bound");
  const output =
    record.event === "provider_event"
      ? providerOutputSchema.safeParse(record.data)
      : undefined;
  if (output !== undefined && !output.success)
    return omitted(
      output.error.issues.some((issue) => issue.code === "too_big")
        ? "record-byte-bound"
        : "unsupported-provider-event",
    );
  // Every serialized string is bounded before copying; raw data never reaches
  // JSON.stringify. The final byte check also covers Unicode/JSON escaping.
  const line =
    JSON.stringify({
      ...identity.data,
      event: record.event,
      timestamp,
      data: output?.success ? output.data : undefined,
      delta: "delta" in record ? record.delta : undefined,
      contentIndex: "delta" in record ? record.contentIndex : undefined,
    }) + "\n";
  return Buffer.byteLength(line) <= serviceTraceRecordBytes
    ? line
    : omitted("record-byte-bound");
}
