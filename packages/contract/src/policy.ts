import { ContractError } from "./errors.js";

/** 公開上限とトリム目標は別。短縮しても実出力の再計測を省略しない。 */
export const maxPublishedVideoSeconds = 4;
export const videoTrimTargetsSeconds = Object.freeze([3.8, 3.5, 3.0] as const);

export const postStates = [
  "uploading",
  "upload_failed",
  "uploaded",
  "processing",
  "published",
  "published_flagged",
  "blocked",
  "held",
  "hidden",
  "deleted",
] as const;
export type PostState = (typeof postStates)[number];
export type PublicState = Extract<PostState, "published" | "published_flagged">;
export const transitions: Readonly<Record<PostState, readonly PostState[]>> = {
  uploading: ["uploaded", "upload_failed", "deleted"],
  upload_failed: ["uploading", "deleted"],
  uploaded: ["processing", "held", "deleted"],
  processing: ["published", "published_flagged", "blocked", "held", "deleted"],
  published: ["hidden", "deleted"],
  published_flagged: ["hidden", "deleted"],
  blocked: ["processing", "deleted"],
  held: ["processing", "deleted"],
  hidden: ["published", "published_flagged", "deleted"],
  deleted: [],
};

export const moderationEngines = ["openai", "safesearch", "ocr"] as const;
export type ModerationDecision = "PASS" | "FLAG" | "BLOCK" | "ERROR";
export interface EngineResult {
  engine: (typeof moderationEngines)[number];
  decision: ModerationDecision;
}

/** BLOCK優先。必須エンジンの欠落・重複・エラーをPASSへ倒さない。 */
export function resolveModeration(
  results: readonly EngineResult[],
): "PASS" | "FLAG" | "BLOCK" | "HELD" {
  if (results.some((result) => result.decision === "BLOCK")) return "BLOCK";
  if (
    results.length !== moderationEngines.length ||
    moderationEngines.some(
      (engine) =>
        results.filter((result) => result.engine === engine).length !== 1,
    )
  )
    return "HELD";
  if (results.some((result) => !["PASS", "FLAG"].includes(result.decision)))
    return "HELD";
  return results.some((result) => result.decision === "FLAG") ? "FLAG" : "PASS";
}

export interface PublicationGuard {
  banned: boolean;
  publicationStopped: boolean;
  mediaReady: boolean;
  kind: "photo" | "video";
  measuredDurationSeconds?: number;
  decision: ReturnType<typeof resolveModeration>;
}

export function assertPublishable(guard: PublicationGuard): PublicState {
  if (guard.banned) throw new ContractError("ACCOUNT_BANNED");
  if (guard.publicationStopped) throw new ContractError("PUBLICATION_STOPPED");
  if (guard.decision === "BLOCK") throw new ContractError("CONTENT_BLOCKED");
  if (!guard.mediaReady || !["PASS", "FLAG"].includes(guard.decision))
    throw new ContractError("PROCESSING_HELD");
  if (!["photo", "video"].includes(guard.kind))
    throw new ContractError("UNSUPPORTED_MEDIA");
  if (
    guard.kind === "video" &&
    (!Number.isFinite(guard.measuredDurationSeconds) ||
      (guard.measuredDurationSeconds ?? 0) <= 0 ||
      (guard.measuredDurationSeconds ?? Infinity) > maxPublishedVideoSeconds)
  )
    throw new ContractError("VIDEO_TOO_LONG");
  return guard.decision === "FLAG" ? "published_flagged" : "published";
}

export function assertTransition(from: PostState, to: PostState): void {
  if (!transitions[from].includes(to))
    throw new ContractError("STATE_CONFLICT");
}

/** 1件目で非表示。本人による重複通報はDBのUNIQUEで増えない。 */
export function reportEffect(uniqueReports: number): {
  hide: boolean;
  notify: boolean;
  escalate: boolean;
} {
  if (!Number.isInteger(uniqueReports) || uniqueReports < 1)
    throw new ContractError("INVALID_INPUT");
  return { hide: true, notify: true, escalate: uniqueReports === 2 };
}

export type Role = "user" | "moderator" | "admin";
export type Permission =
  | "review"
  | "hide"
  | "restore"
  | "delete"
  | "ban"
  | "settings"
  | "themes"
  | "export";
const permissions: Record<Role, readonly Permission[]> = {
  user: [],
  moderator: ["review", "hide", "restore", "delete"],
  admin: [
    "review",
    "hide",
    "restore",
    "delete",
    "ban",
    "settings",
    "themes",
    "export",
  ],
};
export function hasPermission(role: Role, permission: Permission): boolean {
  return permissions[role].includes(permission);
}

/** 日付+IDの降順キーセット。APIは不透明化し、イベント・フィルター条件も署名へ含める。 */
export interface CursorPosition {
  createdAt: string;
  id: string;
}

function timestampMicros(value: string): bigint {
  const match =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds))
    throw new ContractError("INVALID_CURSOR");
  // Date.parseはmsまで。Postgresの残る3桁を捨てるとページ境界で欠落する。
  const remainder = (match[1] ?? "").padEnd(6, "0").slice(3);
  return BigInt(milliseconds) * 1000n + BigInt(remainder);
}
export function isAfterCursor(
  item: CursorPosition,
  cursor: CursorPosition,
): boolean {
  const itemTime = timestampMicros(item.createdAt);
  const cursorTime = timestampMicros(cursor.createdAt);
  return (
    itemTime < cursorTime ||
    (itemTime === cursorTime && item.id.toLowerCase() < cursor.id.toLowerCase())
  );
}
