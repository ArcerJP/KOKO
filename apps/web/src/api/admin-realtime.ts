import type { Me } from "./client";
import { validId } from "./upload-contract";

type Subscription = { close(): void };
type Dependencies = {
  getMe(signal: AbortSignal): Promise<Me>;
  connect(
    topic: string,
    onInvalidate: (payload: unknown) => void,
    onClosed: () => void,
    signal: AbortSignal,
  ): Promise<Subscription>;
  invalidate(): void;
  unavailable(): void;
};
const safely = (action: () => void) => {
  try {
    action();
  } catch {
    /* Cleanup must not leave other resources live. */
  }
};

/** Broadcast never supplies records or authorization; receive only an advisory refresh hint.
 * Server Realtime authorization is cached. This local poll is not a server revocation guarantee. */
export function createAdminRealtime(
  eventId: string,
  dependencies: Dependencies,
) {
  let generation = 0;
  let active: AbortController | null = null;
  let channel: Subscription | null = null;
  let identity: Pick<Me, "user_id" | "role"> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let starting = false;
  const stop = () => {
    generation++;
    const previous = active,
      subscription = channel;
    active = null;
    channel = null;
    identity = null;
    starting = false;
    clearTimeout(timer);
    timer = undefined;
    previous?.abort();
    if (subscription) safely(() => subscription.close());
  };
  const permitted = (me: Me) =>
    me.event_id === eventId &&
    validId(me.user_id) &&
    me.is_banned === false &&
    me.consent_required === false &&
    (me.role === "admin" || me.role === "moderator");
  const lost = (revision: number) => {
    if (revision !== generation) return;
    stop();
    safely(dependencies.invalidate);
    safely(dependencies.unavailable);
  };
  async function deadline<T>(
    revision: number,
    ms: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (revision !== generation) throw new Error("STOPPED");
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), ms);
    let abort!: () => void;
    try {
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("STOPPED"));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      return await Promise.race([
        stopped,
        Promise.resolve().then(() => {
          if (controller.signal.aborted || revision !== generation)
            throw new Error("STOPPED");
          return operation(controller.signal);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      // A successful connection keeps its signal alive until close; do not abort it here.
      if (active === controller) active = null;
    }
  }
  async function check(revision: number): Promise<Me> {
    const me = await deadline(revision, 5000, (signal) =>
      dependencies.getMe(signal),
    );
    if (
      revision !== generation ||
      !permitted(me) ||
      (identity &&
        (identity.user_id !== me.user_id || identity.role !== me.role))
    )
      throw new Error("REVOKED");
    return me;
  }
  async function poll(revision: number) {
    try {
      await check(revision);
      if (revision === generation)
        timer = setTimeout(() => void poll(revision), 10000);
    } catch {
      lost(revision);
    }
  }
  return {
    async start(enabled: boolean) {
      if (!enabled) {
        stop();
        return;
      }
      if (!validId(eventId) || channel || starting) return;
      starting = true;
      const revision = ++generation;
      let accepted = false;
      let pending: Subscription | null = null;
      try {
        const me = await check(revision);
        identity = { user_id: me.user_id, role: me.role };
        pending = await deadline(revision, 10000, async (signal) => {
          const subscription = await dependencies.connect(
            "koko:admin:" + eventId.toLowerCase(),
            (value) => {
              if (
                !accepted ||
                revision !== generation ||
                !value ||
                typeof value !== "object" ||
                Array.isArray(value)
              )
                return;
              const body = value as Record<string, unknown>;
              if (
                Object.keys(body).length === 1 &&
                Object.hasOwn(body, "changed") &&
                body.changed === true
              )
                safely(dependencies.invalidate);
            },
            () => lost(revision),
            signal,
          );
          // Even an adapter ignoring AbortSignal cannot leave a late channel live.
          if (signal.aborted || revision !== generation) {
            safely(() => subscription.close());
            throw new Error("STOPPED");
          }
          return subscription;
        });
        if (revision !== generation) throw new Error("STOPPED");
        // Close immediately on stop even while the post-subscribe authorization is pending.
        channel = pending;
        pending = null;
        await check(revision);
        accepted = true;
        timer = setTimeout(() => void poll(revision), 10000);
      } catch {
        if (pending) safely(() => pending?.close());
        lost(revision);
      } finally {
        if (revision === generation) starting = false;
      }
    },
    stop,
  };
}

/** Narrow injectable transport; SDK errors/payloads never become rendered diagnostics. */
export type AdminBroadcastChannel = {
  onBroadcast(receive: (payload: unknown) => void): void;
  subscribe(status: (value: string) => void): void;
  close(): void;
};
export async function connectAdminBroadcast(
  transport: {
    setAuth(): Promise<void>;
    channel(topic: string): AdminBroadcastChannel;
  },
  topic: string,
  invalidate: (payload: unknown) => void,
  closed: () => void,
  outer: AbortSignal,
): Promise<Subscription> {
  if (!/^koko:admin:[0-9a-f-]{36}$/.test(topic) || !validId(topic.slice(11)))
    throw new Error("REALTIME_UNAVAILABLE");
  let channel: AdminBroadcastChannel | null = null;
  let removed = false;
  let joined = false;
  let settled = false;
  let rejectPending!: () => void;
  const close = () => {
    if (removed) return;
    removed = true;
    outer.removeEventListener("abort", abort);
    clearTimeout(timeout);
    if (channel) safely(() => channel?.close());
    if (!settled) rejectPending();
  };
  const abort = () => close();
  const timeout = setTimeout(close, 10000);
  const result = new Promise<Subscription>((resolve, reject) => {
    rejectPending = () => {
      settled = true;
      reject(new Error("REALTIME_UNAVAILABLE"));
    };
    outer.addEventListener("abort", abort, { once: true });
    if (outer.aborted) {
      close();
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (removed) throw new Error("REALTIME_UNAVAILABLE");
        return transport.setAuth();
      })
      .then(() => {
        if (removed || outer.aborted) {
          close();
          return;
        }
        channel = transport.channel(topic);
        channel.onBroadcast((payload) => {
          if (joined && !removed && !outer.aborted) invalidate(payload);
        });
        channel.subscribe((status) => {
          if (removed || outer.aborted) return;
          if (status === "SUBSCRIBED") {
            joined = true;
            settled = true;
            clearTimeout(timeout);
            resolve({ close });
          } else if (
            ["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)
          ) {
            const notify = joined;
            close();
            if (notify) safely(closed);
          }
        });
      })
      .catch(() => {
        const notify = joined;
        close();
        if (notify) safely(closed);
      });
  });
  return result;
}
