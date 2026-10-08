import { createHash } from "node:crypto";
import {
  snapshotModerationPlan,
  type ModerationPlan,
} from "./moderation-db.js";
import type { PrivateVideoFrames } from "./moderation-runner.js";

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const uuid = (x: unknown) =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    x,
  );
function fail(): never {
  throw new Error("PRIVATE_FRAMES_UNAVAILABLE");
}

/** Private fixed-provider reads only. The caller subsequently decodes/strips every JPEG before AI use. */
export function createPrivateModerationFrames(
  options: {
    enabled?: boolean;
    accountId?: string;
    customerHost?: string;
    allowedOrigins?: readonly string[];
    apiToken?: (signal: AbortSignal) => Promise<string>;
    isCurrent?: (plan: ModerationPlan) => Promise<boolean>;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
):
  | ((plan: ModerationPlan, signal: AbortSignal) => Promise<PrivateVideoFrames>)
  | null {
  if (options.enabled !== true) return null;
  const {
    accountId,
    customerHost,
    apiToken,
    isCurrent,
    fetcher = fetch,
    timeoutMs = 15000,
  } = options;
  const origins = [...(options.allowedOrigins ?? [])];
  if (
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    typeof customerHost !== "string" ||
    !/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(customerHost) ||
    origins.length < 1 ||
    origins.length > 5 ||
    new Set(origins).size !== origins.length ||
    origins.some(
      (o) =>
        typeof o !== "string" ||
        o.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(o),
    ) ||
    typeof apiToken !== "function" ||
    typeof isCurrent !== "function" ||
    typeof fetcher !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000
  )
    throw new Error("INVALID_PRIVATE_FRAMES_CONFIG");
  return async (input, outer) => {
    const plan = snapshotModerationPlan(input);
    const media = plan.media;
    if (media.kind !== "video") fail();
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer.addEventListener("abort", abort, { once: true });
    if (outer.aborted) abort();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (signal.aborted || Date.now() >= plan.expiresAt) fail();
    };
    const check = async () => {
      stop();
      if (!(await isCurrent(plan))) fail();
      stop();
    };
    async function bytes(
      response: Response,
      max: number,
      contentType: string,
    ): Promise<Buffer> {
      const reader = response.body?.getReader();
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const length = response.headers.get("content-length");
        if (
          response.status !== 200 ||
          response.redirected ||
          !reader ||
          response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== contentType ||
          (response.headers.has("content-encoding") &&
            response.headers.get("content-encoding") !== "identity") ||
          (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
        )
          fail();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          stop();
          const part = await reader.read();
          stop();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > max) fail();
          chunks.push(part.value);
        }
        if (!size || (length !== null && Number(length) !== size)) fail();
        return Buffer.concat(chunks);
      } finally {
        signal.removeEventListener("abort", cancel);
        cancel();
      }
    }
    async function api(suffix: string, body?: object): Promise<unknown> {
      await check();
      const token = await apiToken!(signal);
      stop();
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{8,1024}$/.test(token))
        fail();
      await check();
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${media.kind === "video" ? media.streamUid : ""}${suffix}`;
      const response = await fetcher(url, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (signal.aborted || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => {});
        fail();
      }
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await bytes(response, 65536, "application/json"),
        ),
      );
      if (
        !record(value) ||
        value.success !== true ||
        !Array.isArray(value.errors) ||
        value.errors.length !== 0 ||
        !record(value.result)
      )
        fail();
      return value.result;
    }
    async function inspect(): Promise<string> {
      const value = await api("");
      if (
        !record(value) ||
        media.kind !== "video" ||
        value.uid !== media.streamUid ||
        value.requireSignedURLs !== true ||
        value.readyToStream !== true ||
        !record(value.status) ||
        value.status.state !== "ready" ||
        typeof value.status.pctComplete !== "string" ||
        !/^100(?:\.0+)?$/.test(value.status.pctComplete) ||
        value.duration !== media.measuredDurationSeconds ||
        !Array.isArray(value.allowedOrigins) ||
        value.allowedOrigins.length !== origins.length ||
        !origins.every((o) =>
          (value.allowedOrigins as unknown[]).includes(o),
        ) ||
        !record(value.meta) ||
        value.meta.koko_event !== plan.original.eventId ||
        value.meta.koko_post !== plan.original.postId ||
        value.meta.koko_asset !== plan.original.assetId ||
        !uuid(value.meta.koko_job) ||
        !uuid(value.meta.koko_operation) ||
        typeof value.meta.koko_version !== "string" ||
        !/^[1-9][0-9]{0,9}$/.test(value.meta.koko_version) ||
        value.meta.koko_source !== (media.sourceUid ?? "original") ||
        (media.sourceUid === null
          ? ![null, undefined, ""].includes(
              value.clippedFrom as null | undefined | "",
            )
          : value.clippedFrom !== media.sourceUid) ||
        typeof value.modified !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
          value.modified,
        ) ||
        !Number.isFinite(Date.parse(value.modified))
      )
        fail();
      return value.modified;
    }
    try {
      return await Promise.race([
        (async (): Promise<PrivateVideoFrames> => {
          const modified = await inspect();
          const now = Math.floor(Date.now() / 1000);
          const issued = await api("/token", {
            exp: now + 60,
            nbf: now - 5,
            downloadable: false,
          });
          if (
            !record(issued) ||
            typeof issued.token !== "string" ||
            issued.token.length > 8192 ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
              issued.token,
            )
          )
            fail();
          const claims: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.from(issued.token.split(".")[1]!, "base64url"),
            ),
          );
          if (
            !record(claims) ||
            claims.sub !== media.streamUid ||
            !Number.isSafeInteger(claims.exp) ||
            (claims.exp as number) <= now ||
            (claims.exp as number) > now + 60 ||
            (claims.nbf !== undefined &&
              (!Number.isSafeInteger(claims.nbf) ||
                (claims.nbf as number) > now)) ||
            (claims.downloadable !== undefined &&
              claims.downloadable !== false) ||
            claims.flags !== undefined
          )
            fail();
          const frames: PrivateVideoFrames["frames"][number][] = [];
          for (const [index, seconds] of media.frameTimes.entries()) {
            await check();
            if (Date.now() / 1000 >= (claims.exp as number)) fail();
            const url = new URL(
              `/${issued.token}/thumbnails/thumbnail.jpg`,
              `https://${customerHost}`,
            );
            url.searchParams.set("time", `${seconds}s`);
            url.searchParams.set("width", "1024");
            url.searchParams.set("height", "1024");
            url.searchParams.set("fit", "clip");
            const response = await fetcher(url, {
              redirect: "manual",
              cache: "no-store",
              credentials: "omit",
              signal,
              headers: {
                accept: "image/jpeg",
                "accept-encoding": "identity",
                origin: `https://${origins[0]}`,
              },
            });
            if (signal.aborted || (response.url && response.url !== url.href)) {
              void response.body?.cancel().catch(() => {});
              fail();
            }
            const raw = await bytes(response, 4194304, "image/jpeg");
            if (
              raw.length < 4 ||
              raw[0] !== 255 ||
              raw[1] !== 216 ||
              raw.at(-2) !== 255 ||
              raw.at(-1) !== 217
            )
              fail();
            frames.push({
              index,
              seconds,
              sha256: createHash("sha256").update(raw).digest("hex"),
              bytes: raw,
            });
          }
          if ((await inspect()) !== modified) fail();
          await check();
          return {
            streamAssetId: media.streamAssetId,
            postVersion: plan.postVersion,
            measuredDurationSeconds: media.measuredDurationSeconds,
            requireSignedURLs: true,
            readyToStream: true,
            processingComplete: true,
            frames,
          };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error("PRIVATE_FRAMES_UNAVAILABLE"));
              controller.abort();
            },
            Math.min(timeoutMs, Math.max(1, plan.expiresAt - Date.now())),
          );
        }),
      ]);
    } catch {
      return fail();
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", abort);
      controller.abort();
    }
  };
}
