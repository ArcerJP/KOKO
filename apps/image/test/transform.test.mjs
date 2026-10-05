import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import sharp from "sharp";
import { transformImage } from "../dist/index.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const create = (width, height, background = "#bc4010") =>
  sharp({ create: { width, height, channels: 4, background } });

async function verify(input, expected) {
  const original = hash(input);
  const result = await transformImage(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(hash(input), original);
  assert.deepEqual(
    result.derivatives.map((d) => d.name),
    [
      "ai-1024.jpg",
      "display-600.webp",
      "display-600.jpg",
      "display-1600.webp",
      "display-1600.jpg",
    ],
  );
  for (const [i, derivative] of result.derivatives.entries()) {
    const meta = await sharp(derivative.bytes).metadata();
    assert.equal(
      meta.format,
      derivative.contentType === "image/jpeg" ? "jpeg" : "webp",
    );
    assert.deepEqual([meta.width, meta.height], expected[i]);
    assert.equal(derivative.width, meta.width);
    assert.equal(derivative.height, meta.height);
    assert.equal(hash(derivative.bytes), derivative.sha256);
    for (const key of ["exif", "icc", "iptc", "xmp", "orientation"])
      assert.equal(meta[key], undefined, key);
    assert.equal(meta.space, "srgb");
    assert.equal(meta.hasAlpha, false);
    await sharp(derivative.bytes).raw().toBuffer();
  }
  return result.derivatives;
}

test("EXIF/ICC are removed, orientation applied, five sizes produced without changing original", async () => {
  const input = await create(1800, 1200)
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Artist: "KOKO_SYNTHETIC_TEST" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "0/1 0/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "0/1 0/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
  const meta = await sharp(input).metadata();
  assert.ok(meta.exif);
  assert.ok(meta.icc);
  assert.equal(meta.orientation, 6);
  await verify(input, [
    [683, 1024],
    [400, 600],
    [400, 600],
    [1067, 1600],
    [1067, 1600],
  ]);
});

test("small transparent images are not enlarged and use consistent white background", async () => {
  const input = await create(4, 2, { r: 0, g: 0, b: 0, alpha: 0 })
    .png()
    .toBuffer();
  const derivatives = await verify(
    input,
    Array.from({ length: 5 }, () => [4, 2]),
  );
  for (const d of derivatives) {
    const pixels = await sharp(d.bytes).raw().toBuffer();
    assert.ok(pixels.every((p) => p >= 250));
  }
});

test("rotates actual pixels as well as dimensions", async () => {
  const pixels = Buffer.alloc(80 * 40 * 3);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 80; x++)
      pixels[(y * 80 + x) * 3 + (x < 40 ? 0 : 2)] = 255;
  const input = await sharp(pixels, {
    raw: { width: 80, height: 40, channels: 3 },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 100 })
    .toBuffer();
  const derivatives = await verify(
    input,
    Array.from({ length: 5 }, () => [40, 80]),
  );
  const raw = await sharp(derivatives[0].bytes).raw().toBuffer();
  const top = (10 * 40 + 20) * 3,
    bottom = (70 * 40 + 20) * 3;
  assert.ok(raw[top] > 240 && raw[top + 2] < 20);
  assert.ok(raw[bottom] < 20 && raw[bottom + 2] > 240);
});

test("synthetic HEVC/HEIC decodes and produces five metadata-free derivatives", async () => {
  const input = await readFile(
    new URL("./fixtures/blocks.heic", import.meta.url),
  );
  assert.equal(input.toString("ascii", 4, 8), "ftyp");
  const derivatives = await verify(
    input,
    Array.from({ length: 5 }, () => [96, 64]),
  );
  const raw = await sharp(derivatives[0].bytes).raw().toBuffer();
  const left = (32 * 96 + 16) * 3,
    right = (32 * 96 + 80) * 3;
  assert.ok(raw[left] > 200 && raw[left + 2] < 50);
  assert.ok(raw[right] < 50 && raw[right + 2] > 200);
});

for (const [name, input] of [
  ["corrupt", Buffer.from("PRIVATE_DETAIL_NOT_FOR_LOGS")],
  [
    "truncated HEIC",
    (
      await readFile(new URL("./fixtures/blocks.heic", import.meta.url))
    ).subarray(0, 48),
  ],
]) {
  test(`${name} returns only a fixed failure and no partial outputs`, async () => {
    assert.deepEqual(await transformImage(input), {
      ok: false,
      reason: "DECODE_FAILED",
    });
  });
}

test("invalid inputs and deadlines are rejected without a worker", async () => {
  for (const input of [null, "file.jpg", new Uint8Array()])
    assert.deepEqual(await transformImage(input), {
      ok: false,
      reason: "INVALID_INPUT",
    });
  for (const timeout of [0, -1, 15_001, NaN, Infinity, 1.5])
    assert.deepEqual(await transformImage(new Uint8Array([1]), timeout), {
      ok: false,
      reason: "INVALID_INPUT",
    });
});

test("multiple HEIC images fail closed instead of silently selecting the first", async () => {
  const input = await readFile(
    new URL("./fixtures/multiple.heic", import.meta.url),
  );
  assert.deepEqual(await transformImage(input), {
    ok: false,
    reason: "DECODE_FAILED",
  });
});

test("concurrent request is BUSY and timeout releases the slot for recovery", async () => {
  const input = await create(100, 50).png().toBuffer();
  const first = transformImage(input, 1);
  assert.deepEqual(await transformImage(input), { ok: false, reason: "BUSY" });
  assert.deepEqual(await first, { ok: false, reason: "TIMEOUT" });
  await verify(
    input,
    Array.from({ length: 5 }, () => [100, 50]),
  );
});
