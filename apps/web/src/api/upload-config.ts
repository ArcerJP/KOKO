import "server-only";
import { accountEventId } from "./account-config";
import { getApprovedTerms } from "./approved-terms";

/** The only fields allowed across the server/client boundary. No secrets. */
export function uploadConfiguration(
  config: Record<string, string | undefined>,
) {
  const eventId = accountEventId(config)?.toLowerCase();
  if (
    !eventId ||
    config.KOKO_UPLOAD_UI_ENABLED !== "true" ||
    config.KOKO_UPLOAD_PROXY_ENABLED !== "true"
  )
    return null;
  const r2AccountId = config.KOKO_R2_ACCOUNT_ID;
  const terms = getApprovedTerms(eventId);
  if (!r2AccountId || !/^[a-f0-9]{32}$/.test(r2AccountId) || !terms)
    return null;
  return { eventId, r2AccountId, termsVersion: terms.version };
}
