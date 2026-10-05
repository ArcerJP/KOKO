import { failure, object, privateHeaders } from "./api-context";
import type { AuthorizedMedia } from "./media-delivery";

/** Proposed bindings only. Creating credentials or changing Stream policy is a separate human gate. */
export type StreamDeliveryEnv = {
  KOKO_STREAM_DELIVERY_ENABLED?: string;
  KOKO_STREAM_ACCOUNT_ID?: string;
  KOKO_STREAM_CUSTOMER_HOST?: string;
  KOKO_STREAM_PLAYBACK_ORIGIN?: string;
  KOKO_STREAM_DELIVERY_API_TOKEN?: string;
  KOKO_STREAM_RESOURCE_SECRET?: string;
};
type Kind = "manifest" | "segment" | "key" | "map" | "thumbnail" | "mp4";
type Child = {
  e: string;
  p: string;
  v: number;
  x: number;
  path: string;
  kind: Kind;
};
const encoder = new TextEncoder();
const ttl = 120;
const maxBinary = 64 * 1024 * 1024;
const denied = (): never => {
  throw new Error("STREAM_DELIVERY_FAILED");
};
const discard = (response: Response) => {
  void response.body?.cancel().catch(() => {});
};
/** Even a late/non-cooperative fetch must not leave a request waiting or a body unconsumed. */
async function fetchBounded(
  target: string,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  signal.throwIfAborted();
  let expired = false;
  const pending = fetcher(target, init).then((response) => {
    if (expired || signal.aborted) discard(response);
    return response;
  });
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => {
          expired = true;
          reject(new Error("STREAM_DELIVERY_FAILED"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function config(env: StreamDeliveryEnv) {
  const account = env.KOKO_STREAM_ACCOUNT_ID ?? "",
    host = env.KOKO_STREAM_CUSTOMER_HOST ?? "",
    token = env.KOKO_STREAM_DELIVERY_API_TOKEN ?? "",
    secret = env.KOKO_STREAM_RESOURCE_SECRET ?? "",
    origin = env.KOKO_STREAM_PLAYBACK_ORIGIN ?? "";
  if (
    !/^[a-f0-9]{32}$/.test(account) ||
    !/^customer-[a-z0-9]{1,64}\.cloudflarestream\.com$/.test(host) ||
    !/^[A-Za-z0-9_-]{8,1024}$/.test(token) ||
    !/^[a-f0-9]{64}$/.test(secret)
  )
    denied();
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !/^[a-z0-9.-]+$/.test(parsed.hostname)
  )
    denied();
  return { account, host, token, secret, origin };
}
function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function unb64(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return denied();
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (b64(bytes) !== value) return denied();
  return bytes;
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!, (h) => parseInt(h, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
function safePath(path: string, kind: Kind): boolean {
  if (
    path.length > 300 ||
    !/^[A-Za-z0-9_./-]+(?:\?[A-Za-z0-9_.~=&-]+)?$/.test(path) ||
    path.startsWith("/") ||
    path
      .split("?")[0]!
      .split("/")
      .some((s) => !s || s === "." || s === "..")
  )
    return false;
  const name = path.split("?")[0]!;
  if (kind === "manifest")
    return name.startsWith("manifest/") && name.endsWith(".m3u8");
  if (kind === "thumbnail")
    return path === "thumbnails/thumbnail.jpg?time=0s&height=600&fit=scale";
  if (kind === "mp4") return path === "downloads/default.mp4";
  // Only opaque references created from a validated manifest can reach these paths.
  return (
    !name.endsWith(".m3u8") &&
    !name.startsWith("downloads/") &&
    !name.startsWith("thumbnails/") &&
    !name.endsWith(".html")
  );
}
async function encryptChild(child: Child, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode("koko.stream-child.v1"),
    },
    await key(secret),
    encoder.encode(JSON.stringify(child)),
  );
  const opaque = `hls-${b64(iv)}.${b64(new Uint8Array(data))}`;
  if (opaque.length > 1004) denied();
  return `/media/${child.e}/${child.p}/${opaque}`;
}
/** Returns trusted internal data only after AEAD, scope and expiry validation; never reflects plaintext. */
export async function decodeStreamChild(
  request: Request,
  env: StreamDeliveryEnv,
): Promise<Child | null> {
  const match = /^\/media\/([^/]+)\/([^/]+)\/(hls-[^/]+)$/.exec(
    new URL(request.url).pathname,
  );
  if (!match) return null;
  if (env.KOKO_STREAM_DELIVERY_ENABLED !== "true") denied();
  const c = config(env),
    parts = /^hls-([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{20,980})$/.exec(
      match[3]!,
    );
  if (!parts) return denied();
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(parts[1]!),
          additionalData: encoder.encode("koko.stream-child.v1"),
        },
        await key(c.secret),
        unb64(parts[2]!),
      ),
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "e,kind,p,path,v,x" ||
    value.e !== match[1]!.toLowerCase() ||
    value.p !== match[2]!.toLowerCase() ||
    !Number.isSafeInteger(value.v) ||
    Number(value.v) < 1 ||
    !Number.isSafeInteger(value.x) ||
    Number(value.x) <= now ||
    Number(value.x) > now + ttl ||
    typeof value.path !== "string" ||
    !["manifest", "segment", "key", "map"].includes(String(value.kind)) ||
    !safePath(value.path, value.kind as Kind)
  )
    return denied();
  return value as Child;
}
async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  if (!response.body) return denied();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        abort();
        denied();
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
// Bounded credential-keyed cache contains provider tokens, never authorization decisions or manifests.
const tokens = new Map<string, { value: string; expires: number }>();
async function providerToken(
  c: ReturnType<typeof config>,
  uid: string,
  downloadable: boolean,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const cacheKey = b64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(
          `${c.account}:${c.host}:${c.token}:${uid}:${downloadable}`,
        ),
      ),
    ),
  );
  const now = Math.floor(Date.now() / 1000),
    cached = tokens.get(cacheKey);
  if (cached && cached.expires > now + 15) return cached.value;
  const expires = now + ttl;
  const response = await fetchBounded(
    `https://api.cloudflare.com/client/v4/accounts/${c.account}/stream/${uid}/token`,
    {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: {
        authorization: `Bearer ${c.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "identity",
      },
      body: JSON.stringify({
        exp: expires,
        ...(downloadable ? { downloadable: true } : {}),
      }),
    },
    signal,
    fetcher,
  );
  try {
    if (
      response.status !== 200 ||
      response.redirected ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      return denied();
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        await readBounded(response, 16384, signal),
      ),
    );
    if (
      !object(result) ||
      result.success !== true ||
      !Array.isArray(result.errors) ||
      result.errors.length ||
      !object(result.result) ||
      typeof result.result.token !== "string" ||
      result.result.token.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        result.result.token,
      )
    )
      return denied();
    // Transport is the trust boundary; these claims prevent stale/wrong-video or broad-lifetime API responses.
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(unb64(result.result.token.split(".")[1]!)),
    );
    if (
      !object(claims) ||
      claims.sub !== uid ||
      claims.exp !== expires ||
      (claims.nbf !== undefined &&
        (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > now)) ||
      (downloadable && claims.downloadable !== true)
    )
      return denied();
    signal.throwIfAborted();
    if (tokens.size >= 128) tokens.delete(tokens.keys().next().value!);
    tokens.set(cacheKey, { value: result.result.token, expires });
    return result.result.token;
  } finally {
    if (!response.bodyUsed) discard(response);
  }
}
type Attribute = { name: string; value: string; quoted: boolean };
function attributes(text: string): Attribute[] {
  const result: Attribute[] = [];
  let rest = text;
  while (rest) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s"]+))(,|$)/.exec(rest);
    if (!match || result.some((a) => a.name === match[1])) return denied();
    result.push({
      name: match[1]!,
      value: match[2] ?? match[3]!,
      quoted: match[2] !== undefined,
    });
    rest = rest.slice(match[0].length);
    if (!rest && match[4] === ",") denied();
  }
  if (!result.length || result.length > 24) denied();
  return result;
}
const tagAttributes: Record<string, readonly string[]> = {
  "EXT-X-STREAM-INF": [
    "BANDWIDTH",
    "AVERAGE-BANDWIDTH",
    "CODECS",
    "RESOLUTION",
    "FRAME-RATE",
    "AUDIO",
    "VIDEO",
    "SUBTITLES",
    "CLOSED-CAPTIONS",
    "PROGRAM-ID",
  ],
  "EXT-X-I-FRAME-STREAM-INF": [
    "BANDWIDTH",
    "AVERAGE-BANDWIDTH",
    "CODECS",
    "RESOLUTION",
    "VIDEO",
    "URI",
  ],
  "EXT-X-MEDIA": [
    "TYPE",
    "URI",
    "GROUP-ID",
    "LANGUAGE",
    "ASSOC-LANGUAGE",
    "NAME",
    "DEFAULT",
    "AUTOSELECT",
    "FORCED",
    "INSTREAM-ID",
    "CHARACTERISTICS",
    "CHANNELS",
  ],
  "EXT-X-KEY": ["METHOD", "URI", "IV", "KEYFORMAT", "KEYFORMATVERSIONS"],
  "EXT-X-SESSION-KEY": [
    "METHOD",
    "URI",
    "IV",
    "KEYFORMAT",
    "KEYFORMATVERSIONS",
  ],
  "EXT-X-MAP": ["URI", "BYTERANGE"],
  "EXT-X-START": ["TIME-OFFSET", "PRECISE"],
};
async function rewriteManifest(
  text: string,
  current: Child,
  c: ReturnType<typeof config>,
  uid: string,
  token: string,
) {
  // Stream recommends direct fresh manifests, not proxies. This no-store gateway is a deliberate
  // KOKO authorization exception; real-provider manifest compatibility remains an acceptance gate.
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (
    lines[0] !== "#EXTM3U" ||
    lines.length > 1024 ||
    /[^ -~]/.test(
      text.replaceAll("\r\n", "\n").replaceAll("\n", "").replaceAll("\t", ""),
    )
  )
    return denied();
  let pending: "manifest" | "segment" | null = null,
    media = false,
    master = false,
    ended = false,
    resources = 0;
  const output = ["#EXTM3U"];
  async function rewrite(uri: string, kind: Kind) {
    if (++resources > 128 || uri.length > 4600 || /[\s\\%#{}]/.test(uri))
      return denied();
    const url = new URL(uri, `https://${c.host}/${token}/${current.path}`);
    if (url.origin !== `https://${c.host}` || url.username || url.password)
      return denied();
    const prefix = url.pathname.startsWith(`/${token}/`)
      ? `/${token}/`
      : `/${uid}/`;
    if (!url.pathname.startsWith(prefix)) return denied();
    const path = url.pathname.slice(prefix.length) + url.search;
    if (!safePath(path, kind) || path.includes(token) || path.includes(uid))
      return denied();
    return encryptChild({ ...current, path, kind }, c.secret);
  }
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.length > 8192 || line.trim() !== line) return denied();
    if (!line.startsWith("#")) {
      if (!pending || ended) return denied();
      output.push(await rewrite(line, pending));
      pending = null;
      continue;
    }
    if (!line.startsWith("#EXT")) continue; // Comments are never reflected.
    const m = /^#([A-Z0-9-]+)(?::(.*))?$/.exec(line);
    if (!m) return denied();
    const name = m[1]!,
      body = m[2];
    if (name === "EXTINF") {
      const duration = /^([0-9]+(?:\.[0-9]+)?),[^\r\n]*$/.exec(body ?? "");
      if (!duration || Number(duration[1]) > 10 || pending || ended)
        return denied();
      media = true;
      pending = "segment";
      output.push(`#EXTINF:${duration[1]},`);
      continue;
    }
    if (Object.hasOwn(tagAttributes, name)) {
      const attrs = attributes(body ?? "");
      if (attrs.some((a) => !tagAttributes[name]!.includes(a.name)))
        return denied();
      const get = (n: string) => attrs.find((a) => a.name === n)?.value;
      if (name.includes("KEY")) {
        const method = get("METHOD");
        if (method !== "AES-128" && method !== "NONE") return denied();
        if (method === "NONE" ? attrs.length !== 1 : !get("URI"))
          return denied();
        if (get("KEYFORMAT") && get("KEYFORMAT") !== "identity")
          return denied();
        if (get("KEYFORMATVERSIONS") && get("KEYFORMATVERSIONS") !== "1")
          return denied();
        if (get("IV") && !/^0x[a-fA-F0-9]{32}$/.test(get("IV")!))
          return denied();
      }
      if (
        ["EXT-X-MAP", "EXT-X-I-FRAME-STREAM-INF"].includes(name) &&
        !get("URI")
      )
        return denied();
      if (name === "EXT-X-STREAM-INF") {
        if (pending) return denied();
        pending = "manifest";
        master = true;
      }
      if (
        [
          "EXT-X-MEDIA",
          "EXT-X-I-FRAME-STREAM-INF",
          "EXT-X-SESSION-KEY",
        ].includes(name)
      )
        master = true;
      if (["EXT-X-MAP", "EXT-X-KEY"].includes(name)) media = true;
      for (const a of attrs) {
        if (a.name === "URI") {
          if (!a.quoted) return denied();
          a.value = await rewrite(
            a.value,
            name.includes("KEY")
              ? "key"
              : name === "EXT-X-MAP"
                ? "map"
                : "manifest",
          );
        } else if (
          !/^[A-Za-z0-9_. ,/@-]{1,200}$/.test(a.value) ||
          a.value.includes(uid) ||
          a.value.includes(token) ||
          a.value.includes(c.host)
        )
          return denied();
      }
      output.push(
        `#${name}:${attrs.map((a) => `${a.name}=${a.quoted ? `"${a.value}"` : a.value}`).join(",")}`,
      );
      continue;
    }
    if (
      [
        "EXT-X-ENDLIST",
        "EXT-X-INDEPENDENT-SEGMENTS",
        "EXT-X-DISCONTINUITY",
        "EXT-X-I-FRAMES-ONLY",
        "EXT-X-GAP",
      ].includes(name)
    ) {
      if (body !== undefined) return denied();
      if (name === "EXT-X-ENDLIST") {
        ended = true;
        media = true;
      }
    } else if (
      [
        "EXT-X-VERSION",
        "EXT-X-TARGETDURATION",
        "EXT-X-MEDIA-SEQUENCE",
        "EXT-X-DISCONTINUITY-SEQUENCE",
      ].includes(name)
    ) {
      if (!/^[0-9]{1,12}$/.test(body ?? "")) return denied();
    } else if (name === "EXT-X-PLAYLIST-TYPE") {
      if (body !== "VOD") return denied();
    } else if (name === "EXT-X-ALLOW-CACHE") {
      if (body !== "NO" && body !== "YES") return denied();
      continue;
    } else if (name === "EXT-X-BYTERANGE") {
      if (!/^[1-9][0-9]{0,9}(?:@[0-9]{1,10})?$/.test(body ?? ""))
        return denied();
    } else if (name === "EXT-X-PROGRAM-DATE-TIME") {
      if (!/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(body ?? ""))
        return denied();
    } else return denied(); // Unknown/URI-capable extensions cannot escape the gateway.
    output.push(line);
  }
  if (
    pending ||
    !resources ||
    (media && master) ||
    (media && !ended) ||
    current.x <= Math.floor(Date.now() / 1000)
  )
    return denied();
  return output.join("\n") + "\n";
}
function validRange(value: string | null) {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (
    value.length > 60 ||
    !match ||
    (!match[1] && !match[2]) ||
    (match[1] && !Number.isSafeInteger(Number(match[1]))) ||
    (match[2] && !Number.isSafeInteger(Number(match[2]))) ||
    (match[1] && match[2] && Number(match[2]) < Number(match[1])) ||
    (!match[1] && Number(match[2]) === 0)
  )
    return denied();
  return value;
}
function binaryHeaders(response: Response, kind: Kind, range: string | null) {
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBinary)
    return denied();
  const actual = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .toLowerCase();
  const allowed =
    kind === "thumbnail"
      ? ["image/jpeg"]
      : kind === "key"
        ? ["application/octet-stream"]
        : [
            "video/mp4",
            "video/iso.segment",
            "video/mp2t",
            "audio/mp4",
            "audio/aac",
            "application/octet-stream",
          ];
  if (!allowed.includes(actual) || (kind === "key" && length !== 16))
    return denied();
  const headers = new Headers({
    ...privateHeaders,
    "content-type":
      kind === "thumbnail"
        ? "image/jpeg"
        : kind === "mp4" || kind === "map"
          ? "video/mp4"
          : actual,
    "content-length": String(length),
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "accept-ranges": "bytes",
  });
  if (response.status === 206) {
    const part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("content-range") ?? "",
    );
    if (!range || !part) return denied();
    const start = Number(part[1]),
      end = Number(part[2]),
      total = Number(part[3]),
      requested = /^bytes=(\d*)-(\d*)$/.exec(range)!;
    if (
      ![start, end, total].every(Number.isSafeInteger) ||
      total <= end ||
      end < start ||
      end - start + 1 !== length ||
      total > maxBinary ||
      (requested[1]
        ? start !== Number(requested[1]) ||
          end !==
            Math.min(requested[2] ? Number(requested[2]) : total - 1, total - 1)
        : start !== Math.max(0, total - Number(requested[2])) ||
          end !== total - 1)
    )
      return denied();
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
  } else if (response.status !== 200 || response.headers.has("content-range"))
    return denied();
  return { headers, length };
}
/** Gate is provided by media-delivery after fresh Auth + transactionally checked read_media. */
export async function serveStream(
  request: Request,
  env: StreamDeliveryEnv,
  gate: AuthorizedMedia,
  child: Child | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_STREAM_DELIVERY_ENABLED !== "true") return failure("NOT_FOUND");
  const controller = new AbortController(),
    signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 15000);
  let body: ReadableStream<Uint8Array> | null = null,
    handedOff = false;
  try {
    const c = config(env),
      uid = gate.asset.streamUid!;
    const current: Child = child ?? {
      e: gate.eventId,
      p: gate.postId,
      v: gate.asset.postVersion,
      x: Math.floor(Date.now() / 1000) + ttl,
      path:
        gate.resource === "hls"
          ? "manifest/video.m3u8"
          : gate.resource === "thumbnail" ||
              gate.resource === "review-thumbnail"
            ? "thumbnails/thumbnail.jpg?time=0s&height=600&fit=scale"
            : "downloads/default.mp4",
      kind:
        gate.resource === "hls"
          ? "manifest"
          : gate.resource === "thumbnail" ||
              gate.resource === "review-thumbnail"
            ? "thumbnail"
            : "mp4",
    };
    if (
      gate.asset.provider !== "stream" ||
      !/^[a-f0-9]{32}$/.test(uid) ||
      !safePath(current.path, current.kind) ||
      current.e !== gate.eventId ||
      current.p !== gate.postId ||
      current.v !== gate.asset.postVersion
    )
      return denied();
    let range: string | null;
    try {
      range = validRange(
        request.headers.has("if-range") ? null : request.headers.get("range"),
      );
    } catch {
      return new Response(null, { status: 416, headers: privateHeaders });
    }
    if ((current.kind === "manifest" || current.kind === "key") && range)
      return new Response(null, { status: 416, headers: privateHeaders });
    if (
      !(await gate.revalidate()) ||
      current.x <= Math.floor(Date.now() / 1000)
    )
      return failure("NOT_FOUND");
    signal.throwIfAborted();
    const token = await providerToken(
      c,
      uid,
      current.kind === "mp4",
      signal,
      fetcher,
    );
    if (
      !(await gate.revalidate()) ||
      current.x <= Math.floor(Date.now() / 1000)
    )
      return failure("NOT_FOUND");
    signal.throwIfAborted();
    const response = await fetchBounded(
      `https://${c.host}/${token}/${current.path}`,
      {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal,
        headers: {
          accept:
            current.kind === "manifest"
              ? "application/vnd.apple.mpegurl"
              : "*/*",
          "accept-encoding": "identity",
          origin: c.origin,
          referer: `${c.origin}/`,
          ...(range ? { range } : {}),
        },
      },
      signal,
      fetcher,
    );
    body = response.body;
    signal.throwIfAborted();
    if (
      !body ||
      response.redirected ||
      ![200, 206].includes(response.status) ||
      (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    )
      return denied();
    if (current.kind === "manifest") {
      if (
        response.status !== 200 ||
        !/^(?:application\/(?:vnd.apple.mpegurl|x-mpegurl)|audio\/mpegurl)(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        return denied();
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(await readBounded(response, 256 * 1024, signal));
      body = null;
      const rewritten = await rewriteManifest(text, current, c, uid, token);
      if (
        !(await gate.revalidate()) ||
        current.x <= Math.floor(Date.now() / 1000)
      )
        return failure("NOT_FOUND");
      signal.throwIfAborted();
      return new Response(rewritten, {
        headers: {
          ...privateHeaders,
          "content-type": "application/vnd.apple.mpegurl",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        },
      });
    }
    const { headers, length } = binaryHeaders(response, current.kind, range);
    if (
      !(await gate.revalidate()) ||
      current.x <= Math.floor(Date.now() / 1000)
    )
      return failure("NOT_FOUND");
    signal.throwIfAborted();
    const reader = body.getReader();
    body = null;
    let bytes = 0,
      stopped = false;
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (!stopped) {
        stopped = true;
        void reader.cancel().catch(() => {});
      }
      cleanup();
    };
    signal.addEventListener("abort", abort, { once: true });
    // A slow consumer cannot keep a hidden/BAN/stopped resource alive indefinitely.
    // Recheck every 5s; fail closed within 4s if Auth/DB is unavailable (under the 10s revocation budget).
    async function watch() {
      if (stopped) return;
      let policyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const current = await Promise.race([
          gate.revalidate().catch(() => false),
          new Promise<boolean>((resolve) => {
            policyTimer = setTimeout(() => resolve(false), 4000);
          }),
        ]);
        if (stopped) return;
        if (!current) {
          controller.abort();
          return;
        }
        guardTimer = setTimeout(() => {
          void watch();
        }, 5000);
      } finally {
        if (policyTimer !== undefined) clearTimeout(policyTimer);
      }
    }
    guardTimer = setTimeout(() => {
      void watch();
    }, 5000);
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(out) {
          try {
            signal.throwIfAborted();
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) {
              if (bytes !== length) denied();
              stopped = true;
              cleanup();
              out.close();
              return;
            }
            bytes += next.value.byteLength;
            if (bytes > length || bytes > maxBinary) denied();
            out.enqueue(next.value);
          } catch {
            abort();
            out.error(new Error("STREAM_DELIVERY_FAILED"));
          }
        },
        async cancel() {
          stopped = true;
          cleanup();
          controller.abort();
          await reader.cancel().catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    handedOff = true;
    return new Response(stream, { status: response.status, headers });
  } catch {
    return failure("NOT_FOUND");
  } finally {
    if (body) void body.cancel().catch(() => {});
    if (!handedOff) {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
