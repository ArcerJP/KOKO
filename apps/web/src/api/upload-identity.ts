import { ApiFailure, type Me } from "./client";
import { validId } from "./upload-contract";

/** Fresh identity/consent/CSRF before every control operation. Never persist Me. */
export function uploadAuthorizer(
  owner: string,
  eventId: string,
  termsVersion: string,
  prepare: (signal: AbortSignal) => Promise<boolean>,
  getMe: (signal: AbortSignal) => Promise<Me>,
) {
  return async (signal: AbortSignal) => {
    if (!validId(owner) || !validId(eventId) || !termsVersion.trim())
      throw new ApiFailure("FORBIDDEN");
    signal.throwIfAborted();
    if (!(await prepare(signal))) throw new ApiFailure("AUTH_REQUIRED");
    signal.throwIfAborted();
    const me = await getMe(signal);
    signal.throwIfAborted();
    if (
      me.user_id.toLowerCase() !== owner ||
      me.event_id.toLowerCase() !== eventId
    )
      throw new ApiFailure("AUTH_REQUIRED");
    if (me.is_banned) throw new ApiFailure("ACCOUNT_BANNED");
    if (me.consent_required || me.terms_version !== termsVersion)
      throw new ApiFailure("CONSENT_REQUIRED");
    if (!me.csrf_token) throw new ApiFailure("FORBIDDEN");
    return me.csrf_token;
  };
}
