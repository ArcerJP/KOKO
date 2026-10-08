import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateModerationCostUsd,
  snapshotModerationCostRates,
} from "../dist/moderation-cost.js";
import { costRates } from "./moderation-fixture.mjs";
const usage = { openaiRequests: 1, safeSearchImages: 1, ocrImages: 1 };
test("unknown rates and known zero are different; snapshots are canonical and immutable", () => {
  assert.equal(estimateModerationCostUsd(undefined, usage), null);
  const input = costRates(),
    card = snapshotModerationCostRates(input);
  input.microUsdPerUnit.ocrImages = 0;
  assert.equal(card.microUsdPerUnit.ocrImages, 1500);
  assert.ok(
    Object.isFrozen(card) &&
      Object.isFrozen(card.microUsdPerUnit) &&
      Object.isFrozen(card.sources),
  );
  assert.equal(estimateModerationCostUsd(card, usage), 0.003);
  assert.equal(
    estimateModerationCostUsd(card, {
      ...usage,
      safeSearchImages: 0,
      ocrImages: 0,
    }),
    0,
  );
  const unknown = costRates();
  unknown.microUsdPerUnit.ocrImages = null;
  assert.equal(estimateModerationCostUsd(unknown, usage), null);
  assert.equal(
    estimateModerationCostUsd(unknown, { ...usage, ocrImages: 0 }),
    0.0015,
  );
  assert.equal(
    estimateModerationCostUsd(unknown, {
      openaiRequests: 0,
      safeSearchImages: 0,
      ocrImages: 0,
    }),
    0,
  );
  const reordered = Object.fromEntries(Object.entries(card).reverse());
  assert.equal(
    JSON.stringify(snapshotModerationCostRates(reordered)),
    JSON.stringify(card),
  );
});
test("integer microUSD arithmetic keeps six decimal precision and bounded totals", () => {
  const card = costRates();
  card.microUsdPerUnit = {
    openaiRequests: 1,
    safeSearchImages: 2,
    ocrImages: 3,
  };
  assert.equal(estimateModerationCostUsd(card, usage), 0.000006);
  card.microUsdPerUnit = {
    openaiRequests: 1e9,
    safeSearchImages: 1e9,
    ocrImages: 1e9,
  };
  assert.equal(estimateModerationCostUsd(card, usage), 3000);
});
for (const [name, change] of [
  ["missing", (x) => delete x.version],
  ["extra", (x) => (x.secret = "do-not-log")],
  ["zero version", (x) => (x.version = 0)],
  ["fraction version", (x) => (x.version = 1.5)],
  ["overflow version", (x) => (x.version = 2147483648)],
  ["currency", (x) => (x.currency = "JPY")],
  ["bill claim", (x) => (x.basis = "actual_invoice")],
  ["date normalized", (x) => (x.verifiedOn = "2026-02-30")],
  ["bad date", (x) => (x.validUntil = "2026-13-02")],
  ["date type", (x) => (x.verifiedOn = 20261006)],
  ["no expiry", (x) => delete x.validUntil],
  ["inverted", (x) => (x.validUntil = x.verifiedOn)],
  ["long validity", (x) => (x.validUntil = "2028-10-06")],
  ["source URL", (x) => (x.sources.vision += "?secret=value")],
  ["source spoof", (x) => (x.sources.openai = "https://evil.test")],
  ["partial source", (x) => delete x.sources.openai],
  ["partial rate", (x) => delete x.microUsdPerUnit.openaiRequests],
  ["new unit", (x) => (x.microUsdPerUnit.tokens = 1)],
  ["negative", (x) => (x.microUsdPerUnit.ocrImages = -1)],
  ["fraction", (x) => (x.microUsdPerUnit.ocrImages = 0.1)],
  ["huge", (x) => (x.microUsdPerUnit.ocrImages = 1e9 + 1)],
  ["NaN", (x) => (x.microUsdPerUnit.ocrImages = NaN)],
  ["infinity", (x) => (x.microUsdPerUnit.ocrImages = Infinity)],
  ["numeric string", (x) => (x.microUsdPerUnit.ocrImages = "1500")],
])
  test(`invalid cost rates ${name} reject`, () => {
    const card = costRates();
    change(card);
    assert.throws(
      () => snapshotModerationCostRates(card),
      /INVALID_MODERATION_COST_RATES/,
    );
  });
for (const invalid of [
  null,
  {},
  { ...usage, ocrImages: 2 },
  { ...usage, openaiRequests: -1 },
  { ...usage, ocrImages: 0.5 },
  { ...usage, ocrImages: "1" },
  { ...usage, secret: 1 },
])
  test("invalid attempted usage is never estimated", () =>
    assert.throws(
      () => estimateModerationCostUsd(costRates(), invalid),
      /INVALID_MODERATION_COST_USAGE/,
    ));
