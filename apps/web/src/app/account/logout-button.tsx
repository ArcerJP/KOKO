"use client";

import { useRef, useState } from "react";
import { createBrowserAuthClient } from "../../auth/browser";
import { completeSignOut } from "../../auth/sign-out";

export function LogoutButton({
  apiEnabled = false,
  onStart,
}: {
  apiEnabled?: boolean;
  onStart?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const signOut = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFailed(false);
    try {
      // Stop this tab before any async sign-out. Other tabs also stop immediately.
      window.dispatchEvent(new Event("koko-upload-stop"));
      try {
        const channel = new BroadcastChannel("koko-upload-stop");
        channel.postMessage("stop");
        channel.close();
      } catch {
        /* Supabase SIGNED_OUT remains the fallback notification. */
      }
      onStart?.();
      await completeSignOut(apiEnabled, () =>
        createBrowserAuthClient().auth.signOut(),
      );
      window.location.replace("/login");
    } catch {
      setFailed(true);
      setPending(false);
      running.current = false;
    }
  };

  return (
    <>
      <button type="button" onClick={signOut} disabled={pending}>
        {pending ? "ログアウト中…" : "ログアウト"}
      </button>
      {failed && (
        <p role="alert" className="warning">
          ログアウトを完了できませんでした。再試行してください。
        </p>
      )}
    </>
  );
}
