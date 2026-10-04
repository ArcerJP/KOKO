import Link from "next/link";
import { redirect } from "next/navigation";
import { isGoogleOnlySession } from "../../auth/google-session";
import { createServerAuthClient } from "../../auth/server";
import { LogoutButton } from "./logout-button";
import { AccountPanel } from "./account-panel";
import { accountEventId } from "../../api/account-config";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createServerAuthClient();
  if (!supabase) redirect("/login");

  const { data, error } = await supabase.auth.getClaims();
  if (error || !isGoogleOnlySession(data?.claims)) redirect("/login");
  const eventId = accountEventId(process.env);

  return (
    <main className="shell auth-shell">
      <p className="eyebrow">第49回技科大祭 · KOKO</p>
      <h1>ログイン状態の確認</h1>
      <section className="panel">
        <p role="status">Googleアカウントでログインしています。</p>
        {eventId ? (
          <AccountPanel key={eventId} eventId={eventId} />
        ) : (
          <LogoutButton
            apiEnabled={process.env.KOKO_API_COOKIE_ENABLED === "true"}
          />
        )}
      </section>
      <p>
        <Link href="/">端末内の撮影・トリム検証へ</Link>
      </p>
      <p className="caption">
        投稿・写真／動画の閲覧と規約への同意はまだ接続されていません。
        {!eventId && "表示名の確認・変更も現在は無効です。"}
      </p>
    </main>
  );
}
