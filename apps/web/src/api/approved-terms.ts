import { copyTermsDocument } from "./terms-document";

// 正式本文は未採択。人間の採択記録と公開確認なしに埋めない。
// イベントごとに1つの現行文書。本文変更時は版も変更し、旧版はGit履歴に保持。
const approvedTerms: readonly unknown[] = [];

/** Server page専用の選択入口。未設定・重複・不正は閉じる。 */
export function getApprovedTerms(eventId: string, catalog = approvedTerms) {
  const matches = catalog.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      "eventId" in entry &&
      entry.eventId === eventId,
  );
  return matches.length === 1 ? copyTermsDocument(matches[0]) : null;
}
