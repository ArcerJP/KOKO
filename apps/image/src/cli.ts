import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { transformImage } from "./index.js";

// Offline/local acceptance tool. No URLs, credentials, or external writes.
const args = process.argv.slice(2);
if (args.length !== 2 || !args[0] || !args[1]) {
  process.stderr.write(
    "Usage: image-transform <input-file> <new-output-directory>\n",
  );
  process.exitCode = 2;
} else {
  try {
    const input = await readFile(resolve(args[0]));
    const result = await transformImage(input);
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    } else {
      const directory = resolve(args[1]);
      // Exclusive directory creation: never overwrite existing user output.
      await mkdir(directory);
      const manifest = [];
      for (const { bytes, ...metadata } of result.derivatives) {
        await writeFile(join(directory, metadata.name), bytes, { flag: "wx" });
        manifest.push(metadata);
      }
      // Written last; its presence is the acceptance marker for a complete set.
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { flag: "wx" },
      );
      process.stdout.write("IMAGE_TRANSFORM_COMPLETE\n");
    }
  } catch {
    // A write failure can leave an incomplete directory; never erase it blindly.
    process.stderr.write("IMAGE_TRANSFORM_FAILED\n");
    process.exitCode = 1;
  }
}
