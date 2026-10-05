import { describe, expect, it, vi } from "vitest";
import { handleEnrollment, type EnrollmentEnv } from "../src/enrollment";
import worker from "../src/index";
import { env as workerEnv } from "cloudflare:workers";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const jwt = "signed.cookie.placeholder";
const origin = "https://web.example.test";
const config: EnrollmentEnv = {
  KOKO_ENROLLMENT_ENABLED: "true",
  KOKO_EVENT_ID: eventId,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  KOKO_WEB_ORIGIN: origin,
  KOKO_CSRF_SECRET: "10".repeat(32),
};
const authUser = {
  id: userId,
  app_metadata: { provider: "google", providers: ["google"] },
};
const preflight = { code: "ok", status: "not_enrolled", can_enroll: true };
function request(method = "GET", init: RequestInit = {}, cookie = false) {
  return new Request("https://api.example.test/me/enrollment", {
    method,
    ...(method === "POST"
      ? { body: JSON.stringify({ display_name: "Fixture" }) }
      : {}),
    ...init,
    headers: {
      "X-Event-ID": eventId,
      ...(cookie
        ? {
            Cookie: `__Host-koko_session=${jwt}`,
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
          }
        : { Authorization: `Bearer ${jwt}` }),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}
function fixture(
  options: {
    auth?: Response | object;
    result?: unknown;
    response?: () => Response;
    throws?: boolean;
  } = {},
) {
  const calls: Request[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push(req);
      expect(req.redirect).toBe("manual");
      expect(new URL(req.url).origin).toBe(config.SUPABASE_URL);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (new URL(req.url).pathname === "/auth/v1/user") {
        expect(req.headers.get("apikey")).toBe(config.SUPABASE_PUBLISHABLE_KEY);
        return options.auth instanceof Response
          ? options.auth
          : Response.json(options.auth ?? authUser);
      }
      expect(req.headers.get("authorization")).toBeNull();
      expect(req.headers.get("apikey")).toBe(config.SUPABASE_SECRET_KEY);
      expect([
        "/rest/v1/rpc/read_event_enrollment",
        "/rest/v1/rpc/enroll_event",
      ]).toContain(new URL(req.url).pathname);
      if (options.throws) throw new Error("sb_secret_canary");
      if (options.response) return options.response();
      return Response.json(
        "result" in options
          ? options.result
          : new URL(req.url).pathname.endsWith("read_event_enrollment")
            ? preflight
            : "enrolled",
      );
    },
  ) as typeof fetch;
  return { calls, fetcher };
}
async function failure(response: Response, code: string, status?: number) {
  if (status !== undefined) expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    code,
    request_id: expect.any(String),
  });
}

