import { afterEach, expect, it, vi } from "vitest";
import {
  createCloudRunClient,
  createWorkloadIdentityToken,
  type WorkloadIdentityConfig,
} from "../src/cloud-run-client";

const serviceUrl =
  "https://koko-image-fixture-123456789.asia-northeast1.run.app";
const email = "koko-image-caller@fixture-project.iam.gserviceaccount.com";
const subject = "123456789012345678901";
const job = {
  eventId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
};
const now = () => Math.floor(Date.now() / 1000);
// Deliberately unsigned fixtures: STS/Cloud Run, not this parser, verify signatures.
function token(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {
    alg: "RS256",
    kid: "fixture",
    typ: "JWT",
  },
) {
  const encode = (x: unknown) =>
    btoa(JSON.stringify(x))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode(header)}.${encode(claims)}.fixture_signature`;
}
function sourceClaims() {
  return {
    iss: "https://identity.fixture.test",
    aud: "koko-media",
    sub: "worker-fixture",
    iat: now() - 5,
    exp: now() + 600,
  };
}
function googleClaims() {
  return {
    iss: "https://accounts.google.com",
    aud: serviceUrl,
    sub: subject,
    email,
    email_verified: true,
    iat: now() - 5,
    exp: now() + 600,
  };
}
function fixture() {
  const assertion = token(sourceClaims());
  const google = token(googleClaims());
  const source = vi.fn(async (signal: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return assertion;
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    if (url === "https://sts.googleapis.com/v1/token") {
      expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience:
          "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/koko-worker/providers/koko-oidc",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: assertion,
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      });
      return Response.json({
        access_token: "fixture_sts_access",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    expect(url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateIdToken`,
    );
    expect(headers.get("authorization")).toBe("Bearer fixture_sts_access");
    expect(JSON.parse(String(init?.body))).toEqual({
      audience: serviceUrl,
      includeEmail: true,
    });
    return Response.json({ token: google });
  });
  const config: WorkloadIdentityConfig = {
    enabled: true,
    serviceUrl,
    serviceAccountEmail: email,
    serviceAccountSubject: subject,
    providerAudience:
      "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/koko-worker/providers/koko-oidc",
    subjectIssuer: "https://identity.fixture.test",
    subjectAudience: "koko-media",
    subject: "worker-fixture",
    subjectToken: source,
    fetcher,
  };
  return { config, fetcher, source, assertion, google };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("identity and processing are default OFF with no identity source or fetch", () => {
  expect(createWorkloadIdentityToken()).toBeNull();
  expect(createCloudRunClient()).toBeNull();
});
it.each([
  "serviceUrl",
  "serviceAccountEmail",
  "serviceAccountSubject",
  "providerAudience",
  "subjectIssuer",
  "subjectAudience",
  "subject",
  "subjectToken",
] as const)("identity config requires fixed %s", (key) => {
  const f = fixture();
  delete f.config[key];
  expect(() => createWorkloadIdentityToken(f.config)).toThrow(
    "INVALID_WORKLOAD_IDENTITY_CONFIG",
  );
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.source).not.toHaveBeenCalled();
});
it.each([
  "http://example.test",
  "https://evil.test",
  "https://fixture.run.app/path",
  "https://fixture.run.app?token=private",
  "https://fixture.run.app#hash",
  "https://user@fixture.run.app",
])("never sends credentials to non-origin/flexible URL %s", (serviceUrl) => {
  const f = fixture();
  expect(() =>
    createWorkloadIdentityToken({ ...f.config, serviceUrl }),
  ).toThrow("INVALID_WORKLOAD_IDENTITY_CONFIG");
  expect(() =>
    createCloudRunClient({ enabled: true, serviceUrl, idToken: f.source }),
  ).toThrow("INVALID_CLOUD_RUN_CONFIG");
});
it("exchanges the trusted external assertion only at STS, then obtains fixed Google identity at IAM", async () => {
  const f = fixture();
  expect(
    await createWorkloadIdentityToken(f.config)!(new AbortController().signal),
  ).toBe(f.google);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.source).toHaveBeenCalledOnce();
});
it.each([
  { iss: "https://evil.test" },
  { aud: ["koko-media"] },
  { sub: "other" },
  { exp: 1 },
  { iat: now() + 600 },
  { nbf: now() + 600 },
  { exp: now() + 86401 },
  { iat: 0 },
])("rejects wrong external claims %j before networking", async (change) => {
  const f = fixture();
  f.source.mockResolvedValue(token({ ...sourceClaims(), ...change }));
  await expect(
    createWorkloadIdentityToken(f.config)!(new AbortController().signal),
  ).rejects.toThrow("CLOUD_RUN_UNAVAILABLE");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { alg: "none", kid: "fixture" },
  { alg: "HS256", kid: "fixture" },
  { alg: "RS256" },
  { alg: "RS256", kid: "fixture", jku: "https://evil.test" },
])("rejects unsafe JWT header %j", async (header) => {
  const f = fixture();
  f.source.mockResolvedValue(token(sourceClaims(), header));
  await expect(
    createWorkloadIdentityToken(f.config)!(new AbortController().signal),
  ).rejects.toThrow("CLOUD_RUN_UNAVAILABLE");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { iss: "https://evil.test" },
  { aud: "https://other.run.app" },
  { sub: "111111111111111111111" },
  { email: "other@fixture-project.iam.gserviceaccount.com" },
  { email_verified: false },
  { exp: 1 },
  { exp: now() + 4000 },
  { nbf: now() + 600 },
])("rejects mismatched returned Google identity %j", async (change) => {
  const f = fixture();
  f.fetcher
    .mockImplementationOnce(async () =>
      Response.json({
        access_token: "fixture_sts_access",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    )
    .mockImplementationOnce(async () =>
      Response.json({ token: token({ ...googleClaims(), ...change }) }),
    );
  await expect(
    createWorkloadIdentityToken(f.config)!(new AbortController().signal),
  ).rejects.toThrow("CLOUD_RUN_UNAVAILABLE");
});
it.each([
  new Response(null, {
    status: 302,
    headers: { location: "https://evil.test" },
  }),
  Response.json({ access_token: "private", error: "secret" }, { status: 400 }),
  new Response("x".repeat(40000), {
    headers: { "content-type": "application/json" },
  }),
  Response.json({
    access_token: "fixture_sts_access",
    token_type: "Bearer",
    expires_in: 3600,
  }),
])(
  "sanitizes bad provider response and never follows redirects",
  async (response) => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(response);
    await expect(
      createWorkloadIdentityToken(f.config)!(new AbortController().signal),
    ).rejects.toThrow(/^CLOUD_RUN_UNAVAILABLE$/);
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);
it("bounds a stalled identity source without leaking its content", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.source.mockImplementation(() => new Promise(() => {}));
  const promise = createWorkloadIdentityToken({ ...f.config, timeoutMs: 10 })!(
    new AbortController().signal,
  );
  const rejected = expect(promise).rejects.toThrow(/^CLOUD_RUN_UNAVAILABLE$/);
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("aborted input never obtains an assertion", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    createWorkloadIdentityToken(f.config)!(controller.signal),
  ).rejects.toThrow(/^CLOUD_RUN_UNAVAILABLE$/);
  expect(f.source).not.toHaveBeenCalled();
});
it.each(["moderation_recorded", "moderation_already_recorded"])(
  "fixed Cloud Run endpoint accepts %s but carries only three IDs",
  async (outcome) => {
    const google = token(googleClaims());
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(`${serviceUrl}/internal/process`);
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${google}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual(job);
      return Response.json({
        stage: "moderation",
        outcome,
        processComplete: true,
      });
    });
    expect(
      await createCloudRunClient({
        enabled: true,
        serviceUrl,
        idToken: async () => google,
        fetcher,
      })!.process(job),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it.each([
  { stage: "image", outcome: "image_recorded", processComplete: false },
  {
    stage: "moderation",
    outcome: "moderation_recorded",
    processComplete: false,
  },
  {
    stage: "moderation",
    outcome: "moderation_recorded",
    processComplete: true,
    bytes: "private",
  },
  { stage: "moderation", outcome: "success", processComplete: true },
])("does not accept image-only/partial/expanded response %j", async (value) => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(value));
  await expect(
    createCloudRunClient({
      enabled: true,
      serviceUrl,
      idToken: async () => token(googleClaims()),
      fetcher,
    })!.process(job),
  ).rejects.toThrow(/^CLOUD_RUN_UNAVAILABLE$/);
});
it("rejects arbitrary body fields before identity or network use", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const idToken = vi.fn(async () => token(googleClaims()));
  await expect(
    createCloudRunClient({
      enabled: true,
      serviceUrl,
      idToken,
      fetcher,
    })!.process({ ...job, url: "https://evil.test" } as typeof job),
  ).rejects.toThrow();
  expect(idToken).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("Cloud Run transport is deadline-bound even for a stalled response body", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      }),
  );
  const result = createCloudRunClient({
    enabled: true,
    serviceUrl,
    idToken: async () => token(googleClaims()),
    fetcher,
    timeoutMs: 10,
  })!.process(job);
  const rejected = expect(result).rejects.toThrow(/^CLOUD_RUN_UNAVAILABLE$/);
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
});
