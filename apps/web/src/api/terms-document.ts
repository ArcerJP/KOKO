/** 利用規約とプライバシーポリシーを同じ版で扱う、公開可能な採択本文。 */
export type TermsDocument = Readonly<{
  eventId: string;
  version: string;
  terms: readonly string[];
  privacy: readonly string[];
}>;

/** 外部取得/HTML解釈なし。呼出し元による後の変更から表示本文を分離する。 */
export function copyTermsDocument(value: unknown): TermsDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const paragraphs = (part: unknown): part is string[] =>
    Array.isArray(part) &&
    part.length > 0 &&
    part.length <= 128 &&
    [...part].every(
      (text) => typeof text === "string" && text.trim().length > 0,
    );
  if (
    Object.keys(doc).length !== 4 ||
    typeof doc.eventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      doc.eventId,
    ) ||
    typeof doc.version !== "string" ||
    !doc.version.trim() ||
    Array.from(doc.version).length > 128 ||
    /[\p{Cc}\p{Cf}]/u.test(doc.version) ||
    !paragraphs(doc.terms) ||
    !paragraphs(doc.privacy)
  )
    return null;
  if (new TextEncoder().encode(JSON.stringify(doc)).byteLength > 131_072)
    return null;
  return Object.freeze({
    eventId: doc.eventId,
    version: doc.version,
    terms: Object.freeze([...doc.terms]),
    privacy: Object.freeze([...doc.privacy]),
  });
}

export function matchesTerms(
  doc: TermsDocument | null,
  me: { event_id: string; terms_version: string },
): doc is TermsDocument {
  return (
    doc !== null &&
    doc.eventId === me.event_id &&
    doc.version === me.terms_version
  );
}
