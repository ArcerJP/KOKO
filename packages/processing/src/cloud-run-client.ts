const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProcessingJob = Readonly<{
  eventId: string;
  postId: string;
  jobId: string;
}>;
export type CloudRunClient = {
  process(job: ProcessingJob, signal?: AbortSignal): Promise<boolean>;
};
export type WorkloadIdentityConfig = {
  enabled?: boolean;
  serviceUrl?: string;
  serviceAccountEmail?: string;
  serviceAccountSubject?: string;
  providerAudience?: string;
  subjectIssuer?: string;
  subjectAudience?: string;
  subject?: string;
  /** Additional fixed runtime claims; signature verification remains Google's responsibility. */
  subjectClaims?: Readonly<Record<string, string>>;
  /** Trusted runtime identity source; never take a token/URL from HTTP or Queue input. */
  subjectToken?: (signal: AbortSignal) => Promise<string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};
const origin = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+run\.app$/.test(value);
const exact = (value: object, fields: readonly string[]) =>
  Object.keys(value).length === fields.length &&
  fields.every((k) => Object.hasOwn(value, k));
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length === 36 &&
  uuid.test(x) &&
  x === x.toLowerCase();
const opaque = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9._~+/-]{8,8192}={0,2}$/.test(x);
function fail(): never {
  throw new Error("CLOUD_RUN_UNAVAILABLE");
}
function job(value: ProcessingJob): ProcessingJob {
  if (
    !object(value) ||
    !exact(value, ["eventId", "postId", "jobId"]) ||
    !id(value.eventId) ||
    !id(value.postId) ||
    !id(value.jobId)
  )
    fail();
  return Object.freeze({ ...value });
}
function jwt(value: unknown): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  if (
    typeof value !== "string" ||
    value.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  const [h, c] = value.split(".");
  const decode = (x: string) =>
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(
          atob(x.replaceAll("-", "+").replaceAll("_", "/")),
          (ch) => ch.charCodeAt(0),
        ),
      ),
    ) as unknown;
  const header = decode(h!),
    claims = decode(c!);
  if (
    !object(header) ||
    !object(claims) ||
    !["RS256", "ES256"].includes(header.alg as string) ||
    typeof header.kid !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid) ||
    Object.keys(header).some((k) => !["alg", "kid", "typ"].includes(k)) ||
    (header.typ !== undefined && header.typ !== "JWT")
  )
    fail();
  return { header, claims };
}
async function bounded<T>(
  ms: number,
  outer: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectAbort?.(new Error("CLOUD_RUN_UNAVAILABLE"));
  };
  outer?.addEventListener("abort", abort, { once: true });
  if (outer?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) fail();
        return operation(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        rejectAbort = reject;
        if (controller.signal.aborted)
          reject(new Error("CLOUD_RUN_UNAVAILABLE"));
        timer = setTimeout(() => {
          reject(new Error("CLOUD_RUN_UNAVAILABLE"));
          controller.abort();
        }, ms);
      }),
    ]);
  } catch {
    return fail();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    controller.abort();
  }
}
async function responseJson(
  response: Response,
  url: string,
  signal: AbortSignal,
  max: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const length = response.headers.get("content-length");
    if (
      signal.aborted ||
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url) ||
      !reader ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      (response.headers.has("content-encoding") &&
        response.headers.get("content-encoding") !== "identity") ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
    )
      fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (signal.aborted) fail();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) fail();
      chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) fail();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Google STS verifies the external signature; Google IAM and Cloud Run verify the resulting identity.
 * This local parser is an additional fixed-subject check, NOT signature verification. No long-lived key. */
