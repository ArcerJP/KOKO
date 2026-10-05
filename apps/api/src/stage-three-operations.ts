import { isAfterCursor, postStates, type ApiErrorCode } from "@koko/contract";
import {
  authenticateApiRequest,
  failure,
  object,
  privateHeaders,
  reply,
  uuid,
  type AccountEnv,
} from "./api-context";
import { ownPostsCursorKey, validPosition } from "./own-post-cursor";
import { projectPostStateDetails } from "./own-posts";

export type StageThreeEnv = AccountEnv & {
  KOKO_STAGE_THREE_ENABLED?: string;
  KOKO_POST_CURSOR_SECRET?: string;
};
type Operation =
  | "themes"
  | "admin_themes"
  | "get_settings"
  | "update_settings"
  | "delete_own"
  | "report"
  | "appeal"
  | "admin_feed"
  | "admin_appeals"
  | "hide"
  | "restore"
  | "delete"
  | "retry"
  | "reassign_theme"
  | "ban"
  | "unban"
  | "create_theme"
  | "update_theme"
  | "delete_theme"
  | "resolve_appeal";
type Route = { operation: Operation; id: string | null; methods: string[] };
type Position = { createdAt: string; id: string; priority: number };
class OperationError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}
const invalid = (): never => {
  throw new OperationError("INVALID_INPUT");
};
const upstreamInvalid = (): never => {
  throw new OperationError("INTERNAL_ERROR");
};
const string = (x: unknown, min: number, max: number): x is string =>
  typeof x === "string" &&
  [...x].length >= min &&
  [...x].length <= max &&
  (min === 0 || x.trim().length > 0);
const integer = (x: unknown, min = 1, max = 2147483647): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
const keys = (
  x: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((k) => Object.hasOwn(x, k)) &&
  Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
const nullableId = (x: unknown) =>
  x === null || (typeof x === "string" && uuid.test(x));
const date = (x: unknown): x is string =>
  typeof x === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
    x,
  ) &&
  Number.isFinite(Date.parse(x));

