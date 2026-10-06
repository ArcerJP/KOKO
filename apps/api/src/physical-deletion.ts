import { uuid, object, type AccountEnv } from "./api-context";
import { createInternalRpc, type InternalRpc } from "./internal-rpc";
import {
  deleteProviderAsset,
  deletionProviderConfigured,
  readDeletionPlan,
  type DeletionProviderEnv,
} from "./deletion-provider";

export type PhysicalDeletionEnv = AccountEnv &
  DeletionProviderEnv & {
    KOKO_EVENT_ID?: string;
    KOKO_PHYSICAL_DELETION_ENABLED?: string;
  };
export const physicalDeletionCron = "* * * * *";
type Claim = { event_id: string; job_id: string; lease_id: string };
const id = (x: unknown): x is string =>
  typeof x === "string" && uuid.test(x) && x === x.toLowerCase();
const claim = (x: unknown, event: string): x is Claim =>
  object(x) &&
  Object.keys(x).length === 3 &&
  x.event_id === event &&
  id(x.job_id) &&
  id(x.lease_id);

/** No HTTP route. Exact DB tombstones only; five sequential jobs maximum, default OFF. */
export async function handlePhysicalDeletionScheduled(
  controller: Pick<ScheduledController, "cron">,
  env: PhysicalDeletionEnv,
  fetcher: typeof fetch = fetch,
  dependencies?: { rpc?: InternalRpc },
) {
  if (
    env.KOKO_PHYSICAL_DELETION_ENABLED !== "true" ||
    controller.cron !== physicalDeletionCron
  )
    return null;
  const counts = {
    claimed: 0,
    done: 0,
    held: 0,
    retry: 0,
    wait: 0,
    stale: 0,
    failed: 0,
    configured: false,
  };
  if (!id(env.KOKO_EVENT_ID) || !deletionProviderConfigured(env)) return counts;
  counts.configured = true;
  try {
    const rpc = dependencies?.rpc ?? createInternalRpc(env, fetcher);
    const call = (job: string | null, action: string, input: object) =>
      rpc("manage_physical_deletion", {
        p_event_id: env.KOKO_EVENT_ID,
        p_job_id: job,
        p_action: action,
        p_input: input,
      });
    const classify = (code: unknown) => {
      if (code === "DONE") counts.done++;
      else if (code === "HELD") counts.held++;
      else if (code === "WAIT") counts.wait++;
      else if (code === "RETRY") counts.retry++;
      else if (code === "STALE" || code === "DISABLED") counts.stale++;
      else counts.failed++;
    };
    const seen = new Set<string>();
    // Claim immediately before each bounded operation. Do not let four queued jobs'
    // 120-second leases expire while waiting behind up to five 60-second adapters.
    for (let i = 0; i < 5; i++) {
      const result = await call(null, "claim", { limit: 1 });
      if (result.code === "DISABLED") break;
      if (
        result.code !== "CLAIMED" ||
        !Array.isArray(result.jobs) ||
        result.jobs.length > 1 ||
        typeof result.held !== "number" ||
        !Number.isInteger(result.held) ||
        result.held < 0 ||
        result.held + result.jobs.length > 1 ||
        result.jobs.some((j) => !claim(j, env.KOKO_EVENT_ID!))
      )
        throw new Error();
      counts.held += result.held;
      const job = result.jobs[0] as Claim | undefined;
      if (!job) {
        if (result.held === 0) break;
        continue;
      }
      if (seen.has(job.job_id)) throw new Error();
      seen.add(job.job_id);
      counts.claimed++;
      try {
        const prepared = await call(job.job_id, "prepare", {
          lease_id: job.lease_id,
        });
        if (prepared.code !== "PREPARED") {
          classify(prepared.code);
          continue;
        }
        const plan = readDeletionPlan(prepared.plan);
        if (!plan || plan.event_id !== env.KOKO_EVENT_ID) throw new Error();
        const recheck = async () =>
          (await call(job.job_id, "begin", { lease_id: job.lease_id, plan }))
            .code === "CURRENT";
        const outcome = await deleteProviderAsset(plan, env, recheck, fetcher);
        classify(
          (
            await call(job.job_id, "settle", {
              lease_id: job.lease_id,
              plan,
              result: outcome,
            })
          ).code,
        );
      } catch {
        counts.failed++;
      }
    }
  } catch {
    counts.failed++;
  }
  // Only counters. Never emit keys, provider IDs/errors, policy internals or credentials.
  return counts;
}
