import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";
import { validId } from "../api/upload-contract";

/** No upstream/CDN URLs or cross-post resources. Only our individually authorized media route. */
export function scopedMediaUrl(
  raw: string,
  origin: string,
  eventId: string,
  postId: string,
): URL | null {
  if (!validId(eventId) || !validId(postId)) return null;
  try {
    const url = new URL(raw, origin);
    const prefix = `/media/${eventId}/${postId}/`;
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      !/^(?:hls|hls-[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,980})$/.test(
        url.pathname.slice(prefix.length),
      )
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function createScopedHlsLoader(
  origin: string,
  eventId: string,
  postId: string,
  fetcher: typeof fetch = fetch,
) {
  return class ScopedHlsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
    private active: AbortController | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private revision = 0;
    abort() {
      this.revision++;
      if (this.active) this.stats.aborted = true;
      this.active?.abort();
      this.active = null;
      void this.reader?.cancel().catch(() => {});
      this.reader = null;
      clearTimeout(this.timer);
    }
    destroy() {
      this.abort();
      this.context = null;
    }
    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      this.abort();
      this.stats = {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      };
      this.context = context;
      const current = ++this.revision,
        controller = new AbortController();
      this.active = controller;
      const url = scopedMediaUrl(context.url, origin, eventId, postId);
      const fail = (code = 0) => {
        if (current !== this.revision) return;
        this.abort();
        callbacks.onError(
          { code, text: "MEDIA_LOAD_FAILED" },
          context,
          null,
          this.stats,
        );
      };
      if (
        !url ||
        !["manifest", "level", "audioTrack", "media-fragment", "key"].includes(
          context.type,
        ) ||
        !["text", "arraybuffer"].includes(context.responseType)
      ) {
        fail();
        return;
      }
      const max =
        context.responseType === "text"
          ? 262144
          : context.type === "key"
            ? 64
            : 16 * 1024 * 1024;
      const headers: Record<string, string> = {
        accept:
          context.responseType === "text"
            ? "application/vnd.apple.mpegurl, application/x-mpegURL"
            : "application/octet-stream",
      };
      // hls.js 1.7 uses 0/0 for a full fragment, not a zero-length byte range.
      if (
        !(context.rangeStart === 0 && context.rangeEnd === 0) &&
        (context.rangeStart !== undefined || context.rangeEnd !== undefined)
      ) {
        if (
          !Number.isSafeInteger(context.rangeStart) ||
          !Number.isSafeInteger(context.rangeEnd) ||
          context.rangeStart! < 0 ||
          context.rangeEnd! <= context.rangeStart! ||
          context.rangeEnd! - context.rangeStart! > max
        ) {
          fail();
          return;
        }
        headers.range = `bytes=${context.rangeStart}-${context.rangeEnd! - 1}`;
      }
      this.stats.loading.start = performance.now();
      this.timer = setTimeout(() => {
        if (current !== this.revision) return;
        this.abort();
        callbacks.onTimeout(this.stats, context, null);
      }, 10000);
      void (async () => {
        const response = await fetcher(url, {
          method: "GET",
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers,
        });
        if (current !== this.revision) {
          void response.body?.cancel().catch(() => {});
          return;
        }
        try {
          this.stats.loading.first = performance.now();
          if (
            response.redirected ||
            ![200, 206].includes(response.status) ||
            (!headers.range && response.status !== 200) ||
            !response.body
          ) {
            fail(response.status);
            return;
          }
          if (
            headers.range &&
            (response.status !== 206 ||
              !response.headers
                .get("content-range")
                ?.startsWith(
                  `bytes ${context.rangeStart}-${context.rangeEnd! - 1}/`,
                ))
          ) {
            fail();
            return;
          }
          const length = response.headers.get("content-length");
          if (
            length !== null &&
            (!/^[0-9]+$/.test(length) || Number(length) > max)
          ) {
            fail();
            return;
          }
          this.reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const part = await this.reader.read();
            if (current !== this.revision || controller.signal.aborted) return;
            if (part.done) break;
            size += part.value.byteLength;
            if (size > max) {
              fail();
              return;
            }
            chunks.push(part.value);
          }
          if (
            size === 0 ||
            (context.type === "key" && size !== 16) ||
            (length !== null && Number(length) !== size) ||
            (headers.range && size !== context.rangeEnd! - context.rangeStart!)
          ) {
            fail();
            return;
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) {
            bytes.set(part, offset);
            offset += part.length;
          }
          let data: string | ArrayBuffer = bytes.buffer;
          if (context.responseType === "text") {
            data = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (!data.startsWith("#EXTM3U")) {
              fail();
              return;
            }
            for (const line of data.split(/\r?\n/)) {
              const trimmed = line.trim();
              const refs = trimmed.startsWith("#")
                ? [...trimmed.matchAll(/URI="([^"\r\n]+)"/g)].map(
                    (match) => match[1]!,
                  )
                : trimmed
                  ? [trimmed]
                  : [];
              if (
                refs.some(
                  (ref) => !scopedMediaUrl(ref, origin, eventId, postId),
                )
              ) {
                fail();
                return;
              }
            }
          }
          clearTimeout(this.timer);
          this.stats.loaded = size;
          this.stats.total = size;
          this.stats.loading.end = performance.now();
          this.stats.chunkCount = 1;
          this.active = null;
          this.reader?.releaseLock();
          this.reader = null;
          callbacks.onSuccess(
            { url: url.href, data, code: response.status },
            this.stats,
            context,
            null,
          );
        } finally {
          if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
        }
      })().catch(() => fail());
    }
  };
}
