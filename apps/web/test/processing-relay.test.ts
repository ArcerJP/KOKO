import { afterEach, expect, it, vi } from "vitest";
import {
  createProcessingRelayClient,
  processingJob,
  relayBody,
  relayBounded,
  relayPath,
  signRelay,
  verifyRelay,
} from "@koko/processing/relay";
import {
  handleProcessingRelay,
  processingRelayConfiguration,
  type ProcessingRelayConfig,
} from "../src/api/processing-relay";
import {
  POST,
  maxDuration,
  runtime,
} from "../src/app/api/internal/media/process/route";

const native = vi.hoisted(() => ({
  getContext: vi.fn(),
  getVercelOidcTokenSync: vi.fn(),
}));
vi.mock("@vercel/oidc", () => native);
const origin = "https://koko-relay-fixture.vercel.app";
const secret = "ab".repeat(32); // Synthetic test-only HMAC material.
const job = {
  eventId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
};
const nonce = "44444444-4444-4444-8444-444444444444";
const config: ProcessingRelayConfig = {
  enabled: true,
  production: true,
  origin,
  secret,
  eventId: job.eventId,
  serviceUrl: "https://koko-image-fixture-123456789.asia-northeast1.run.app",
  serviceAccountEmail:
    "koko-cloud-run-caller@fixture-project.iam.gserviceaccount.com",
  serviceAccountSubject: "123456789012345678901",
  providerAudience:
    "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/koko-cloud-run/providers/koko-vercel",
  subjectIssuer: "https://oidc.vercel.com/fixture",
  subjectAudience: "https://vercel.com/fixture",
  subject: "owner:fixture:project:koko-web:environment:production",
  projectId: "prj_Fixture0123456789",
};
const body = JSON.stringify(job);
function jwt(claims: Record<string, unknown>) {
  const encode = (x: unknown) =>
    Buffer.from(JSON.stringify(x)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "fixture", typ: "JWT" })}.${encode(claims)}.fixture_signature`;
}
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({
  iss: config.subjectIssuer,
  aud: config.subjectAudience,
  sub: config.subject,
  project_id: config.projectId,
  environment: "production",
  iat: now() - 5,
  exp: now() + 600,
});
const google = () =>
  jwt({
    iss: "https://accounts.google.com",
    aud: config.serviceUrl,
    sub: config.serviceAccountSubject,
    email: config.serviceAccountEmail,
    email_verified: true,
    iat: now() - 5,
    exp: now() + 600,
  });
async function request(
  text = body,
  at = String(Date.now()),
  endpoint = `${origin}${relayPath}`,
) {
  return new Request(endpoint, {
    method: "POST",
    headers: await signRelay(origin, secret, text, at, nonce),
    body: text,
  });
}
function fixture(sourceClaims: Record<string, unknown> = claims()) {
  const assertion = jwt(sourceClaims);
  const token = google();
  const source = vi.fn(async () => assertion);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === "https://sts.googleapis.com/v1/token") {
      expect(JSON.parse(String(init?.body)).subjectToken).toBe(assertion);
      return Response.json({
        access_token: "fixture_sts_access",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (String(url).endsWith(":generateIdToken")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture_sts_access",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        audience: config.serviceUrl,
        includeEmail: true,
      });
      return Response.json({ token });
    }
    expect(url).toBe(`${config.serviceUrl}/internal/process`);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual(job);
    return Response.json({
      stage: "moderation",
      outcome: "moderation_recorded",
      processComplete: true,
    });
  });
  return { source, fetcher, assertion, token };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("signed machine request is forwarded to fixed Google endpoints; only receipt is returned", async () => {
  const f = fixture();
  const response = await handleProcessingRelay(
    await request(),
    config,
    f.fetcher,
    f.source,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    stage: "moderation",
    processComplete: true,
  });
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("native invocation context, not incoming headers or a local credential fallback, supplies the source", async () => {
  const f = fixture();
  native.getContext.mockReturnValue({
    headers: { "x-vercel-oidc-token": f.assertion },
  });
  native.getVercelOidcTokenSync.mockReturnValue(f.assertion);
  const req = await request();
  req.headers.set("x-vercel-oidc-token", "untrusted_incoming_value");
  expect((await handleProcessingRelay(req, config, f.fetcher)).status).toBe(
    200,
  );
  expect(native.getVercelOidcTokenSync).toHaveBeenCalledTimes(1);
  native.getContext.mockReturnValue({});
  expect(
    (await handleProcessingRelay(await request(), config, f.fetcher)).status,
  ).toBe(503);
  expect(native.getVercelOidcTokenSync).toHaveBeenCalledTimes(1);
});
it.each(["enabled", "production"] as const)(
  "%s=false is fail closed before credentials or network",
  async (k) => {
    const f = fixture();
    expect(
      (
        await handleProcessingRelay(
          await request(),
          { ...config, [k]: false },
          f.fetcher,
          f.source,
        )
      ).status,
    ).toBe(503);
    expect(f.source).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it("real route is disabled by default and has a finite Node runtime", async () => {
  vi.stubEnv("KOKO_PROCESSING_RELAY_ENABLED", "false");
  expect((await POST(await request())).status).toBe(503);
  expect(runtime).toBe("nodejs");
  expect(maxDuration).toBe(180);
  expect(processingRelayConfiguration().enabled).toBe(false);
});
it.each([
  ["origin", "https://attacker.test"],
  ["secret", "short"],
  ["eventId", "bad"],
  ["projectId", "bad"],
  ["subjectIssuer", "https://oidc.vercel.com"],
  ["subjectAudience", "other"],
  ["subject", "owner:fixture:project:koko-web:environment:preview"],
  ["serviceUrl", "https://attacker.test"],
  ["serviceAccountEmail", "arbitrary"],
  ["serviceAccountSubject", "arbitrary"],
  ["providerAudience", "other"],
] as const)(
  "invalid trusted config %s never issues external calls",
  async (k, value) => {
    const f = fixture();
    expect(
      (
        await handleProcessingRelay(
          await request(),
          { ...config, [k]: value },
          f.fetcher,
          f.source,
        )
      ).status,
    ).toBe(503);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.source).not.toHaveBeenCalled();
  },
);
it.each([
  ["project_id", "prj_Other0123456789"],
  ["environment", "preview"],
  ["sub", "other"],
  ["iss", "https://oidc.vercel.com/other"],
  ["aud", "other"],
  ["exp", 1],
] as const)(
  "wrong source %s is refused before Google network",
  async (k, value) => {
    const f = fixture({ ...claims(), [k]: value });
    expect(
      (
        await handleProcessingRelay(
          await request(),
          config,
          f.fetcher,
          f.source,
        )
      ).status,
    ).toBe(503);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each(["project_id", "environment"])(
  "missing %s is fail closed",
  async (k) => {
    const source: Record<string, unknown> = claims();
    delete source[k];
    const f = fixture(source);
    expect(
      (
        await handleProcessingRelay(
          await request(),
          config,
          f.fetcher,
          f.source,
        )
      ).status,
    ).toBe(503);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each(["origin", "cookie", "authorization"])(
  "browser/user credentials %s are not a machine credential",
  async (k) => {
    const f = fixture();
    const req = await request();
    req.headers.set(k, "fixture_value");
    expect(
      (await handleProcessingRelay(req, config, f.fetcher, f.source)).status,
    ).toBe(403);
    expect(f.source).not.toHaveBeenCalled();
  },
);
it.each(["x-koko-relay-at", "x-koko-relay-nonce", "x-koko-relay-signature"])(
  "missing or altered signature field %s refuses input",
  async (k) => {
    const f = fixture();
    const req = await request();
    req.headers.set(k, "bad");
    expect(
      (await handleProcessingRelay(req, config, f.fetcher, f.source)).status,
    ).toBe(403);
    expect(f.source).not.toHaveBeenCalled();
  },
);
it.each([-60001, 60001])(
  "expired/future HMAC timestamp %s is refused",
  async (delta) => {
    vi.spyOn(Date, "now").mockReturnValue(1791273600000);
    const f = fixture();
    expect(
      (
        await handleProcessingRelay(
          await request(body, String(Date.now() + delta)),
          config,
          f.fetcher,
          f.source,
        )
      ).status,
    ).toBe(403);
    expect(f.source).not.toHaveBeenCalled();
  },
);
it("changing body bytes invalidates the signature", async () => {
  const f = fixture();
  const req = await request();
  const altered = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({ ...job, jobId: nonce }),
  });
  expect(
    (await handleProcessingRelay(altered, config, f.fetcher, f.source)).status,
  ).toBe(403);
  expect(f.source).not.toHaveBeenCalled();
});
it.each([
  `${origin}${relayPath}?url=https://attacker.test`,
  `${origin}/other`,
  `https://other.vercel.app${relayPath}`,
])("different target %s fails closed", async (endpoint) => {
  const f = fixture();
  expect(
    (
      await handleProcessingRelay(
        await request(body, String(Date.now()), endpoint),
        config,
        f.fetcher,
        f.source,
      )
    ).status,
  ).toBe(403);
  expect(f.source).not.toHaveBeenCalled();
});
it.each([
  { ...job, url: "https://attacker.test" },
  { ...job, token: "injected" },
  { ...job, eventId: nonce },
  { ...job, postId: "bad" },
  [],
  null,
])("wrong/extra job input %# is never forwarded", async (value) => {
  const f = fixture();
  expect(
    (
      await handleProcessingRelay(
        await request(JSON.stringify(value)),
        config,
        f.fetcher,
        f.source,
      )
    ).status,
  ).toBe(403);
  expect(f.source).not.toHaveBeenCalled();
});
it("unknown upstream failure data and tokens are never echoed", async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error(`upstream ${f.token} ${secret}`));
  const result = await handleProcessingRelay(
    await request(),
    config,
    f.fetcher,
    f.source,
  );
  expect(result.status).toBe(503);
  expect(await result.text()).toBe('{"error":"PROCESSING_RELAY_UNAVAILABLE"}');
});
it("oversized and non-JSON body is rejected before source lookup", async () => {
  const f = fixture();
  expect(
    (
      await handleProcessingRelay(
        await request("x".repeat(513)),
        config,
        f.fetcher,
        f.source,
      )
    ).status,
  ).toBe(503);
  const req = await request();
  req.headers.set("content-type", "text/plain");
  expect(
    (await handleProcessingRelay(req, config, f.fetcher, f.source)).status,
  ).toBe(503);
  expect(f.source).not.toHaveBeenCalled();
});
it("Worker client sends only signed UUIDs, optional bypass stays in fixed-target header", async () => {
  const f = fixture();
  const forward = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(`${origin}${relayPath}`);
    expect(init?.redirect).toBe("manual");
    const req = new Request(String(url), init);
    expect(req.headers.get("x-vercel-protection-bypass")).toBe(
      "fixture_bypass_".repeat(4),
    );
    return handleProcessingRelay(req, config, f.fetcher, f.source);
  });
  const client = createProcessingRelayClient({
    enabled: true,
    origin,
    secret,
    eventId: job.eventId,
    protectionBypass: "fixture_bypass_".repeat(4),
    fetcher: forward,
  });
  expect(await client!.process(job)).toBe(true);
  expect(forward).toHaveBeenCalledTimes(1);
});
it.each([undefined, false])(
  "Worker relay enabled=%s performs no call",
  (enabled) => {
    expect(
      createProcessingRelayClient({
        ...(enabled === undefined ? {} : { enabled }),
      }),
    ).toBeNull();
  },
);
it.each([
  { origin: "https://attacker.test" },
  { secret: "short" },
  { eventId: "bad" },
  { protectionBypass: "short" },
  { timeoutMs: 150001 },
])("invalid Worker config %# is refused", (invalid) => {
  expect(() =>
    createProcessingRelayClient({
      enabled: true,
      origin,
      secret,
      eventId: job.eventId,
      ...invalid,
    }),
  ).toThrow("INVALID_PROCESSING_RELAY_CONFIG");
});
it.each([
  new Response("", {
    status: 302,
    headers: { location: "https://attacker.test" },
  }),
  Response.json({
    stage: "moderation",
    processComplete: true,
    token: "secret",
  }),
  Response.json({ stage: "image", processComplete: true }),
  Response.json({ stage: "moderation", processComplete: false }),
  new Response("x".repeat(513), {
    headers: { "content-type": "application/json" },
  }),
])("Worker does not trust redirects or wrong receipts %#", async (result) => {
  const client = createProcessingRelayClient({
    enabled: true,
    origin,
    secret,
    eventId: job.eventId,
    fetcher: vi.fn(async () => result),
  });
  await expect(client!.process(job)).rejects.toThrow(
    "PROCESSING_RELAY_UNAVAILABLE",
  );
});
it("Worker client refuses other events before network", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createProcessingRelayClient({
    enabled: true,
    origin,
    secret,
    eventId: job.eventId,
    fetcher,
  });
  await expect(client!.process({ ...job, eventId: nonce })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("finite operation aborts even if an upstream ignores AbortSignal", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const pending = relayBounded(20, undefined, async (active) => {
    signal = active;
    return new Promise(() => {});
  });
  const rejected = expect(pending).rejects.toThrow(
    "PROCESSING_RELAY_UNAVAILABLE",
  );
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(signal?.aborted).toBe(true);
});
it("outer abort promptly stops waiting and aborts the downstream", async () => {
  const outer = new AbortController();
  let signal: AbortSignal | undefined;
  const pending = relayBounded(10000, outer.signal, async (active) => {
    signal = active;
    return new Promise(() => {});
  });
  const rejected = expect(pending).rejects.toThrow();
  await Promise.resolve();
  outer.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
});
it("stalled request bodies are cancelled after the finite input timeout", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const req = new Request(`${origin}${relayPath}`, {
    method: "POST",
    body: stream,
    headers: { "content-type": "application/json" },
    duplex: "half",
  } as RequestInit);
  const pending = relayBounded(20, undefined, (signal) =>
    relayBody(req, signal),
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  expect(cancel).toHaveBeenCalled();
});
it("same signed body is valid only within a short window; DB lease/versions, not a nonce ledger, provide idempotence", async () => {
  const req = await request();
  expect(await verifyRelay(req, origin, secret, body)).toBe(true);
  expect(await verifyRelay(req, origin, "cd".repeat(32), body)).toBe(false);
  expect(processingJob({ ...job, url: "bad" })).toBeNull();
});
