import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentForm } from "../src/app/account/consent-form";
import { consentState, syntheticTerms } from "./consent-fixture";
import type { ProfileState } from "../src/api/account-profile";

const render = (patch: Partial<ProfileState> = {}) =>
  renderToStaticMarkup(
    createElement(ConsentForm, {
      state: { ...consentState, ...patch },
      onCheck() {},
      onAccept() {},
    }),
  );
describe("規約同意フォーム", () => {
  it("本文2種類・版を表示し、初期チェックなし・送信不可", () => {
    const html = render();
    expect(html).toContain(syntheticTerms.terms[0]);
    expect(html).toContain(syntheticTerms.privacy[0]);
    expect(html).toContain("test-only");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-describedby="consent-help"');
  });
  it("明示チェック済みだけ送信可能", () => {
    const html = render({ consentChecked: true });
    expect(html).toContain('checked=""');
    expect(html).not.toContain('disabled=""');
  });
  it("同意済みは再送のフォームなし", () => {
    const html = render({ consentRequired: false });
    expect(html).toContain("同意済み");
    expect(html).not.toContain("<form");
  });
  it("本文未設定/不一致はチェックを表示しない", () => {
    const html = render({ terms: null });
    expect(html).toContain("同意を受け付けられません");
    expect(html).not.toContain("<input");
  });
  it.each([
    "idle",
    "loading",
    "saving",
    "consenting",
    "error",
    "closed",
  ] as const)("%sでは同意できない", (phase) => {
    expect(render({ phase })).not.toContain("<form");
  });
  it("HTMLを実行せずBANの制限を明記", () => {
    const html = render({
      blocked: true,
      terms: {
        ...syntheticTerms,
        terms: ['<script>alert("fixture")</script>'],
      },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("投稿制限は解除されません");
  });
});
