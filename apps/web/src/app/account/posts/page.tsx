import Link from "next/link";
import { redirect } from "next/navigation";
import { ownPostsEventId } from "../../../api/own-posts-config";
import { validId } from "../../../api/upload-contract";
import { createServerAuthClient } from "../../../auth/server";
import { isGoogleOnlySession } from "../../../auth/google-session";
import { PostsPanel } from "./posts-panel";
import { AppNavigation } from "../../../components/app-navigation";

export const dynamic = "force-dynamic";
export default async function OwnPostsPage() {
  const eventId = ownPostsEventId(process.env);
  if (!eventId)
    return (
      <main className="shell auth-shell">
        <h1>自分の投稿状況</h1>
        <p role="status">
          投稿状況の確認は現在無効です。実環境の設定と受入れ後に有効にします。
        </p>
        <Link href="/account">アカウントへ</Link>
      </main>
    );
  const supabase = await createServerAuthClient();
  if (!supabase) redirect("/login");
  const { data, error } = await supabase.auth.getClaims();
  if (
    error ||
    !isGoogleOnlySession(data?.claims) ||
    !validId(data?.claims?.sub)
  )
    redirect("/login");
  const owner = data.claims.sub.toLowerCase();
  return (
    <main className="shell">
      <p className="eyebrow">第49回技科大祭</p>
      <h1>自分の投稿状況</h1>
      <p>
        <Link href="/account">アカウントへ</Link> ·{" "}
        <Link href="/upload">送信画面へ</Link>
      </p>
      <AppNavigation />
      {process.env.KOKO_STAGE_THREE_ENABLED === "true" ? (
        <p>
          <Link href="/appeal" prefetch={false}>
            BAN・投稿について異議を申し立てる
          </Link>
        </p>
      ) : null}
      <PostsPanel
        key={`${eventId}:${owner}`}
        eventId={eventId}
        owner={owner}
        operationsEnabled={process.env.KOKO_STAGE_THREE_ENABLED === "true"}
      />
    </main>
  );
}
