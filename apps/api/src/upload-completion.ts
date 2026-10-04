import { type ApiErrorCode } from "@koko/contract";
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
  CompletionError,
  normalizeCompletionParts,
  verifyCompletedOriginal,
  type CompletionBucket,
  type CompletionPart,
} from "./r2-completion";
import {
  completionErrors,
  completionReceipt,
  preparedCompletion,
} from "./completion-result";

export type CompletionEnv = AccountEnv & {
  KOKO_UPLOADS_ENABLED?: string;
  ORIGINALS_BUCKET: CompletionBucket;
};
const maxBodyBytes = 1024 * 1024; // 10,000 part ETags, not a media size cap.

export async function handleUploadCompletion(
  request: Request,
  env: CompletionEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_UPLOADS_ENABLED !== "true") return failure("NOT_FOUND");
  if (request.method !== "POST")
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...privateHeaders, allow: "POST" } },
    );
  const postId = /^\/posts\/([^/]+)\/complete$/
    .exec(new URL(request.url).pathname)?.[1]
    ?.toLowerCase();
  if (!postId || !uuid.test(postId)) return failure("INVALID_INPUT");
  try {
    const context = await authenticateApiRequest(request, env, fetcher);
    if (!context.ok) return failure(context.code);
    const { settings, userId } = context;
    const eventId = context.eventId.toLowerCase();
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json" ||
      Number(request.headers.get("content-length")) > maxBodyBytes
    )
      return failure("INVALID_INPUT");
    const raw = await limitedBody(request, maxBodyBytes);
    if (raw === null) return failure("INVALID_INPUT");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return failure("INVALID_INPUT");
    }
    if (
      !object(input) ||
      Object.keys(input).some((key) => !["upload_id", "parts"].includes(key)) ||
      typeof input.upload_id !== "string" ||
      !uuid.test(input.upload_id)
    )
      return failure("INVALID_INPUT");
    const uploadId = input.upload_id.toLowerCase();
    const parts: CompletionPart[] | null =
      "parts" in input ? normalizeCompletionParts(input.parts) : [];
    if (parts === null) return failure("INVALID_INPUT");

    async function rpc(
      action: "prepare" | "commit",
      payload: object,
    ): Promise<unknown> {
      const response = await fetcher(
        new URL("/rest/v1/rpc/complete_upload", settings.url),
        {
          method: "POST",
          redirect: "manual",
          cache: "no-store",
          headers: {
            apikey: settings.secretKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            p_event_id: eventId,
            p_user_id: userId,
            p_post_id: postId,
            p_upload_id: uploadId,
            p_action: action,
            p_input: payload,
          }),
        },
      );
      if (!response.ok) throw new CompletionError("INTERNAL_ERROR");
      const value: unknown = await response.json();
      if (
        object(value) &&
        completionErrors.includes(value.code as ApiErrorCode)
      )
        throw new CompletionError(value.code as ApiErrorCode);
      return value;
    }
    const acknowledgement = (value: unknown): Response | null => {
      const receipt = completionReceipt(value, eventId, postId);
      return receipt ? reply(receipt, 202) : null;
    };
    const prepared = await rpc("prepare", { parts });
    const existing = acknowledgement(prepared);
    if (existing) return existing;
    const validated = preparedCompletion(prepared, {
      eventId,
      postId,
      uploadId,
      parts,
    });
    const observation = await verifyCompletedOriginal(
      env.ORIGINALS_BUCKET,
      validated.identity,
      validated.size,
      validated.providerId,
      parts,
    );
    return (
      acknowledgement(
        await rpc("commit", {
          parts,
          post_version: validated.version,
          observation,
        }),
      ) ?? failure("INTERNAL_ERROR")
    );
  } catch (error) {
    return failure(
      error instanceof CompletionError ? error.code : "INTERNAL_ERROR",
    );
  }
}