function route(path: string, method: string): Route | null {
  const fixed: Record<string, Record<string, Operation>> = {
    "/themes": { GET: "themes" },
    "/appeals": { POST: "appeal" },
    "/admin/feed": { GET: "admin_feed" },
    "/admin/appeals": { GET: "admin_appeals" },
    "/admin/settings": { GET: "get_settings", PUT: "update_settings" },
    "/admin/themes": { GET: "admin_themes", POST: "create_theme" },
  };
  let methods = fixed[path],
    id: string | null = null;
  if (!methods) {
    let match = /^\/posts\/([^/]+)(\/reports)?$/.exec(path);
    if (match) {
      id = match[1]!;
      methods = match[2] ? { POST: "report" } : { DELETE: "delete_own" };
    }
    match = /^\/admin\/posts\/([^/]+)\/(hide|restore|delete|theme|retry)$/.exec(
      path,
    );
    if (match) {
      id = match[1]!;
      methods =
        match[2] === "theme"
          ? { PATCH: "reassign_theme" }
          : { POST: match[2] as Operation };
    }
    match = /^\/admin\/users\/([^/]+)\/(ban|unban)$/.exec(path);
    if (match) {
      id = match[1]!;
      methods = { POST: match[2] as Operation };
    }
    match = /^\/admin\/themes\/([^/]+)$/.exec(path);
    if (match) {
      id = match[1]!;
      methods = { PUT: "update_theme", DELETE: "delete_theme" };
    }
    match = /^\/admin\/appeals\/([^/]+)$/.exec(path);
    if (match) {
      id = match[1]!;
      methods = { PATCH: "resolve_appeal" };
    }
  }
  if (!methods) return null;
  if (id !== null && !uuid.test(id)) invalid();
  return {
    operation: methods[method] ?? Object.values(methods)[0]!,
    id: id?.toLowerCase() ?? null,
    methods: Object.keys(methods),
  };
}
function validThresholds(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  const seen = new Set<string>();
  return value.every((t) => {
    if (
      !object(t) ||
      !keys(t, ["engine", "category", "flag", "block", "immediate_ban"]) ||
      !["openai", "safesearch", "ocr"].includes(String(t.engine)) ||
      !string(t.category, 1, 100) ||
      typeof t.flag !== "number" ||
      typeof t.block !== "number" ||
      !Number.isFinite(t.flag) ||
      !Number.isFinite(t.block) ||
      t.flag < 0 ||
      t.flag > t.block ||
      t.block > 1 ||
      typeof t.immediate_ban !== "boolean"
    )
      return false;
    const key = `${t.engine}:${t.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      !t.immediate_ban ||
      (t.engine !== "safesearch" &&
        [
          "sexual/minors",
          "violence/graphic",
          "illicit/violent",
          "hate/threatening",
          "harassment/threatening",
        ].includes(t.category))
    );
  });
}
function validTheme(x: Record<string, unknown>) {
  return (
    keys(x, [
      "title",
      "description",
      "icon",
      "color",
      "status",
      "starts_at",
      "ends_at",
    ]) &&
    string(x.title, 1, 100) &&
    string(x.description, 0, 2000) &&
    string(x.icon, 0, 50) &&
    typeof x.color === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(x.color) &&
    ["draft", "published", "ended"].includes(String(x.status)) &&
    date(x.starts_at) &&
    date(x.ends_at) &&
    Date.parse(x.starts_at) < Date.parse(x.ends_at)
  );
}
function validSettings(x: Record<string, unknown>) {
  return (
    keys(x, [
      "version",
      "publication_stopped",
      "uploads_enabled",
      "moderation_concurrency",
      "thresholds",
    ]) &&
    integer(x.version) &&
    typeof x.publication_stopped === "boolean" &&
    typeof x.uploads_enabled === "boolean" &&
    integer(x.moderation_concurrency) &&
    validThresholds(x.thresholds)
  );
}
function validateInput(op: Operation, x: unknown): Record<string, unknown> {
  if (!object(x)) invalid();
  const body = x as Record<string, unknown>;
  let ok: boolean;
  const action = () =>
    integer(body.expected_version) && string(body.reason, 1, 1000);
  switch (op) {
    case "hide":
    case "restore":
    case "delete":
    case "retry":
      ok = keys(body, ["expected_version", "reason"]) && action();
      break;
    case "reassign_theme":
      ok =
        keys(body, ["expected_version", "reason", "theme_id"]) &&
        action() &&
        nullableId(body.theme_id);
      break;
    case "ban":
    case "unban":
      ok = keys(body, ["reason"]) && string(body.reason, 1, 1000);
      break;
    case "report":
      ok =
        keys(body, ["reason"], ["detail"]) &&
        ["privacy", "sexual", "violence", "harassment", "other"].includes(
          String(body.reason),
        ) &&
        (body.detail === undefined || string(body.detail, 0, 1000));
      break;
    case "appeal":
      ok =
        keys(body, ["message"], ["post_id"]) &&
        string(body.message, 1, 2000) &&
        (body.post_id === undefined || nullableId(body.post_id));
      break;
    case "resolve_appeal":
      ok =
        keys(body, ["status", "reason"]) &&
        ["resolved", "rejected"].includes(String(body.status)) &&
        string(body.reason, 1, 1000);
      break;
    case "create_theme":
    case "update_theme":
      ok = validTheme(body);
      break;
    case "update_settings":
      ok = validSettings(body);
      break;
    default:
      ok = Object.keys(body).length === 0;
  }
  if (!ok) invalid();
  return body;
}
async function bodyText(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  max: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let result = "",
    bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) {
        abort();
        throw new Error("LIMIT");
      }
      result += decoder.decode(next.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
const encode = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
function decode(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error();
  const value = Uint8Array.from(
    atob(
      s.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (s.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
  if (encode(value) !== s) throw new Error();
  return value;
}
async function signCursor(key: CryptoKey, scope: string[], position: Position) {
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify([
        "koko.operations.v1",
        ...scope,
        position.priority,
        position.createdAt,
        position.id,
        Math.floor(Date.now() / 1000) + 900,
      ]),
    ),
  );
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}
async function readCursor(
  value: string,
  key: CryptoKey,
  scope: string[],
): Promise<Position> {
  try {
    if (value.length > 1500) throw new Error();
    const parts = value.split(".");
    if (
      parts.length !== 2 ||
      decode(parts[1]!).length !== 32 ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(parts[1]!),
        new TextEncoder().encode(parts[0]!),
      ))
    )
      throw new Error();
    const p: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        decode(parts[0]!),
      ),
    );
    if (
      !Array.isArray(p) ||
      p.length !== 9 ||
      p[0] !== "koko.operations.v1" ||
      !scope.every((v, i) => p[i + 1] === v) ||
      !integer(p[5], 0, 2) ||
      typeof p[6] !== "string" ||
      typeof p[7] !== "string" ||
      !integer(p[8], 1, Number.MAX_SAFE_INTEGER) ||
      p[8] <= Math.floor(Date.now() / 1000) ||
      p[8] > Math.floor(Date.now() / 1000) + 900
    )
      throw new Error();
    const position = { priority: p[5], createdAt: p[6], id: p[7] };
    if (
      !validPosition(position) ||
      (scope[0] === "admin_appeals" && position.priority !== 0)
    )
      throw new Error();
    return position;
  } catch {
    throw new OperationError("INVALID_CURSOR");
  }
}
function projectTheme(x: unknown, eventId: string) {
  if (
    !object(x) ||
    typeof x.id !== "string" ||
    !uuid.test(x.id) ||
    x.event_id !== eventId
  )
    return upstreamInvalid();
  const fields = {
    title: x.title,
    description: x.description,
    icon: x.icon,
    color: x.color,
    status: x.status,
    starts_at: x.starts_at,
    ends_at: x.ends_at,
  };
  if (!validTheme(fields)) return upstreamInvalid();
  return { id: x.id, event_id: eventId, ...fields };
}
function projectAdminPost(x: unknown, eventId: string) {
  if (
    !object(x) ||
    !object(x.post) ||
    typeof x.user_id !== "string" ||
    !uuid.test(x.user_id) ||
    !integer(x.report_count, 0) ||
    typeof x.is_banned !== "boolean" ||
    !integer(x.priority, 0, 2)
  )
    return upstreamInvalid();
  const p = x.post;
  if (
    typeof p.id !== "string" ||
    !uuid.test(p.id) ||
    p.event_id !== eventId ||
    !postStates.includes(p.status as (typeof postStates)[number]) ||
    !integer(p.version) ||
    !date(p.created_at)
  )
    return upstreamInvalid();
  const expectedPriority =
    x.report_count > 0 ? 2 : p.status === "published_flagged" ? 1 : 0;
  if (expectedPriority !== x.priority) return upstreamInvalid();
  const preview = x.preview_resource;
  if (
    preview !== undefined &&
    preview !== null &&
    (!["review-webp-600", "review-thumbnail"].includes(String(preview)) ||
      !["published", "published_flagged", "hidden"].includes(
        String(p.status),
      ) ||
      x.is_banned)
  )
    return upstreamInvalid();
  return {
    item: {
      post: {
        id: p.id,
        event_id: eventId,
        status: p.status,
        version: p.version,
        created_at: p.created_at,
        ...projectPostStateDetails(p, p.status as (typeof postStates)[number]),
      },
      user_id: x.user_id,
      report_count: x.report_count,
      is_banned: x.is_banned,
      ...(typeof preview === "string"
        ? { preview_url: `/media/${eventId}/${p.id}/${preview}` }
        : {}),
    },
    position: { priority: x.priority, id: p.id, createdAt: p.created_at },
  };
}
function projectAppeal(x: unknown) {
  if (
    !object(x) ||
    typeof x.id !== "string" ||
    !uuid.test(x.id) ||
    typeof x.user_id !== "string" ||
    !uuid.test(x.user_id) ||
    !nullableId(x.post_id) ||
    !string(x.message, 1, 2000) ||
    !["open", "resolved", "rejected"].includes(String(x.status)) ||
    !date(x.created_at)
  )
    return upstreamInvalid();
  return {
    item: {
      id: x.id,
      user_id: x.user_id,
      post_id: x.post_id,
      message: x.message,
      status: x.status,
      created_at: x.created_at,
    },
    position: { priority: 0, id: x.id, createdAt: x.created_at },
  };
}
/** No external provider mutations. Every operation calls an atomic, service-only policy RPC. */
export async function handleStageThreeOperations(
  request: Request,
  env: StageThreeEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.KOKO_STAGE_THREE_ENABLED !== "true") return failure("NOT_FOUND");
  const deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), 10_000);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  try {
    signal.throwIfAborted();
    const url = new URL(request.url),
      found = route(url.pathname, request.method);
    if (!found) return failure("NOT_FOUND");
    if (!found.methods.includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { ...privateHeaders, allow: found.methods.join(", ") },
      });
    const upstream: typeof fetch = async (target, init) => {
      signal.throwIfAborted();
      const response = await fetcher(target, { ...init, signal });
      signal.throwIfAborted();
      if (
        !response.ok ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, {
          status: [400, 401, 403].includes(response.status)
            ? response.status
            : 502,
        });
      }
      return new Response(await bodyText(response.body, signal, 1024 * 1024), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
    const ctx = await authenticateApiRequest(request, env, upstream);
    if (!ctx.ok) return failure(ctx.code);
    const eventId = ctx.eventId.toLowerCase(),
      userId = ctx.userId.toLowerCase(),
      op = found.operation;
    const paged = op === "admin_feed" || op === "admin_appeals";
    if (
      [...url.searchParams.keys()].some(
        (k) =>
          !paged ||
          !["cursor", "limit"].includes(k) ||
          url.searchParams.getAll(k).length !== 1,
      )
    )
      invalid();
    let input: Record<string, unknown> = {},
      before: Position | null = null,
      key: CryptoKey | null = null;
    const rawLimit = url.searchParams.get("limit") ?? "30";
    if (paged && !/^(?:[1-9][0-9]?|100)$/.test(rawLimit)) invalid();
    const limit = Number(rawLimit),
      scope = [op, eventId, userId, rawLimit];
    if (paged) {
      try {
        key = await ownPostsCursorKey(env.KOKO_POST_CURSOR_SECRET);
      } catch {
        upstreamInvalid();
      }
      before = url.searchParams.has("cursor")
        ? await readCursor(url.searchParams.get("cursor")!, key!, scope)
        : null;
      input = {
        limit,
        ...(before
          ? {
              before_at: before.createdAt,
              before_id: before.id,
              before_priority: before.priority,
            }
          : {}),
      };
    }
    if (request.method === "GET" || request.method === "DELETE") {
      if (request.body !== null) invalid();
    } else {
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        ) ||
        request.headers.has("content-encoding")
      )
        invalid();
      try {
        input = validateInput(
          op,
          JSON.parse(await bodyText(request.body, signal, 32768)),
        );
      } catch (err) {
        if (err instanceof OperationError) throw err;
        invalid();
      }
    }
    const requestId = crypto.randomUUID();
    const response = await upstream(
      new URL("/rest/v1/rpc/stage_three_operation", ctx.settings.url),
      {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: {
          apikey: ctx.settings.secretKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_event_id: eventId,
          p_user_id: userId,
          p_operation: op,
          p_target_id: found.id,
          p_input: input,
          p_request_id: requestId,
        }),
      },
    );
    if (response.status !== 200) upstreamInvalid();
    const value: unknown = await response.json();
    if (!object(value)) return upstreamInvalid();
    const known = [
      "FORBIDDEN",
      "NOT_FOUND",
      "INVALID_INPUT",
      "CONSENT_REQUIRED",
      "ACCOUNT_BANNED",
      "PUBLICATION_STOPPED",
      "EVENT_CLOSED",
      "STATE_CONFLICT",
      "THEME_UNAVAILABLE",
      "PROCESSING_HELD",
      "RATE_LIMITED",
      "INTERNAL_ERROR",
    ] as const;
    if (known.includes(value.code as (typeof known)[number]))
      return failure(
        value.code as (typeof known)[number],
        value.code === "RATE_LIMITED" ? 60 : undefined,
      );
    if (value.code !== "ok") upstreamInvalid();
    signal.throwIfAborted();
    if (op === "get_settings") {
      if (!object(value.settings)) return upstreamInvalid();
      const s = value.settings,
        fields = {
          version: s.version,
          publication_stopped: s.publication_stopped,
          uploads_enabled: s.uploads_enabled,
          moderation_concurrency: s.moderation_concurrency,
          thresholds: s.thresholds,
        };
      if (
        !validSettings(fields) ||
        typeof s.thresholds_approved !== "boolean" ||
        (s.publication_stopped && s.uploads_enabled)
      )
        return upstreamInvalid();
      return reply(
        { ...fields, thresholds_approved: s.thresholds_approved },
        200,
      );
    }
    if (op === "themes" || op === "admin_themes") {
      if (!Array.isArray(value.items)) return upstreamInvalid();
      const items = value.items.map((x) => projectTheme(x, eventId));
      if (
        new Set(items.map((x) => x.id)).size !== items.length ||
        (op === "themes" && items.some((x) => x.status === "draft"))
      )
        return upstreamInvalid();
      return reply({ items }, 200);
    }
    if (paged) {
      if (
        !Array.isArray(value.items) ||
        value.items.length > limit ||
        typeof value.has_more !== "boolean" ||
        (value.has_more && value.items.length !== limit)
      )
        return upstreamInvalid();
      const rows = value.items.map((x) =>
        op === "admin_feed" ? projectAdminPost(x, eventId) : projectAppeal(x),
      );
      let previous = before;
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          seen.has(row.position.id) ||
          (previous &&
            !(
              row.position.priority < previous.priority ||
              (row.position.priority === previous.priority &&
                isAfterCursor(row.position, previous))
            ))
        )
          upstreamInvalid();
        seen.add(row.position.id);
        previous = row.position;
      }
      const next_cursor = value.has_more
        ? await signCursor(key!, scope, previous!)
        : null;
      signal.throwIfAborted();
      return reply({ items: rows.map((r) => r.item), next_cursor }, 200);
    }
    return reply({ request_id: requestId }, 200);
  } catch (error) {
    return failure(
      error instanceof OperationError ? error.code : "INTERNAL_ERROR",
    );
  } finally {
    clearTimeout(timer);
  }
}
