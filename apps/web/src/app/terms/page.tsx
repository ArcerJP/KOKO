import {
  approvedLegalDocument,
  LegalDocument,
} from "../../components/legal-document";
export const dynamic = "force-dynamic";
export default function TermsPage() {
  return (
    <LegalDocument
      kind="terms"
      document={approvedLegalDocument(process.env.KOKO_EVENT_ID)}
    />
  );
}
