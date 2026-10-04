"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createAccountProfile } from "../../api/account-profile";
import { createApiClient } from "../../api/client";
import { createBrowserAuthClient } from "../../auth/browser";
import { postApiSession } from "../../auth/session-post";
import { LogoutButton } from "./logout-button";
import { ProfileForm } from "./profile-form";

export function AccountPanel({ eventId }: { eventId: string }) {
  const [profile] = useState(() => {
    // SSRでは通信を開始しない。実URLは明示操作時にブラウザで確定する。
    const client = () =>
      createApiClient(new URL("/api/", window.location.origin), eventId);
    return createAccountProfile(
      {
        getMe: (signal) => client().getMe(signal),
        updateMe: (input, csrf, signal) =>
          client().updateMe(input, csrf, signal),
      },
      (signal) => postApiSession("/auth/api-session", signal),
    );
  });
  const state = useSyncExternalStore(
    profile.subscribe,
    profile.getSnapshot,
    profile.getServerSnapshot,
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const { data } = createBrowserAuthClient().auth.onAuthStateChange(
        (event) => {
          // callback内でAuth通信を再入しない。session/JWTも保持しない。
          if (event === "SIGNED_OUT") profile.close();
          else if (event !== "INITIAL_SESSION") profile.invalidate();
        },
      );
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      profile.close();
    }
    const leave = () => profile.close();
    window.addEventListener("pagehide", leave);
    return () => {
      unsubscribe?.();
      window.removeEventListener("pagehide", leave);
      profile.invalidate();
    };
  }, [profile]);
  return (
    <>
      <ProfileForm
        state={state}
        onLoad={() => void profile.load()}
        onEdit={profile.edit}
        onSave={() => void profile.save()}
      />
      <LogoutButton apiEnabled onStart={profile.close} />
    </>
  );
}
