import {
  approvedLegalDocument,
  LegalDocument,
} from "../../components/legal-document";
export const dynamic = "force-dynamic";
export default function PrivacyPage() {
  return (
    <LegalDocument
      kind="privacy"
      document={approvedLegalDocument(process.env.KOKO_EVENT_ID)}
    />
  );
}
