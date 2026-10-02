import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicConfig } from "./config";

export function createBrowserAuthClient() {
  const config = getSupabasePublicConfig();
  if (!config) throw new Error("Supabase Authの公開設定がありません。");
  return createBrowserClient(config.url, config.publishableKey);
}
