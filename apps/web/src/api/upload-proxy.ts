import "server-only";
import { ApiFailure } from "./client";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";
import { createUploadClient } from "./upload-client";
import {
  assertDestination,
  record,
  validId,
  type CompleteUpload,
  type UploadRequest,
} from "./upload-contract";

type Configuration = ProxyConfiguration & {
  KOKO_UPLOAD_PROXY_ENABLED?: string | undefined;
  KOKO_R2_ACCOUNT_ID?: string | undefined;
};
export async function handleUploadProxy(
  request: Request,
  config: Configuration = {
    ...proxyConfiguration(),
    KOKO_UPLOAD_PROXY_ENABLED: process.env.KOKO_UPLOAD_PROXY_ENABLED,
    KOKO_R2_ACCOUNT_ID: process.env.KOKO_R2_ACCOUNT_ID,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (config.KOKO_UPLOAD_PROXY_ENABLED !== "true")
    return Response.json(
      { code: "NOT_FOUND", request_id: crypto.randomUUID() },
      { status: 404, headers },
    );
  const path = new URL(request.url).pathname;
  const match =
    /^\/api\/(uploads\/([^/]+)\/(refresh|parts)|posts\/([^/]+)\/complete)$/.exec(
      path,
    );
  const action =
    path === "/api/uploads"
      ? "open"
      : (match?.[3] ?? (match?.[4] ? "complete" : undefined));
  const resourceId = match?.[2] ?? match?.[4];
  if (!action || (resourceId !== undefined && !validId(resourceId)))
    return Response.json(
      { code: "INVALID_INPUT", request_id: crypto.randomUUID() },
      { status: 400, headers },
    );
  return handleJsonProxy(
    request,
    {
      path: path.slice(5),
      upstreamPath: path.slice(5).toLowerCase(),
      methods: ["POST"],
      status: action === "complete" ? 202 : 200,
      inputLimit:
        action === "refresh" ? 0 : action === "complete" ? 1024 * 1024 : 4096,
      responseLimit: action === "parts" ? 1024 * 1024 : 16 * 1024,
      async run({ base, eventId, input, csrf, signal, fetcher: forward }) {
        const destination = {
          eventId,
          r2AccountId: config.KOKO_R2_ACCOUNT_ID ?? "",
        };
        assertDestination(destination);
        const client = createUploadClient(base, destination, forward);
        switch (action) {
          case "open":
            return client.open(input as UploadRequest, csrf, signal);
          case "refresh":
            return client.refresh(resourceId!, csrf, signal);
          case "parts":
            if (!record(input) || Object.keys(input).length !== 1)
              throw new ApiFailure("INVALID_INPUT");
            return client.parts(
              resourceId!,
              input.part_numbers as number[],
              csrf,
              signal,
            );
          default:
            return client.complete(
              resourceId!,
              input as CompleteUpload,
              csrf,
              signal,
            );
        }
      },
    },
    config,
    fetcher,
  );
}
