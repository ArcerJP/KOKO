import { originalKey, type ApiErrorCode } from "@koko/contract";
import type { components } from "@koko/contract/api";
import {
  authenticateApiRequest,
  failure,
  limitedBody,
  object,
  privateHeaders,
  reply,
  uuid,
  type AccountEnv,
} from "./api-context";
import {
  createR2UploadAdapter,
  maxUploadSignatureSeconds,
  planR2Upload,
  R2UploadError,
  type R2SigningEnv,
} from "./r2-upload";

export type UploadEnv = AccountEnv &
  R2SigningEnv & {
    KOKO_UPLOADS_ENABLED?: string;
    ORIGINALS_BUCKET: Pick<
      R2Bucket,
      "createMultipartUpload" | "resumeMultipartUpload"
    >;
  };
type UploadRequest = components["schemas"]["UploadRequest"];
type Session = {
  code: "ready" | "provision";
  post_id: string;
  asset_id: string;
  upload_id: string;
  mode: "single" | "multipart";
  expires_at: string;
  provider_upload_id: string | null;
  request: UploadRequest;
};
const admissionErrors: readonly ApiErrorCode[] = [
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "CONSENT_REQUIRED",
  "ACCOUNT_BANNED",
  "EVENT_CLOSED",
  "PUBLICATION_STOPPED",
  "THEME_UNAVAILABLE",
  "STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "UPLOAD_EXPIRED",
  "UPLOAD_INCOMPLETE",
  "PROVIDER_LIMIT",
  "INTERNAL_ERROR",
];
function normalizeRequest(value: unknown): UploadRequest | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "client_request_id",
          "kind",
          "content_type",
          "file_size_bytes",
          "original_scope",
          "theme_id",
        ].includes(key),
    ) ||
    typeof value.client_request_id !== "string" ||
    !uuid.test(value.client_request_id) ||
    (value.kind !== "photo" && value.kind !== "video") ||
    typeof value.content_type !== "string" ||
    !/^[\x20-\x7e]{1,255}$/.test(value.content_type) ||
    value.content_type.trim() !== value.content_type ||
    typeof value.file_size_bytes !== "number" ||
    !Number.isSafeInteger(value.file_size_bytes) ||
    value.file_size_bytes < 1 ||
    (value.kind === "photo"
      ? value.original_scope !== "photo_file"
      : value.original_scope !== "client_trimmed" &&
        value.original_scope !== "full_video_fallback") ||
    (value.theme_id != null &&
      (typeof value.theme_id !== "string" || !uuid.test(value.theme_id)))
  )
    return null;
  return {
    client_request_id: value.client_request_id.toLowerCase(),
    kind: value.kind,
    content_type: value.content_type,
    file_size_bytes: value.file_size_bytes,
    original_scope: value.original_scope as UploadRequest["original_scope"],
    theme_id:
      typeof value.theme_id === "string" ? value.theme_id.toLowerCase() : null,
  };
}
function sessionResult(
  value: unknown,
  eventId: string,
  now: number,
): Session | null {
  if (
    !object(value) ||
    (value.code !== "ready" && value.code !== "provision") ||
    typeof value.post_id !== "string" ||
    !uuid.test(value.post_id) ||
    typeof value.asset_id !== "string" ||
    !uuid.test(value.asset_id) ||
    typeof value.upload_id !== "string" ||
    !uuid.test(value.upload_id) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= now ||
    Date.parse(value.expires_at) > now + maxUploadSignatureSeconds * 1000 ||
    value.object_key !==
      originalKey(eventId.toLowerCase(), value.post_id, value.asset_id)
  )
    return null;
  const request = normalizeRequest(value.request);
  if (!request) return null;
  const plan = planR2Upload(request.file_size_bytes);
  if (
    value.mode !== plan.mode ||
    (plan.mode === "single" &&
      (value.code !== "ready" || value.provider_upload_id !== null)) ||
    (value.code === "provision" && value.provider_upload_id !== null) ||
    (value.mode === "multipart" &&
      value.code === "ready" &&
      (typeof value.provider_upload_id !== "string" ||
        !/^[\x21-\x7e]{1,2048}$/.test(value.provider_upload_id)))
  )
    return null;
  return {
    code: value.code,
    post_id: value.post_id,
    asset_id: value.asset_id,
    upload_id: value.upload_id,
    mode: plan.mode,
    expires_at: value.expires_at,
    provider_upload_id: value.provider_upload_id as string | null,
    request,
  };
}

