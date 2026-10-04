import type { TermsDocument } from "../src/api/terms-document";
import type { ProfileState } from "../src/api/account-profile";

// 自動試験専用。正式規約・実イベント・実同意ではない。productionからimportしない。
export const syntheticTerms: TermsDocument = {
  eventId: "00000000-0000-4000-8000-000000000001",
  version: "test-only",
  terms: ["試験専用の利用規約です。実際の規約としての効力はありません。"],
  privacy: ["試験専用のプライバシー本文です。実データは取り扱いません。"],
};
export const consentState: ProfileState = {
  phase: "ready",
  displayName: "試験名",
  draft: "試験名",
  blocked: false,
  terms: syntheticTerms,
  consentRequired: true,
  consentChecked: false,
  message: null,
  error: false,
};
