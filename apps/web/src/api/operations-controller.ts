import { ApiFailure, type Me } from "./client";
import {
  operationRoute,
  type Operation,
  type OperationResponse,
} from "./operations-contract";

export type OperationsState = Readonly<{
  phase: "idle" | "loading" | "ready" | "saving" | "error" | "closed";
  role: Me["role"] | null;
  data: OperationResponse | null;
  message: string | null;
}>;
const initial: OperationsState = Object.freeze({
  phase: "idle",
  role: null,
  data: null,
  message: null,
});
type Client = {
  getMe(signal: AbortSignal): Promise<Me>;
  execute(
    op: Operation,
    input?: unknown,
    csrf?: string,
    signal?: AbortSignal,
  ): Promise<OperationResponse>;
};
/** No auto write/retry; identities and CSRF stay outside React snapshots/persistent stores. */
export function createOperationsController(
  client: Client,
  prepare: (signal: AbortSignal) => Promise<boolean>,
) {
  let state = initial,
    revision = 0;
  let identity: Pick<Me, "user_id" | "event_id" | "role"> | null = null;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OperationsState) => {
    state = Object.freeze(next);
    for (const cb of listeners) cb();
  };
  const invalidate = (closed: boolean) => {
    revision++;
    active?.abort();
    active = null;
    identity = null;
    publish({ ...initial, phase: closed ? "closed" : "idle" });
  };
  async function execute(
    op: Operation | null,
    input?: unknown,
    confirmed = false,
  ) {
    if (active || state.phase === "closed") return false;
    const mutation = op !== null && operationRoute(op).mutation,
      expected = identity;
    if (mutation && (!confirmed || state.phase !== "ready" || !expected))
      return false;
    const current = ++revision,
      controller = new AbortController();
    active = controller;
    identity = null;
    publish({ ...initial, phase: mutation ? "saving" : "loading" });
    const check = () => {
      controller.signal.throwIfAborted();
      if (revision !== current) throw new Error("STALE");
    };
    const timer = setTimeout(() => controller.abort(), 30000);
    let stop!: () => void;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          stop = () => reject(new Error("ABORTED"));
          controller.signal.addEventListener("abort", stop, { once: true });
        }),
        (async () => {
          if (!(await prepare(controller.signal)))
            throw new ApiFailure("AUTH_REQUIRED");
          check();
          const me = await client.getMe(controller.signal);
          check();
          if (
            mutation &&
            (!expected ||
              me.user_id !== expected.user_id ||
              me.event_id !== expected.event_id ||
              me.role !== expected.role ||
              !me.csrf_token)
          )
            throw new ApiFailure("FORBIDDEN");
          const response =
            op === null
              ? null
              : await client.execute(
                  op,
                  input,
                  me.csrf_token,
                  controller.signal,
                );
          check();
          identity = {
            user_id: me.user_id,
            event_id: me.event_id,
            role: me.role,
          };
          publish({
            phase: "ready",
            role: me.role,
            data: response,
            message: mutation
              ? "操作結果を受け取りました。最新の一覧を読み直して確認してください。"
              : null,
          });
          return true;
        })(),
      ]);
    } catch (error) {
      if (current === revision)
        publish({
          ...initial,
          phase: "error",
          message: mutation
            ? "更新結果を確認できませんでした。自動再送はしません。最新の状態を読み直してください。"
            : error instanceof ApiFailure
              ? error.message
              : "読み込めませんでした。接続とログイン状態を確認してください。",
        });
      return false;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", stop);
      controller.abort();
      if (current === revision) active = null;
    }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    load(op: Operation) {
      if (operationRoute(op).mutation) return Promise.resolve(false);
      return execute(op);
    },
    bootstrap() {
      return execute(null);
    },
    mutate(op: Operation, input: unknown, confirmed: boolean) {
      if (!operationRoute(op).mutation) return Promise.resolve(false);
      return execute(op, input, confirmed);
    },
    invalidate() {
      if (state.phase !== "closed") invalidate(false);
    },
    close() {
      invalidate(true);
    },
  };
}
