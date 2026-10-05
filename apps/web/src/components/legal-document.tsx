import Link from "next/link";
import { copyTermsDocument, type TermsDocument } from "../api/terms-document";
import { getApprovedTerms } from "../api/approved-terms";
import { validId } from "../api/upload-contract";
import { AppNavigation } from "./app-navigation";
/** Reads the approved public catalog only. No draft files, fetching, or automatic adoption. */
export function approvedLegalDocument(eventId: unknown): TermsDocument | null {
  return validId(eventId) ? getApprovedTerms(eventId.toLowerCase()) : null;
}
export function LegalDocument({
  kind,
  document,
}: {
  kind: "terms" | "privacy";
  document: TermsDocument | null;
}) {
  const approved = copyTermsDocument(document),
    title = kind === "terms" ? "利用規約" : "プライバシーポリシー";
  return (
    <main className="shell">
      <p className="eyebrow">第49回技科大祭</p>
      <h1>{title}</h1>
      <AppNavigation />
      {approved ? (
        <section aria-label={title}>
          <p>文書バージョン：{approved.version}</p>
          {approved[kind].map((paragraph, index) => (
            <p
              key={index}
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {paragraph}
            </p>
          ))}
          <p>
            この画面を読んだだけでは同意は登録されません。
            <Link href="/account" prefetch={false}>
              アカウント画面
            </Link>
            で現行版を確認して明示的に同意してください。
          </p>
        </section>
      ) : (
        <p role="status">
          本文は公開準備中です。利用規約とプライバシーポリシーの両方の最終確認が完了するまで、未承認の文案をここに掲載せず、投稿の利用開始はできません。
        </p>
      )}
      <p>
        <Link href={kind === "terms" ? "/privacy" : "/terms"} prefetch={false}>
          {kind === "terms" ? "プライバシーポリシー" : "利用規約"}
        </Link>{" "}
        ·{" "}
        <Link href="/help" prefetch={false}>
          お問い合わせ・ヘルプ
        </Link>
      </p>
    </main>
  );
}
