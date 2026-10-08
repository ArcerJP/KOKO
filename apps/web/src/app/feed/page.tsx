import Link from "next/link";
import { redirect } from "next/navigation";
import { accountEventId } from "../../api/account-config";
import { validId } from "../../api/upload-contract";
import { createServerAuthClient } from "../../auth/server";
import { isGoogleOnlySession } from "../../auth/google-session";
import { FeedPanel } from "./feed-panel";
export const dynamic = "force-dynamic";
export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ theme_id?: string | string[] }>;
}) {
  const eventId =
    process.env.KOKO_PUBLIC_FEED_ENABLED === "true"
      ? accountEventId(process.env)?.toLowerCase()
      : null;
  if (!eventId)
    return (
      <main className="shell">
        <h1>みんなの投稿</h1>
        <p role="status">
          公開投稿の閲覧は現在無効です。実環境の設定と受入れ後に有効にします。
        </p>
        <Link href="/account">アカウントへ</Link>
      </main>
    );
  const client = await createServerAuthClient();
  if (!client) redirect("/login");
  const { data, error } = await client.auth.getClaims();
  if (
    error ||
    !isGoogleOnlySession(data?.claims) ||
    !validId(data?.claims?.sub)
  )
    redirect("/login");
  const { theme_id } = await searchParams;
  if (
    theme_id !== undefined &&
    (typeof theme_id !== "string" || !validId(theme_id))
  )
    return (
      <main className="shell">
        <h1>みんなの投稿</h1>
        <p role="alert">お題の指定が正しくありません。</p>
        <Link href="/feed">絞り込みを解除する</Link>
      </main>
    );
  return (
    <main className="shell">
      <p className="eyebrow">第49回技科大祭</p>
      <h1>みんなの投稿</h1>
      <nav aria-label="イベントの画面">
        <Link href="/upload">撮影・送信</Link> ·{" "}
        <Link href="/themes">お題</Link> ·{" "}
        <Link href="/account/posts">自分の投稿</Link> ·{" "}
        <Link href="/account">アカウント</Link>
      </nav>
      {theme_id ? (
        <p>
          お題で絞り込んでいます。<Link href="/feed">絞り込みを解除する</Link>
        </p>
      ) : null}
      <FeedPanel
        key={`${eventId}:${data.claims.sub}:${theme_id ?? ""}`}
        owner={data.claims.sub.toLowerCase()}
        eventId={eventId}
        {...(theme_id ? { theme: theme_id.toLowerCase() } : {})}
      />
    </main>
  );
}
