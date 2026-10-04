import {
  ApiFailure,
  isValidDisplayName,
  type Me,
  type createApiClient,
} from "./client";

type Client = Pick<ReturnType<typeof createApiClient>, "getMe" | "updateMe">;
export type ProfileState = Readonly<{
  phase: "idle" | "loading" | "ready" | "saving" | "error" | "closed";
  displayName: string | null;
  draft: string;
  blocked: boolean;
  message: string | null;
  error: boolean;
}>;
const initial: ProfileState = Object.freeze({
  phase: "idle",
  displayName: null,
  draft: "",
  blocked: false,
  message: null,
  error: false,
});
const readFailure =
  "本人情報を読み込めませんでした。ログイン状態や接続を確認し、再読込みしてください。";
const saveFailure =
  "保存結果を確認できませんでした。再送せず、本人情報を読み直して現在の表示名を確認してください。";

/** 1画面1controller。CSRFは各操作の局所変数だけ、snapshot/永続領域へ置かない。 */
export function createAccountProfile(
  client: Client,
  prepare: (signal: AbortSignal) => Promise<boolean>,
) {
  let state = initial;
  let baseline: Pick<Me, "user_id" | "event_id" | "display_name"> | null = null;
  let revision = 0;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ProfileState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const reset = (phase: "idle" | "closed", message: string | null) => {
    revision++;
    active?.abort();
    active = null;
    baseline = null;
    publish({ ...initial, phase, message });
  };
  const samePerson = (a: Pick<Me, "user_id" | "event_id">, b: Me) =>
    a.user_id === b.user_id && a.event_id === b.event_id;
  const ready = (me: Me, message: string | null) => {
    baseline = {
      user_id: me.user_id,
      event_id: me.event_id,
      display_name: me.display_name,
    };
    publish({
      phase: "ready",
      displayName: me.display_name,
      draft: me.display_name,
      blocked: me.is_banned,
      message,
      error: false,
    });
  };
  async function run(kind: "load" | "save") {
    if (active || state.phase === "closed") return;
    const expected = baseline;
    const draft = state.draft;
    if (kind === "save") {
      if (
        state.phase !== "ready" ||
        !expected ||
        state.blocked ||
        draft === expected.display_name
      )
        return;
      if (!isValidDisplayName(draft)) {
        publish({
          ...state,
          error: true,
          message:
            "表示名は空白のみを除く1〜50文字で、制御文字を含めず入力してください。",
        });
        return;
      }
    }
    const current = ++revision;
    const controller = new AbortController();
    active = controller;
    baseline = null;
    publish({ ...initial, phase: kind === "load" ? "loading" : "saving" });
    const check = () => {
      controller.signal.throwIfAborted();
      if (current !== revision) throw new Error("STALE_PROFILE");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("PROFILE_STOPPED"));
      controller.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => controller.abort(), 30_000);
    });
    try {
      await Promise.race([
        stopped,
        (async () => {
          const prepared = await prepare(controller.signal);
          check();
          if (!prepared) throw new ApiFailure("AUTH_REQUIRED");
          const fresh = await client.getMe(controller.signal);
          check();
          if (!fresh.csrf_token) throw new ApiFailure("FORBIDDEN");
          if (kind === "load") {
            ready(fresh, null);
            return;
          }
          if (
            !expected ||
            !samePerson(expected, fresh) ||
            fresh.is_banned ||
            fresh.display_name !== expected.display_name
          )
            throw new ApiFailure("FORBIDDEN");
          await client.updateMe(
            { display_name: draft },
            fresh.csrf_token,
            controller.signal,
          );
          check();
          const confirmed = await client.getMe(controller.signal);
          check();
          if (
            !samePerson(expected, confirmed) ||
            confirmed.is_banned ||
            confirmed.display_name !== draft
          )
            throw new ApiFailure("FORBIDDEN");
          ready(confirmed, "表示名を保存し、現在の情報を確認しました。");
        })(),
      ]);
    } catch {
      if (current === revision)
        publish({
          ...initial,
          phase: "error",
          error: true,
          message: kind === "save" ? saveFailure : readFailure,
        });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
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
    load: () => run("load"),
    save: () => run("save"),
    edit(draft: string) {
      if (state.phase === "ready" && !state.blocked)
        publish({ ...state, draft, message: null, error: false });
    },
    invalidate() {
      if (state.phase !== "closed")
        reset(
          "idle",
          "ログイン状態が更新されました。本人情報を読み直してください。",
        );
    },
    close() {
      reset(
        "closed",
        "この画面の本人情報を破棄しました。再度使う場合はログイン状態を確認し、ページを開き直してください。",
      );
    },
  };
}