export function createWorkloadIdentityToken(
  config: WorkloadIdentityConfig = {},
): ((signal: AbortSignal) => Promise<string>) | null {
  if (config.enabled !== true) return null;
  const {
    serviceUrl,
    serviceAccountEmail,
    serviceAccountSubject,
    providerAudience,
    subjectIssuer,
    subjectAudience,
    subject,
    subjectClaims = {},
    subjectToken,
    fetcher = fetch,
    timeoutMs = 10000,
  } = config;
  if (
    !origin(serviceUrl) ||
    typeof serviceAccountEmail !== "string" ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      serviceAccountEmail,
    ) ||
    typeof serviceAccountSubject !== "string" ||
    !/^\d{10,30}$/.test(serviceAccountSubject) ||
    typeof providerAudience !== "string" ||
    !/^\/\/iam\.googleapis\.com\/projects\/[0-9]{6,30}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{2,31}\/providers\/[a-z][a-z0-9-]{2,31}$/.test(
      providerAudience,
    ) ||
    typeof subjectIssuer !== "string" ||
    !/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(subjectIssuer) ||
    typeof subjectAudience !== "string" ||
    subjectAudience.length < 1 ||
    subjectAudience.length > 512 ||
    Array.from(subjectAudience).some(
      (ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127,
    ) ||
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > 127 ||
    Array.from(subject).some(
      (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
    ) ||
    typeof subjectToken !== "function" ||
    !object(subjectClaims) ||
    Object.entries(subjectClaims).some(
      ([k, v]) =>
        !/^[a-z_]{1,64}$/.test(k) ||
        typeof v !== "string" ||
        v.length < 1 ||
        v.length > 512,
    ) ||
    typeof fetcher !== "function" ||
    !integer(timeoutMs) ||
    timeoutMs > 10000
  )
    throw new Error("INVALID_WORKLOAD_IDENTITY_CONFIG");
  return (outer) =>
    bounded(timeoutMs, outer, async (signal) => {
      const assertion = await subjectToken(signal);
      if (signal.aborted) fail();
      const source = jwt(assertion).claims;
      const now = Math.floor(Date.now() / 1000);
      if (
        source.iss !== subjectIssuer ||
        source.aud !== subjectAudience ||
        source.sub !== subject ||
        Object.entries(subjectClaims).some(([k, v]) => source[k] !== v) ||
        !integer(source.iat) ||
        !integer(source.exp) ||
        source.iat > now + 30 ||
        source.exp <= now + 30 ||
        source.exp - source.iat > 86400 ||
        (source.nbf !== undefined && (!integer(source.nbf) || source.nbf > now))
      )
        fail();
      const stsUrl = "https://sts.googleapis.com/v1/token";
      const stsResponse = await fetcher(stsUrl, {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
        },
        body: JSON.stringify({
          grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: providerAudience,
          scope: "https://www.googleapis.com/auth/cloud-platform",
          requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
          subjectToken: assertion,
          subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        }),
      });
      const sts = await responseJson(stsResponse, stsUrl, signal, 32768);
      if (
        !object(sts) ||
        !exact(sts, [
          "access_token",
          "issued_token_type",
          "token_type",
          "expires_in",
        ]) ||
        !opaque(sts.access_token) ||
        sts.issued_token_type !==
          "urn:ietf:params:oauth:token-type:access_token" ||
        sts.token_type !== "Bearer" ||
        !integer(sts.expires_in) ||
        sts.expires_in < 60 ||
        sts.expires_in > 3600
      )
        fail();
      const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateIdToken`;
      const iamResponse = await fetcher(iamUrl, {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        signal,
        headers: {
          authorization: `Bearer ${sts.access_token}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
        },
        body: JSON.stringify({ audience: serviceUrl, includeEmail: true }),
      });
      const iam = await responseJson(iamResponse, iamUrl, signal, 32768);
      if (
        !object(iam) ||
        !exact(iam, ["token"]) ||
        typeof iam.token !== "string"
      )
        fail();
      const { header, claims } = jwt(iam.token);
      const received = Math.floor(Date.now() / 1000);
      if (
        header.alg !== "RS256" ||
        !["https://accounts.google.com", "accounts.google.com"].includes(
          claims.iss as string,
        ) ||
        claims.aud !== serviceUrl ||
        claims.sub !== serviceAccountSubject ||
        claims.email !== serviceAccountEmail ||
        claims.email_verified !== true ||
        !integer(claims.iat) ||
        !integer(claims.exp) ||
        claims.iat > received + 30 ||
        claims.exp <= received + 30 ||
        claims.exp - claims.iat > 3600 ||
        (claims.nbf !== undefined &&
          (!integer(claims.nbf) || claims.nbf > received))
      )
        fail();
      return iam.token;
    });
}

/** A 200 is only a claim of completion: the consumer must independently reload DB evidence before ACK. */
export function createCloudRunClient(
  options: {
    enabled?: boolean;
    serviceUrl?: string;
    idToken?: (signal: AbortSignal) => Promise<string>;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): CloudRunClient | null {
  if (options.enabled !== true) return null;
  const { serviceUrl, idToken, fetcher = fetch, timeoutMs = 145000 } = options;
  if (
    !origin(serviceUrl) ||
    typeof idToken !== "function" ||
    typeof fetcher !== "function" ||
    !integer(timeoutMs) ||
    timeoutMs > 145000
  )
    throw new Error("INVALID_CLOUD_RUN_CONFIG");
  const endpoint = `${serviceUrl}/internal/process`;
  return Object.freeze({
    async process(value: ProcessingJob, signal?: AbortSignal) {
      const ref = job(value);
      return bounded(timeoutMs, signal, async (active) => {
        const token = await idToken(active);
        if (active.aborted) fail();
        const claims = jwt(token).claims;
        if (
          claims.aud !== serviceUrl ||
          !integer(claims.exp) ||
          claims.exp <= Math.floor(Date.now() / 1000)
        )
          fail();
        const response = await fetcher(endpoint, {
          method: "POST",
          redirect: "manual",
          cache: "no-store",
          signal: active,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
            "accept-encoding": "identity",
          },
          body: JSON.stringify(ref),
        });
        const result = await responseJson(response, endpoint, active, 4096);
        if (
          !object(result) ||
          !exact(result, ["stage", "outcome", "processComplete"]) ||
          result.stage !== "moderation" ||
          !["moderation_recorded", "moderation_already_recorded"].includes(
            result.outcome as string,
          ) ||
          result.processComplete !== true
        )
          fail();
        return true;
      });
    },
  });
}
