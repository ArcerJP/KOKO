import "server-only";
import { ApiFailure, createApiClient, type EnrollmentRequest } from "./client";
import {
  handleJsonProxy,
  proxyConfiguration,
  type ProxyConfiguration,
} from "./json-proxy";

type Configuration = ProxyConfiguration & {
  KOKO_ENROLLMENT_ENABLED?: string | undefined;
  KOKO_EVENT_ID?: string | undefined;
};
export async function handleEnrollmentProxy(
  request: Request,
  config: Configuration = {
    ...proxyConfiguration(),
    KOKO_ENROLLMENT_ENABLED: process.env.KOKO_ENROLLMENT_ENABLED,
    KOKO_EVENT_ID: process.env.KOKO_EVENT_ID,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const fail = (code: string, status: number) =>
    Response.json(
      { code, request_id: crypto.randomUUID() },
      {
        status,
        headers: {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  if (config.KOKO_ENROLLMENT_ENABLED !== "true") return fail("NOT_FOUND", 404);
  if (
    !config.KOKO_EVENT_ID ||
    request.headers.get("x-event-id") !== config.KOKO_EVENT_ID
  )
    return fail("FORBIDDEN", 403);
  return handleJsonProxy(
    request,
    {
      path: "me/enrollment",
      methods: ["GET", "POST"],
      inputLimit: 1024,
      responseLimit: 4096,
      status: 200,
      async run({ base, eventId, input, csrf, signal, fetcher: forward }) {
        const client = createApiClient(base, eventId, forward);
        if (request.method === "GET") {
          const status = await client.getEnrollment(signal);
          if (!status.csrf_token) throw new ApiFailure("INTERNAL_ERROR");
          return status;
        }
        return client.enrollEvent(input as EnrollmentRequest, csrf, signal);
      },
    },
    config,
    fetcher,
  );
}
