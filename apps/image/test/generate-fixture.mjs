// Generate original test artwork, not photographs. Run only in fixture-generator.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import sharp from "sharp";

const output = process.argv[2];
if (!output) throw new Error("OUTPUT_REQUIRED");
const directory = await mkdtemp(join(tmpdir(), "koko-synthetic-heic-"));
try {
  const pixels = Buffer.alloc(96 * 64 * 3);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 96; x++)
      pixels[(y * 96 + x) * 3 + (x < 48 ? 0 : 2)] = 255;
  const png = join(directory, "blocks.png"),
    heic = join(directory, "blocks.heic");
  await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } })
    .png()
    .toFile(png);
  const inputs = process.argv[3] === "--multiple" ? [png, png] : [png];
  execFileSync("heif-enc", ["-L", "-o", heic, ...inputs], {
    stdio: "ignore",
    timeout: 30_000,
  });
  await writeFile(output, await readFile(heic), { flag: "wx" });
} finally {
  await rm(directory, { recursive: true, force: true });
}
