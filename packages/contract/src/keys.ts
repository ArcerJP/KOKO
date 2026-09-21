import { ContractError } from "./errors.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string): string {
  if (!uuidPattern.test(value)) throw new ContractError("INVALID_INPUT");
  return value.toLowerCase();
}

/** クライアント由来のファイル名・パスを使用しない。MIMEは別メタデータで保持。 */
export function originalKey(
  eventId: string,
  postId: string,
  assetId: string,
): string {
  return `events/${uuid(eventId)}/posts/${uuid(postId)}/original/${uuid(assetId)}.bin`;
}

export function deliveryKey(
  eventId: string,
  assetId: string,
  variant: "600" | "1600",
  format: "webp" | "jpg",
): string {
  if (!["600", "1600"].includes(variant) || !["webp", "jpg"].includes(format)) {
    throw new ContractError("INVALID_INPUT");
  }
  return `events/${uuid(eventId)}/delivery/${uuid(assetId)}/${variant}.${format}`;
}
