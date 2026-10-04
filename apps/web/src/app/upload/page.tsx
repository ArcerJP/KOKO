import Link from "next/link";
import { redirect } from "next/navigation";
import { uploadConfiguration } from "../../api/upload-config";
import { validId } from "../../api/upload-contract";
import { createServerAuthClient } from "../../auth/server";
import { isGoogleOnlySession } from "../../auth/google-session";
import { UploadScreen } from "./upload-screen";

export const dynamic = "force-dynamic";
export default async function UploadPage() {
  const config = uploadConfiguration(process.env);
  if (!config)
    return (
      <main className="shell auth-shell">
        <h1>写真・動画を送信</h1>
        <p role="status">
          送信機能は現在無効です。設定・正式規約・実環境の受入れを確認してから有効にします。
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
  return (
    <main className="shell">
      <p className="eyebrow">第49回技科大祭 · KOKO</p>
      <h1>写真・動画を送信</h1>
      <p>
        <Link href="/account">アカウント・規約を確認</Link>
      </p>
      <UploadScreen owner={data.claims.sub.toLowerCase()} />
    </main>
  );
}
