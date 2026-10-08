import "server-only";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { accountEventId } from "../../../api/account-config";
import { validId } from "../../../api/upload-contract";
import { createServerAuthClient } from "../../../auth/server";
import { isGoogleOnlySession } from "../../../auth/google-session";

/** Page-entry authentication only. Every API read/write enforces its own authorization. */
export async function operationsEntry() {
  if (process.env.KOKO_STAGE_THREE_ENABLED !== "true") return null;
  const eventId = accountEventId(process.env);
  if (!eventId) return null;
  const client = await createServerAuthClient();
  if (!client) redirect("/login");
  const { data, error } = await client.auth.getClaims();
  if (
    error ||
    !isGoogleOnlySession(data?.claims) ||
    !validId(data?.claims?.sub)
  )
    redirect("/login");
  return { eventId, owner: data.claims.sub.toLowerCase() };
}

export function OperationsFrame({
  title,
  enabled,
  children,
}: {
  title: string;
  enabled: boolean;
  children?: ReactNode;
}) {
  return (
    <main className="shell">
      <p className="eyebrow">第49回技科大祭</p>
      <h1>{title}</h1>
      <nav aria-label="イベントの画面">
        <Link href="/account">アカウント</Link> ·{" "}
        <Link href="/account/posts">自分の投稿</Link> ·{" "}
        <Link href="/themes">お題</Link> ·{" "}
        <Link href="/appeal">異議申立て</Link>
      </nav>
      {enabled ? (
        children
      ) : (
        <p role="status">
          この機能は現在無効です。実環境の設定と受入れ後に有効にします。
        </p>
      )}
    </main>
  );
}
