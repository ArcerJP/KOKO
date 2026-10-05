import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings, Theme } from "../src/api/operations-contract";
const { createClient, redirect } = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("REDIRECT_LOGIN");
  }),
}));
vi.mock("../src/auth/server", () => ({ createServerAuthClient: createClient }));
vi.mock("next/navigation", () => ({ redirect }));
import ManagePage from "../src/app/manage/page";
import ThemesPage from "../src/app/themes/page";
import AppealPage from "../src/app/appeal/page";
import { ThemesList } from "../src/app/themes/themes-panel";
import { SettingsEditor } from "../src/app/manage/settings-editor";
import { ThemeForm } from "../src/app/manage/themes-editor";
import { PostActions, PostActionForm } from "../src/components/post-actions";
import { AppealForm } from "../src/app/appeal/appeal-panel";
import { mockEventId, mockMe } from "../src/mocks/handlers";

const claims = {
  sub: mockMe.user_id,
  role: "authenticated",
  is_anonymous: false,
  app_metadata: { provider: "google", providers: ["google"] },
};
beforeEach(() => {
  for (const flag of [
    "KOKO_STAGE_THREE_ENABLED",
    "KOKO_ACCOUNT_UI_ENABLED",
    "KOKO_API_COOKIE_ENABLED",
    "KOKO_API_PROXY_ENABLED",
  ])
    vi.stubEnv(flag, "true");
  vi.stubEnv("KOKO_EVENT_ID", mockEventId);
  createClient.mockResolvedValue({
    auth: {
      getClaims: vi.fn().mockResolvedValue({ data: { claims }, error: null }),
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const pages = [
  ManagePage,
  ThemesPage,
  () => AppealPage({ searchParams: Promise.resolve({}) }),
];
it.each(pages)(
  "page defaults closed before auth/client data when stage flag is off",
  async (page) => {
    vi.stubEnv("KOKO_STAGE_THREE_ENABLED", "false");
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("この機能は現在無効");
    expect(createClient).not.toHaveBeenCalled();
    expect(html).not.toContain("<form");
  },
);
it.each(pages)(
  "enabled page renders no private data or credentials at SSR",
  async (page) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(await page());
    expect(html).not.toContain("現在無効");
    expect(html).not.toContain(mockMe.user_id);
    expect(html).not.toMatch(/csrf|Bearer|service_role|access_token/);
    expect(html).not.toContain("<textarea");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  {},
  { ...claims, sub: "bad" },
  { ...claims, is_anonymous: true },
  { ...claims, app_metadata: { provider: "email", providers: ["email"] } },
])("page rejects non-Google or invalid session %o", async (invalid) => {
  createClient.mockResolvedValue(
    invalid === null
      ? null
      : {
          auth: {
            getClaims: vi
              .fn()
              .mockResolvedValue({ data: { claims: invalid }, error: null }),
          },
        },
  );
  await expect(ManagePage()).rejects.toThrow("REDIRECT_LOGIN");
});
it("missing fixed event prevents operation forms", async () => {
  vi.stubEnv("KOKO_EVENT_ID", "invalid");
  expect(renderToStaticMarkup(await ManagePage())).toContain("現在無効");
  expect(createClient).not.toHaveBeenCalled();
});
it("themes render untrusted icon/description as text, never HTML or external CSS URL", () => {
  const theme: Theme = {
    id: mockMe.user_id,
    event_id: mockEventId,
    title: "合成お題",
    description: "<script>secret()</script>",
    icon: "<img src=x>",
    color: "url(https://attacker.invalid)",
    status: "published",
    starts_at: "2026-10-10T01:00:00Z",
    ends_at: "2026-10-11T09:00:00Z",
  };
  const html = renderToStaticMarkup(
    createElement(ThemesList, { items: [theme] }),
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("attacker.invalid");
  expect(html).toContain("10:00:00");
});
it("new theme form starts draft without guessing dates", () => {
  const html = renderToStaticMarkup(
    createElement(ThemeForm, { onSave: vi.fn() }),
  );
  expect(html).toContain('value="draft" selected');
  expect(html).toContain('type="datetime-local" required="" value=""');
  expect(html).toContain('disabled=""');
});
it("threshold approval is read-only and no default score is inserted", () => {
  const settings: Settings = {
    version: 7,
    publication_stopped: true,
    uploads_enabled: false,
    moderation_concurrency: 1,
    thresholds_approved: false,
    thresholds: [],
  };
  const html = renderToStaticMarkup(
    createElement(SettingsEditor, { settings, mutate: vi.fn() }),
  );
  expect(html).toContain("readOnly");
  expect(html).toContain("この画面では承認できません");
  expect(html).toContain("閾値は未設定");
  expect(html).not.toContain('value="0.5"');
});
it.each(["report", "delete-own"] as const)(
  "post operation %s requires explicit confirmation",
  (mode) => {
    const html = renderToStaticMarkup(
      createElement(PostActionForm, { mode, onSubmit: vi.fn() }),
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("checked");
  },
);
it("invalid post identity cannot render a mutation control", () => {
  expect(
    renderToStaticMarkup(
      createElement(PostActions, {
        eventId: mockEventId,
        postId: "bad",
        mode: "delete-own",
      }),
    ),
  ).toBe("");
});
it("appeal requires bounded text and explicit confirmation without privacy policy draft", () => {
  const html = renderToStaticMarkup(
    createElement(AppealForm, { initialPostId: "", onSubmit: vi.fn() }),
  );
  expect(html).toContain('maxLength="2000"');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain("プライバシーポリシー");
});
