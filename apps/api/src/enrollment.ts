import { createCsrfToken } from "./account-auth";
import {
  authenticateApiRequest,
  failure,
  object,
  privateHeaders,
  reply,
  uuid,
  type AccountEnv,
} from "./api-context";

export type EnrollmentEnv = AccountEnv & {
  KOKO_ENROLLMENT_ENABLED?: string;
  KOKO_EVENT_ID?: string;
};

async function text(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
) {
  if (!body) throw new Error("INVALID_BODY");
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("INVALID_BODY");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/** No membership implied by preflight or CSRF. All existing routes retain their own authorization. */
export async function handleEnrollment(
  request: Request,
  env: EnrollmentEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_ENROLLMENT_ENABLED !== "true") return failure("NOT_FOUND");
  if (!["GET", "POST"].includes(request.method))
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
      { status: 405, headers: { ...privateHeaders, allow: "GET, POST" } },
    );
  const eventId = env.KOKO_EVENT_ID;
  if (!eventId || !uuid.test(eventId)) return failure("INTERNAL_ERROR");
  const headerEvent = request.headers.get("X-Event-ID");
  if (!headerEvent || !uuid.test(headerEvent)) return failure("INVALID_INPUT");
  if (headerEvent.toLowerCase() !== eventId.toLowerCase())
    return failure("FORBIDDEN");
  const target = new URL(request.url);
  if (
    target.pathname !== "/me/enrollment" ||
    target.search ||
    (request.method === "GET" && request.body)
  )
    return failure("INVALID_INPUT");

  const deadline = new AbortController();
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 10000);
  let rejectAbort: (() => void) | undefined;
  try {
    const operation = async (): Promise<Response> => {
      signal.throwIfAborted();
      const upstream: typeof fetch = async (url, init) => {
        signal.throwIfAborted();
        const response = await fetcher(url, { ...init, signal });
        signal.throwIfAborted();
        if (!response.ok || response.redirected) {
          void response.body?.cancel().catch(() => {});
          return new Response(null, {
            status:
              response.status >= 300 && response.status < 400
                ? 502
                : response.status,
          });
        }
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            response.headers.get("content-type") ?? "",
          )
        ) {
          void response.body?.cancel().catch(() => {});
          throw new Error("INVALID_RESPONSE");
        }
        return new Response(await text(response.body, 16384, signal), {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      };
      const context = await authenticateApiRequest(request, env, upstream);
      if (!context.ok) return failure(context.code);
      const { settings, userId, auth } = context;
      let displayName: string | undefined;
      if (request.method === "POST") {
        const length = request.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") ?? "",
          ) ||
          request.headers.has("content-encoding") ||
          (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024))
        )
          return failure("INVALID_INPUT");
        try {
          const raw = await text(request.body, 1024, signal);
          if (
            length !== null &&
            new TextEncoder().encode(raw).byteLength !== Number(length)
          )
            return failure("INVALID_INPUT");
          const value: unknown = JSON.parse(raw);
          if (
            !object(value) ||
            Object.keys(value).length !== 1 ||
            typeof value.display_name !== "string" ||
            value.display_name.trim().length === 0 ||
            Array.from(value.display_name).length > 50 ||
            /[\p{Cc}\p{Cf}]/u.test(value.display_name)
          )
            return failure("INVALID_INPUT");
          displayName = value.display_name;
        } catch {
          return failure("INVALID_INPUT");
        }
      }
      signal.throwIfAborted();
      const name =
        request.method === "GET" ? "read_event_enrollment" : "enroll_event";
      const response = await upstream(
        new URL(`/rest/v1/rpc/${name}`, settings.url),
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
            p_event_id: eventId.toLowerCase(),
            p_user_id: userId.toLowerCase(),
            ...(displayName !== undefined
              ? { p_display_name: displayName }
              : {}),
          }),
        },
      );
      if (response.status !== 200) return failure("INTERNAL_ERROR");
      const result: unknown = await response.json();
      signal.throwIfAborted();
      if (request.method === "POST") {
        if (result === "enrolled")
          return reply({ request_id: crypto.randomUUID() }, 200);
        if (
          result === "INVALID_INPUT" ||
          result === "FORBIDDEN" ||
          result === "EVENT_CLOSED" ||
          result === "PUBLICATION_STOPPED"
        )
          return failure(result);
        return failure("INTERNAL_ERROR");
      }
      if (!object(result)) return failure("INTERNAL_ERROR");
      if (result.code === "INVALID_INPUT" || result.code === "FORBIDDEN")
        return failure(result.code);
      if (
        result.code !== "ok" ||
        !["enrolled", "not_enrolled"].includes(String(result.status)) ||
        typeof result.can_enroll !== "boolean" ||
        (result.status === "enrolled" && result.can_enroll)
      )
        return failure("INTERNAL_ERROR");
      return reply(
        {
          user_id: userId.toLowerCase(),
          event_id: eventId.toLowerCase(),
          enrolled: result.status === "enrolled",
          registration_open: result.can_enroll,
          ...(auth.mode === "cookie"
            ? { csrf_token: await createCsrfToken(auth, context.eventId) }
            : {}),
        },
        200,
      );
    };
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("ABORTED"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
  } catch {
    return failure("INTERNAL_ERROR");
  } finally {
    clearTimeout(timer);
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    deadline.abort();
  }
}
