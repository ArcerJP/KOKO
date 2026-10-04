import "server-only";
import { accountEventId } from "./account-config";

export function ownPostsEventId(config: Record<string, string | undefined>) {
  if (
    config.KOKO_OWN_POSTS_UI_ENABLED !== "true" ||
    config.KOKO_OWN_POSTS_PROXY_ENABLED !== "true"
  )
    return null;
  return accountEventId(config)?.toLowerCase() ?? null;
}
