type Claims = {
  role?: unknown;
  is_anonymous?: unknown;
  app_metadata?: unknown;
};

export function isGoogleOnlySession(
  claims: Claims | null | undefined,
): boolean {
  if (claims?.role !== "authenticated" || claims.is_anonymous !== false) {
    return false;
  }

  const metadata = claims.app_metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const { provider, providers } = metadata as Record<string, unknown>;
  return (
    provider === "google" &&
    Array.isArray(providers) &&
    providers.length === 1 &&
    providers[0] === "google"
  );
}
