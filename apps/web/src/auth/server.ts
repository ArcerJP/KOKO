import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicConfig } from "./config";

export async function createServerAuthClient(
  options: { requireCookieWrites?: boolean } = {},
) {
  const config = getSupabasePublicConfig();
  if (!config) return null;

  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          if (options.requireCookieWrites) {
            // A route issuing another cookie must not hide a failed SSR refresh.
            throw new Error("Auth cookie update failed");
          }
          // Server Components are read-only; proxy.ts refreshes their cookies.
        }
      },
    },
  });
}
