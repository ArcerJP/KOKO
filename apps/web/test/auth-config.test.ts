import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabasePublicConfig } from "../src/auth/config";
import { isGoogleOnlySession } from "../src/auth/google-session";

afterEach(() => vi.unstubAllEnvs());

describe("Supabase公開設定", () => {
  it("未設定やsecret keyを拒否する", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(getSupabasePublicConfig()).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_secret_mistake");
    expect(getSupabasePublicConfig()).toBeNull();
  });

  it("HTTPSのProject URLとpublishable keyだけを採用する", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://example.supabase.co");
    expect(getSupabasePublicConfig()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    expect(getSupabasePublicConfig()).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    });
  });
});

describe("Google単独セッション", () => {
  const google = {
    role: "authenticated",
    is_anonymous: false,
    app_metadata: { provider: "google", providers: ["google"] },
  };

  it("Google以外・匿名・複数identityを拒否する", () => {
    expect(isGoogleOnlySession(google)).toBe(true);
    expect(isGoogleOnlySession(null)).toBe(false);
    expect(
      isGoogleOnlySession({
        ...google,
        app_metadata: { provider: "email", providers: ["email"] },
      }),
    ).toBe(false);
    expect(
      isGoogleOnlySession({
        ...google,
        app_metadata: { provider: "google", providers: ["google", "email"] },
      }),
    ).toBe(false);
    expect(isGoogleOnlySession({ ...google, is_anonymous: true })).toBe(false);
  });
});
