import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileForm } from "../src/app/account/profile-form";
import { createAccountProfile } from "../src/api/account-profile";

describe("表示名フォーム", () => {
  const initial = createAccountProfile(
    {
      getMe: async () => {
        throw new Error();
      },
      updateMe: async () => {
        throw new Error();
      },
    },
    async () => false,
  ).getSnapshot();
  const render = (patch = {}) =>
    renderToStaticMarkup(
      createElement(ProfileForm, {
        state: { ...initial, ...patch },
        onLoad() {},
        onSave() {},
        onEdit() {},
      }),
    );
  it("初期状態は個人情報も入力欄もなく、明示読込みを案内", () => {
    const html = render();
    expect(html).toContain("本人情報を読み込む");
    expect(html).not.toContain("<input");
    expect(html).toContain('aria-labelledby="profile-heading"');
  });
  it("HTMLとして表示名を実行せず、labelと説明を関連付ける", () => {
    const html = render({
      phase: "ready",
      displayName: '<script>alert("synthetic")</script>',
      draft: "変更名",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('for="display-name"');
    expect(html).toContain('aria-describedby="display-name-help"');
    expect(html).not.toContain("csrf");
  });
  it.each(["loading", "saving", "closed"])(
    "%s中は編集欄を出さない",
    (phase) => {
      const html = render({ phase });
      expect(html).not.toContain("<input");
      expect(html).toContain("disabled");
    },
  );
  it("入力不正とBANを色だけに依存せず案内", () => {
    const html = render({
      phase: "ready",
      displayName: "名前",
      draft: "",
      blocked: true,
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("現在、このアカウントでは変更できません");
    expect(html).toContain("1〜50文字");
  });
  it("固定エラーはalert", () =>
    expect(
      render({ phase: "error", error: true, message: "再読込みしてください" }),
    ).toContain('role="alert"'));
});
