import { object, uuid, type AccountEnv } from "./api-context";
import { createInternalRpc, type InternalRpc } from "./internal-rpc";

export type CapacityMonitorEnv = AccountEnv & {
  KOKO_EVENT_ID?: string;
  R2_ACCOUNT_ID?: string;
  KOKO_CAPACITY_MONITOR_ENABLED?: string;
  KOKO_CAPACITY_ANALYTICS_TOKEN?: string;
};
export const capacityMonitorCron = "* * * * *";
type Plan = {
  event_id: string;
  account_id: string;
  epoch: number;
  policy_version: number;
  limit_bytes: number;
  lease_id: string;
  window_start: string;
  window_end: string;
};
type Sample = {
  bucket: string;
  observed_at: string;
  payload_bytes: number;
  metadata_bytes: number;
  object_count: number;
};
const buckets = ["koko-dev-originals", "koko-dev-derived"] as const;
// Official R2 Storage dataset: latest observation, not sum of hourly storage snapshots.
// No account overview, object listing, custom bucket, or caller-controlled GraphQL.
const query = `query KokoCapacity($accountTag: string!, $startDate: Time!, $endDate: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    originals: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: "koko-dev-originals", datetime_geq: $startDate, datetime_leq: $endDate }, orderBy: [datetime_DESC]) {
      max { payloadSize metadataSize objectCount } dimensions { datetime bucketName }
    }
    derived: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: "koko-dev-derived", datetime_geq: $startDate, datetime_leq: $endDate }, orderBy: [datetime_DESC]) {
      max { payloadSize metadataSize objectCount } dimensions { datetime bucketName }
    }
  } }
}`;
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const exact = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const fail = () => new Error("CAPACITY_MEASUREMENT_UNAVAILABLE");
function timestamp(x: unknown) {
  if (
    typeof x !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(x)
  )
    throw fail();
  const ms = Date.parse(x),
    [base, fraction = ""] = x.slice(0, -1).split(".");
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== `${base}.${fraction.padEnd(3, "0")}Z`
  )
    throw fail();
  return ms;
}
function readPlan(x: unknown, env: CapacityMonitorEnv): Plan {
  if (
    !object(x) ||
    !exact(x, [
      "event_id",
      "account_id",
      "epoch",
      "policy_version",
      "limit_bytes",
      "lease_id",
      "window_start",
      "window_end",
    ]) ||
    x.event_id !== env.KOKO_EVENT_ID ||
    x.account_id !== env.R2_ACCOUNT_ID ||
    !integer(x.epoch) ||
    !integer(x.policy_version) ||
    x.policy_version < 1 ||
    !integer(x.limit_bytes) ||
    x.limit_bytes < 1 ||
    typeof x.lease_id !== "string" ||
    !uuid.test(x.lease_id) ||
    x.lease_id !== x.lease_id.toLowerCase()
  )
    throw fail();
  const end = timestamp(x.window_end),
    start = timestamp(x.window_start),
    now = Date.now();
  if (
    end - start !== 86400000 ||
    end > now + 30000 ||
    end < now - 120000 ||
    Math.floor(end / 3600000) !== x.epoch
  )
    throw fail();
  return x as Plan;
}
function samples(value: unknown, plan: Plan): Sample[] {
  if (
    !object(value) ||
    (value.errors !== undefined &&
      value.errors !== null &&
      (!Array.isArray(value.errors) || value.errors.length)) ||
    !object(value.data) ||
    !object(value.data.viewer) ||
    !Array.isArray(value.data.viewer.accounts) ||
    value.data.viewer.accounts.length !== 1
  )
    throw fail();
  const account = value.data.viewer.accounts[0];
  if (!object(account) || !exact(account, ["originals", "derived"]))
    throw fail();
  const end = timestamp(plan.window_end);
  const output = (["originals", "derived"] as const).map((name, index) => {
    const rows = account[name];
    if (!Array.isArray(rows) || rows.length !== 1) throw fail();
    const row = rows[0];
    if (
      !object(row) ||
      !exact(row, ["max", "dimensions"]) ||
      !object(row.max) ||
      !exact(row.max, ["payloadSize", "metadataSize", "objectCount"]) ||
      !object(row.dimensions) ||
      !exact(row.dimensions, ["datetime", "bucketName"]) ||
      row.dimensions.bucketName !== buckets[index] ||
      !integer(row.max.payloadSize) ||
      !integer(row.max.metadataSize) ||
      !integer(row.max.objectCount)
    )
      throw fail();
    const observed = timestamp(row.dimensions.datetime);
    if (observed > end || observed < end - 7200000) throw fail();
    return {
      bucket: buckets[index]!,
      observed_at: new Date(observed).toISOString(),
      payload_bytes: row.max.payloadSize,
      metadata_bytes: row.max.metadataSize,
      object_count: row.max.objectCount,
    };
  });
  if (
    !Number.isSafeInteger(
      output.reduce((n, s) => n + s.payload_bytes + s.metadata_bytes, 0),
    )
  )
    throw fail();
  return output;
}
async function measure(plan: Plan, token: string, fetcher: typeof fetch) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(
          "https://api.cloudflare.com/client/v4/graphql",
          {
            method: "POST",
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              query,
              variables: {
                accountTag: plan.account_id,
                startDate: plan.window_start,
                endDate: plan.window_end,
              },
            }),
          },
        );
        reader = response.body?.getReader();
        try {
          if (
            controller.signal.aborted ||
            response.redirected ||
            response.status !== 200 ||
            !reader ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            throw fail();
          let text = "",
            size = 0;
          const decoder = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          });
          for (;;) {
            const chunk = await reader.read();
            controller.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 32768) throw fail();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          return samples(JSON.parse(text) as unknown, plan);
        } finally {
          void reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          void reader?.cancel().catch(() => {});
          reject(fail());
        }, 10000);
      }),
    ]);
  } catch {
    throw fail();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

/** One provider query per approved hourly epoch, at most three attempts; never a billing guarantee. */
export async function handleCapacityMonitorScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: CapacityMonitorEnv,
  fetcher: typeof fetch = fetch,
  dependencies?: { rpc?: InternalRpc },
) {
  if (
    env.KOKO_CAPACITY_MONITOR_ENABLED !== "true" ||
    controller.cron !== capacityMonitorCron
  )
    return null;
  if (
    !env.KOKO_EVENT_ID ||
    !uuid.test(env.KOKO_EVENT_ID) ||
    env.KOKO_EVENT_ID !== env.KOKO_EVENT_ID.toLowerCase() ||
    !env.R2_ACCOUNT_ID ||
    !/^[0-9a-f]{32}$/.test(env.R2_ACCOUNT_ID) ||
    !env.KOKO_CAPACITY_ANALYTICS_TOKEN ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(env.KOKO_CAPACITY_ANALYTICS_TOKEN)
  )
    return { state: "unconfigured" as const };
  let plan: Plan | undefined;
  let rpc: InternalRpc | undefined;
  const call = (action: string, input: object) =>
    rpc!("manage_capacity_monitor", {
      p_event_id: env.KOKO_EVENT_ID,
      p_action: action,
      p_input: input,
    });
  try {
    rpc = dependencies?.rpc ?? createInternalRpc(env, fetcher);
    const claimed = await call("claim", { account_id: env.R2_ACCOUNT_ID });
    if (claimed.code === "DISABLED") return { state: "unconfigured" as const };
    if (claimed.code === "DONE" || claimed.code === "WAIT")
      return { state: "idle" as const };
    if (claimed.code === "UNKNOWN") return { state: "unknown" as const };
    if (claimed.code !== "CLAIMED") throw fail();
    plan = readPlan(claimed.plan, env);
    const measured = await measure(
      plan,
      env.KOKO_CAPACITY_ANALYTICS_TOKEN,
      fetcher,
    );
    const result = await call("finish", { plan, samples: measured });
    if (result.code === "OBSERVED") return { state: "observed" as const };
    if (result.code === "ALERTED") return { state: "alert_enqueued" as const };
    if (result.code === "STALE" || result.code === "DISABLED")
      return { state: "stale" as const };
    throw fail();
  } catch {
    if (plan && rpc) {
      try {
        await call("fail", { plan });
      } catch {
        /* no raw provider/transport error output */
      }
    }
    return { state: "unknown" as const };
  }
}
