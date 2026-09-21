import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import YAML from "yaml";
import {
  assertPublishable,
  assertTransition,
  ContractError,
  deliveryKey,
  errors,
  hasPermission,
  isAfterCursor,
  maxPublishedVideoSeconds,
  moderationEngines,
  originalKey,
  postStates,
  reportEffect,
  resolveModeration,
  transitions,
  videoTrimTargetsSeconds,
} from "../dist/index.js";

const event = "11111111-1111-4111-8111-111111111111";
const post = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
const spec = YAML.parse(
  await readFile(new URL("../openapi.yaml", import.meta.url), "utf8"),
  { maxAliasCount: 10000, merge: true },
);
const contractError = (code) => (error) =>
  error instanceof ContractError && error.code === code;

test("OpenAPI・状態契約・エラーコードの正本が一致する", () => {
  assert.deepEqual(spec.components.schemas.State.enum, [...postStates]);
  assert.deepEqual(
    spec.components.schemas.ApiError.properties.code.enum.sort(),
    Object.entries(errors)
      .filter(([, value]) => value.status !== 0)
      .map(([code]) => code)
      .sort(),
  );
  for (const error of Object.values(errors))
    assert.ok(error.message.length > 0);
});

test("全APIに認証・実装時期・イベント境界・一意なoperationIdがある", () => {
  const ids = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    assert.ok(
      item.parameters.some(
        (param) =>
          param.name === "event_id" ||
          param.$ref === "#/components/parameters/EventId",
      ),
      path,
    );
    for (const method of ["get", "post", "patch", "put", "delete"]) {
      const operation = item[method];
      if (!operation) continue;
      assert.ok(!ids.has(operation.operationId), operation.operationId);
      ids.add(operation.operationId);
      assert.ok((operation.security ?? spec.security).length > 0, path);
      assert.ok(operation["x-stage"] >= 1 && operation["x-stage"] <= 5, path);
      assert.ok(operation.responses.default, path);
    }
  }
  assert.ok(ids.size >= 35);
});

test("配信URLはゲートの相対パスだけで、一般feedに原本・メール・個人のlikedはない", () => {
  const properties = spec.components.schemas.PublicPost.properties;
  for (const field of [
    "original_url",
    "object_key",
    "stream_uid",
    "email",
    "user_id",
    "liked",
    "is_banned",
  ])
    assert.ok(!(field in properties), field);
  for (const key of ["webp_600", "jpg_600", "webp_1600", "jpg_1600"]) {
    const pattern = new RegExp(
      spec.components.schemas.PhotoDelivery.properties[key].pattern,
    );
    assert.equal(pattern.test(`/media/${event}/${post}/600.webp`), true);
    assert.equal(pattern.test("https://public.example/image.webp"), false);
    assert.equal(
      pattern.test(`/media/${event}/${post}/600.webp?token=secret`),
      false,
    );
  }
  assert.ok(spec.components.securitySchemes.sessionCookie);
});

test("型生成後の状態遷移は許可した辺だけを受け付け、deletedから復帰しない", () => {
  for (const from of postStates) {
    for (const to of postStates) {
      if (transitions[from].includes(to))
        assert.doesNotThrow(() => assertTransition(from, to));
      else
        assert.throws(
          () => assertTransition(from, to),
          contractError("STATE_CONFLICT"),
        );
    }
  }
  assert.deepEqual(transitions.deleted, []);
  assert.throws(
    () => assertTransition("blocked", "published"),
    contractError("STATE_CONFLICT"),
  );
});

test("モデレーションはBLOCK優先・欠落/重複/ERROR時に閉じる", () => {
  const pass = moderationEngines.map((engine) => ({
    engine,
    decision: "PASS",
  }));
  assert.equal(resolveModeration(pass), "PASS");
  assert.equal(
    resolveModeration([
      ...pass.slice(0, 2),
      { engine: "ocr", decision: "FLAG" },
    ]),
    "FLAG",
  );
  assert.equal(
    resolveModeration([
      ...pass.slice(0, 2),
      { engine: "ocr", decision: "ERROR" },
    ]),
    "HELD",
  );
  assert.equal(resolveModeration(pass.slice(0, 2)), "HELD");
  assert.equal(resolveModeration([pass[0], pass[0], pass[2]]), "HELD");
  assert.equal(
    resolveModeration([
      { engine: "openai", decision: "BLOCK" },
      { engine: "ocr", decision: "ERROR" },
    ]),
    "BLOCK",
  );
  assert.equal(resolveModeration([]), "HELD");
});

test("未準備・BAN・公開停止・4秒超・未計測動画は公開不可", () => {
  const base = {
    banned: false,
    publicationStopped: false,
    mediaReady: true,
    kind: "video",
    measuredDurationSeconds: 3.8,
    decision: "PASS",
  };
  assert.equal(assertPublishable(base), "published");
  assert.equal(
    assertPublishable({
      ...base,
      decision: "FLAG",
      measuredDurationSeconds: 4,
    }),
    "published_flagged",
  );
  for (const value of [4.0001, 0, -1, NaN, Infinity, undefined])
    assert.throws(
      () => assertPublishable({ ...base, measuredDurationSeconds: value }),
      contractError("VIDEO_TOO_LONG"),
    );
  assert.throws(
    () => assertPublishable({ ...base, banned: true }),
    contractError("ACCOUNT_BANNED"),
  );
  assert.throws(
    () => assertPublishable({ ...base, publicationStopped: true }),
    contractError("PUBLICATION_STOPPED"),
  );
  assert.throws(
    () => assertPublishable({ ...base, mediaReady: false }),
    contractError("PROCESSING_HELD"),
  );
  assert.throws(
    () => assertPublishable({ ...base, decision: "BLOCK" }),
    contractError("CONTENT_BLOCKED"),
  );
  assert.throws(
    () => assertPublishable({ ...base, decision: "HELD" }),
    contractError("PROCESSING_HELD"),
  );
});

