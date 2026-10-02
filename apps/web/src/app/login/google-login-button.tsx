"use client";

import { useState } from "react";
import { createBrowserAuthClient } from "../../auth/browser";

export function GoogleLoginButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const signIn = async () => {
    setPending(true);
    setFailed(false);
    try {
      const supabase = createBrowserAuthClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: new URL("/auth/callback", window.location.origin).href,
        },
      });
      if (error) throw error;
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <>
      <button type="button" onClick={signIn} disabled={pending}>
        {pending ? "Googleへ移動しています…" : "Googleでログイン"}
      </button>
      {failed && (
        <p role="alert" className="warning">
          ログインを開始できませんでした。時間をおいて再試行してください。
        </p>
      )}
    </>
  );
}
