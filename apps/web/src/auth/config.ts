export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
};

export function getSupabasePublicConfig(): SupabasePublicConfig | null {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !publishableKey?.startsWith("sb_publishable_")) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.pathname !== "/") return null;
    return { url: url.origin, publishableKey };
  } catch {
    return null;
  }
}
