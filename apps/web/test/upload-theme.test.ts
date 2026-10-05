import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Theme } from "../src/api/operations-contract";
import { availableUploadThemes } from "../src/components/upload-theme-picker";
import { PostsView } from "../src/app/account/posts/posts-view";
import { eventId, theme as themeId, id } from "./feed-fixture";
import { post } from "./own-posts-fixture";
const now = Date.parse("2026-10-10T01:00:00Z");
const theme: Theme = {
  id: themeId,
  event_id: eventId,
  title: "合成のお題",
  description: "合成の説明",
  icon: "📷",
  color: "#112233",
  status: "published",
  starts_at: "2026-10-10T00:00:00Z",
  ends_at: "2026-10-10T02:00:00Z",
};
it("only available published themes from the fixed event can be selected", () => {
  const items = [
    theme,
    { ...theme, id: id(20), status: "draft" as const },
    { ...theme, id: id(21), status: "ended" as const },
    { ...theme, id: id(22), starts_at: "2026-10-10T02:00:00Z" },
    { ...theme, id: id(23), ends_at: "2026-10-10T01:00:00Z" },
    { ...theme, id: id(24), event_id: id(999) },
  ];
  expect(availableUploadThemes(items, eventId, now)).toEqual([theme]);
});
it("opening boundary is inclusive and closing boundary is exclusive", () => {
  expect(
    availableUploadThemes([theme], eventId, Date.parse(theme.starts_at)),
  ).toHaveLength(1);
  expect(
    availableUploadThemes([theme], eventId, Date.parse(theme.ends_at)),
  ).toHaveLength(0);
});
it("own-post actions are gated, exclude deleted, and retain raw-media denial", () => {
  const items = [
    post(10, { status: "blocked" }),
    post(11, { status: "hidden" }),
    post(12, { status: "deleted" }),
    post(13, { status: "uploading" }),
  ];
  const props = {
    state: { phase: "ready" as const, items, nextCursor: null, message: "" },
    onReload() {},
    onMore() {},
    onRefresh() {},
  };
  const off = renderToStaticMarkup(createElement(PostsView, props));
  expect(off).not.toContain("自分の投稿を削除");
  const on = renderToStaticMarkup(
    createElement(PostsView, { ...props, operationsEnabled: true }),
  );
  expect(on.match(/自分の投稿を削除/g)).toHaveLength(3);
  expect(on).toContain(`/appeal?post=${items[0]!.id}`);
  expect(on).toContain("原本削除完了を示すものではありません");
  expect(on).not.toMatch(/<img|<video|<form/);
});
