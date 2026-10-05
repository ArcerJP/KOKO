import type { components } from "@koko/contract/api";
import { ApiFailure } from "./client";
import { record, validId } from "./upload-contract";
import { parseOwnPost } from "./own-posts-contract";

export type Theme = components["schemas"]["Theme"];
export type ThemeInput = components["schemas"]["ThemeInput"];
export type Settings = components["schemas"]["Settings"];
export type Appeal = components["schemas"]["Appeal"];
export type AdminPost = components["schemas"]["AdminPostPage"]["items"][number];
export type OperationName =
  | "themes"
  | "adminThemes"
  | "adminFeed"
  | "appeals"
  | "settings"
  | "report"
  | "appeal"
  | "deleteOwn"
  | "hide"
  | "restore"
  | "deletePost"
  | "retry"
  | "reassignTheme"
  | "ban"
  | "unban"
  | "createTheme"
  | "updateTheme"
  | "deleteTheme"
  | "resolveAppeal"
  | "updateSettings";
export type Operation = { name: OperationName; id?: string; cursor?: string };
export type OperationResponse =
  | { kind: "themes"; items: Theme[] }
  | { kind: "posts"; items: AdminPost[]; next_cursor: string | null }
  | { kind: "appeals"; items: Appeal[]; next_cursor: string | null }
  | { kind: "settings"; settings: Settings }
  | { kind: "ack"; request_id: string; resource_id?: string };
const invalid = (output = false): never => {
  throw new ApiFailure(output ? "INTERNAL_ERROR" : "INVALID_INPUT");
};
const text = (x: unknown, min: number, max: number): x is string =>
  typeof x === "string" &&
  [...x].length >= min &&
  [...x].length <= max &&
  (min === 0 || x.trim().length > 0);
const integer = (x: unknown, min = 1): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= min;
const date = (x: unknown): x is string =>
  typeof x === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(x) &&
  Number.isFinite(Date.parse(x));
const keys = (
  x: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((k) => Object.hasOwn(x, k)) &&
  Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
const cursor = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x) &&
  x.length <= 1500;

export function operationRoute(op: Operation) {
  if (!record(op) || !keys(op, ["name"], ["id", "cursor"])) return invalid();
  const routes: Record<OperationName, [string, string, boolean]> = {
    themes: ["themes", "GET", false],
    adminThemes: ["admin/themes", "GET", false],
    adminFeed: ["admin/feed", "GET", false],
    appeals: ["admin/appeals", "GET", false],
    settings: ["admin/settings", "GET", false],
    report: ["posts/:id/reports", "POST", true],
    appeal: ["appeals", "POST", false],
    deleteOwn: ["posts/:id", "DELETE", true],
    hide: ["admin/posts/:id/hide", "POST", true],
    restore: ["admin/posts/:id/restore", "POST", true],
    deletePost: ["admin/posts/:id/delete", "POST", true],
    retry: ["admin/posts/:id/retry", "POST", true],
    reassignTheme: ["admin/posts/:id/theme", "PATCH", true],
    ban: ["admin/users/:id/ban", "POST", true],
    unban: ["admin/users/:id/unban", "POST", true],
    createTheme: ["admin/themes", "POST", false],
    updateTheme: ["admin/themes/:id", "PUT", true],
    deleteTheme: ["admin/themes/:id", "DELETE", true],
    resolveAppeal: ["admin/appeals/:id", "PATCH", true],
    updateSettings: ["admin/settings", "PUT", false],
  };
  if (!Object.hasOwn(routes, op.name)) return invalid();
  const [pattern, method, needsId] = routes[op.name];
  if (needsId ? !validId(op.id) : op.id !== undefined) return invalid();
  if (
    op.cursor !== undefined &&
    (!["adminFeed", "appeals"].includes(op.name) || !cursor(op.cursor))
  )
    return invalid();
  const path = pattern.replace(":id", op.id?.toLowerCase() ?? "");
  const search = ["adminFeed", "appeals"].includes(op.name)
    ? `?limit=30${op.cursor ? `&cursor=${encodeURIComponent(op.cursor)}` : ""}`
    : "";
  return { path, search, method, mutation: method !== "GET" };
}

