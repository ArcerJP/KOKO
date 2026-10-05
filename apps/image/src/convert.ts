import { createHash } from "node:crypto";
import decode from "heic-decode";
import sharp, { type Sharp } from "sharp";
import type { Derivative } from "./types.js";

// Keep libvips' default safety limit; this is not a product upload limit.
const MAX_PIXELS = 268402689;
const outputs = [
  ["ai-1024.jpg", 1024, "jpeg"],
  ["display-600.webp", 600, "webp"],
  ["display-600.jpg", 600, "jpeg"],
  ["display-1600.webp", 1600, "webp"],
  ["display-1600.jpg", 1600, "jpeg"],
] as const;

function isHeic(input: Buffer): boolean {
  if (input.length < 16 || input.toString("ascii", 4, 8) !== "ftyp")
    return false;
  return ["mif1", "msf1", "heic", "heix", "hevc", "hevx"].includes(
    input.toString("ascii", 8, 12),
  );
}

function checkDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("DECODE_FAILED");
  }
}

// Internal: only called in the disposable worker, never on an HTTP event loop.
export async function convert(input: Buffer): Promise<Derivative[]> {
  sharp.cache(false);
  sharp.concurrency(1);
  let source: Sharp;
  if (isHeic(input)) {
    const images = await decode.all({ buffer: input });
    try {
      // Never silently discard additional images from a sequence/container.
      const first = images[0];
      if (images.length !== 1 || !first) throw new Error("DECODE_FAILED");
      checkDimensions(first.width, first.height);
      const raw = await first.decode();
      checkDimensions(raw.width, raw.height);
      if (raw.data.byteLength !== raw.width * raw.height * 4)
        throw new Error("DECODE_FAILED");
      source = sharp(Buffer.from(raw.data), {
        raw: { width: raw.width, height: raw.height, channels: 4 },
      });
    } finally {
      images.dispose();
    }
  } else {
    source = sharp(input, { failOn: "warning", limitInputPixels: MAX_PIXELS });
    const meta = await source.metadata();
    checkDimensions(meta.width ?? 0, meta.height ?? 0);
    if ((meta.pages ?? 1) !== 1) throw new Error("DECODE_FAILED");
  }
  const derivatives: Derivative[] = [];
  for (const [name, size, format] of outputs) {
    const pipeline = source
      .clone()
      .rotate()
      .toColourspace("srgb")
      .flatten({ background: "#ffffff" })
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      });
    // Do not call keepMetadata/withMetadata: derivatives must not carry EXIF.
    const { data, info } = await (
      format === "jpeg"
        ? pipeline.jpeg({ quality: 85 })
        : pipeline.webp({ quality: 82 })
    ).toBuffer({ resolveWithObject: true });
    derivatives.push({
      name,
      contentType: format === "jpeg" ? "image/jpeg" : "image/webp",
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data,
    });
  }
  return derivatives;
}