/** Opt-in only: deployment, DB migrations, R2 credentials/CORS and acceptance are separate gates. */
export async function handleUploads(
  request: Request,
  env: UploadEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_UPLOADS_ENABLED !== "true")
    return reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  if (request.method !== "POST")
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...privateHeaders, allow: "POST" } },
    );
  const path = new URL(request.url).pathname;
  const match = /^\/uploads\/([^/]+)\/(refresh|parts)$/.exec(path);
  const action = path === "/uploads" ? "open" : match?.[2];
  const uploadId = match?.[1];
  if (!action || (uploadId !== undefined && !uuid.test(uploadId)))
    return failure("INVALID_INPUT");
  try {
    const context = await authenticateApiRequest(request, env, fetcher);
    if (!context.ok) return failure(context.code);
    const { settings, eventId, userId } = context;
    let input: UploadRequest | undefined;
    let partNumbers: number[] = [];
    if (action === "refresh") {
      if (request.body !== null && (await limitedBody(request, 1)) !== "")
        return failure("INVALID_INPUT");
    } else {
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json" ||
        Number(request.headers.get("content-length")) > 4096
      )
        return failure("INVALID_INPUT");
      const raw = await limitedBody(request, 4096);
      if (raw === null) return failure("INVALID_INPUT");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return failure("INVALID_INPUT");
      }
      if (action === "open") {
        const normalized = normalizeRequest(body);
        if (!normalized) return failure("INVALID_INPUT");
        input = normalized;
        planR2Upload(input.file_size_bytes);
      } else {
        if (
          !object(body) ||
          Object.keys(body).length !== 1 ||
          !Array.isArray(body.part_numbers) ||
          body.part_numbers.length < 1 ||
          body.part_numbers.length > 100 ||
          new Set(body.part_numbers).size !== body.part_numbers.length ||
          body.part_numbers.some(
            (n: unknown) =>
              typeof n !== "number" ||
              !Number.isInteger(n) ||
              n < 1 ||
              n > 10000,
          )
        )
          return failure("INVALID_INPUT");
        partNumbers = body.part_numbers;
      }
    }
    // Validate signing configuration before reserving any DB rows or starting R2.
    const r2 = createR2UploadAdapter(env, env.ORIGINALS_BUCKET);
    const attemptId = crypto.randomUUID();
    async function rpc(
      operation: string,
      payload: object,
    ): Promise<Session | Response> {
      const response = await fetcher(
        new URL("/rest/v1/rpc/manage_upload_session", settings.url),
        {
          method: "POST",
          headers: {
            apikey: settings.secretKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            p_event_id: eventId,
            p_user_id: userId,
            p_action: operation,
            p_input: payload,
          }),
          redirect: "manual",
          cache: "no-store",
        },
      );
      if (!response.ok) return failure("INTERNAL_ERROR");
      const result: unknown = await response.json();
      if (
        object(result) &&
        admissionErrors.includes(result.code as ApiErrorCode)
      ) {
        if (result.code === "RATE_LIMITED") {
          const seconds = result.retry_after_seconds;
          if (
            typeof seconds !== "number" ||
            !Number.isInteger(seconds) ||
            seconds < 1 ||
            seconds > 60
          )
            return failure("INTERNAL_ERROR");
          return failure("RATE_LIMITED", seconds);
        }
        return failure(result.code as ApiErrorCode);
      }
      // Invalid upstream values must never become caller-facing input errors or URLs.
      try {
        return (
          sessionResult(result, eventId, Date.now()) ??
          failure("INTERNAL_ERROR")
        );
      } catch {
        return failure("INTERNAL_ERROR");
      }
    }
    let session = await rpc(
      action,
      action === "open"
        ? { request: input, attempt_id: attemptId }
        : { upload_id: uploadId },
    );
    if (session instanceof Response) return session;
    if (
      (uploadId &&
        session.upload_id.toLowerCase() !== uploadId.toLowerCase()) ||
      (input && JSON.stringify(input) !== JSON.stringify(session.request))
    )
      return failure("INTERNAL_ERROR");
    if (session.code === "provision") {
      if (action !== "open") return failure("INTERNAL_ERROR");
      const pending = session;
      const provider = await r2.beginMultipart(
        {
          eventId: eventId.toLowerCase(),
          postId: pending.post_id,
          assetId: pending.asset_id,
        },
        pending.request.file_size_bytes,
        pending.request.content_type,
      );
      // No automatic create retry or blind abort after an ambiguous DB response.
      // A later open sees ready (committed) or stays pending (needs recovery).
      session = await rpc("attach", {
        upload_id: pending.upload_id,
        attempt_id: attemptId,
        provider_upload_id: provider.providerUploadId,
      });
      if (session instanceof Response) return session;
      if (
        session.code !== "ready" ||
        session.upload_id !== pending.upload_id ||
        session.post_id !== pending.post_id ||
        session.asset_id !== pending.asset_id ||
        session.provider_upload_id !== provider.providerUploadId ||
        JSON.stringify(session.request) !== JSON.stringify(pending.request)
      )
        return failure("INTERNAL_ERROR");
    }
    const identity = {
      eventId: eventId.toLowerCase(),
      postId: session.post_id,
      assetId: session.asset_id,
    };
    if (action === "parts") {
      if (session.mode !== "multipart" || !session.provider_upload_id)
        return failure("STATE_CONFLICT");
      return reply(
        {
          parts: await r2.partPuts(
            identity,
            session.request.file_size_bytes,
            session.provider_upload_id,
            partNumbers,
            session.expires_at,
          ),
        },
        200,
      );
    }
    const ticket = {
      post_id: session.post_id,
      upload_id: session.upload_id,
      mode: session.mode,
      expires_at: session.expires_at,
    };
    if (session.mode === "single")
      return reply(
        {
          ...ticket,
          ...(await r2.singlePut(
            identity,
            session.request.file_size_bytes,
            session.request.content_type,
            session.expires_at,
          )),
        },
        200,
      );
    const plan = planR2Upload(session.request.file_size_bytes);
    if (plan.mode !== "multipart") return failure("INTERNAL_ERROR");
    return reply({ ...ticket, part_size_bytes: plan.partSizeBytes }, 200);
  } catch (error) {
    return failure(
      error instanceof R2UploadError ? error.code : "INTERNAL_ERROR",
    );
  }
}
