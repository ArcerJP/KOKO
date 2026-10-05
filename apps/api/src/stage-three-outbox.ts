import { object, uuid, type AccountEnv } from "./api-context";
import { createInternalRpc, type InternalRpc } from "./internal-rpc";

export type StageThreeOutboxEnv = AccountEnv & {
  KOKO_EVENT_ID?: string;
  KOKO_OPERATIONAL_OUTBOX_ENABLED?: string;
  KOKO_DISCORD_NOTIFICATIONS_ENABLED?: string;
  KOKO_DISCORD_WEBHOOK_URL?: string;
  KOKO_ADMIN_ORIGIN?: string;
};
export const stageThreeOutboxCron = "* * * * *";
type Claim = {
  job_id: string;
  event_id: string;
  lease_id: string;
  kind: "notify" | "revoke_delivery" | "delete_assets";
  attempt: number;
};
type DiscordSettings = {
  endpoint: URL;
  webhookId: string;
  adminOrigin: string;
};
type SendOutcome = {
  outcome: "delivered" | "retry" | "ambiguous" | "rejected";
  retry_seconds: number;
};
const id = (x: unknown): x is string =>
  typeof x === "string" && uuid.test(x) && x === x.toLowerCase();
const exact = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const int = (x: unknown, max: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
const fail = () => new Error("OPERATIONAL_OUTBOX_FAILED");
const ambiguous = (): SendOutcome => ({
  outcome: "ambiguous",
  retry_seconds: 0,
});
const snowflake = (x: unknown): x is string =>
  typeof x === "string" && /^[1-9][0-9]{16,19}$/.test(x);

function discordSettings(env: StageThreeOutboxEnv): DiscordSettings | null {
  try {
    const endpoint = new URL(env.KOKO_DISCORD_WEBHOOK_URL ?? "");
    const match =
      /^\/api\/(?:v10\/)?webhooks\/([1-9][0-9]{16,19})\/([A-Za-z0-9_-]{30,200})$/.exec(
        endpoint.pathname,
      );
    const origin = new URL(env.KOKO_ADMIN_ORIGIN ?? "");
    if (
      !match ||
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "discord.com" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      origin.protocol !== "https:" ||
      origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(origin.hostname)
    )
      return null;
    return {
      endpoint: new URL(
        `https://discord.com/api/v10/webhooks/${match[1]}/${match[2]}?wait=true`,
      ),
      webhookId: match[1]!,
      adminOrigin: origin.origin,
    };
  } catch {
    return null;
  }
}

/** DB display name only; no control/bidi, Discord formatting, mention, email or URL syntax. */
function displayName(value: string) {
  return (
    Array.from(
      value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "),
    )
      .slice(0, 64)
      .join("")
      .replace(/[\\`*_~|<>()[\]#]/g, " ")
      .replaceAll("@", "＠")
      .replaceAll(":", "：")
      .replaceAll(".", "．")
      .replaceAll("/", "／")
      .replaceAll("?", "？")
      .replaceAll("=", "＝")
      .replace(/\s+/g, " ")
      .trim() || "（表示名なし）"
  );
}
function notification(value: unknown, claim: Claim, config: DiscordSettings) {
  if (
    !object(value) ||
    !exact(value, [
      "job_id",
      "event_id",
      "post_id",
      "category",
      "display_name",
      "report_count",
      ...(value.category === "capacity" ? ["capacity"] : []),
    ]) ||
    value.job_id !== claim.job_id ||
    value.event_id !== claim.event_id ||
    (value.post_id !== null && !id(value.post_id)) ||
    typeof value.category !== "string" ||
    ![
      "flag",
      "block",
      "report",
      "ai_error",
      "stream_failure",
      "processing_error",
      "ban",
      "appeal",
      "capacity",
    ].includes(value.category) ||
    typeof value.display_name !== "string" ||
    value.display_name.length > 256 ||
    (value.category === "report"
      ? ![1, 2].includes(value.report_count as number)
      : value.report_count !== null) ||
    (!["ban", "appeal", "capacity"].includes(value.category) &&
      value.post_id === null)
  )
    throw fail();
  let capacityText = "";
  if (value.category === "capacity") {
    const c = value.capacity;
    if (
      value.post_id !== null ||
      !object(c) ||
      !exact(c, ["observed_bytes", "limit_bytes", "observed_at"]) ||
      !int(c.observed_bytes, Number.MAX_SAFE_INTEGER) ||
      !int(c.limit_bytes, Number.MAX_SAFE_INTEGER) ||
      c.limit_bytes < 1 ||
      c.observed_bytes < c.limit_bytes ||
      typeof c.observed_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c.observed_at) ||
      !Number.isFinite(Date.parse(c.observed_at))
    )
      throw fail();
    capacityText = `\nR2容量（payload＋metadata）: ${c.observed_bytes} bytes\n承認済み通知閾値: ${c.limit_bytes} bytes\n観測時刻: ${c.observed_at}\n注: 使用量の観測であり請求上限・自動停止ではありません。`;
  }
  const admin = new URL("/manage", config.adminOrigin);
  // Stable notification reference is for human reconciliation, not an exactly-once guarantee.
  return {
    content: `[KOKO 運営通知] ${value.category}\n投稿ID: ${value.post_id ?? "対象投稿なし"}\n表示名: ${displayName(value.display_name)}${value.report_count === null ? "" : `\n通報: ${value.report_count}件目`}${capacityText}\n管理画面: <${admin.href}>\n通知ID: ${claim.job_id}`,
    allowed_mentions: { parse: [] },
    flags: 4, // SUPPRESS_EMBEDS, including BLOCK and every other category.
  };
}

/** No authorization header, redirect, media, arbitrary destination or raw provider logging. */
async function sendDiscord(
  config: DiscordSettings,
  body: ReturnType<typeof notification>,
  fetcher: typeof fetch,
): Promise<SendOutcome> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<SendOutcome> => {
        const response = await fetcher(config.endpoint, {
          method: "POST",
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        reader = response.body?.getReader();
        try {
          if (controller.signal.aborted || response.redirected)
            return ambiguous();
          if ([400, 401, 403, 404, 405, 413].includes(response.status))
            return { outcome: "rejected", retry_seconds: 0 };
          if (
            ![200, 429].includes(response.status) ||
            !reader ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            return ambiguous();
          let text = "",
            size = 0;
          const decoder = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          });
          for (;;) {
            const chunk = await reader.read();
            if (controller.signal.aborted) return ambiguous();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 32768) return ambiguous();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          const data: unknown = JSON.parse(text);
          if (!object(data)) return ambiguous();
          if (response.status === 429) {
            // Only an explicit rate-limit rejection is known safe to retry. 5xx/timeouts are not.
            const seconds = data.retry_after;
            return typeof seconds === "number" &&
              Number.isFinite(seconds) &&
              seconds > 0 &&
              seconds <= 86400
              ? { outcome: "retry", retry_seconds: Math.ceil(seconds) }
              : ambiguous();
          }
          return snowflake(data.id) &&
            data.webhook_id === config.webhookId &&
            snowflake(data.channel_id)
            ? { outcome: "delivered", retry_seconds: 0 }
            : ambiguous();
        } finally {
          void reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
      })(),
      new Promise<SendOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          resolve(ambiguous());
        }, 10000);
      }),
    ]);
  } catch {
    return ambiguous();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

/** One claimed job. SQL prepare rechecks the live row and durably records send intent. */
export async function consumeStageThreeOutbox(
  claim: Claim,
  env: StageThreeOutboxEnv,
  rpc: InternalRpc,
  fetcher: typeof fetch = fetch,
) {
  if (
    env.KOKO_OPERATIONAL_OUTBOX_ENABLED !== "true" ||
    !object(claim) ||
    claim.event_id !== env.KOKO_EVENT_ID ||
    !exact(claim, ["job_id", "event_id", "lease_id", "kind", "attempt"]) ||
    !id(claim.job_id) ||
    !id(claim.event_id) ||
    !id(claim.lease_id) ||
    !["notify", "revoke_delivery", "delete_assets"].includes(claim.kind) ||
    !int(claim.attempt, 5) ||
    claim.attempt === 0
  )
    return "failed" as const;
  const config =
    env.KOKO_DISCORD_NOTIFICATIONS_ENABLED === "true"
      ? discordSettings(env)
      : null;
  if (claim.kind === "notify" && !config) return "failed" as const;
  const call = (action: string, input: object) =>
    rpc("stage_three_outbox", {
      p_event_id: claim.event_id,
      p_job_id: claim.job_id,
      p_action: action,
      p_input: input,
    });
  try {
    const prepared = await call("prepare", { lease_id: claim.lease_id });
    if (prepared.code === "DONE") return "done" as const;
    if (prepared.code === "HELD") return "held" as const;
    if (prepared.code === "STALE" || prepared.code === "DISABLED")
      return "stale" as const;
    if (prepared.code !== "SEND" || claim.kind !== "notify" || !config)
      return "failed" as const;
    let outcome: SendOutcome;
    try {
      outcome = await sendDiscord(
        config,
        notification(prepared.notification, claim, config),
        fetcher,
      );
    } catch {
      outcome = ambiguous();
    }
    const settled = await call("settle", {
      lease_id: claim.lease_id,
      ...outcome,
    });
    if (settled.code === "DONE") return "done" as const;
    if (settled.code === "HELD") return "held" as const;
    if (settled.code === "AMBIGUOUS") return "ambiguous" as const;
    if (settled.code === "RETRY") return "retry" as const;
    if (settled.code === "STALE" || settled.code === "DISABLED")
      return "stale" as const;
    return "failed" as const;
  } catch {
    return "failed" as const;
  }
}

/** Max ten jobs/invocation, max two concurrent workers. No extra Queue or physical-delete adapter. */
export async function handleStageThreeOutboxScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: StageThreeOutboxEnv,
  fetcher: typeof fetch = fetch,
  dependencies?: { rpc?: InternalRpc },
) {
  if (
    env.KOKO_OPERATIONAL_OUTBOX_ENABLED !== "true" ||
    controller.cron !== stageThreeOutboxCron
  )
    return null;
  const counts = {
    claimed: 0,
    done: 0,
    held: 0,
    ambiguous: 0,
    retry: 0,
    stale: 0,
    failed: 0,
    notification_unavailable: false,
  };
  try {
    if (!id(env.KOKO_EVENT_ID)) throw fail();
    const rpc = dependencies?.rpc ?? createInternalRpc(env, fetcher);
    const notify =
      env.KOKO_DISCORD_NOTIFICATIONS_ENABLED === "true" &&
      discordSettings(env) !== null;
    counts.notification_unavailable =
      env.KOKO_DISCORD_NOTIFICATIONS_ENABLED === "true" && !notify;
    const result = await rpc("stage_three_outbox", {
      p_event_id: env.KOKO_EVENT_ID,
      p_job_id: null,
      p_action: "claim",
      p_input: { limit: 10, notify },
    });
    if (result.code === "DISABLED") return counts;
    if (
      result.code !== "CLAIMED" ||
      !Array.isArray(result.jobs) ||
      result.jobs.length > 10 ||
      !int(result.held, 10) ||
      result.jobs.length + result.held > 10
    )
      throw fail();
    const jobs = result.jobs as Claim[];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (
        !object(job) ||
        !exact(job, ["job_id", "event_id", "lease_id", "kind", "attempt"]) ||
        !id(job.job_id) ||
        seen.has(job.job_id) ||
        job.event_id !== env.KOKO_EVENT_ID ||
        !id(job.lease_id) ||
        !int(job.attempt, 5) ||
        job.attempt === 0 ||
        !["notify", "revoke_delivery", "delete_assets"].includes(job.kind) ||
        (!notify && job.kind === "notify")
      )
        throw fail();
      seen.add(job.job_id);
    }
    counts.claimed = jobs.length;
    counts.held = result.held;
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, jobs.length) }, async () => {
        while (index < jobs.length) {
          const job = jobs[index++]!;
          const outcome = await consumeStageThreeOutbox(job, env, rpc, fetcher);
          counts[outcome]++;
        }
      }),
    );
  } catch {
    counts.failed++;
  }
  // No IDs/display names/provider errors/body/secret values leave this dispatcher.
  return counts;
}