function themeFields(x: Record<string, unknown>): ThemeInput {
  if (
    !keys(x, [
      "title",
      "description",
      "icon",
      "color",
      "status",
      "starts_at",
      "ends_at",
    ]) ||
    !text(x.title, 1, 100) ||
    !text(x.description, 0, 2000) ||
    !text(x.icon, 0, 50) ||
    typeof x.color !== "string" ||
    !/^#[a-fA-F0-9]{6}$/.test(x.color) ||
    !["draft", "published", "ended"].includes(String(x.status)) ||
    !date(x.starts_at) ||
    !date(x.ends_at) ||
    Date.parse(x.starts_at) >= Date.parse(x.ends_at)
  )
    return invalid();
  return {
    title: x.title,
    description: x.description,
    icon: x.icon,
    color: x.color,
    status: x.status as ThemeInput["status"],
    starts_at: x.starts_at,
    ends_at: x.ends_at,
  };
}
function settingsFields(x: Record<string, unknown>): Settings {
  if (
    !keys(x, [
      "version",
      "publication_stopped",
      "uploads_enabled",
      "moderation_concurrency",
      "thresholds",
    ]) ||
    !integer(x.version) ||
    typeof x.publication_stopped !== "boolean" ||
    typeof x.uploads_enabled !== "boolean" ||
    !integer(x.moderation_concurrency) ||
    !Array.isArray(x.thresholds) ||
    x.thresholds.length > 100
  )
    return invalid();
  const seen = new Set<string>();
  const thresholds = x.thresholds.map((t) => {
    if (
      !record(t) ||
      !keys(t, ["engine", "category", "flag", "block", "immediate_ban"]) ||
      !["openai", "safesearch", "ocr"].includes(String(t.engine)) ||
      !text(t.category, 1, 100) ||
      typeof t.flag !== "number" ||
      typeof t.block !== "number" ||
      !Number.isFinite(t.flag) ||
      !Number.isFinite(t.block) ||
      t.flag < 0 ||
      t.flag > t.block ||
      t.block > 1 ||
      typeof t.immediate_ban !== "boolean"
    )
      return invalid();
    const key = `${t.engine}:${t.category}`;
    if (seen.has(key)) return invalid();
    seen.add(key);
    return {
      engine: t.engine as "openai" | "safesearch" | "ocr",
      category: t.category,
      flag: t.flag,
      block: t.block,
      immediate_ban: t.immediate_ban,
    };
  });
  return {
    version: x.version,
    publication_stopped: x.publication_stopped,
    uploads_enabled: x.uploads_enabled,
    moderation_concurrency: x.moderation_concurrency,
    thresholds,
  };
}

export function operationInput(
  op: Operation,
  input: unknown,
): Record<string, unknown> {
  operationRoute(op);
  if (!record(input)) return invalid();
  const action = () =>
    integer(input.expected_version) && text(input.reason, 1, 1000);
  let ok = false;
  switch (op.name) {
    case "hide":
    case "restore":
    case "deletePost":
    case "retry":
      ok = keys(input, ["expected_version", "reason"]) && action();
      break;
    case "reassignTheme":
      ok =
        keys(input, ["expected_version", "reason", "theme_id"]) &&
        action() &&
        (input.theme_id === null || validId(input.theme_id));
      break;
    case "ban":
    case "unban":
      ok = keys(input, ["reason"]) && text(input.reason, 1, 1000);
      break;
    case "report":
      ok =
        keys(input, ["reason"], ["detail"]) &&
        ["privacy", "sexual", "violence", "harassment", "other"].includes(
          String(input.reason),
        ) &&
        (input.detail === undefined || text(input.detail, 0, 1000));
      break;
    case "appeal":
      ok =
        keys(input, ["message"], ["post_id"]) &&
        text(input.message, 1, 2000) &&
        (input.post_id == null || validId(input.post_id));
      break;
    case "resolveAppeal":
      ok =
        keys(input, ["status", "reason"]) &&
        ["resolved", "rejected"].includes(String(input.status)) &&
        text(input.reason, 1, 1000);
      break;
    case "createTheme":
    case "updateTheme":
      return themeFields(input);
    case "updateSettings":
      return settingsFields(input);
    case "deleteOwn":
    case "deleteTheme":
      ok = Object.keys(input).length === 0;
      break;
    default:
      return invalid();
  }
  if (!ok) return invalid();
  // Validators allow only the specific scalar input keys, never opaque objects.
  return { ...input };
}

