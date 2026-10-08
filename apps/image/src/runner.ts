import {
  ImageDatabaseError,
  imageFailureReasons,
  type ImageFailureReason,
  type ImageDatabase,
  type ImageJobReference,
} from "./db.js";
import { createImagePipeline, type ImageProcessingResult } from "./pipeline.js";
import type { Derivative } from "./types.js";

type PipelineOptions = NonNullable<Parameters<typeof createImagePipeline>[0]>;
type Failure =
  | Extract<ImageProcessingResult, { ok: false }>["reason"]
  | "INVALID_INPUT"
  | "DB_FAILED"
  | "DB_TIMEOUT"
  | "EXHAUSTED"
  | "CONFLICT"
  | "RUNNER_FAILED";
export type ImageRunResult =
  | { ok: false; reason: Failure }
  | { ok: true; outcome: "image_recorded"; ai: Derivative }
  | { ok: true; outcome: "image_already_recorded" };

/** Internal phase only. Caller authentication, Queue ACK and AI/publication are NOT implemented. */
export function createImageRunner(
  options: {
    enabled?: boolean;
    database?: ImageDatabase | null;
    store?: PipelineOptions["store"];
    transform?: PipelineOptions["transform"];
  } = {},
): { run(job: ImageJobReference): Promise<ImageRunResult> } | null {
  if (options.enabled !== true) return null;
  const { database, store, transform } = options;
  if (
    !database ||
    typeof database.claim !== "function" ||
    typeof database.check !== "function" ||
    typeof database.finish !== "function" ||
    typeof database.fail !== "function"
  )
    throw new Error("INVALID_RUNNER_CONFIG");
  const claim = database.claim.bind(database);
  const finish = database.finish.bind(database);
  const pipeline = createImagePipeline({
    enabled: true,
    store: store ?? null,
    isCurrent: database.check.bind(database),
    ...(transform !== undefined ? { transform } : {}),
  })!;
  let active = false;
  return Object.freeze({
    async run(job: ImageJobReference): Promise<ImageRunResult> {
      if (active) return { ok: false, reason: "BUSY" };
      active = true;
      try {
        const found = await claim(job);
        if (found.code === "IMAGE_SAVED")
          return { ok: true, outcome: "image_already_recorded" };
        if (found.code !== "CLAIMED") return { ok: false, reason: found.code };
        const saved = await pipeline.process(found.plan);
        if (!saved.ok) {
          if (
            imageFailureReasons.includes(saved.reason as ImageFailureReason)
          ) {
            const held = await database.fail(
              found.plan,
              saved.reason as ImageFailureReason,
            );
            if (held.code !== "HELD") return { ok: false, reason: held.code };
          }
          // Even after a durable hold, never claim that image conversion/AI succeeded.
          // Queue delivery is settled only after its separate authoritative DB read.
          return saved;
        }
        const result = await finish(found.plan, {
          originalSha256: saved.originalSha256,
          deliveries: saved.deliveries,
        });
        if (result.code !== "RECORDED")
          return { ok: false, reason: result.code };
        return { ok: true, outcome: "image_recorded", ai: saved.ai };
      } catch (error) {
        if (
          error instanceof ImageDatabaseError &&
          error.code !== "INVALID_DB_CONFIG"
        )
          return { ok: false, reason: error.code };
        return { ok: false, reason: "RUNNER_FAILED" };
      } finally {
        active = false;
      }
    },
  });
}
