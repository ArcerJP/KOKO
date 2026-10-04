"use client";

import { useRef, useState } from "react";
import { createBrowserAuthClient } from "../../auth/browser";
import { completeSignOut } from "../../auth/sign-out";

export function LogoutButton({ apiEnabled = false }: { apiEnabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const signOut = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFailed(false);
    try {
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
