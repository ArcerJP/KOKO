import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabasePublicConfig } from "../../auth/config";
import { isGoogleOnlySession } from "../../auth/google-session";
import { createServerAuthClient } from "../../auth/server";
import { GoogleLoginButton } from "./google-login-button";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const configured = getSupabasePublicConfig() !== null;
  let signedIn = false;
  if (configured) {
    try {
      const supabase = await createServerAuthClient();
      const { data } = await supabase!.auth.getClaims();
      signedIn = isGoogleOnlySession(data?.claims);
    } catch {
      // A temporary Auth outage does not expose the account page.
    }
  }
  if (signedIn) redirect("/account");

  const { error } = await searchParams;
  return (
    <main className="shell auth-shell">
      <p className="eyebrow">第49回技科大祭 · KOKO</p>
      <h1>Googleでログイン</h1>
      <p>現在は登録済みのテストユーザーだけが利用できます。</p>
      {error === "auth" && (
        <p role="alert" className="status warning">
          ログインを完了できませんでした。設定とテストユーザーを確認してください。
        </p>
      )}
      <section className="panel" aria-label="ログイン">
        {configured ? (
          <GoogleLoginButton />
        ) : (
          <p role="status">
            認証先がまだ設定されていません。公開用のSupabase URLとpublishable
            keyを設定すると、ログイン操作を試せます。
          </p>
        )}
      </section>
      <p>
        <Link href="/capture-lab">端末内の撮影・トリム検証へ戻る</Link>
      </p>
      <p className="caption">
        このログインだけでは、利用規約への同意・表示名登録・投稿は完了しません。
      </p>
    </main>
  );
}
