import {
  ApiFailure,
  isValidDisplayName,
  type createApiClient,
  type EnrollmentStatus,
} from "./client";
type Client = Pick<
  ReturnType<typeof createApiClient>,
  "getEnrollment" | "enrollEvent"
>;
export type EnrollmentState = Readonly<{
  phase: "idle" | "loading" | "ready" | "saving" | "error" | "closed";
  enrolled: boolean;
  open: boolean;
  draft: string;
  message: string | null;
}>;
const initial: EnrollmentState = Object.freeze({
  phase: "idle",
  enrolled: false,
  open: false,
  draft: "",
  message: null,
});
/** No identity/CSRF in snapshots; each explicit write is preceded by a fresh session-bound read. */
export function createEnrollmentController(
  client: Client,
  prepare: (signal: AbortSignal) => Promise<boolean>,
) {
  let state = initial;
  let baseline: Pick<EnrollmentStatus, "user_id" | "event_id"> | null = null;
  let revision = 0;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: EnrollmentState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const same = (a: NonNullable<typeof baseline>, b: EnrollmentStatus) =>
    a.user_id === b.user_id && a.event_id === b.event_id;
  const reset = (phase: "idle" | "closed") => {
    revision++;
    active?.abort();
    active = null;
    baseline = null;
    publish({ ...initial, phase });
  };
  async function run(save: boolean): Promise<boolean> {
    if (active || state.phase === "closed") return false;
    const expected = baseline;
    const draft = state.draft;
    if (
      save &&
      (state.phase !== "ready" ||
        !state.open ||
        state.enrolled ||
        !expected ||
        !isValidDisplayName(draft))
    )
      return false;
    const current = ++revision;
    const controller = new AbortController();
    active = controller;
    baseline = null;
    publish({ ...initial, phase: save ? "saving" : "loading" });
    const check = () => {
      controller.signal.throwIfAborted();
      if (current !== revision) throw new Error("STALE");
    };
    const timer = setTimeout(() => controller.abort(), 30000);
    let stop!: () => void;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          stop = () => reject(new Error("STOPPED"));
          controller.signal.addEventListener("abort", stop, { once: true });
        }),
        (async () => {
          if (!(await prepare(controller.signal)))
            throw new ApiFailure("AUTH_REQUIRED");
          check();
          let fresh = await client.getEnrollment(controller.signal);
          check();
          if (!fresh.csrf_token) throw new ApiFailure("FORBIDDEN");
          if (save) {
            if (!expected || !same(expected, fresh))
              throw new ApiFailure("FORBIDDEN");
            if (!fresh.enrolled) {
              if (!fresh.registration_open) throw new ApiFailure("FORBIDDEN");
              await client.enrollEvent(
                { display_name: draft },
                fresh.csrf_token,
                controller.signal,
              );
              check();
              fresh = await client.getEnrollment(controller.signal);
              check();
              if (
                !same(expected, fresh) ||
                !fresh.enrolled ||
                !fresh.csrf_token
              )
                throw new ApiFailure("FORBIDDEN");
            }
          }
          baseline = { user_id: fresh.user_id, event_id: fresh.event_id };
          publish({
            ...initial,
            phase: "ready",
            enrolled: fresh.enrolled,
            open: fresh.registration_open,
            message: fresh.enrolled
              ? "イベントへの参加済み状態を確認しました。続いて本人情報と規約を確認してください。"
              : fresh.registration_open
                ? null
                : "現在は新規参加を受け付けていません。",
          });
          return fresh.enrolled;
        })(),
      ]);
    } catch {
      if (current === revision)
        publish({
          ...initial,
          phase: "error",
          message: save
            ? "登録結果を確認できませんでした。再送せず、参加状況を読み直してください。"
            : "参加状況を読み込めませんでした。ログイン状態を確認してください。",
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
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: () => run(false),
    enroll: () => run(true),
    edit(draft: string) {
      if (state.phase === "ready" && state.open && !state.enrolled)
        publish({ ...state, draft });
    },
    invalidate() {
      if (state.phase !== "closed") reset("idle");
    },
    close() {
      reset("closed");
    },
  };
}
