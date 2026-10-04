import { errors, type ErrorCode } from "@koko/contract";
import {
  ApiFailure,
  createApiClient,
  type AcceptTerms,
  type UpdateMe,
} from "./client";

type Resource = "me" | "consents";
type Configuration = {
  KOKO_API_PROXY_ENABLED?: string | undefined;
  KOKO_API_COOKIE_ENABLED?: string | undefined;
  KOKO_WEB_ORIGIN?: string | undefined;
  KOKO_API_UPSTREAM_ORIGIN?: string | undefined;
};
const upstreamOrigin = "https://koko-api-dev.arcer-jp.workers.dev";
const sessionName = "__Host-koko_session";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const responseHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function failure(code: ErrorCode, requestId: string | null = null) {
  return Response.json(
    { code, request_id: requestId ?? crypto.randomUUID() },
    { status: errors[code].status, headers: responseHeaders },
  );
}

function configuredOrigin(config: Configuration): string | null {
  if (
    config.KOKO_API_PROXY_ENABLED !== "true" ||
    config.KOKO_API_COOKIE_ENABLED !== "true" ||
    config.KOKO_API_UPSTREAM_ORIGIN !== upstreamOrigin
  )
    return null;
  try {
    const url = new URL(config.KOKO_WEB_ORIGIN ?? "");
    return url.protocol === "https:" && url.origin === config.KOKO_WEB_ORIGIN
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function sessionCookie(headers: Headers): string | null {
  if (headers.has("authorization")) return null;
  const cookie = headers.get("cookie") ?? "";
  if (new TextEncoder().encode(cookie).byteLength > 16 * 1024) return null;
  let token: string | undefined;
  for (const part of cookie.split(";")) {
    const item = part.trim();
    const separator = item.indexOf("=");
    const name = separator < 0 ? item : item.slice(0, separator);
    if (name.startsWith(`${sessionName}.`)) return null;
    if (name !== sessionName) continue;
    if (token !== undefined) return null;
    token = item.slice(separator + 1);
  }
  // 署名・claimsの信頼判定はWorker。ここでは発行側上限と転送形式だけ。
  return token && token.length <= 3500 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
    ? `${sessionName}=${token}`
    : null;
}

async function deadline<T>(
  milliseconds: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, milliseconds);
  let stop: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("Request interrupted"));
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
  }
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!body) return "";
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maximum) throw new Error("Body too large");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function isJson(headers: Headers) {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    headers.get("content-type") ?? "",
  );
}

/** Node Route Handler専用。秘密値やAccess認証を自動補完しない。 */
export async function handleAccountProxy(
  request: Request,
  resource: Resource,
  config: Configuration = {
    KOKO_API_PROXY_ENABLED: process.env.KOKO_API_PROXY_ENABLED,
    KOKO_API_COOKIE_ENABLED: process.env.KOKO_API_COOKIE_ENABLED,
    KOKO_WEB_ORIGIN: process.env.KOKO_WEB_ORIGIN,
    KOKO_API_UPSTREAM_ORIGIN: process.env.KOKO_API_UPSTREAM_ORIGIN,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const allowed = resource === "me" ? ["GET", "PATCH"] : ["POST"];
  if (!allowed.includes(request.method))
    return Response.json(
      { code: "METHOD_NOT_ALLOWED" },
      {
        status: 405,
        headers: { ...responseHeaders, Allow: allowed.join(", ") },
      },
    );
  const origin = configuredOrigin(config);
  if (!origin) return failure("INTERNAL_ERROR");
  const url = new URL(request.url);
  const mutation = request.method !== "GET";
  const sentOrigin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    url.origin !== origin ||
    url.pathname !== `/api/${resource}` ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (sentOrigin !== null && sentOrigin !== origin) ||
    (mutation && sentOrigin !== origin) ||
    (site !== null && site !== "same-origin" && !(site === "none" && !mutation))
  )
    return failure("FORBIDDEN");
  const eventId = request.headers.get("x-event-id") ?? "";
  if (!uuid.test(eventId)) return failure("INVALID_INPUT");
  const cookie = sessionCookie(request.headers);
  if (!cookie) return failure("AUTH_REQUIRED");
  let input: unknown;
  try {
    if (request.headers.has("content-encoding"))
      return failure("INVALID_INPUT");
    if (mutation && !isJson(request.headers)) return failure("INVALID_INPUT");
    const text = await deadline(1000, request.signal, (signal) =>
      readBody(request.body, mutation ? 1024 : 0, signal),
    );
    if (mutation) input = JSON.parse(text);
  } catch {
    return failure("INVALID_INPUT");
  }

  try {
    return await deadline(10_000, request.signal, async (signal) => {
      const client = createApiClient(
        new URL(`${upstreamOrigin}/`),
        eventId,
        async (target, init) => {
          // 呼出し元Cookie/Access/Authorization/転送先headerは透過しない。
          const generated = new Headers(init?.headers);
          const headers = new Headers({
            Accept: "application/json",
            Cookie: cookie,
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "X-Event-ID": eventId,
          });
          if (mutation) {
            headers.set("Content-Type", "application/json");
            headers.set("X-CSRF-Token", generated.get("x-csrf-token") ?? "");
          }
          const response = await fetcher(target, {
            method: request.method,
            headers,
            ...(mutation && init?.body !== undefined
              ? { body: init.body }
              : {}),
            credentials: "omit",
            redirect: "manual",
            cache: "no-store",
            signal,
          });
          if (
            signal.aborted ||
            response.redirected ||
            (response.status >= 300 && response.status < 400) ||
            !isJson(response.headers)
          ) {
            void response.body?.cancel().catch(() => {});
            throw new Error("Invalid upstream response");
          }
          const body = await readBody(response.body, 16 * 1024, signal);
          return new Response(body, {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        },
      );
      const csrf = request.headers.get("x-csrf-token") ?? "";
      // 型assertionは信頼判定ではない。clientの実行時検査で拒否/投影する。
      const result = !mutation
        ? await client.getMe(signal)
        : resource === "me"
          ? await client.updateMe(input as UpdateMe, csrf, signal)
          : await client.acceptTerms(input as AcceptTerms, csrf, signal);
      if (!mutation && !("csrf_token" in result))
        return failure("INTERNAL_ERROR");
      return Response.json(result, { headers: responseHeaders });
    });
  } catch (error) {
    if (error instanceof ApiFailure && errors[error.code].status > 0)
      return failure(error.code, error.requestId);
    // timeout後に上流の更新が成立している可能性がある。自動再送しない。
    return failure("INTERNAL_ERROR");
  }
}
