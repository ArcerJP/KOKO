"use client";
import { useEffect, useState } from "react";
import {
  connectAdminBroadcast,
  createAdminRealtime,
} from "../api/admin-realtime";
import { createApiClient } from "../api/client";
import { createBrowserAuthClient } from "../auth/browser";

export function AdminRealtimeNotice({
  eventId,
  enabled,
  canReview,
}: {
  eventId: string;
  enabled: boolean;
  canReview: boolean;
}) {
  const [changed, setChanged] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!enabled || !canReview) return;
    // Effect-local lifecycle prevents a previous mount's callback writing into a later mount.
    let mounted = true,
      active = true;
    const cleanup: (() => void)[] = [];
    const dispose = () => {
      active = false;
      for (const action of cleanup.splice(0).reverse()) {
        try {
          action();
        } catch {
          /* Continue removing the remaining listeners/channel. */
        }
      }
    };
    try {
      const auth = createBrowserAuthClient();
      const realtime = createAdminRealtime(eventId, {
        getMe: (signal) =>
          createApiClient(new URL("/api/", location.origin), eventId).getMe(
            signal,
          ),
        invalidate: () => {
          if (mounted && active) setChanged(true);
        },
        unavailable: () => {
          if (mounted && active) setUnavailable(true);
        },
        connect: (topic, invalidate, closed, signal) =>
          connectAdminBroadcast(
            {
              setAuth: () => auth.realtime.setAuth(),
              channel: (name) => {
                const channel = auth.channel(name, {
                  config: { private: true, broadcast: { self: false } },
                });
                return {
                  onBroadcast: (receive) => {
                    channel.on(
                      "broadcast",
                      { event: "invalidate" },
                      ({ payload }: { payload: unknown }) => receive(payload),
                    );
                  },
                  subscribe: (status) => {
                    channel.subscribe(status);
                  },
                  close: () => {
                    void auth.removeChannel(channel).catch(() => {});
                  },
                };
              },
            },
            topic,
            invalidate,
            closed,
            signal,
          ),
      });
      const stop = () => realtime.stop();
      cleanup.push(stop);
      const visibility = () => {
        if (document.visibilityState !== "visible") stop();
        else void realtime.start(true);
      };
      const session = auth.auth.onAuthStateChange((event) => {
        if (event !== "INITIAL_SESSION") stop();
      });
      cleanup.push(() => session.data.subscription.unsubscribe());
      // Failure to install cross-tab lifecycle protection disables the optional subscription.
      const broadcast = new BroadcastChannel("koko-upload-stop");
      cleanup.push(() => broadcast.close());
      broadcast.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data === "stop") stop();
      };
      document.addEventListener("visibilitychange", visibility);
      cleanup.push(() =>
        document.removeEventListener("visibilitychange", visibility),
      );
      for (const name of ["pagehide", "offline", "koko-upload-stop"]) {
        window.addEventListener(name, stop);
        cleanup.push(() => window.removeEventListener(name, stop));
      }
      if (document.visibilityState === "visible") void realtime.start(true);
    } catch {
      dispose();
      // Keep synchronous initialization errors outside the component render path.
      queueMicrotask(() => {
        if (mounted) setUnavailable(true);
      });
    }
    return () => {
      mounted = false;
      dispose();
    };
  }, [eventId, enabled, canReview]);
  if (!enabled || !canReview) return null;
  return (
    <p role="status">
      {unavailable
        ? "更新通知を確認できません。一覧を読み直してください。"
        : changed
          ? "運営データが更新されました。現在の一覧を読み直してください。入力中の内容は自動で上書きしません。"
          : "運営向け更新通知を利用します。操作時の権限はAPIで再確認します。"}
    </p>
  );
}
