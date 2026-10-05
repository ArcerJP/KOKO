import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/blocks.heic", import.meta.url),
);

test("CLI creates a complete manifest without leaking input paths or overwriting output", async () => {
  const temp = await mkdtemp(join(tmpdir(), "koko-image-test-"));
  try {
    const output = join(temp, "derivatives");
    const result = await exec(process.execPath, [cli, fixture, output]);
    assert.equal(result.stdout, "IMAGE_TRANSFORM_COMPLETE\n");
    assert.equal(result.stderr, "");
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.length, 5);
    assert.equal((await readdir(output)).length, 6);
    const before = await readFile(join(output, "manifest.json"));
    await assert.rejects(
      exec(process.execPath, [cli, fixture, output]),
      (error) => {
        assert.equal(error.stderr, "IMAGE_TRANSFORM_FAILED\n");
        return true;
      },
    );
    assert.deepEqual(await readFile(join(output, "manifest.json")), before);
    const invalid = join(temp, "private-original-name.txt");
    await writeFile(invalid, "PRIVATE_DETAIL");
    await assert.rejects(
      exec(process.execPath, [cli, invalid, join(temp, "invalid")]),
      (error) => {
        assert.equal(error.stderr, "DECODE_FAILED\n");
        return true;
      },
    );
    assert.deepEqual((await readdir(temp)).sort(), [
      "derivatives",
      "private-original-name.txt",
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("CLI rejects missing and extra arguments", async () => {
  for (const args of [[], ["one"], ["one", "two", "three"]]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.equal(
        error.stderr,
        "Usage: image-transform <input-file> <new-output-directory>\n",
      );
      return true;
    });
  }
});
