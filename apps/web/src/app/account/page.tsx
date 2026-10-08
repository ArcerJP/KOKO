import Link from "next/link";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { isGoogleOnlySession } from "../../auth/google-session";
import { createServerAuthClient } from "../../auth/server";
import { LogoutButton } from "./logout-button";
import { AccountPanel } from "./account-panel";
import { accountEventId } from "../../api/account-config";
import { getApprovedTerms } from "../../api/approved-terms";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createServerAuthClient();
  if (!supabase) redirect("/login");

  const { data, error } = await supabase.auth.getClaims();
  if (error || !isGoogleOnlySession(data?.claims)) redirect("/login");
  const eventId = accountEventId(process.env);
  const termsDocument = eventId ? getApprovedTerms(eventId) : null;
  // RSC更新で本文/版が変わった場合も、旧チェック・進行中操作を引き継がない。
  const panelKey = createHash("sha256")
    .update(
      JSON.stringify([
        eventId,
        termsDocument,
        process.env.KOKO_ENROLLMENT_ENABLED === "true",
      ]),
    )
    .digest("hex");

  return (
    <main className="shell auth-shell">
      <p className="eyebrow">第49回技科大祭 · KOKO</p>
      <h1>アカウント</h1>
      <section className="panel">
        <p role="status">Googleアカウントでログインしています。</p>
        {eventId ? (
          <AccountPanel
            key={panelKey}
            eventId={eventId}
            termsDocument={termsDocument}
            enrollmentEnabled={process.env.KOKO_ENROLLMENT_ENABLED === "true"}
          />
        ) : (
          <LogoutButton
            apiEnabled={process.env.KOKO_API_COOKIE_ENABLED === "true"}
          />
        )}
      </section>
      <p>
        <Link href="/feed">みんなの投稿へ</Link> ·{" "}
        <Link href="/themes">お題へ</Link> · <Link href="/help">ヘルプ</Link>
      </p>
      <p>
        <Link href="/upload">写真・動画の送信と端末の保存状況へ</Link>
      </p>
      <p>
        <Link href="/account/posts">自分の投稿状況へ</Link>
      </p>
      <p>
        <Link href="/capture-lab">端末内の撮影・トリム検証へ</Link>
      </p>
      <p className="caption">
        送信画面は設定と規約の条件を満たす場合のみ利用できます。
        規約とプライバシーポリシーを確認し、表示名と同意を登録してください。
        {!eventId && "表示名の確認・変更も現在は無効です。"}
      </p>
    </main>
  );
}
