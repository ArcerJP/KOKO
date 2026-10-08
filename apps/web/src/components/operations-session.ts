"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createOperationsController } from "../api/operations-controller";
import { createOperationsClient } from "../api/operations-client";
import { createApiClient } from "../api/client";
import { createBrowserAuthClient } from "../auth/browser";
import { postApiSession } from "../auth/session-post";

export function useOperations(eventId: string) {
  const [controller] = useState(() =>
    createOperationsController(
      {
        getMe: (signal) =>
          createApiClient(
            new URL("/api/", window.location.origin),
            eventId,
          ).getMe(signal),
        execute: (op, input, csrf, signal) =>
          createOperationsClient(
            new URL("/api/", window.location.origin),
            eventId,
          ).execute(op, input, csrf, signal),
      },
      (signal) => postApiSession("/auth/api-session", signal),
    ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined,
      channel: BroadcastChannel | undefined;
    try {
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          if (
            event === "SIGNED_OUT" ||
            event === "SIGNED_IN" ||
            event === "USER_UPDATED"
          )
            controller.close();
          else if (event !== "INITIAL_SESSION") controller.invalidate();
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
      channel = new BroadcastChannel("koko-upload-stop");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "stop") controller.close();
      };
    } catch {
      controller.close();
    }
    const leave = () => controller.close();
    const hide = () => {
      if (document.visibilityState !== "visible") controller.invalidate();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("koko-upload-stop", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      unsubscribe?.();
      channel?.close();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("koko-upload-stop", leave);
      document.removeEventListener("visibilitychange", hide);
      controller.invalidate();
    };
  }, [controller]);
  return {
    controller,
    state,
    busy:
      state.phase === "loading" ||
      state.phase === "saving" ||
      state.phase === "closed",
  };
}
