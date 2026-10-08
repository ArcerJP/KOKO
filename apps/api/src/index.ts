import { handleAccount, handleConsent, type AccountEnv } from "./account";
import { handleUploads, type UploadEnv } from "./uploads";
import { handleOwnPosts, type OwnPostsEnv } from "./own-posts";
import { handleEnrollment, type EnrollmentEnv } from "./enrollment";
import { handlePublicFeed, type PublicFeedEnv } from "./public-feed";
import {
  handleMediaProcessingQueue,
  type MediaConsumerEnv,
} from "./media-consumer";
import { runStreamPreparation, type StreamRunnerEnv } from "./stream-runner";
import {
  handleStreamWebhook,
  streamWebhookPath,
  type StreamWebhookEnv,
} from "./stream-webhook";
import {
  handleCapacityMonitorScheduled,
  type CapacityMonitorEnv,
} from "./capacity-monitor";
import {
  handleStageThreeOutboxScheduled,
  type StageThreeOutboxEnv,
} from "./stage-three-outbox";
import { handleMediaDelivery, type MediaReadEnv } from "./media-delivery";
import {
  handleStageThreeOperations,
  type StageThreeEnv,
} from "./stage-three-operations";
import {
  handleMediaDispatchScheduled,
  mediaDispatchCron,
  type MediaDispatchEnv,
} from "./media-dispatch";
import {
  handleUploadCompletion,
  type CompletionEnv,
} from "./upload-completion";
import {
  handleUploadRecoveryQueue,
  handleUploadRecoveryScheduled,
  type RecoveryEnv,
} from "./upload-recovery";
import {
  handlePhysicalDeletionScheduled,
  type PhysicalDeletionEnv,
} from "./physical-deletion";
import { handleCleanupOrphansScheduled } from "./cleanup-orphans";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

function json(body: object, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export default {
  async queue(batch, env) {
    const processingEnv = env as MediaConsumerEnv &
      StreamRunnerEnv &
      RecoveryEnv;
    if (
      processingEnv.KOKO_MEDIA_PROCESSING_QUEUE &&
      batch.queue === processingEnv.KOKO_MEDIA_PROCESSING_QUEUE
    ) {
      if (batch.queue === processingEnv.KOKO_UPLOAD_RECOVERY_QUEUE)
        throw new Error("QUEUE_ROUTING_CONFLICT");
      console.info(
        "media_processing_queue",
        await handleMediaProcessingQueue(batch, processingEnv, {
          // Fixed HMAC-authenticated Vercel relay supplies runtime OIDC; secrets/activation remain deployment gates.
          prepareVideo: (job) => runStreamPreparation(job, processingEnv),
        }),
      );
      return;
    }
    console.info(
      "upload_recovery_queue",
      await handleUploadRecoveryQueue(batch, env as RecoveryEnv),
    );
  },
  async scheduled(controller, env) {
    if (controller.cron === mediaDispatchCron) {
      const [counts, operations, capacity, deletion, orphans] =
        await Promise.all([
          handleMediaDispatchScheduled(controller, env as MediaDispatchEnv),
          handleStageThreeOutboxScheduled(
            controller,
            env as StageThreeOutboxEnv,
          ),
          handleCapacityMonitorScheduled(controller, env as CapacityMonitorEnv),
          handlePhysicalDeletionScheduled(
            controller,
            env as PhysicalDeletionEnv,
          ),
          handleCleanupOrphansScheduled(controller, env as PhysicalDeletionEnv),
        ]);
      if (counts) console.info("media_outbox_dispatch", counts);
      if (operations) console.info("operational_outbox_dispatch", operations);
      if (capacity) console.info("capacity_monitor", capacity);
      if (deletion) console.info("physical_deletion", deletion);
      if (orphans) console.info("cleanup_orphan_observations", orphans);
      return;
    }
    const counts = await handleUploadRecoveryScheduled(
      controller,
      env as RecoveryEnv,
    );
    if (counts) console.info("upload_recovery_scheduled", counts);
  },
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === streamWebhookPath)
      return handleStreamWebhook(request, env as StreamWebhookEnv);
    if (pathname === "/me") return handleAccount(request, env as AccountEnv);
    if (pathname === "/me/enrollment")
      return handleEnrollment(request, env as EnrollmentEnv);
    if (
      /^\/media\/[^/]+\/[^/]+\/[^/]+$/.test(pathname) ||
      /^\/admin\/posts\/[^/]+\/original$/.test(pathname)
    )
      return handleMediaDelivery(request, env as MediaReadEnv);
    if (
      pathname === "/feed" ||
      (request.method === "GET" && /^\/posts\/[^/]+$/.test(pathname))
    )
      return handlePublicFeed(request, env as PublicFeedEnv);
    if (pathname === "/me/posts" || /^\/posts\/[^/]+\/status$/.test(pathname))
      return handleOwnPosts(request, env as OwnPostsEnv);
    if (pathname === "/consents")
      return handleConsent(request, env as AccountEnv);
    if (/^\/posts\/[^/]+\/complete$/.test(pathname))
      return handleUploadCompletion(request, env as CompletionEnv);
    if (
      pathname === "/uploads" ||
      /^\/uploads\/[^/]+\/(refresh|parts|recover)$/.test(pathname)
    )
      return handleUploads(request, env as UploadEnv);
    if (
      pathname === "/themes" ||
      pathname === "/appeals" ||
      pathname.startsWith("/admin/") ||
      /^\/posts\/[^/]+\/reports$/.test(pathname) ||
      (request.method === "DELETE" && /^\/posts\/[^/]+$/.test(pathname))
    )
      return handleStageThreeOperations(request, env as StageThreeEnv);

    if (pathname === "/health") {
      if (request.method !== "GET") {
        return json(
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }

      return json({ service: "koko-api", status: "ok" }, 200);
    }

    return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  },
} satisfies ExportedHandler<Env>;
