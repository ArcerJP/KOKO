import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostStateDetails } from "../src/components/post-state-details";
import { post } from "./own-posts-fixture";
it.each([
  ["sexual", "性的な内容"],
  ["violence", "暴力的な内容"],
  ["hate", "差別・憎悪"],
  ["harassment", "嫌がらせ・脅迫"],
  ["self_harm", "自傷行為"],
  ["illicit", "違法行為"],
  ["other", "その他の安全基準"],
] as const)(
  "owner and operator shared view explains coarse %s category",
  (category, label) => {
    const html = renderToStaticMarkup(
      createElement(PostStateDetails, {
        post: post(1, { status: "blocked", block_category: category }),
      }),
    );
    expect(html).toContain(label);
    expect(html).toContain("自動判定による大分類");
    expect(html).not.toMatch(/ocr:|openai:|safesearch:|<img|<video/);
  },
);
it.each([
  ["RETENTION_UNKNOWN", "保持期限が未確認"],
  ["RETENTION_PENDING", "保持期限まで"],
  ["PHYSICAL_DELETION_NOT_ENABLED", "未有効化"],
  ["DELETION_UNCONFIRMED", "実物が削除されたかは未確認"],
] as const)(
  "explains %s without physical-completion inference",
  (state, label) => {
    const html = renderToStaticMarkup(
      createElement(PostStateDetails, {
        post: post(1, {
          status: "deleted",
          deletion: { state, retention_until: "2099-01-01T00:00:00Z" },
        }),
      }),
    );
    expect(html).toContain(label);
    expect(html).toContain("DBに記録された保持期限");
    expect(html).toContain("日本時間");
    expect(html).toContain("この記録だけでは確認できません");
    expect(html).not.toContain("削除が完了");
  },
);
it("does not invent a retention date", () => {
  const html = renderToStaticMarkup(
    createElement(PostStateDetails, {
      post: post(1, {
        status: "deleted",
        deletion: { state: "RETENTION_UNKNOWN", retention_until: null },
      }),
    }),
  );
  expect(html).toContain("保持期限：未確認");
  expect(html).not.toContain("<time");
});
