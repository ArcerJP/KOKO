import "server-only";
import { apiCookieName, apiTokenForProxy } from "../auth/api-session-cookies";
import { proxyConfiguration, type ProxyConfiguration } from "./json-proxy";

type Configuration = ProxyConfiguration & {
  KOKO_MEDIA_DELIVERY_ENABLED?: string | undefined;
  KOKO_ADMIN_ORIGINALS_ENABLED?: string | undefined;
  KOKO_EVENT_ID?: string | undefined;
};
const upstream = "https://koko-api-dev.arcer-jp.workers.dev";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximum = 5492189429760; // R2 service object limit; no application size cutoff.
const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};
const fail = (status: number) =>
  new Response(null, { status, headers: privateHeaders });

async function fetchBounded(
  target: string,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  signal.throwIfAborted();
  const pending = fetcher(target, init).then((response) => {
    if (signal.aborted) void response.body?.cancel().catch(() => {});
    return response;
  });
  let abort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Media transfer interrupted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Fixed-origin, cookie-generation-bound binary relay. No URL, token or object-key redirect. */
export async function handleMediaProxy(
  request: Request,
  config: Configuration = {
    ...proxyConfiguration(),
    KOKO_MEDIA_DELIVERY_ENABLED: process.env.KOKO_MEDIA_DELIVERY_ENABLED,
    KOKO_ADMIN_ORIGINALS_ENABLED: process.env.KOKO_ADMIN_ORIGINALS_ENABLED,
    KOKO_EVENT_ID: process.env.KOKO_EVENT_ID,
  },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "GET") return fail(405);
  const url = new URL(request.url);
  const media = /^\/media\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const original = /^\/api\/admin\/posts\/([^/]+)\/original$/.exec(
    url.pathname,
  );
  if (
    (!media && !original) ||
    (original
      ? config.KOKO_ADMIN_ORIGINALS_ENABLED
      : config.KOKO_MEDIA_DELIVERY_ENABLED) !== "true"
  )
    return fail(404);
  const eventId = config.KOKO_EVENT_ID ?? "";
  const postId = original?.[1] ?? media?.[2] ?? "";
  if (
    !uuid.test(eventId) ||
    !uuid.test(postId) ||
    (media && media[1] !== eventId)
  )
    return fail(400);
  if (original) {
    const version = url.searchParams.get("expected_version");
    if (
      !version ||
      !/^[1-9][0-9]{0,9}$/.test(version) ||
      Number(version) > 2147483647 ||
      [...url.searchParams].length !== 1
    )
      return fail(400);
  } else if (
    url.search ||
    !/^(?:(?:review-)?(?:webp|jpg)-(?:600|1600)|hls|(?:review-)?thumbnail|mp4|hls-[A-Za-z0-9_.-]{1,1000})$/.test(
      media![3]!,
    )
  )
    return fail(404);
  const origin = config.KOKO_WEB_ORIGIN;
  const safeCredential = (s: string | undefined): s is string =>
    !!s && /^[\x21-\x7e]{1,512}$/.test(s);
  if (
    config.KOKO_API_PROXY_ENABLED !== "true" ||
    config.KOKO_API_COOKIE_ENABLED !== "true" ||
    config.KOKO_API_UPSTREAM_ORIGIN !== upstream ||
    !origin ||
    !safeCredential(config.KOKO_API_ACCESS_CLIENT_ID) ||
    !safeCredential(config.KOKO_API_ACCESS_CLIENT_SECRET)
  )
    return fail(503);
  try {
    if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
      return fail(503);
  } catch {
    return fail(503);
  }
  const site = request.headers.get("sec-fetch-site");
  const sentOrigin = request.headers.get("origin");
  if (
    url.origin !== origin ||
    url.hash ||
    url.username ||
    url.password ||
    request.body !== null ||
    request.headers.has("content-encoding") ||
    (sentOrigin !== null && sentOrigin !== origin) ||
    (site !== null && site !== "same-origin" && site !== "none") ||
    (request.headers.has("x-event-id") &&
      request.headers.get("x-event-id") !== eventId)
  )
    return fail(403);
  const token = apiTokenForProxy(request.headers);
  if (!token) return fail(401);
  // No validator is exposed by this no-store relay; an If-Range request must fall back to full.
  const range = request.headers.has("if-range")
    ? null
    : request.headers.get("range");
  const requested = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
  if (
    range !== null &&
    (range.length > 60 ||
      !requested ||
      (!requested[1] && !requested[2]) ||
      (requested[1] && !Number.isSafeInteger(Number(requested[1]))) ||
      (requested[2] && !Number.isSafeInteger(Number(requested[2]))) ||
      (requested[1] &&
        requested[2] &&
        Number(requested[2]) < Number(requested[1])) ||
      (!requested[1] && Number(requested[2]) === 0))
  )
    return fail(416);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let owned = false;
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
  };
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(abort, ms);
  };
  try {
    arm(10_000);
    const headers = new Headers({
      cookie: `${apiCookieName}=${token}`,
      origin,
      "sec-fetch-site": "same-origin",
      "x-event-id": eventId,
      "cf-access-client-id": config.KOKO_API_ACCESS_CLIENT_ID,
      "cf-access-client-secret": config.KOKO_API_ACCESS_CLIENT_SECRET,
      accept: "*/*",
      "accept-encoding": "identity",
    });
    if (range) headers.set("range", range);
    const path = original ? url.pathname.slice(4) : url.pathname;
    const response = await fetchBounded(
      upstream + path + url.search,
      {
        method: "GET",
        headers,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
      },
      controller.signal,
      fetcher,
    );
    reader = response.body?.getReader();
    if (
      controller.signal.aborted ||
      response.redirected ||
      ![200, 206].includes(response.status)
    ) {
      return fail(
        [401, 403, 404, 409, 416, 429].includes(response.status)
          ? response.status
          : 502,
      );
    }
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    const allowed = original
      ? ["application/octet-stream"]
      : [
          "image/jpeg",
          "image/webp",
          "video/mp4",
          "video/mp2t",
          "video/iso.segment",
          "audio/mp4",
          "audio/aac",
          "application/octet-stream",
          "application/vnd.apple.mpegurl",
          "application/x-mpegurl",
        ];
    if (
      !reader ||
      !allowed.includes(type.split(";")[0]!) ||
      (response.headers.has("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    )
      return fail(502);
    const length = response.headers.get("content-length");
    if (
      (original && length === null) ||
      (length !== null &&
        (!/^[1-9][0-9]{0,12}$/.test(length) || Number(length) > maximum))
    )
      return fail(502);
    const contentRange = response.headers.get("content-range");
    if (response.status === 206) {
      const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
        contentRange ?? "",
      );
      if (
        !range ||
        !match ||
        !length ||
        !match.slice(1).every((x) => Number.isSafeInteger(Number(x))) ||
        Number(match[2]) < Number(match[1]) ||
        Number(match[3]) <= Number(match[2]) ||
        Number(match[3]) > maximum ||
        Number(match[2]) - Number(match[1]) + 1 !== Number(length) ||
        (requested![1]
          ? Number(match[1]) !== Number(requested![1]) ||
            Number(match[2]) !==
              Math.min(
                requested![2] ? Number(requested![2]) : Number(match[3]) - 1,
                Number(match[3]) - 1,
              )
          : Number(match[1]) !==
              Math.max(0, Number(match[3]) - Number(requested![2])) ||
            Number(match[2]) !== Number(match[3]) - 1)
      )
        return fail(502);
    } else if (contentRange !== null) return fail(502);
    const outgoing = new Headers({ ...privateHeaders, "content-type": type });
    if (length !== null) outgoing.set("content-length", length);
    if (contentRange !== null) outgoing.set("content-range", contentRange);
    if (response.headers.get("accept-ranges") === "bytes")
      outgoing.set("accept-ranges", "bytes");
    if (original) {
      outgoing.set(
        "content-disposition",
        `attachment; filename="${postId}-original.bin"`,
      );
      outgoing.set("content-security-policy", "sandbox; default-src 'none'");
    }
    let size = 0;
    arm(30_000);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(destination) {
          try {
            controller.signal.throwIfAborted();
            arm(30_000);
            const chunk = await reader!.read();
            controller.signal.throwIfAborted();
            if (chunk.done) {
              if (length !== null && size !== Number(length))
                throw new Error("Invalid length");
              cleanup();
              destination.close();
              return;
            }
            size += chunk.value.byteLength;
            if (size > maximum || (length !== null && size > Number(length)))
              throw new Error("Invalid length");
            destination.enqueue(chunk.value);
          } catch {
            cleanup();
            abort();
            destination.error(new Error("Media transfer interrupted"));
          }
        },
        cancel() {
          cleanup();
          abort();
        },
      },
      { highWaterMark: 0 },
    );
    owned = true;
    return new Response(body, { status: response.status, headers: outgoing });
  } catch {
    return fail(502);
  } finally {
    if (!owned) {
      cleanup();
      abort();
    }
  }
}
