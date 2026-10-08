/** Offline evaluation of human-labelled, de-identified receipts. No image, provider call or approval. */
export function summarizeEvaluation(input: unknown) {
  const record = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  const exact = (x: object, keys: string[]) =>
    Object.keys(x).length === keys.length &&
    keys.every((k) => Object.hasOwn(x, k));
  const invalid = (): never => {
    throw new Error("INVALID_EVALUATION_INPUT");
  };
  if (
    !record(input) ||
    !exact(input, ["version", "policy_version", "samples"]) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.policy_version) ||
    Number(input.policy_version) < 1 ||
    !Array.isArray(input.samples) ||
    input.samples.length < 1 ||
    input.samples.length > 10000
  )
    return invalid();
  const seen = new Set<string>();
  const counts = {
    normal: 0,
    inappropriate: 0,
    pass: 0,
    flag: 0,
    block: 0,
    held: 0,
    error: 0,
    normalBlocked: 0,
    normalFlagged: 0,
    normalHeldOrError: 0,
    inappropriatePublished: 0,
  };
  const durations: number[] = [];
  let unmeasured = 0;
  for (const sample of input.samples) {
    if (
      !record(sample) ||
      !exact(sample, [
        "sample_sha256",
        "expected",
        "observed",
        "processing_ms",
      ]) ||
      typeof sample.sample_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sample.sample_sha256) ||
      seen.has(sample.sample_sha256) ||
      !["allow", "block"].includes(String(sample.expected)) ||
      !["PASS", "FLAG", "BLOCK", "HELD", "ERROR"].includes(
        String(sample.observed),
      ) ||
      (sample.processing_ms !== null &&
        (typeof sample.processing_ms !== "number" ||
          !Number.isFinite(sample.processing_ms) ||
          sample.processing_ms < 0 ||
          sample.processing_ms > 3600000))
    )
      return invalid();
    seen.add(sample.sample_sha256);
    const normal = sample.expected === "allow",
      observed = sample.observed as
        "PASS" | "FLAG" | "BLOCK" | "HELD" | "ERROR";
    counts[normal ? "normal" : "inappropriate"]++;
    counts[
      observed.toLowerCase() as "pass" | "flag" | "block" | "held" | "error"
    ]++;
    if (normal && observed === "BLOCK") counts.normalBlocked++;
    if (normal && observed === "FLAG") counts.normalFlagged++;
    if (normal && ["HELD", "ERROR"].includes(observed))
      counts.normalHeldOrError++;
    if (!normal && ["PASS", "FLAG"].includes(observed))
      counts.inappropriatePublished++;
    if (sample.processing_ms === null) unmeasured++;
    else durations.push(Number(sample.processing_ms));
  }
  durations.sort((a, b) => a - b);
  const percentile = (quantile: number) =>
    durations.length
      ? durations[Math.ceil(durations.length * quantile) - 1]!
      : null;
  const ratio = (numerator: number, denominator: number) =>
    denominator ? numerator / denominator : null;
  return {
    version: 1,
    policy_version: input.policy_version,
    unique_samples: seen.size,
    counts,
    normal_sample_target_met: counts.normal >= 200,
    normal_block_rate: ratio(counts.normalBlocked, counts.normal),
    normal_flag_rate: ratio(counts.normalFlagged, counts.normal),
    normal_unavailable_rate: ratio(counts.normalHeldOrError, counts.normal),
    inappropriate_publication_rate: ratio(
      counts.inappropriatePublished,
      counts.inappropriate,
    ),
    processing_ms: {
      measured: durations.length,
      unmeasured,
      median_nearest_rank: percentile(0.5),
      p95_nearest_rank: percentile(0.95),
    },
    human_acceptance_required: true,
    limitations: [
      "input_labels_and_permissions_not_verified",
      "sample_independence_not_proven",
      "held_and_error_are_not_pass",
      "no_provider_quota_cost_or_live_slo_verification",
    ],
  } as const;
}
