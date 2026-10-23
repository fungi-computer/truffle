import { Worker } from "node:worker_threads";
import { imageSize } from "image-size";
import { z } from "zod";

/**
 * Local shrinks every image it reads before it becomes an image part, as the
 * retained `read_image` did on the Images binding: at most 512 px on the long
 * edge as a quality-80 JPEG, stepping down to a 256 px floor until the bytes
 * meet the 100 KB budget. Photon (Rust `image` compiled to WebAssembly, inlined
 * in the package) decodes and encodes with no network, no Cloudflare and no
 * per-platform native build.
 *
 * Photon's WebAssembly memory grows to the largest decode and never shrinks,
 * and the Local service is long-running, so each image is decoded in its own
 * worker thread that is terminated afterwards, returning that memory.
 */

/** Largest image file Local reads to shrink; larger files are refused unread. */
export const maximumLocalImageInputBytes = 16 * 1_024 * 1_024;
/**
 * Largest decoded image Local shrinks, checked from the header before any
 * worker starts. 25 megapixels admits 24 MP phone photos (5712 x 4284) and 6K
 * screenshots.
 */
export const maximumLocalImagePixels = 25_000_000;
/** At most this many bytes of one image reach the model. */
export const maximumLocalImageViewBytes = 100 * 1_024;
/** The retained steps: 512 px long edge, down to a 256 px floor. */
const viewDimensions = [512, 384, 256] as const;
const viewQuality = 80;

/** Built beside this module; the CLI bundle ships it at the same relative path. */
const workerUrl = new URL(
  "./internal/local-image-fit-worker.mjs",
  import.meta.url,
);

const replySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fitted"),
    bytes: z.instanceof(Uint8Array),
  }),
  z.strictObject({ kind: z.literal("undecodable") }),
  z.strictObject({ kind: z.literal("over-budget") }),
]);
type Reply = z.output<typeof replySchema>;

const undecodable = (path: string) =>
  new Error(`Image ${path} could not be decoded. Refusing to read it.`);

/** Read the header with `image-size`; a header it cannot parse is refused. */
function header(path: string, bytes: Uint8Array) {
  try {
    return imageSize(bytes);
  } catch {
    throw undecodable(path);
  }
}

/** Run one throwaway worker over `bytes`; it is terminated however it ends. */
async function shrinkInWorker(
  bytes: Uint8Array,
  orientation: number | undefined,
  signal: AbortSignal,
): Promise<Reply> {
  signal.throwIfAborted();
  const worker = new Worker(workerUrl, {
    workerData: {
      bytes,
      orientation,
      dimensions: viewDimensions,
      quality: viewQuality,
      maxBytes: maximumLocalImageViewBytes,
    },
  });
  // Ends the abort listener with the worker.
  const settled = new AbortController();
  try {
    return await new Promise<Reply>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(
            new Error("Local image read was cancelled", {
              cause: signal.reason,
            }),
          );
        },
        { once: true, signal: settled.signal },
      );
      worker.once("message", (message: unknown) => {
        const reply = replySchema.safeParse(message);
        if (reply.success) resolve(reply.data);
        else reject(new Error("Local image worker sent an invalid reply"));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        reject(
          new Error(
            `Local image worker exited (${String(code)}) before replying`,
          ),
        );
      });
    });
  } finally {
    settled.abort();
    await worker.terminate();
  }
}

/**
 * Shrink one whole png, jpeg, gif (first frame) or webp file for the model.
 * Refuses, with the Files read error, an image whose header or pixels cannot
 * be decoded, one above {@link maximumLocalImagePixels}, and one still above
 * {@link maximumLocalImageViewBytes} at the 256 px floor. Never passes the
 * original bytes through.
 */
export async function fitLocalImage(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const { width, height, orientation } = header(path, bytes);
  if (width * height > maximumLocalImagePixels)
    throw new Error(
      `Image ${path} is ${String(width)} x ${String(height)} pixels; the read limit is ${String(maximumLocalImagePixels)} pixels. Refusing to read it.`,
    );
  const reply = await shrinkInWorker(bytes, orientation, signal);
  if (reply.kind === "fitted") return reply.bytes;
  if (reply.kind === "undecodable") throw undecodable(path);
  throw new Error(
    `Image ${path} does not fit ${String(maximumLocalImageViewBytes)} bytes at ${String(viewDimensions.at(-1))} px. Refusing to read it.`,
  );
}
