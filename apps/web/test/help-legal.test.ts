import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LegalDocument,
  approvedLegalDocument,
} from "../src/components/legal-document";
import HelpPage from "../src/app/help/page";
import TermsPage from "../src/app/terms/page";
import PrivacyPage from "../src/app/privacy/page";
import { eventId } from "./feed-fixture";
afterEach(() => vi.unstubAllEnvs());
it.each([null, "bad", eventId])("approved catalog remains empty for %s", (id) =>
  expect(approvedLegalDocument(id)).toBeNull(),
);
it.each([TermsPage, PrivacyPage])(
  "real legal route never adopts or publishes draft text",
  (page) => {
    vi.stubEnv("KOKO_EVENT_ID", eventId);
    const html = renderToStaticMarkup(createElement(page));
    expect(html).toContain("本文は公開準備中");
    expect(html).not.toContain("文書バージョン");
    expect(html).not.toContain("<form");
  },
);
it.each(["terms", "privacy"] as const)(
  "renders only the approved part as escaped text: %s",
  (kind) => {
    const document = {
      eventId,
      version: "synthetic-1",
      terms: ["<script>example</script>", "TERM_ONLY"],
      privacy: ["PRIVACY_ONLY"],
    };
    const html = renderToStaticMarkup(
      createElement(LegalDocument, { kind, document }),
    );
    expect(html).toContain("synthetic-1");
    expect(html).toContain(kind === "terms" ? "TERM_ONLY" : "PRIVACY_ONLY");
    expect(html).not.toContain(kind === "terms" ? "PRIVACY_ONLY" : "TERM_ONLY");
    expect(html).not.toContain("<script>");
    expect(html).toContain("同意は登録されません");
  },
);
it("incomplete terms/privacy pair remains closed", () => {
  const document = {
    eventId,
    version: "synthetic",
    terms: ["Not approved"],
    privacy: [],
  };
  const html = renderToStaticMarkup(
    createElement(LegalDocument, { kind: "terms", document }),
  );
  expect(html).toContain("公開準備中");
  expect(html).not.toContain("Not approved");
});
it("help states required user actions, bounded promises and latest public contact", () => {
  const html = renderToStaticMarkup(createElement(HelpPage));
  for (const text of [
    "飯島優人",
    "arcer.jp@gmail.com",
    "消音設定",
    "物理的に消去",
    "継続を保証できません",
    "同じアカウント",
    "APIキー",
    "BAN中でも",
  ])
    expect(html).toContain(text);
  for (const path of [
    "/feed",
    "/upload",
    "/themes",
    "/account",
    "/help",
    "/terms",
    "/privacy",
    "/appeal",
  ])
    expect(html).toContain(`href="${path}"`);
  expect(html).not.toContain("13歳");
  expect(html).not.toContain("KOKO");
});
