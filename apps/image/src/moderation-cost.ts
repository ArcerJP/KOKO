/** Service-supplied, claim-time rate snapshot. Never a provider bill or a spending limit. */
export type ModerationCostRates = Readonly<{
  version: number;
  currency: "USD";
  basis: "request_list_price_excluding_free_tiers_discounts_tax";
  verifiedOn: string;
  validUntil: string;
  sources: Readonly<{ openai: string; vision: string }>;
  microUsdPerUnit: Readonly<{
    openaiRequests: number | null;
    safeSearchImages: number | null;
    ocrImages: number | null;
  }>;
}>;
type Usage = {
  openaiRequests: number;
  safeSearchImages: number;
  ocrImages: number;
};
const units = ["openaiRequests", "safeSearchImages", "ocrImages"] as const;
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: object, keys: readonly string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function snapshotModerationCostRates(
  input: unknown,
): ModerationCostRates {
  const fail = (): never => {
    throw new Error("INVALID_MODERATION_COST_RATES");
  };
  let x: unknown;
  try {
    x = structuredClone(input);
  } catch {
    return fail();
  }
  if (
    !record(x) ||
    !exact(x, [
      "version",
      "currency",
      "basis",
      "verifiedOn",
      "validUntil",
      "sources",
      "microUsdPerUnit",
    ]) ||
    !Number.isSafeInteger(x.version) ||
    Number(x.version) < 1 ||
    Number(x.version) > 2147483647 ||
    x.currency !== "USD" ||
    x.basis !== "request_list_price_excluding_free_tiers_discounts_tax" ||
    !date(x.verifiedOn) ||
    !date(x.validUntil) ||
    x.verifiedOn >= x.validUntil ||
    Date.parse(x.validUntil) - Date.parse(x.verifiedOn) > 366 * 86400000 ||
    !record(x.sources) ||
    !exact(x.sources, ["openai", "vision"]) ||
    x.sources.openai !==
      "https://developers.openai.com/api/docs/guides/moderation" ||
    x.sources.vision !== "https://cloud.google.com/vision/pricing" ||
    !record(x.microUsdPerUnit) ||
    !exact(x.microUsdPerUnit, units) ||
    Object.values(x.microUsdPerUnit).some(
      (n) =>
        n !== null &&
        (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 1000000000),
    )
  )
    return fail();
  const r = x as ModerationCostRates;
  // Canonical property order also permits comparison of semantically equal RPC snapshots.
  return Object.freeze({
    version: r.version,
    currency: r.currency,
    basis: r.basis,
    verifiedOn: r.verifiedOn,
    validUntil: r.validUntil,
    sources: Object.freeze({
      openai: r.sources.openai,
      vision: r.sources.vision,
    }),
    microUsdPerUnit: Object.freeze({
      openaiRequests: r.microUsdPerUnit.openaiRequests,
      safeSearchImages: r.microUsdPerUnit.safeSearchImages,
      ocrImages: r.microUsdPerUnit.ocrImages,
    }),
  });
}
/** HTTP attempts × configured rate, including retries/ambiguous requests; not billed units. */
export function estimateModerationCostUsd(
  rates: ModerationCostRates | undefined,
  usage: Usage,
): number | null {
  if (
    !record(usage) ||
    !exact(usage, units) ||
    units.some((k) => usage[k] !== 0 && usage[k] !== 1)
  )
    throw new Error("INVALID_MODERATION_COST_USAGE");
  if (!rates) return null;
  const card = snapshotModerationCostRates(rates);
  let micros = 0;
  for (const k of units) {
    if (usage[k] === 0) continue;
    const rate = card.microUsdPerUnit[k];
    if (rate === null) return null;
    micros += rate;
  }
  return micros / 1000000;
}