export function operationResponse(
  op: Operation,
  body: unknown,
  eventId: string,
): OperationResponse {
  try {
    if (!record(body)) return invalid(true);
    if (operationRoute(op).mutation) {
      if (
        !validId(body.request_id) ||
        (body.resource_id !== undefined && !validId(body.resource_id))
      )
        return invalid(true);
      return {
        kind: "ack",
        request_id: body.request_id,
        ...(body.resource_id
          ? { resource_id: body.resource_id as string }
          : {}),
      };
    }
    if (op.name === "settings") {
      if (typeof body.thresholds_approved !== "boolean") return invalid(true);
      const fields = settingsFields(
        Object.fromEntries(
          [
            "version",
            "publication_stopped",
            "uploads_enabled",
            "moderation_concurrency",
            "thresholds",
          ].map((k) => [k, body[k]]),
        ),
      );
      return {
        kind: "settings",
        settings: { ...fields, thresholds_approved: body.thresholds_approved },
      };
    }
    if (
      !Array.isArray(body.items) ||
      body.items.length >
        (op.name === "themes" || op.name === "adminThemes" ? 1000 : 30)
    )
      return invalid(true);
    if (op.name === "themes" || op.name === "adminThemes") {
      const items = body.items.map((x) => {
        if (!record(x) || !validId(x.id) || x.event_id !== eventId)
          return invalid(true);
        const fields = themeFields(
          Object.fromEntries(
            [
              "title",
              "description",
              "icon",
              "color",
              "status",
              "starts_at",
              "ends_at",
            ].map((k) => [k, x[k]]),
          ),
        );
        if (op.name === "themes" && fields.status === "draft")
          return invalid(true);
        return { id: x.id, event_id: eventId, ...fields };
      });
      if (new Set(items.map((x) => x.id)).size !== items.length)
        return invalid(true);
      return { kind: "themes", items };
    }
    if (body.next_cursor !== null && !cursor(body.next_cursor))
      return invalid(true);
    if (op.name === "adminFeed") {
      const items = body.items.map((x) => {
        if (
          !record(x) ||
          !validId(x.user_id) ||
          !integer(x.report_count, 0) ||
          typeof x.is_banned !== "boolean"
        )
          return invalid(true);
        const post = parseOwnPost(x.post, eventId);
        if (!post) return invalid(true);
        // The review gate is optional. Never accept arbitrary preview URLs.
        const prefix = `/media/${eventId}/${post.id}/`;
        if (
          x.preview_url !== undefined &&
          (![`${prefix}review-webp-600`, `${prefix}review-thumbnail`].includes(
            String(x.preview_url),
          ) ||
            x.is_banned ||
            !["published", "published_flagged", "hidden"].includes(post.status))
        )
          return invalid(true);
        return {
          post,
          user_id: x.user_id,
          report_count: x.report_count,
          is_banned: x.is_banned,
          ...(x.preview_url === undefined
            ? {}
            : { preview_url: String(x.preview_url) }),
        };
      });
      if (new Set(items.map((x) => x.post.id)).size !== items.length)
        return invalid(true);
      return {
        kind: "posts",
        items,
        next_cursor: body.next_cursor as string | null,
      };
    }
    const items = body.items.map((x): Appeal => {
      if (
        !record(x) ||
        !validId(x.id) ||
        !validId(x.user_id) ||
        !(x.post_id === null || validId(x.post_id)) ||
        !text(x.message, 1, 2000) ||
        !["open", "resolved", "rejected"].includes(String(x.status)) ||
        !date(x.created_at)
      )
        return invalid(true);
      return {
        id: x.id,
        user_id: x.user_id,
        post_id: x.post_id as string | null,
        message: x.message,
        status: x.status as Appeal["status"],
        created_at: x.created_at,
      };
    });
    if (new Set(items.map((x) => x.id)).size !== items.length)
      return invalid(true);
    return {
      kind: "appeals",
      items,
      next_cursor: body.next_cursor as string | null,
    };
  } catch {
    return invalid(true);
  }
}
