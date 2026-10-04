import { isAfterCursor, type CursorPosition } from "@koko/contract";
import { uuid } from "./api-context";

export class OwnPostsError extends Error {
  constructor(public readonly code: "INVALID_CURSOR" | "INTERNAL_ERROR") {
    super(code);
  }
}
type Scope = { eventId: string; userId: string; limit: number };
const lifetimeSeconds = 15 * 60;
const purpose = "koko.own-posts.v1:created_at.desc,id.desc";
const utf8 = new TextEncoder();
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new OwnPostsError("INVALID_CURSOR");
  const result = Uint8Array.from(
    atob(
      text.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (text.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
  if (encode(result) !== text) throw new OwnPostsError("INVALID_CURSOR");
  return result;
}
export function ownPostsCursorKey(secret: string | undefined) {
  if (!/^[0-9a-f]{64}$/i.test(secret ?? ""))
    throw new OwnPostsError("INTERNAL_ERROR");
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret!.match(/../g)!, (x) => parseInt(x, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export function validPosition(position: CursorPosition) {
  if (!uuid.test(position.id) || typeof position.createdAt !== "string")
    return false;
  try {
    // Reuse contract precision validation; do not round Postgres microseconds.
    isAfterCursor(position, position);
    return true;
  } catch {
    return false;
  }
}
export async function signOwnPostsCursor(
  key: CryptoKey,
  scope: Scope,
  position: CursorPosition,
  now = Date.now(),
) {
  if (!validPosition(position)) throw new OwnPostsError("INTERNAL_ERROR");
  const payload = encode(
    utf8.encode(
      JSON.stringify([
        purpose,
        scope.eventId,
        scope.userId,
        scope.limit,
        position.createdAt,
        position.id,
        Math.floor(now / 1000) + lifetimeSeconds,
      ]),
    ),
  );
  const mac = await crypto.subtle.sign("HMAC", key, utf8.encode(payload));
  return `${payload}.${encode(new Uint8Array(mac))}`;
}
export async function readOwnPostsCursor(
  value: string,
  key: CryptoKey,
  scope: Scope,
  now = Date.now(),
): Promise<CursorPosition> {
  try {
    if (!value || value.length > 1024) throw new Error();
    const pieces = value.split(".");
    if (pieces.length !== 2) throw new Error();
    const [payload, mac] = pieces as [string, string];
    const signature = decode(mac);
    if (
      signature.length !== 32 ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        utf8.encode(payload),
      ))
    )
      throw new Error();
    const parts: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        decode(payload),
      ),
    );
    if (
      !Array.isArray(parts) ||
      parts.length !== 7 ||
      parts[0] !== purpose ||
      parts[1] !== scope.eventId ||
      parts[2] !== scope.userId ||
      parts[3] !== scope.limit ||
      typeof parts[4] !== "string" ||
      typeof parts[5] !== "string" ||
      !Number.isSafeInteger(parts[6]) ||
      parts[6] <= Math.floor(now / 1000) ||
      parts[6] > Math.floor(now / 1000) + lifetimeSeconds
    )
      throw new Error();
    const position = { createdAt: parts[4], id: parts[5] };
    if (!validPosition(position)) throw new Error();
    return position;
  } catch {
    throw new OwnPostsError("INVALID_CURSOR");
  }
}
