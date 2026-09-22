import { http, HttpResponse } from "msw";
import type { components } from "@koko/contract/api";

// 合成fixture。実ユーザー・Googleアカウント・セッションではない。
export const mockEventId = "00000000-0000-4000-8000-000000000001";
export const mockMe = {
  user_id: "00000000-0000-4000-8000-000000000002",
  event_id: mockEventId,
  display_name: "検証用ユーザー",
  role: "user",
  is_banned: false,
  terms_version: "test-only",
  consent_required: true,
  crown: "none",
} satisfies components["schemas"]["Me"];

export function mockHandlers(baseUrl = "http://127.0.0.1:3100/api/") {
  return [
    http.get(new URL("me", baseUrl).href, ({ request }) => {
      if (request.headers.get("X-Event-ID") !== mockEventId) {
        return HttpResponse.json(
          {
            code: "INVALID_INPUT",
            request_id: "00000000-0000-4000-8000-000000000003",
          } satisfies components["schemas"]["ApiError"],
          { status: 400 },
        );
      }
      return HttpResponse.json(mockMe, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }),
  ];
}
