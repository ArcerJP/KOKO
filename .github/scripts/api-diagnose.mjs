import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const worker = "koko-api-dev";
const apiOrigin = "https://api.cloudflare.com/client/v4";
const workflowRef =
  "ArcerJP/KOKO/.github/workflows/api-diagnose.yml@refs/heads/main";
const shaPattern = /^[a-f0-9]{40}$/;
const maxResponseBytes = 256 * 1024;
const requestTimeoutMs = 15_000;

class DiagnosticStopped extends Error {}
class ResponseTooLarge extends Error {}

function requireCondition(condition, reason) {
  if (!condition) throw new DiagnosticStopped(reason);
}

function validateContext(env, readHead) {
  requireCondition(env.GITHUB_ACTIONS === "true", "NOT_GITHUB_ACTIONS");
  requireCondition(
    env.GITHUB_REPOSITORY === "ArcerJP/KOKO",
    "REPOSITORY_DENIED",
  );
  requireCondition(env.GITHUB_REF === "refs/heads/main", "REF_DENIED");
  requireCondition(
    env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "EVENT_DENIED",
  );
  requireCondition(env.GITHUB_WORKFLOW_REF === workflowRef, "WORKFLOW_DENIED");
  requireCondition(shaPattern.test(env.GITHUB_SHA ?? ""), "INVALID_SHA");
  requireCondition(readHead() === env.GITHUB_SHA, "CHECKOUT_SHA_MISMATCH");
  requireCondition(
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? ""),
    "INVALID_ACCOUNT_ID",
  );
  requireCondition(
    typeof env.CLOUDFLARE_API_TOKEN === "string" &&
      /^[\x21-\x7e]{1,2048}$/.test(env.CLOUDFLARE_API_TOKEN),
    "INVALID_CREDENTIAL",
  );
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        // Cancellation failures must not replace the fixed, safe diagnosis.
        await reader.cancel().catch(() => {});
        throw new ResponseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new globalThis.Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new globalThis.TextDecoder().decode(bytes));
}

function numericErrorCodes(data) {
  if (!Array.isArray(data?.errors)) return [];
  return [
    ...new Set(
      data.errors
        .map((error) => error?.code)
        .filter(
          (code) => Number.isSafeInteger(code) && code >= 0 && code <= 1e9,
        ),
    ),
  ].slice(0, 10);
}

async function inspectEndpoint(check, path, token, fetchApi) {
  const summary = {
    check,
    httpStatus: null,
    result: "REQUEST_FAILED",
    errorCodes: [],
  };
  try {
    const response = await fetchApi(`${apiOrigin}${path}`, {
      method: "GET",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (
      !Number.isInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      return { summary: { ...summary, result: "INVALID_RESPONSE" } };
    }
    summary.httpStatus = response.status;
    let data;
    try {
      data = await readJson(response);
    } catch (error) {
      summary.result =
        error instanceof ResponseTooLarge
          ? "BODY_TOO_LARGE"
          : response.status < 200 || response.status >= 300
            ? "HTTP_ERROR"
            : "INVALID_BODY";
      return { summary };
    }
    summary.errorCodes = numericErrorCodes(data);
    summary.result =
      response.status < 200 || response.status >= 300
        ? "HTTP_ERROR"
        : data?.success === false
          ? "API_ERROR"
          : data?.success === true && Object.hasOwn(data, "result")
            ? "OK"
            : "INVALID_RESPONSE";
    // Raw data stays in memory; callers emit only the explicitly selected summary.
    return { summary, data };
  } catch {
    // Fetch exceptions may contain the token, URL, headers or response body.
    return { summary };
  }
}

export async function diagnose(env, { readHead, fetchApi, writeLine }) {
  validateContext(env, readHead);
  const account = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers`;
  const service = `${account}/services/${worker}`;
  const report = (summary) => writeLine(JSON.stringify(summary));
  const metadata = await inspectEndpoint(
    "service_metadata",
    service,
    env.CLOUDFLARE_API_TOKEN,
    fetchApi,
  );
  report(metadata.summary);
  if (metadata.summary.result !== "OK") return 1;

  const remote = metadata.data?.result?.default_environment;
  // Never trust a response-supplied host/path or fall back to a guessed environment.
  requireCondition(
    typeof remote?.environment === "string" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(remote.environment),
    "INVALID_REMOTE_ENVIRONMENT",
  );
  const source = remote.script?.last_deployed_from;
  report({
    check: "deployment_source",
    source: ["dash", "api", "wrangler"].includes(source) ? source : "other",
  });

  const environment = remote.environment;
  const base = `${service}/environments/${environment}`;
  // Match Wrangler 4.147.0 fetchWorkerConfig; no command, target or URL inputs.
  const endpoints = [
    ["bindings", `${base}/bindings`],
    ["routes", `${base}/routes?show_zonename=true`],
    [
      "custom_domains",
      `${account}/domains/records?page=0&per_page=5&service=${worker}&environment=${environment}`,
    ],
    ["subdomain", `${base}/subdomain`],
    ["service_environment", base],
    ["schedules", `${account}/scripts/${worker}/schedules`],
  ];
  let failed = false;
  // One request per endpoint, sequentially, without retrying 401/403/429/5xx.
  for (const [check, path] of endpoints) {
    const { summary } = await inspectEndpoint(
      check,
      path,
      env.CLOUDFLARE_API_TOKEN,
      fetchApi,
    );
    report(summary);
    failed ||= summary.result !== "OK";
  }
  report({
    check: "diagnostic_result",
    result: failed ? "METADATA_READ_FAILED" : "ALL_METADATA_READS_OK",
  });
  return failed ? 1 : 0;
}

export async function main(args, env, dependencies) {
  try {
    requireCondition(args.length === 0, "INVALID_ARGUMENTS");
    return await diagnose(env, dependencies);
  } catch (error) {
    dependencies.writeLine(
      JSON.stringify({
        check: "diagnostic_guard",
        result:
          error instanceof DiagnosticStopped ? error.message : "GUARD_FAILED",
      }),
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    readHead: () =>
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // This job runs on Ubuntu. Do not pass any credentials to the Git process.
        env: { PATH: process.env.PATH },
      }).trim(),
    fetchApi: globalThis.fetch,
    writeLine: (line) => process.stdout.write(`${line}\n`),
  });
}
