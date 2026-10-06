import "server-only";
import { getContext, getVercelOidcTokenSync } from "@vercel/oidc";
import {
  createCloudRunClient,
  createWorkloadIdentityToken,
} from "@koko/processing/cloud-run-client";
import {
  processingId,
  processingJob,
  relayBody,
  relayBounded,
  relayOrigin,
  relayPath,
  relaySecret,
  verifyRelay,
} from "@koko/processing/relay";

export type ProcessingRelayConfig = Readonly<{
  enabled: boolean;
  production: boolean;
  origin: string;
  secret: string;
  eventId: string;
  serviceUrl: string;
  serviceAccountEmail: string;
  serviceAccountSubject: string;
  providerAudience: string;
  subjectIssuer: string;
  subjectAudience: string;
  subject: string;
  projectId: string;
}>;
export function processingRelayConfiguration(): ProcessingRelayConfig {
  return {
    enabled: process.env.KOKO_PROCESSING_RELAY_ENABLED === "true",
    production:
      process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production",
    origin: process.env.KOKO_PROCESSING_RELAY_ORIGIN ?? "",
    secret: process.env.KOKO_PROCESSING_RELAY_SECRET ?? "",
    eventId: process.env.KOKO_EVENT_ID ?? "",
    serviceUrl: process.env.KOKO_IMAGE_SERVICE_URL ?? "",
    serviceAccountEmail: process.env.KOKO_IMAGE_CALLER_EMAIL ?? "",
    serviceAccountSubject: process.env.KOKO_IMAGE_CALLER_SUBJECT ?? "",
    providerAudience: process.env.KOKO_GOOGLE_WIF_PROVIDER_AUDIENCE ?? "",
    subjectIssuer: process.env.KOKO_GOOGLE_WIF_SUBJECT_ISSUER ?? "",
    subjectAudience: process.env.KOKO_GOOGLE_WIF_SUBJECT_AUDIENCE ?? "",
    subject: process.env.KOKO_GOOGLE_WIF_SUBJECT ?? "",
    projectId: process.env.KOKO_VERCEL_PROJECT_ID ?? "",
  };
}
const response = (status: number, complete = false) =>
  Response.json(
    complete
      ? { stage: "moderation", processComplete: true }
      : { error: "PROCESSING_RELAY_UNAVAILABLE" },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
async function runtimeSubjectToken(): Promise<string> {
  // Require the native per-invocation context. Do not use a local file/env/CLI credential fallback or refresh.
  const native = getContext().headers?.["x-vercel-oidc-token"];
  if (typeof native !== "string" || native.length > 16384)
    throw new Error("PROCESSING_RELAY_UNAVAILABLE");
  return getVercelOidcTokenSync();
}
/** Machine endpoint: no session cookies, arbitrary destination, input token or credentials in output. */
export async function handleProcessingRelay(
  request: Request,
  config = processingRelayConfiguration(),
  fetcher: typeof fetch = fetch,
  subjectToken: (signal: AbortSignal) => Promise<string> = runtimeSubjectToken,
): Promise<Response> {
  if (!config.enabled || !config.production) return response(503);
  try {
    const url = new URL(request.url);
    const owner =
      /^https:\/\/oidc\.vercel\.com\/([a-z0-9][a-z0-9-]{0,62})$/.exec(
        config.subjectIssuer,
      )?.[1];
    if (
      !relayOrigin(config.origin) ||
      !relaySecret(config.secret) ||
      !processingId(config.eventId) ||
      !/^prj_[A-Za-z0-9]{10,64}$/.test(config.projectId) ||
      !owner ||
      config.subjectAudience !== `https://vercel.com/${owner}` ||
      !new RegExp(
        `^owner:${owner}:project:[a-z0-9][a-z0-9_-]{0,99}:environment:production$`,
      ).test(config.subject) ||
      typeof subjectToken !== "function"
    )
      return response(503);
    if (
      request.method !== "POST" ||
      url.origin !== config.origin ||
      url.pathname !== relayPath ||
      url.search ||
      request.headers.has("origin") ||
      request.headers.has("cookie") ||
      request.headers.has("authorization")
    )
      return response(403);
    const body = await relayBounded(5000, request.signal, (signal) =>
      relayBody(request, signal),
    );
    if (!(await verifyRelay(request, config.origin, config.secret, body)))
      return response(403);
    const job = processingJob(JSON.parse(body) as unknown);
    if (!job || job.eventId !== config.eventId) return response(403);
    const idToken = createWorkloadIdentityToken({
      enabled: true,
      serviceUrl: config.serviceUrl,
      serviceAccountEmail: config.serviceAccountEmail,
      serviceAccountSubject: config.serviceAccountSubject,
      providerAudience: config.providerAudience,
      subjectIssuer: config.subjectIssuer,
      subjectAudience: config.subjectAudience,
      subject: config.subject,
      subjectClaims: {
        project_id: config.projectId,
        environment: "production",
      },
      subjectToken,
      fetcher,
    });
    const client = createCloudRunClient({
      enabled: true,
      serviceUrl: config.serviceUrl,
      idToken: idToken!,
      fetcher,
    });
    const complete = await client!.process(job, request.signal);
    return complete ? response(200, true) : response(503);
  } catch {
    return response(503);
  }
}
