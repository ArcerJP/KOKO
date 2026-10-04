import "server-only";
import { errors, type ErrorCode } from "@koko/contract";
import { apiCookieName, apiTokenForProxy } from "../auth/api-session-cookies";
import { ApiFailure } from "./client";

export type ProxyConfiguration = {
  KOKO_API_PROXY_ENABLED?: string | undefined;
  KOKO_API_COOKIE_ENABLED?: string | undefined;
  KOKO_WEB_ORIGIN?: string | undefined;
  KOKO_API_UPSTREAM_ORIGIN?: string | undefined;
  KOKO_API_ACCESS_CLIENT_ID?: string | undefined;
  KOKO_API_ACCESS_CLIENT_SECRET?: string | undefined;
};
const upstreamOrigin = "https://koko-api-dev.arcer-jp.workers.dev";
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

function configuredOrigin(config: ProxyConfiguration): string | null {
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
  const token = apiTokenForProxy(headers);
  return token ? `${apiCookieName}=${token}` : null;
}

// Opaque credentials: reject unsafe header values, not old/new token formats.
// This is not authentication; Cloudflare validates the credential and policy.
function accessCredential(value: string | undefined): string | null {
  return value && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null;
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

export type JsonOperation = {
  path: string;
  // Exact request search, supplied only by a descriptor that validated its schema.
  search?: string;
  upstreamPath?: string;
  methods: readonly string[];
  inputLimit: number;
  responseLimit: number;
  status: 200 | 202;
  run(context: {
    base: URL;
    eventId: string;
    input: unknown;
    csrf: string;
    signal: AbortSignal;
    fetcher: typeof fetch;
  }): Promise<unknown>;
};
export function proxyConfiguration(): ProxyConfiguration {
  return {
    KOKO_API_PROXY_ENABLED: process.env.KOKO_API_PROXY_ENABLED,
    KOKO_API_COOKIE_ENABLED: process.env.KOKO_API_COOKIE_ENABLED,
    KOKO_WEB_ORIGIN: process.env.KOKO_WEB_ORIGIN,
    KOKO_API_UPSTREAM_ORIGIN: process.env.KOKO_API_UPSTREAM_ORIGIN,
    KOKO_API_ACCESS_CLIENT_ID: process.env.KOKO_API_ACCESS_CLIENT_ID,
    KOKO_API_ACCESS_CLIENT_SECRET: process.env.KOKO_API_ACCESS_CLIENT_SECRET,
  };
}
/** Server-only fixed JSON boundary. Only explicit route descriptors call this. */
export async function handleJsonProxy(
  request: Request,
  operation: JsonOperation,
  config: ProxyConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const allowed = operation.methods;
  if (!allowed.includes(request.method))
    return Response.json(
      { code: "METHOD_NOT_ALLOWED" },
      {
        status: 405,
        headers: { ...responseHeaders, Allow: allowed.join(", ") },
      },
    );
  const origin = configuredOrigin(config);
  const accessId = accessCredential(config.KOKO_API_ACCESS_CLIENT_ID);
  const accessSecret = accessCredential(config.KOKO_API_ACCESS_CLIENT_SECRET);
  if (!origin || !accessId || !accessSecret) return failure("INTERNAL_ERROR");
  const url = new URL(request.url);
  const mutation = request.method !== "GET";
  const sentOrigin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    url.origin !== origin ||
    url.pathname !== `/api/${operation.path}` ||
    url.search !== (operation.search ?? "") ||
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
    if (mutation && operation.inputLimit > 0 && !isJson(request.headers))
      return failure("INVALID_INPUT");
    const text = await deadline(1000, request.signal, (signal) =>
      readBody(request.body, mutation ? operation.inputLimit : 0, signal),
    );
    if (mutation && operation.inputLimit > 0) input = JSON.parse(text);
  } catch {
    return failure("INVALID_INPUT");
  }

  try {
    return await deadline(10_000, request.signal, async (signal) => {
      const forward: typeof fetch = async (target, init) => {
        if (
          String(target) !==
          `${upstreamOrigin}/${operation.upstreamPath ?? operation.path}`
        )
          throw new Error("Invalid upstream target");
        // 呼出し元Cookie/Access/Authorization/転送先headerは透過しない。
        const generated = new Headers(init?.headers);
        const headers = new Headers({
          Accept: "application/json",
          Cookie: cookie,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "X-Event-ID": eventId,
          "CF-Access-Client-Id": accessId,
          "CF-Access-Client-Secret": accessSecret,
        });
        if (mutation) {
          headers.set("Content-Type", "application/json");
          headers.set("X-CSRF-Token", generated.get("x-csrf-token") ?? "");
        }
        const response = await fetcher(target, {
          method: request.method,
          headers,
          ...(mutation && init?.body !== undefined ? { body: init.body } : {}),
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
        const body = await readBody(
          response.body,
          operation.responseLimit,
          signal,
        );
        // Reject literal/JSON-escaped credential reflection, including keys and
        // error payloads. Never log upstream data; this is not a general DLP.
        JSON.parse(body, (key: string, value: unknown) => {
          if (
            [accessId, accessSecret].some(
              (credential) =>
                key.includes(credential) ||
                (typeof value === "string" && value.includes(credential)),
            )
          )
            throw new Error("Invalid upstream response");
          return value;
        });
        return new Response(body, {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      };
      const result = await operation.run({
        base: new URL(`${upstreamOrigin}/`),
        eventId,
        input,
        csrf: request.headers.get("x-csrf-token") ?? "",
        signal,
        fetcher: forward,
      });
      return Response.json(result, {
        status: operation.status,
        headers: responseHeaders,
      });
    });
  } catch (error) {
    if (error instanceof ApiFailure && errors[error.code].status > 0)
      return failure(error.code, error.requestId);
    // timeout後に上流の更新が成立している可能性がある。自動再送しない。
    return failure("INTERNAL_ERROR");
  }
}
