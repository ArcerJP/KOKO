"use client";

import { useState } from "react";
import { createBrowserAuthClient } from "../../auth/browser";

export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const signOut = async () => {
    setPending(true);
    setFailed(false);
    try {
      const supabase = createBrowserAuthClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      window.location.replace("/login");
    } catch {
      setFailed(true);
      setPending(false);
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
