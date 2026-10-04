import { NextResponse } from "next/server";

export function sessionReply(status: number, code?: string) {
  return NextResponse.json(code ? { code } : { ok: true }, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiSessionOrigin(): string | null {
  if (process.env.KOKO_API_COOKIE_ENABLED !== "true") return null;
  try {
    const origin = process.env.KOKO_WEB_ORIGIN;
    const url = new URL(origin ?? "");
    return url.protocol === "https:" && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.signal.aborted || request.bodyUsed) return false;
  if (!request.body) return true;
  if (request.body.locked) return false;
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Next.jsの空POSTも非nullストリーム。1秒以内のEOFだけを許可する。
    const first = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 1000);
      }),
    ]);
    return first?.done === true && !request.signal.aborted;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function validateSessionRequest(request: Request, path: string) {
  const origin = apiSessionOrigin();
  if (!origin) return sessionReply(503, "API_SESSION_UNAVAILABLE");
  const url = new URL(request.url);
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    url.origin !== origin ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("X-KOKO-Session-Request") !== "1" ||
    (site !== null && site !== "same-origin")
  )
    return sessionReply(403, "FORBIDDEN");
  if (
    url.pathname !== path ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    request.headers.has("Authorization") ||
    !(await hasEmptyBody(request))
  )
    return sessionReply(400, "INVALID_INPUT");
  return null;
}
