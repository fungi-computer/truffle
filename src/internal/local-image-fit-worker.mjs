import { parentPort, workerData } from "node:worker_threads";
import {
  PhotonImage,
  SamplingFilter,
  fliph,
  resize,
  rotate,
} from "@cf-wasm/photon/node";

/**
 * One throwaway worker shrinks one image. Photon's WebAssembly memory grows to
 * fit the largest decode and never shrinks, so it lives only as long as this
 * worker; the parent terminates it after the single reply below.
 *
 * workerData: { bytes: Uint8Array, orientation: number | undefined,
 *   dimensions: readonly number[], quality: number, maxBytes: number }
 * Reply: { kind: "fitted", bytes } | { kind: "undecodable" } | { kind: "over-budget" }
 */

/**
 * Mirror `image` in place, left to right.
 * @param {PhotonImage} image
 */
function mirrored(image) {
  fliph(image);
  return image;
}

/**
 * Apply one EXIF orientation (2-8) so the image is upright; 1, absent or
 * unknown needs nothing. Returns `image` itself or one new image.
 * @param {PhotonImage} image
 * @param {number | undefined} orientation
 */
function upright(image, orientation) {
  switch (orientation) {
    case 2:
      return mirrored(image);
    case 3:
      return rotate(image, 180);
    case 4:
      return mirrored(rotate(image, 180));
    case 5:
      return mirrored(rotate(image, 90));
    case 6:
      return rotate(image, 90);
    case 7:
      return mirrored(rotate(image, 270));
    case 8:
      return rotate(image, 270);
    default:
      return image;
  }
}

/**
 * Blend any transparency over white; JPEG has no alpha channel.
 * @param {PhotonImage} image
 */
function opaque(image) {
  const pixels = image.get_raw_pixels();
  let translucent = false;
  for (let index = 3; index < pixels.length; index += 4) {
    const alpha = pixels[index];
    if (alpha === 255) continue;
    translucent = true;
    for (let channel = index - 3; channel < index; channel += 1)
      pixels[channel] = Math.round(
        (pixels[channel] * alpha + 255 * (255 - alpha)) / 255,
      );
    pixels[index] = 255;
  }
  return translucent
    ? new PhotonImage(pixels, image.get_width(), image.get_height())
    : image;
}

/**
 * Scale `source` within `dimension`, make it upright and encode a JPEG.
 * @param {PhotonImage} source
 * @param {number} dimension
 * @param {number | undefined} orientation
 * @param {number} quality
 */
function encodeAt(source, dimension, orientation, quality) {
  const width = source.get_width();
  const height = source.get_height();
  const scale = Math.min(1, dimension / Math.max(width, height));
  // Every step works on its own image, so in-place flips never touch `source`.
  const scaled =
    scale < 1
      ? resize(
          source,
          Math.max(1, Math.round(width * scale)),
          Math.max(1, Math.round(height * scale)),
          SamplingFilter.Lanczos3,
        )
      : new PhotonImage(source.get_raw_pixels(), width, height);
  const oriented = upright(scaled, orientation);
  const flat = opaque(oriented);
  try {
    return flat.get_bytes_jpeg(quality);
  } finally {
    for (const image of new Set([scaled, oriented, flat])) image.free();
  }
}

/** @param {typeof workerData} input */
function fit(input) {
  let source;
  try {
    // Photon reports a corrupt or unsupported image as a WebAssembly trap.
    source = PhotonImage.new_from_byteslice(input.bytes);
  } catch {
    return { kind: "undecodable" };
  }
  try {
    for (const dimension of input.dimensions) {
      const bytes = encodeAt(
        source,
        dimension,
        input.orientation,
        input.quality,
      );
      if (bytes.byteLength <= input.maxBytes) return { kind: "fitted", bytes };
    }
    return { kind: "over-budget" };
  } finally {
    source.free();
  }
}

const reply = fit(workerData);
parentPort?.postMessage(
  reply,
  reply.kind === "fitted" ? [reply.bytes.buffer] : [],
);
