import { afterEach, expect, it, vi } from "vitest";
import { handleMediaDelivery, type MediaReadEnv } from "../src/media-delivery";
import { decodeStreamChild } from "../src/stream-delivery";

const event = "11111111-1111-4111-8111-111111111111",
  post = "22222222-2222-4222-8222-222222222222",
  user = "33333333-3333-4333-8333-333333333333",
  uid = "a".repeat(32),
  account = "b".repeat(32);
const base = `https://app.example.test/media/${event}/${post}/`;
const b64 = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const master =
  '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"\nvideo-360.m3u8\n';
const media =
  '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,title discarded\nsegment-1.m4s\n#EXT-X-ENDLIST\n';
afterEach(() => vi.useRealTimers());
function request(
  resource = "hls",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(
    resource.startsWith("/media/")
      ? `https://app.example.test${resource}`
      : base + resource,
    {
      headers: { authorization: "Bearer synthetic", ...headers },
      ...(signal ? { signal } : {}),
    },
  );
}
function fixture() {
  const env: MediaReadEnv = {
    KOKO_MEDIA_DELIVERY_ENABLED: "true",
    KOKO_STREAM_DELIVERY_ENABLED: "true",
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SECRET_KEY: "sb_secret_fixture",
    KOKO_STREAM_ACCOUNT_ID: account,
    KOKO_STREAM_CUSTOMER_HOST: "customer-fixture.cloudflarestream.com",
    KOKO_STREAM_PLAYBACK_ORIGIN: "https://app.example.test",
    KOKO_STREAM_DELIVERY_API_TOKEN: `synthetic_${crypto.randomUUID()}`,
    KOKO_STREAM_RESOURCE_SECRET: "d".repeat(64),
  };
  const asset = {
    event_id: event,
    post_id: post,
    post_version: 2,
    asset_id: "44444444-4444-4444-8444-444444444444",
    provider: "stream",
    purpose: "stream_clip",
    object_key: null,
    stream_uid: uid,
    byte_size: null,
    object_version: null,
    object_etag: null,
    sha256: null,
    duration_seconds: 4,
  };
  const db: Record<string, unknown>[] = [],
    api: Record<string, unknown>[] = [],
    delivery: { url: URL; init: RequestInit | undefined }[] = [];
  let dbCode = "ok",
    manifest = master,
    mediaResponse: (() => Response) | undefined,
    tokenResponse: ((value: Record<string, unknown>) => Response) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    const url = new URL(String(target)),
      headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    if (url.hostname === "fixture.supabase.co") {
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: user,
          app_metadata: { provider: "google", providers: ["google"] },
        });
      expect(url.pathname).toBe("/rest/v1/rpc/read_media");
      db.push(JSON.parse(String(init?.body)));
      expect(headers.get("authorization")).toBeNull();
      return Response.json(
        dbCode === "ok" ? { code: "ok", asset } : { code: dbCode },
      );
    }
    if (url.hostname === "api.cloudflare.com") {
      expect(url.pathname).toBe(
        `/client/v4/accounts/${account}/stream/${uid}/token`,
      );
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe(
        `Bearer ${env.KOKO_STREAM_DELIVERY_API_TOKEN}`,
      );
      expect(headers.has("cookie")).toBe(false);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      api.push(body);
      if (tokenResponse) return tokenResponse(body);
      return Response.json({
        success: true,
        errors: [],
        result: {
          token: `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ sub: uid, ...body }))}.synthetic`,
        },
      });
    }
    expect(url.hostname).toBe(env.KOKO_STREAM_CUSTOMER_HOST);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("apikey")).toBeNull();
    expect(headers.get("origin")).toBe(env.KOKO_STREAM_PLAYBACK_ORIGIN);
    expect(headers.get("referer")).toBe(`${env.KOKO_STREAM_PLAYBACK_ORIGIN}/`);
    expect(headers.get("accept-encoding")).toBe("identity");
    delivery.push({ url, init });
    if (mediaResponse) return mediaResponse();
    if (url.pathname.endsWith(".m3u8"))
      return new Response(
        url.pathname.endsWith("/video.m3u8") ? manifest : media,
        { headers: { "content-type": "application/vnd.apple.mpegurl" } },
      );
    const kind = url.pathname.endsWith(".jpg")
      ? "image/jpeg"
      : url.pathname.endsWith("key.bin")
        ? "application/octet-stream"
        : "video/mp4";
    const content =
      kind === "application/octet-stream"
        ? new Uint8Array(16)
        : new TextEncoder().encode("0123456789");
    return new Response(content, {
      headers: {
        "content-type": kind,
        "content-length": String(content.length),
        "set-cookie": "private=secret",
        location: "https://evil.test",
        etag: "provider-secret",
        "cache-control": "public, max-age=600",
      },
    });
  });
  return {
    env,
    asset,
    db,
    api,
    delivery,
    fetcher,
    setDb: (v: string) => {
      dbCode = v;
    },
    setManifest: (v: string) => {
      manifest = v;
    },
    setResponse: (v: () => Response) => {
      mediaResponse = v;
    },
    setToken: (v: (body: Record<string, unknown>) => Response) => {
      tokenResponse = v;
    },
  };
}
const paths = (text: string) =>
  [
    ...text.matchAll(/\/media\/[a-f0-9-]+\/[a-f0-9-]+\/hls-[A-Za-z0-9_.-]+/g),
  ].map((m) => m[0]);
