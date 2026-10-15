import { z } from "zod";

/**
 * One exec launch's own text ceiling: 16384, shared by the shell form's
 * `command` and the direct form's combined `executable`+`args`, so neither
 * gets a materially larger budget. This is exec's own bound, not borrowed
 * from any other owner's limit.
 *
 * The two forms count against it in different units, which the name
 * deliberately leaves open rather than mis-claiming one: `command` is
 * bounded by `z.string().max()`, zod's native UTF-16 code-unit count, the
 * same as the field already was before the direct form existed. The direct
 * form's `combinedArgvBytes` below counts real UTF-8 bytes, because argv is
 * a byte protocol with no code-unit concept. For multi-byte text the two
 * measures diverge; both stay well inside this ceiling for any launch a
 * model would actually send.
 */
export const maximumLaunchTextLength = 16 * 1_024;

/**
 * One exec launch's own stdin bound. A launch's stdin is a finite payload
 * held fully in memory and written to the child once, then closed; it is
 * never streamed, paginated or interactive. 128 KiB keeps that one-shot
 * payload bounded while still fitting an ordinary small script or data blob.
 * This is exec's own bound, not borrowed from any other owner's limit (in
 * particular, not Files' write bound, which governs a different resource:
 * durable file content, read and written in pages).
 */
export const maximumLaunchStdinBytes = 128 * 1_024;

/**
 * Finite UTF-8 text delivered to a launched child once, then closed; never
 * an interactive protocol. A lone surrogate is refused rather than silently
 * becoming U+FFFD, so byte-identity is a real guarantee, not a best effort.
 */
export const launchStdinSchema = z
  .string()
  .refine(
    (value) => value.isWellFormed(),
    "Computer exec stdin must be well-formed UTF-16 text (no lone surrogates)",
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= maximumLaunchStdinBytes,
    `Computer exec stdin exceeds the ${String(maximumLaunchStdinBytes)}-byte bound`,
  );

/** Combined UTF-8 bytes of a direct form's executable and its args. */
export function combinedArgvBytes(
  executable: string,
  args: readonly string[],
): number {
  return [executable, ...args].reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  );
}

/**
 * One launch's requested `cwd`: absolute, bounded, no NUL. The caller still
 * resolves and contains it under the invocation root; this schema only
 * shapes the raw string.
 */
export const launchCwdSchema = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((path) => !path.includes("\0"), "Path cannot contain null bytes");