test("通報1件で非表示、2件目で追加通知", () => {
  assert.deepEqual(reportEffect(1), {
    hide: true,
    notify: true,
    escalate: false,
  });
  assert.deepEqual(reportEffect(2), {
    hide: true,
    notify: true,
    escalate: true,
  });
  assert.equal(reportEffect(3).escalate, false);
  assert.throws(() => reportEffect(0), contractError("INVALID_INPUT"));
});

test("短縮目標3.8/3.5/3.0秒と公開上限4秒を混同しない", () => {
  assert.deepEqual(videoTrimTargetsSeconds, [3.8, 3.5, 3.0]);
  assert.equal(Object.isFrozen(videoTrimTargetsSeconds), true);
  assert.equal(maxPublishedVideoSeconds, 4);
  assert.equal(
    spec.components.schemas.VideoDelivery.properties.duration_seconds.maximum,
    maxPublishedVideoSeconds,
  );
  for (const duration of [...videoTrimTargetsSeconds, 2.5, 4]) {
    assert.equal(
      assertPublishable({
        banned: false,
        publicationStopped: false,
        mediaReady: true,
        kind: "video",
        measuredDurationSeconds: duration,
        decision: "PASS",
      }),
      "published",
    );
  }
});

test("moderatorにBAN・設定・テーマ編集・export権限を渡さない", () => {
  for (const permission of ["ban", "settings", "themes", "export"]) {
    assert.equal(hasPermission("moderator", permission), false);
    assert.equal(hasPermission("admin", permission), true);
  }
  assert.equal(hasPermission("moderator", "hide"), true);
  assert.equal(hasPermission("user", "hide"), false);
});

test("原本・派生物のキーはUUIDに限定しユーザーファイル名やURLを受け付けない", () => {
  assert.equal(
    originalKey(event, post, asset),
    `events/${event}/posts/${post}/original/${asset}.bin`,
  );
  assert.equal(
    deliveryKey(event, asset, "600", "webp"),
    `events/${event}/delivery/${asset}/600.webp`,
  );
  for (const invalid of [
    "../secret",
    "https://example.com",
    "person.jpg",
    "",
    event + "/",
  ])
    assert.throws(
      () => originalKey(invalid, post, asset),
      contractError("INVALID_INPUT"),
    );
  assert.throws(
    () => deliveryKey(event, asset, "raw", "webp"),
    contractError("INVALID_INPUT"),
  );
});

test("同一時刻のキーセットはIDで安定し、OFFSETを必要としない", () => {
  const cursor = { createdAt: "2026-10-10T00:00:00Z", id: post };
  assert.equal(isAfterCursor({ ...cursor, id: event }, cursor), true);
  assert.equal(isAfterCursor(cursor, cursor), false);
  assert.equal(
    isAfterCursor({ ...cursor, createdAt: "2026-10-09T23:59:59Z" }, cursor),
    true,
  );
  assert.throws(
    () => isAfterCursor({ ...cursor, createdAt: "bad" }, cursor),
    contractError("INVALID_CURSOR"),
  );
});

test("初期トークンの主要な文字色のコントラストを検査", async () => {
  const css = await readFile(
    new URL("../../../apps/web/src/styles/tokens.css", import.meta.url),
    "utf8",
  );
  const colors = Object.fromEntries(
    [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const luminance = (hex) => {
    const channels = [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const [foreground, background] of [
    ["text", "background"],
    ["text-muted", "surface"],
    ["on-primary", "primary"],
    ["danger", "surface"],
    ["warning", "surface"],
    ["success", "surface"],
  ]) {
    const values = [
      luminance(colors[foreground]),
      luminance(colors[background]),
    ].sort((a, b) => b - a);
    assert.ok(
      (values[0] + 0.05) / (values[1] + 0.05) >= 4.5,
      `${foreground}/${background}`,
    );
  }
});

test("未知の判定をPASSとして扱わない", () => {
  const results = moderationEngines.map((engine) => ({
    engine,
    decision: engine === "ocr" ? "UNKNOWN" : "PASS",
  }));
  assert.equal(resolveModeration(results), "HELD");
  assert.throws(
    () =>
      assertPublishable({
        banned: false,
        publicationStopped: false,
        mediaReady: true,
        kind: "photo",
        decision: "UNKNOWN",
      }),
    contractError("PROCESSING_HELD"),
  );
});

test("キーセットはPostgreSQLのマイクロ秒精度とタイムゾーンを保持する", () => {
  const cursor = { createdAt: "2026-10-10T00:00:00.001500Z", id: event };
  assert.equal(
    isAfterCursor(
      { createdAt: "2026-10-10T00:00:00.001499Z", id: post },
      cursor,
    ),
    true,
  );
  assert.equal(
    isAfterCursor(
      { createdAt: "2026-10-10T09:00:00.001500+09:00", id: event },
      cursor,
    ),
    false,
  );
  assert.equal(
    isAfterCursor(
      { createdAt: "2026-10-10T00:00:00.001501Z", id: post },
      cursor,
    ),
    false,
  );
});
