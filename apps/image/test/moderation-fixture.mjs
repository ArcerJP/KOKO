import { moderationCategories } from "../dist/moderation.js";
import { plan as imagePlan, receipt, uuid } from "./processing-fixture.mjs";
export const policy = () => ({
  approved: true,
  version: 1,
  safeSearchScoreVersion: "likelihood-ordinal-v1",
  openaiModel: "omni-moderation-2024-09-26",
  thresholds: Object.entries(moderationCategories).flatMap(
    ([engine, categories]) =>
      categories.map((category) => ({
        engine,
        category,
        flag: 0.5,
        block: 0.8,
        immediate_ban: false,
      })),
  ),
});
export function moderationPlan(kind = "photo") {
  const p = imagePlan();
  const frameCount = kind === "photo" ? 1 : 3;
  return {
    jobId: p.jobId,
    postVersion: p.postVersion,
    leaseId: p.leaseId,
    expiresAt: p.expiresAt,
    original: { ...p.original, objectVersion: "object-v1" },
    policy: policy(),
    attemptStarts: Array.from({ length: frameCount }, (_, frame) =>
      Object.keys(moderationCategories).map((engine) => ({
        engine,
        frame,
        nextAttempt: 1,
      })),
    ).flat(),
    media:
      kind === "photo"
        ? {
            kind,
            source: "original_read_only",
            imageReceipt: {
              originalSha256: receipt(p).originalSha256,
              deliveries: receipt(p).deliveries.map((d) => {
                const copy = { ...d };
                delete copy.outcome;
                return copy;
              }),
            },
          }
        : {
            kind,
            postVersion: p.postVersion,
            streamAssetId: uuid(50),
            streamUid: "a".repeat(32),
            sourceUid: null,
            measuredDurationSeconds: 3,
            frameTimes: [0.5, 1.5, 2.5],
            requireSignedURLs: true,
            readyToStream: true,
            processingComplete: true,
          },
  };
}
export const held = () => ({
  decision: "HELD",
  policyVersion: 1,
  engines: Object.keys(moderationCategories).map((engine) => ({
    engine,
    decision: "ERROR",
  })),
  runs: [],
  categories: [],
  immediateBan: false,
  errorCode: "RESOURCE_LIMIT",
});
