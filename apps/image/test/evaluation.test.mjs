import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { summarizeEvaluation } from "../dist/evaluation.js";
const sample = (
  index = 1,
  expected = "allow",
  observed = "PASS",
  processing_ms = 100,
) => ({
  sample_sha256: index.toString(16).padStart(64, "0"),
  expected,
  observed,
  processing_ms,
});
const input = (samples = [sample()]) => ({
  version: 1,
  policy_version: 1,
  samples,
});
const cli = fileURLToPath(
  new URL("../dist/evaluation-cli.js", import.meta.url),
);
test("CLI emits aggregates only without sample identities", () => {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(input()),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).unique_samples, 1);
  assert.ok(!result.stdout.includes("sample_sha256"));
});
test("CLI rejects extra arguments, oversized input, malformed UTF-8/JSON without echo", () => {
  for (const [args, bytes] of [
    [["private/path.json"], JSON.stringify(input())],
    [[], "PRIVATE_DETAIL"],
    [[], Buffer.from([0xff])],
    [[], "x".repeat(4 * 1024 * 1024 + 1)],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      input: bytes,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "INVALID_EVALUATION_INPUT\n");
  }
});
test("normal samples are counted separately from inappropriate and never auto-approved", () => {
  const result = summarizeEvaluation(
    input([
      ...Array.from({ length: 200 }, (_, index) => sample(index + 1)),
      sample(201, "block", "BLOCK"),
    ]),
  );
  assert.equal(result.normal_sample_target_met, true);
  assert.equal(result.unique_samples, 201);
  assert.equal(result.human_acceptance_required, true);
  assert.equal(result.normal_block_rate, 0);
  assert.equal(result.inappropriate_publication_rate, 0);
  assert.ok(!JSON.stringify(result).includes("sample_sha256"));
});
test("200 total with fewer than 200 normal is not sufficient", () => {
  assert.equal(
    summarizeEvaluation(
      input([
        ...Array.from({ length: 199 }, (_, index) => sample(index + 1)),
        sample(200, "block", "BLOCK"),
      ]),
    ).normal_sample_target_met,
    false,
  );
});
test("HELD/errors are never reported as pass or silently removed from denominators", () => {
  const result = summarizeEvaluation(
    input([
      sample(1, "allow", "BLOCK", null),
      sample(2, "allow", "FLAG", 200),
      sample(3, "allow", "HELD", 300),
      sample(4, "allow", "ERROR", null),
      sample(5, "block", "FLAG", 400),
    ]),
  );
  assert.equal(result.normal_block_rate, 0.25);
  assert.equal(result.normal_flag_rate, 0.25);
  assert.equal(result.normal_unavailable_rate, 0.5);
  assert.equal(result.inappropriate_publication_rate, 1);
  assert.equal(result.counts.pass, 0);
  assert.deepEqual(result.processing_ms, {
    measured: 3,
    unmeasured: 2,
    median_nearest_rank: 300,
    p95_nearest_rank: 400,
  });
});
test("unknown denominator and unmeasured timing remain null", () => {
  const result = summarizeEvaluation(
    input([sample(1, "block", "BLOCK", null)]),
  );
  assert.equal(result.normal_block_rate, null);
  assert.equal(result.processing_ms.p95_nearest_rank, null);
});
test("nearest rank p95 uses ceil(n * .95) without fitted interpolation", () => {
  const result = summarizeEvaluation(
    input(
      Array.from({ length: 100 }, (_, i) =>
        sample(i + 1, "allow", "PASS", i + 1),
      ),
    ),
  );
  assert.equal(result.processing_ms.p95_nearest_rank, 95);
  assert.equal(result.processing_ms.median_nearest_rank, 50);
});
for (const malformed of [
  null,
  {},
  input([]),
  input([sample(), sample()]),
  input([{ ...sample(), expected: "unknown" }]),
  input([{ ...sample(), observed: "OK" }]),
  input([{ ...sample(), processing_ms: NaN }]),
  input([{ ...sample(), processing_ms: -1 }]),
  input([{ ...sample(), sample_sha256: "private-name.jpg" }]),
  input([{ ...sample(), raw_ocr: "private" }]),
  { ...input(), secret: "private" },
])
  test(`invalid evaluation ${JSON.stringify(malformed)}`, () =>
    assert.throws(
      () => summarizeEvaluation(malformed),
      /^Error: INVALID_EVALUATION_INPUT$/,
    ));
