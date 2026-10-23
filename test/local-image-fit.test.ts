import { PhotonImage } from "@cf-wasm/photon/node";
import { describe, expect, it } from "vitest";

import {
  fitLocalImage,
  maximumLocalImagePixels,
  maximumLocalImageViewBytes,
} from "../src/local-image-fit.js";

/** A 1 x 1 GIF89a, the smallest real GIF. */
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/** Deterministic noisy RGBA pixels, which compress badly in every format. */
function noise(width: number, height: number, alpha = 255): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      pixels[index + channel] = seed % 256;
    }
    pixels[index + 3] = alpha;
  }
  return pixels;
}

function image(width: number, height: number, alpha = 255): PhotonImage {
  return new PhotonImage(noise(width, height, alpha), width, height);
}

function decoded(bytes: Uint8Array) {
  const result = PhotonImage.new_from_byteslice(bytes);
  try {
    return {
      width: result.get_width(),
      height: result.get_height(),
      pixels: result.get_raw_pixels(),
    };
  } finally {
    result.free();
  }
}

const isJpeg = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Put one EXIF APP1 segment carrying `orientation` right after the JPEG SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // Big-endian TIFF header, one IFD entry (0x0112 Orientation, SHORT), no next IFD.
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.byteLength + 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    length,
    payload,
    jpeg.subarray(2),
  ]);
}

const signal = new AbortController().signal;

describe("fitLocalImage", () => {
  it("shrinks png, jpeg, gif and webp to a JPEG within 512 px and the byte budget", async () => {
    const source = image(1_200, 900);
    const inputs = {
      png: source.get_bytes(),
      jpeg: source.get_bytes_jpeg(95),
      webp: source.get_bytes_webp(),
      gif,
    };
    source.free();
    expect(inputs.png.byteLength).toBeGreaterThan(512 * 1_024);
    for (const [name, bytes] of Object.entries(inputs)) {
      const fitted = await fitLocalImage(name, bytes, signal);
      expect(isJpeg(fitted), name).toBe(true);
      expect(fitted.byteLength).toBeLessThanOrEqual(maximumLocalImageViewBytes);
      const { width, height } = decoded(fitted);
      expect([width, height], name).toEqual(
        name === "gif" ? [1, 1] : [512, 384],
      );
    }
  });

  it("steps down to a smaller edge when 512 px is still over budget", async () => {
    // Raw noise at 512 px is over 100 KB as a quality-80 JPEG, so a smaller step wins.
    const source = image(512, 512);
    const fitted = await fitLocalImage("noise.png", source.get_bytes(), signal);
    source.free();
    expect(fitted.byteLength).toBeLessThanOrEqual(maximumLocalImageViewBytes);
    expect(decoded(fitted).width).toBeLessThan(512);
  });

  it("blends transparency over white", async () => {
    const clear = image(8, 8, 0);
    const fitted = await fitLocalImage("clear.png", clear.get_bytes(), signal);
    clear.free();
    const { pixels } = decoded(fitted);
    expect(Math.min(...pixels.subarray(0, 3))).toBeGreaterThan(245);
  });

  it("applies the JPEG EXIF orientation", async () => {
    const source = image(40, 20);
    const jpeg = source.get_bytes_jpeg(90);
    source.free();
    const fitted = await fitLocalImage(
      "phone.jpg",
      withOrientation(jpeg, 6),
      signal,
    );
    expect(decoded(fitted)).toMatchObject({ width: 20, height: 40 });
  });

  it("refuses an undecodable image instead of passing it through", async () => {
    const signatureOnly = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    await expect(
      fitLocalImage("broken.png", signatureOnly, signal),
    ).rejects.toThrow(
      "Image broken.png could not be decoded. Refusing to read it.",
    );
    const valid = image(4, 4);
    const truncated = valid.get_bytes().subarray(0, 40);
    valid.free();
    await expect(fitLocalImage("cut.png", truncated, signal)).rejects.toThrow(
      "could not be decoded",
    );
  });

  it("refuses an image above the pixel limit from its header, before decoding", async () => {
    const small = image(4, 4);
    const png = Buffer.from(small.get_bytes());
    small.free();
    // IHDR width and height follow the 8-byte signature and the chunk head.
    png.writeUInt32BE(6_000, 16);
    png.writeUInt32BE(5_000, 20);
    expect(6_000 * 5_000).toBeGreaterThan(maximumLocalImagePixels);
    await expect(fitLocalImage("huge.png", png, signal)).rejects.toThrow(
      `Image huge.png is 6000 x 5000 pixels; the read limit is ${String(maximumLocalImagePixels)} pixels. Refusing to read it.`,
    );
  });

  it("stops before decoding when the read is already cancelled", async () => {
    const source = image(4, 4);
    const png = source.get_bytes();
    source.free();
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(
      fitLocalImage("late.png", png, cancelled.signal),
    ).rejects.toThrow("cancelled");
  });
});