describe("explicit first enrollment", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "disabled flag %s causes no Auth/DB calls",
    async (flag) => {
      const f = fixture();
      const settings = { ...config };
      if (flag === undefined) delete settings.KOKO_ENROLLMENT_ENABLED;
      else settings.KOKO_ENROLLMENT_ENABLED = flag;
      await failure(
        await handleEnrollment(request(), settings, f.fetcher),
        "NOT_FOUND",
        404,
      );
      expect(f.calls).toHaveLength(0);
    },
  );
  it("router retains default OFF for both operations", async () => {
    for (const method of ["GET", "POST"])
      expect(
        (
          await worker.fetch(
            request(method) as Request<unknown, IncomingRequestCfProperties>,
            workerEnv,
          )
        ).status,
      ).toBe(404);
  });
  it.each(["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "rejects %s before auth",
    async (method) => {
      const f = fixture();
      const result = await handleEnrollment(request(method), config, f.fetcher);
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET, POST");
      expect(f.calls).toHaveLength(0);
    },
  );
  it("enrollment is fixed to server event and does not trust arbitrary headers", async () => {
    for (const fixed of ["", "bad"]) {
      const f = fixture();
      await failure(
        await handleEnrollment(
          request(),
          { ...config, KOKO_EVENT_ID: fixed },
          f.fetcher,
        ),
        "INTERNAL_ERROR",
        500,
      );
      expect(f.calls).toHaveLength(0);
    }
    for (const [value, code] of [
      [otherId, "FORBIDDEN"],
      ["bad", "INVALID_INPUT"],
      ["", "INVALID_INPUT"],
    ]) {
      const f = fixture();
      await failure(
        await handleEnrollment(
          request("GET", { headers: { "X-Event-ID": value! } }),
          config,
          f.fetcher,
        ),
        code!,
      );
      expect(f.calls).toHaveLength(0);
    }
  });
  it.each(["?user_id=other", "?event_id=other", "?x=1&x=2"])(
    "rejects query %s before upstream",
    async (search) => {
      const f = fixture();
      await failure(
        await handleEnrollment(
          new Request(request().url + search, request()),
          config,
          f.fetcher,
        ),
        "INVALID_INPUT",
        400,
      );
      expect(f.calls).toHaveLength(0);
    },
  );
  it("preflight uses verified IDs and projects no roles, profile, BAN or secrets", async () => {
    const f = fixture({
      result: {
        ...preflight,
        role: "admin",
        is_banned: true,
        display_name: "private",
        secret: "sb_secret_canary",
      },
    });
    const response = await handleEnrollment(request(), config, f.fetcher);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      user_id: userId,
      event_id: eventId,
      enrolled: false,
      registration_open: true,
    });
    expect(f.calls).toHaveLength(2);
    expect(await f.calls[1]!.json()).toEqual({
      p_event_id: eventId,
      p_user_id: userId,
    });
  });
  it("POST sends only verified subject/fixed event and explicit unchanged display name", async () => {
    const f = fixture();
    const result = await handleEnrollment(
      request("POST", { body: JSON.stringify({ display_name: " 試験名 " }) }),
      config,
      f.fetcher,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ request_id: expect.any(String) });
    expect(await f.calls[1]!.json()).toEqual({
      p_event_id: eventId,
      p_user_id: userId,
      p_display_name: " 試験名 ",
    });
  });
  it("Cookie preflight bootstraps session-bound CSRF without creating a member", async () => {
    const f = fixture();
    const status = (await (
      await handleEnrollment(request("GET", {}, true), config, f.fetcher)
    ).json()) as { csrf_token: string };
    expect(status.csrf_token).toMatch(/^v1\./);
    expect(new URL(f.calls[1]!.url).pathname).toBe(
      "/rest/v1/rpc/read_event_enrollment",
    );
    const posted = await handleEnrollment(
      request("POST", { headers: { "X-CSRF-Token": status.csrf_token } }, true),
      config,
      f.fetcher,
    );
    expect(posted.status).toBe(200);
    expect(f.calls).toHaveLength(4);
  });
  it("CSRF never authenticates a different session or origin", async () => {
    const f = fixture();
    const status = (await (
      await handleEnrollment(request("GET", {}, true), config, f.fetcher)
    ).json()) as { csrf_token: string };
    for (const headers of [
      { "X-CSRF-Token": "" },
      {
        "X-CSRF-Token": status.csrf_token,
        Cookie: "__Host-koko_session=other.jwt",
      },
      { "X-CSRF-Token": status.csrf_token, Origin: "https://evil.example" },
      { "X-CSRF-Token": status.csrf_token, Origin: "" },
      { "X-CSRF-Token": status.csrf_token, "Sec-Fetch-Site": "cross-site" },
    ]) {
      const count = f.calls.length;
      await failure(
        await handleEnrollment(
          request("POST", { headers }, true),
          config,
          f.fetcher,
        ),
        "FORBIDDEN",
        403,
      );
      expect(f.calls).toHaveLength(count);
    }
  });
  it.each([
    new Response(null, { status: 401 }),
    { id: userId, app_metadata: { provider: "email", providers: ["email"] } },
    {
      id: userId,
      app_metadata: { provider: "google", providers: ["google", "email"] },
    },
    { id: "invalid", app_metadata: authUser.app_metadata },
  ])("invalid Auth cannot call enrollment RPC", async (auth) => {
    const f = fixture({ auth });
    expect(
      (await handleEnrollment(request(), config, f.fetcher)).status,
    ).not.toBe(200);
    expect(f.calls).toHaveLength(1);
  });
  it.each(["", "Basic fixture"])(
    "missing/invalid credential %s never reaches Auth",
    async (Authorization) => {
      const f = fixture();
      await failure(
        await handleEnrollment(
          request("GET", { headers: { Authorization } }),
          config,
          f.fetcher,
        ),
        "AUTH_REQUIRED",
        401,
      );
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([
    null,
    [],
    {},
    { display_name: "" },
    { display_name: " " },
    { display_name: "x".repeat(51) },
    { display_name: "x\u200b" },
    { display_name: "x\u0001" },
    { display_name: 1 },
    { display_name: "X", role: "admin" },
    { display_name: "X", user_id: otherId },
    { display_name: "X", event_id: otherId },
    { display_name: "X", accepted: true },
  ])("rejects invalid or privilege-bearing body %#", async (body) => {
    const f = fixture();
    await failure(
      await handleEnrollment(
        request("POST", { body: JSON.stringify(body) }),
        config,
        f.fetcher,
      ),
      "INVALID_INPUT",
      400,
    );
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    { body: "{" },
    { body: null },
    { body: new Uint8Array([255]) },
    { body: " ".repeat(1025) },
    { headers: { "Content-Type": "text/plain" } },
    { headers: { "Content-Encoding": "gzip" } },
    { headers: { "Content-Length": "1025" } },
    { headers: { "Content-Length": "3" } },
    { headers: { "Content-Length": "-1" } },
  ])("strict JSON/framing/body limit %#", async (init) => {
    const f = fixture();
    await failure(
      await handleEnrollment(request("POST", init), config, f.fetcher),
      "INVALID_INPUT",
      400,
    );
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    "INVALID_INPUT",
    "FORBIDDEN",
    "EVENT_CLOSED",
    "PUBLICATION_STOPPED",
  ])("maps SQL refusal %s without accepting it", async (code) => {
    const f = fixture({ result: code });
    await failure(
      await handleEnrollment(request("POST"), config, f.fetcher),
      code,
    );
  });
  it.each([
    null,
    [],
    {},
    true,
    "unknown",
    { code: "ok", status: "unknown", can_enroll: true },
    { ...preflight, can_enroll: "true" },
    { code: "ok", status: "enrolled", can_enroll: true },
  ])("rejects malformed preflight response %#", async (result) => {
    const f = fixture({ result });
    await failure(
      await handleEnrollment(request(), config, f.fetcher),
      "INTERNAL_ERROR",
      500,
    );
  });
  it("existing or closed preflight projects booleans without additional member details", async () => {
    for (const status of ["enrolled", "not_enrolled"]) {
      const f = fixture({ result: { code: "ok", status, can_enroll: false } });
      expect(
        await (await handleEnrollment(request(), config, f.fetcher)).json(),
      ).toEqual({
        user_id: userId,
        event_id: eventId,
        enrolled: status === "enrolled",
        registration_open: false,
      });
    }
  });
  it.each([302, 307, 500])(
    "does not follow upstream %s or expose payload",
    async (status) => {
      const f = fixture({
        response: () =>
          new Response("sb_secret_canary", {
            status,
            headers: { location: "https://evil.example" },
          }),
      });
      const result = await handleEnrollment(request("POST"), config, f.fetcher);
      await failure(result, "INTERNAL_ERROR", 500);
      expect(result.headers.get("location")).toBeNull();
      expect(f.calls).toHaveLength(2);
    },
  );
  it.each([
    () => Response.json("x".repeat(16385)),
    () => new Response("canary", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("not-json", {
        headers: { "content-type": "application/json" },
      }),
    () => {
      throw new Error("sb_secret_canary");
    },
  ])("invalid/large/exception upstream is hidden %#", async (response) => {
    const f = fixture({ response });
    await failure(
      await handleEnrollment(request("POST"), config, f.fetcher),
      "INTERNAL_ERROR",
      500,
    );
  });
  it("caller abort and deadline cancel a stalled response and do not reach a write", async () => {
    vi.useFakeTimers();
    try {
      for (const byCaller of [true, false]) {
        const cancel = vi.fn();
        const controller = new AbortController();
        const f = fixture({
          auth: new Response(new ReadableStream({ cancel }), {
            headers: { "content-type": "application/json" },
          }),
        });
        const result = handleEnrollment(
          request("POST", { signal: controller.signal }),
          config,
          f.fetcher,
        );
        await vi.advanceTimersByTimeAsync(0);
        if (byCaller) controller.abort();
        else await vi.advanceTimersByTimeAsync(10000);
        await failure(await result, "INTERNAL_ERROR", 500);
        expect(cancel).toHaveBeenCalledOnce();
        expect(f.calls).toHaveLength(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
