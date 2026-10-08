import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
export type GoogleCallerConfig = {
  audience: string;
  callerEmail: string;
  callerSubject: string;
};

/** Validate a Google-signed service account ID token, never a browser identity. */
export function createGoogleCallerVerifier(
  config: GoogleCallerConfig,
  fetcher: typeof fetch = fetch,
): (authorization: string | null) => Promise<boolean> {
  if (
    !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+run\.app$/.test(
      config.audience,
    ) ||
    config.audience.length > 253 ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      config.callerEmail,
    ) ||
    !/^[0-9]{10,30}$/.test(config.callerSubject) ||
    typeof fetcher !== "function"
  )
    throw new Error("INVALID_SERVICE_AUTH_CONFIG");
  const { audience, callerEmail, callerSubject } = config;
  const resolver = createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 300000,
    [customFetch]: async (url, options) => {
      if (url !== jwksUrl) throw new Error("INVALID_JWKS_SOURCE");
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, options.signal]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetcher(jwksUrl, {
              method: "GET",
              redirect: "manual",
              cache: "no-store",
              signal,
              headers: { accept: "application/json" },
            });
            if (signal.aborted) {
              void response.body?.cancel().catch(() => {});
              throw new Error("JWKS_UNAVAILABLE");
            }
            reader = response.body?.getReader();
            const length = response.headers.get("content-length");
            if (
              response.status !== 200 ||
              response.redirected ||
              (response.url && response.url !== jwksUrl) ||
              !reader ||
              !/^application\/json(?:\s*;|$)/i.test(
                response.headers.get("content-type") ?? "",
              ) ||
              (length !== null &&
                (!/^\d+$/.test(length) || Number(length) > 65536))
            )
              throw new Error("JWKS_UNAVAILABLE");
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
              const next = await reader.read();
              if (signal.aborted) throw new Error("JWKS_UNAVAILABLE");
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 65536) throw new Error("JWKS_UNAVAILABLE");
              chunks.push(next.value);
            }
            if (length !== null && Number(length) !== size)
              throw new Error("JWKS_UNAVAILABLE");
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
            return new Response(text, {
              headers: { "content-type": "application/json" },
            });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("JWKS_UNAVAILABLE"));
              controller.abort();
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
    },
  });
  return async (authorization) => {
    const match =
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
        authorization ?? "",
      );
    if (!match?.[1] || match[1].length > 8192) return false;
    try {
      const { payload, protectedHeader } = await jwtVerify(match[1], resolver, {
        algorithms: ["RS256"],
        audience,
        subject: callerSubject,
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        requiredClaims: [
          "iss",
          "aud",
          "sub",
          "iat",
          "exp",
          "email",
          "email_verified",
        ],
        maxTokenAge: 3600,
        clockTolerance: 5,
      });
      const now = Date.now() / 1000;
      return (
        Object.keys(protectedHeader).every((k) =>
          ["alg", "kid", "typ"].includes(k),
        ) &&
        typeof protectedHeader.kid === "string" &&
        protectedHeader.kid.length > 0 &&
        protectedHeader.kid.length <= 256 &&
        payload.aud === audience &&
        payload.email === callerEmail &&
        payload.email_verified === true &&
        Number.isSafeInteger(payload.iat) &&
        Number.isSafeInteger(payload.exp) &&
        payload.iat! <= now + 5 &&
        payload.exp! > now &&
        payload.exp! > payload.iat! &&
        payload.exp! - payload.iat! <= 3605
      );
    } catch {
      return false; // Never log JWT, claims, keys or provider exception text.
    }
  };
}