async function decoded(r: Response) {
  return new TextDecoder().decode(await r.arrayBuffer());
}
async function rejected(r: Response) {
  expect(r.status).toBe(404);
  expect(await r.json()).toMatchObject({ code: "NOT_FOUND" });
}
async function manifestPaths(f: ReturnType<typeof fixture>) {
  const r = await handleMediaDelivery(request(), f.env, f.fetcher);
  expect(r.status).toBe(200);
  return paths(await decoded(r));
}
it("rewrites every master URI to encrypted short-lived same-app references; tokens/UID stay server-side", async () => {
  const f = fixture(),
    r = await handleMediaDelivery(request(), f.env, f.fetcher),
    text = await decoded(r);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
  expect(text).not.toContain(uid);
  expect(text).not.toContain("cloudflare");
  expect(text).not.toContain("video-360");
  expect(text).not.toContain("audio.m3u8");
  const refs = paths(text);
  expect(refs).toHaveLength(2);
  expect(await decodeStreamChild(request(refs[1]), f.env)).toMatchObject({
    e: event,
    p: post,
    v: 2,
    path: "manifest/video-360.m3u8",
    kind: "manifest",
  });
  expect(f.api).toHaveLength(1);
  expect(f.api[0]).toEqual({ exp: Math.floor(Date.now() / 1000) + 120 });
  expect(f.db).toHaveLength(4);
});
it("variant manifest key/map/segment all use DB hls-child expected-version gate and opaque references", async () => {
  const f = fixture(),
    ref = (await manifestPaths(f))[1]!,
    r = await handleMediaDelivery(request(ref), f.env, f.fetcher),
    text = await decoded(r);
  expect(r.status).toBe(200);
  const refs = paths(text);
  expect(refs).toHaveLength(3);
  expect(text).not.toContain("title discarded");
  expect(text).not.toContain("key.bin");
  expect(text).not.toContain(uid);
  expect(f.db.at(-1)).toMatchObject({
    p_resource: "hls-child",
    p_input: { expected_version: 2 },
  });
  for (let i = 0; i < refs.length; i++) {
    const binary = await handleMediaDelivery(
      request(refs[i]),
      f.env,
      f.fetcher,
    );
    expect(binary.status).toBe(200);
    expect((await binary.arrayBuffer()).byteLength).toBe(i === 0 ? 16 : 10);
    expect(binary.headers.get("set-cookie")).toBeNull();
    expect(binary.headers.get("location")).toBeNull();
    expect(binary.headers.get("etag")).toBeNull();
    expect(binary.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(f.api).toHaveLength(1); // provider token cache is not an authorization cache
});
it.each(["thumbnail", "review-thumbnail", "mp4"])(
  "serves fixed %s path, server credentials never travel to media host",
  async (resource) => {
    const f = fixture(),
      r = await handleMediaDelivery(request(resource), f.env, f.fetcher);
    expect(r.status).toBe(200);
    expect(await decoded(r)).toBe("0123456789");
    expect(f.delivery[0]!.url.pathname).toMatch(
      resource === "mp4"
        ? /\/downloads\/default.mp4$/
        : /\/thumbnails\/thumbnail.jpg$/,
    );
    expect(f.api[0]?.downloadable).toBe(resource === "mp4" ? true : undefined);
    expect(f.delivery[0]!.init?.headers).not.toHaveProperty("authorization");
    expect(f.db[0]?.p_resource).toBe(resource);
  },
);
it("operator review thumbnail cannot bypass the fresh role check", async () => {
  const f = fixture();
  f.setDb("FORBIDDEN");
  const response = await handleMediaDelivery(
    request("review-thumbnail"),
    f.env,
    f.fetcher,
  );
  expect(response.status).toBe(403);
  expect(f.api).toHaveLength(0);
  expect(f.delivery).toHaveLength(0);
});
it("cached provider token never skips DB role/stop/BAN checks", async () => {
  const f = fixture();
  await manifestPaths(f);
  f.setDb("PUBLICATION_STOPPED");
  const r = await handleMediaDelivery(request(), f.env, f.fetcher);
  expect(r.status).toBe(503);
  expect(f.delivery).toHaveLength(1);
});
it.each([
  "ACCOUNT_BANNED",
  "CONSENT_REQUIRED",
  "EVENT_CLOSED",
  "FORBIDDEN",
  "NOT_FOUND",
  "STATE_CONFLICT",
])("DB %s prevents provider access", async (code) => {
  const f = fixture();
  f.setDb(code);
  const r = await handleMediaDelivery(request(), f.env, f.fetcher);
  expect(r.status).not.toBe(200);
  expect(f.api).toHaveLength(0);
  expect(f.delivery).toHaveLength(0);
});
it.each([undefined, "false", "TRUE"])(
  "Stream delivery flag %s is disabled",
  async (flag) => {
    const f = fixture();
    if (flag === undefined) delete f.env.KOKO_STREAM_DELIVERY_ENABLED;
    else f.env.KOKO_STREAM_DELIVERY_ENABLED = flag;
    await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
    expect(f.api).toHaveLength(0);
  },
);
it.each([
  ["KOKO_STREAM_CUSTOMER_HOST", "evil.test"],
  ["KOKO_STREAM_CUSTOMER_HOST", "customer-x.cloudflarestream.com.evil.test"],
  ["KOKO_STREAM_ACCOUNT_ID", "../account"],
  ["KOKO_STREAM_RESOURCE_SECRET", "a"],
  ["KOKO_STREAM_PLAYBACK_ORIGIN", "http://app.example.test"],
  ["KOKO_STREAM_PLAYBACK_ORIGIN", "https://user@app.example.test"],
  ["KOKO_STREAM_PLAYBACK_ORIGIN", "https://app.example.test/path"],
  ["KOKO_STREAM_DELIVERY_API_TOKEN", "bad token"],
] as const)("invalid fixed config %s denied", async (name, value) => {
  const f = fixture();
  f.env[name] = value;
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
  expect(f.api).toHaveLength(0);
});
it.each(["tamper", "event", "post", "secret", "expired", "version"])(
  "opaque child rejects %s",
  async (mode) => {
    const f = fixture();
    let ref = (await manifestPaths(f))[1]!;
    if (mode === "tamper")
      ref = ref.slice(0, -3) + (ref.at(-3) === "a" ? "b" : "a") + ref.slice(-2);
    if (mode === "event")
      ref = ref.replace(event, "55555555-5555-4555-8555-555555555555");
    if (mode === "post")
      ref = ref.replace(post, "55555555-5555-4555-8555-555555555555");
    if (mode === "secret") f.env.KOKO_STREAM_RESOURCE_SECRET = "e".repeat(64);
    if (mode === "expired") {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 121000);
    }
    if (mode === "version") f.asset.post_version++;
    const before = f.delivery.length;
    const r = await handleMediaDelivery(request(ref), f.env, f.fetcher);
    expect(r.status).not.toBe(200);
    expect(f.delivery).toHaveLength(before);
  },
);
it("request query and raw provider URL cannot become an arbitrary proxy", async () => {
  const f = fixture();
  for (const resource of [
    "hls?url=https://evil.test",
    "hls?token=private",
    "hls-child",
    "https:%2F%2Fevil.test",
  ]) {
    const r = await handleMediaDelivery(request(resource), f.env, f.fetcher);
    expect(r.status).not.toBe(200);
  }
  expect(f.delivery).toHaveLength(0);
});
it.each([
  "https://evil.test/video.m3u8",
  "//evil.test/video.m3u8",
  "/another-video/manifest/video.m3u8",
  "data:text/plain,evil",
  "file:///tmp/key",
  "../../../other/manifest/video.m3u8",
  "%2e%2e/video.m3u8",
  "video.m3u8#token",
  "video.m3u8?url=https://evil.test",
  "\\evil.test\\video.m3u8",
  "video.m3u8?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
])("manifest URI %s is rejected without fetching it", async (uri) => {
  const f = fixture();
  f.setManifest(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n${uri}\n`);
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
  expect(f.delivery).toHaveLength(1);
});
it("same fixed host + same UID path is converted to fresh signed-token relative path", async () => {
  const f = fixture();
  f.setManifest(
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttps://${f.env.KOKO_STREAM_CUSTOMER_HOST}/${uid}/manifest/low.m3u8\n`,
  );
  const ref = (await manifestPaths(f))[0]!;
  expect(await decodeStreamChild(request(ref), f.env)).toMatchObject({
    path: "manifest/low.m3u8",
  });
});
it.each([
  '#EXT-X-CONTENT-STEERING:SERVER-URI="https://evil.test"',
  '#EXT-X-SESSION-DATA:DATA-ID="x",URI="https://evil.test"',
  '#EXT-X-DEFINE:NAME="host",VALUE="evil"',
  '#EXT-X-PART:DURATION=1,URI="part.m4s"',
  '#EXT-X-UNKNOWN:URI="bad"',
  '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",EVIL-URI="evil"',
  '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",URI="other.m3u8"',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="evil"',
  '#EXT-X-KEY:METHOD=NONE,URI="key.bin"',
  '#EXT-X-MAP:BYTERANGE="10@0"',
  '#EXT-X-STREAM-INF:BANDWIDTH=10,EVIL="x"',
])("unsupported or malformed HLS tag %s fails closed", async (tag) => {
  const f = fixture();
  f.setManifest(`#EXTM3U\n${tag}\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n`);
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
});
it.each([
  "garbage",
  "#EXTM3U\n#EXTINF:4,\nsegment.m4s\n",
  "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3\n",
  "#EXTM3U\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n#EXT-X-STREAM-INF:BANDWIDTH=3\nx.m3u8\n",
  "#EXTM3U\n\u0000",
])("malformed/incomplete or live manifest rejected", async (text) => {
  const f = fixture();
  f.setManifest(text);
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
});
it("manifest body over bound is canceled and never reflected", async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.setResponse(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(256 * 1024 + 1));
          },
          cancel,
        }),
        { headers: { "content-type": "application/vnd.apple.mpegurl" } },
      ),
  );
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
  expect(cancel).toHaveBeenCalled();
});
it.each([302, 403, 404, 429, 500])(
  "provider status %d fails closed, body canceled, redirect not followed",
  async (status) => {
    const f = fixture(),
      cancel = vi.fn();
    f.setResponse(
      () =>
        new Response(new ReadableStream({ cancel }), {
          status,
          headers: {
            location: "https://evil.test",
            "content-type": "text/plain",
          },
        }),
    );
    await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
    expect(cancel).toHaveBeenCalled();
    expect(f.delivery).toHaveLength(1);
  },
);
it.each([
  { success: false, errors: [] },
  { success: true, errors: [], result: { token: "not-a-jwt" } },
  { success: true, errors: [{ message: "secret" }], result: {} },
])("bad token API envelope fails closed", async (value) => {
  const f = fixture();
  f.setToken(() => Response.json(value));
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
  expect(f.delivery).toHaveLength(0);
});
it.each(["sub", "exp", "nbf", "downloadable"])(
  "rejects mismatched token claim %s",
  async (field) => {
    const f = fixture();
    f.setToken((body) => {
      const claims = {
        ...body,
        sub: uid,
        [field]:
          field === "sub"
            ? "c".repeat(32)
            : field === "downloadable"
              ? false
              : Math.floor(Date.now() / 1000) + 3600,
      };
      return Response.json({
        success: true,
        errors: [],
        result: {
          token: `${b64("{}")} .${b64(JSON.stringify(claims))}.x`.replace(
            " ",
            "",
          ),
        },
      });
    });
    await rejected(
      await handleMediaDelivery(
        request(field === "downloadable" ? "mp4" : "hls"),
        f.env,
        f.fetcher,
      ),
    );
    expect(f.delivery).toHaveLength(0);
  },
);
it.each([
  "bytes=0-1,3-4",
  "bytes=-0",
  "bytes=5-2",
  "items=0-1",
  "bytes=9007199254740992-",
])("bad Range %s rejected before token creation", async (range) => {
  const f = fixture();
  const r = await handleMediaDelivery(
    request("mp4", { range }),
    f.env,
    f.fetcher,
  );
  expect(r.status).toBe(416);
  expect(f.api).toHaveLength(0);
});
it.each([
  ["bytes=2-5", "bytes 2-5/10", "2345"],
  ["bytes=-3", "bytes 7-9/10", "789"],
  ["bytes=8-", "bytes 8-9/10", "89"],
])("single Range %s gets validated 206", async (range, contentRange, bytes) => {
  const f = fixture();
  f.setResponse(
    () =>
      new Response(bytes!, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": contentRange!,
          "content-length": String(bytes!.length),
        },
      }),
  );
  const r = await handleMediaDelivery(
    request("mp4", { range: range! }),
    f.env,
    f.fetcher,
  );
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe(contentRange);
  expect(await decoded(r)).toBe(bytes);
  expect(new Headers(f.delivery[0]!.init?.headers).get("range")).toBe(range);
});
it("If-Range is not forwarded and falls back to 200 without provider ETag exposure", async () => {
  const f = fixture(),
    r = await handleMediaDelivery(
      request("mp4", { range: "bytes=2-5", "if-range": "guessed" }),
      f.env,
      f.fetcher,
    );
  expect(r.status).toBe(200);
  await r.arrayBuffer();
  expect(new Headers(f.delivery[0]!.init?.headers).has("range")).toBe(false);
});
it.each([
  { "content-type": "text/html", "content-length": "10" },
  { "content-type": "video/mp4" },
  { "content-type": "video/mp4", "content-length": "67108865" },
  {
    "content-type": "video/mp4",
    "content-length": "10",
    "content-encoding": "gzip",
  },
  {
    "content-type": "video/mp4",
    "content-length": "10",
    "content-range": "bytes 0-9/10",
  },
])("invalid binary headers rejected", async (headers) => {
  const f = fixture();
  f.setResponse(() => new Response("0123456789", { headers }));
  await rejected(await handleMediaDelivery(request("mp4"), f.env, f.fetcher));
});
it("unsolicited or wrong 206 is rejected", async () => {
  for (const range of [undefined, "bytes=2-5"]) {
    const f = fixture();
    f.setResponse(
      () =>
        new Response("01", {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": "2",
            "content-range": "bytes 0-1/10",
          },
        }),
    );
    await rejected(
      await handleMediaDelivery(
        request("mp4", range ? { range } : {}),
        f.env,
        f.fetcher,
      ),
    );
  }
});
it("stop applied during upstream fetch cancels body before emission", async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.setResponse(() => {
    f.setDb("PUBLICATION_STOPPED");
    return new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "video/mp4", "content-length": "10" },
    });
  });
  await rejected(await handleMediaDelivery(request("mp4"), f.env, f.fetcher));
  expect(cancel).toHaveBeenCalled();
});
it("consumer cancellation cancels upstream without buffering the video", async () => {
  const f = fixture(),
    cancel = vi.fn();
  let pulls = 0;
  f.setResponse(
    () =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              pulls++;
              c.enqueue(new Uint8Array(2));
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "video/mp4", "content-length": "10" } },
      ),
  );
  const r = await handleMediaDelivery(request("mp4"), f.env, f.fetcher);
  expect(r.status).toBe(200);
  expect(pulls).toBe(0);
  const reader = r.body!.getReader();
  expect((await reader.read()).value?.length).toBe(2);
  expect(pulls).toBe(1);
  await reader.cancel();
  expect(cancel).toHaveBeenCalled();
});
it("client abort cancels an in-progress binary read", async () => {
  const f = fixture(),
    cancel = vi.fn(),
    controller = new AbortController();
  f.setResponse(
    () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
  );
  const r = await handleMediaDelivery(
      request("mp4", {}, controller.signal),
      f.env,
      f.fetcher,
    ),
    reader = r.body!.getReader(),
    read = reader.read();
  const rejectedRead = expect(read).rejects.toThrow("STREAM_DELIVERY_FAILED");
  controller.abort();
  await rejectedRead;
  expect(cancel).toHaveBeenCalled();
});
it.each([9, 11])("binary size mismatch %i aborts stream", async (size) => {
  const f = fixture();
  f.setResponse(
    () =>
      new Response(new Uint8Array(size), {
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
  );
  const r = await handleMediaDelivery(request("mp4"), f.env, f.fetcher);
  expect(r.status).toBe(200);
  await expect(r.arrayBuffer()).rejects.toThrow("STREAM_DELIVERY_FAILED");
});
it("hidden during slow delivery cancels the ongoing binary within the revocation budget", async () => {
  const f = fixture(),
    cancel = vi.fn();
  vi.useFakeTimers();
  f.setResponse(
    () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
  );
  const r = await handleMediaDelivery(request("mp4"), f.env, f.fetcher),
    reader = r.body!.getReader();
  const pending = expect(reader.read()).rejects.toThrow(
    "STREAM_DELIVERY_FAILED",
  );
  f.setDb("NOT_FOUND");
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  expect(cancel).toHaveBeenCalled();
});
it("unavailable policy during slow delivery fails closed within 9 seconds", async () => {
  const f = fixture(),
    cancel = vi.fn();
  let stalled = false;
  const fetcher: typeof fetch = (target, init) =>
    stalled && String(target).includes("fixture.supabase.co")
      ? new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        )
      : f.fetcher(target, init);
  vi.useFakeTimers();
  f.setResponse(
    () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
  );
  const r = await handleMediaDelivery(request("mp4"), f.env, fetcher),
    reader = r.body!.getReader();
  const pending = expect(reader.read()).rejects.toThrow(
    "STREAM_DELIVERY_FAILED",
  );
  stalled = true;
  await vi.advanceTimersByTimeAsync(9000);
  await pending;
  expect(cancel).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
});
it("server token cache expires instead of extending token life on reads", async () => {
  const f = fixture();
  vi.useFakeTimers();
  await manifestPaths(f);
  await vi.advanceTimersByTimeAsync(100000);
  await manifestPaths(f);
  expect(f.api).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  await manifestPaths(f);
  expect(f.api).toHaveLength(2);
});
it("unknown language metadata URL and oversized resource lists are rejected", async () => {
  const f = fixture();
  f.setManifest(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8",NAME="https://evil.test"\n#EXT-X-STREAM-INF:BANDWIDTH=3\nx.m3u8\n',
  );
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
  f.setManifest(
    "#EXTM3U\n" + "#EXT-X-STREAM-INF:BANDWIDTH=3\nx.m3u8\n".repeat(129),
  );
  await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
});
it("provider request deadline rejects a non-cooperative fetch and cancels its late response", async () => {
  const f = fixture(),
    cancel = vi.fn();
  let resolve: ((r: Response) => void) | undefined;
  const fetcher: typeof fetch = (target, init) =>
    String(target).includes("api.cloudflare.com")
      ? new Promise<Response>((r) => {
          resolve = r;
        })
      : f.fetcher(target, init);
  vi.useFakeTimers();
  const pending = handleMediaDelivery(request(), f.env, fetcher);
  await vi.advanceTimersByTimeAsync(15000);
  await rejected(await pending);
  expect(resolve).toBeTypeOf("function");
  resolve!(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalled();
});
it("stalled manifest body is canceled on request deadline", async () => {
  const f = fixture(),
    cancel = vi.fn();
  vi.useFakeTimers();
  f.setResponse(
    () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      }),
  );
  const pending = handleMediaDelivery(request(), f.env, f.fetcher);
  await vi.advanceTimersByTimeAsync(15000);
  await rejected(await pending);
  expect(cancel).toHaveBeenCalled();
});
it("token API oversized or redirected responses never reach media host", async () => {
  for (const mode of ["oversize", "redirect"]) {
    const f = fixture(),
      cancel = vi.fn();
    f.setToken(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              if (mode === "oversize") c.enqueue(new Uint8Array(16385));
            },
            cancel,
          }),
          {
            status: mode === "redirect" ? 302 : 200,
            headers: {
              "content-type": "application/json",
              location: "https://evil.test",
            },
          },
        ),
    );
    await rejected(await handleMediaDelivery(request(), f.env, f.fetcher));
    expect(cancel).toHaveBeenCalled();
    expect(f.delivery).toHaveLength(0);
  }
});
it("HLS key cannot receive a partial range or an oversized key", async () => {
  const f = fixture(),
    ref = (await manifestPaths(f))[1]!,
    r = await handleMediaDelivery(request(ref), f.env, f.fetcher);
  const keyRef = paths(await decoded(r))[0]!;
  expect(
    (
      await handleMediaDelivery(
        request(keyRef, { range: "bytes=0-7" }),
        f.env,
        f.fetcher,
      )
    ).status,
  ).toBe(416);
  f.setResponse(
    () =>
      new Response(new Uint8Array(32), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "32",
        },
      }),
  );
  await rejected(await handleMediaDelivery(request(keyRef), f.env, f.fetcher));
});
