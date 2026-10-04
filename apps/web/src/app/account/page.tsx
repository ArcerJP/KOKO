import Link from "next/link";
import { redirect } from "next/navigation";
import { isGoogleOnlySession } from "../../auth/google-session";
import { createServerAuthClient } from "../../auth/server";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createServerAuthClient();
  if (!supabase) redirect("/login");

  const { data, error } = await supabase.auth.getClaims();
  if (error || !isGoogleOnlySession(data?.claims)) redirect("/login");

  return (
    <main className="shell auth-shell">
      <p className="eyebrow">第49回技科大祭 · KOKO</p>
      <h1>ログイン状態の確認</h1>
      <section className="panel">
        <p role="status">Googleアカウントでログインしています。</p>
        <LogoutButton
          apiEnabled={process.env.KOKO_API_COOKIE_ENABLED === "true"}
        />
      </section>
      <p>
        <Link href="/">端末内の撮影・トリム検証へ</Link>
      </p>
      <p className="caption">
        投稿・写真／動画の閲覧はまだ接続されていません。規約への同意と表示名登録も後続です。
      </p>
    </main>
  );
}
