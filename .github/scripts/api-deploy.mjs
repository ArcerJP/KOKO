import { appendFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const mainRefUrl =
  "https://api.github.com/repos/ArcerJP/KOKO/git/ref/heads/main";
const shaPattern = /^[a-f0-9]{40}$/;

class DeploymentStopped extends Error {}

function requireCondition(condition, reason) {
  if (!condition) throw new DeploymentStopped(reason);
}

// This check runs without credentials in verify and again immediately before deploy.
export function deploymentAllowed(env) {
  requireCondition(env.GITHUB_ACTIONS === "true", "NOT_GITHUB_ACTIONS");
  requireCondition(
    env.GITHUB_REPOSITORY === "ArcerJP/KOKO",
    "REPOSITORY_DENIED",
  );
  requireCondition(env.GITHUB_REF === "refs/heads/main", "REF_DENIED");
  requireCondition(
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "EVENT_DENIED",
  );
  requireCondition(shaPattern.test(env.GITHUB_SHA ?? ""), "INVALID_SHA");
  return (
    env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
    env.KOKO_API_AUTO_DEPLOY_ENABLED === "true"
  );
}

export async function guardedDeploy(env, { readHead, fetchMain, runDeploy }) {
  requireCondition(deploymentAllowed(env), "AUTO_DEPLOY_DISABLED");
  requireCondition(
    env.KOKO_API_VERIFY_RESULT === "success",
    "VERIFY_NOT_SUCCESS",
  );
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "GITHUB_TOKEN",
  ]) {
    requireCondition(
      typeof env[key] === "string" && env[key].trim().length > 0,
      "MISSING_CREDENTIAL",
    );
  }
  requireCondition(readHead() === env.GITHUB_SHA, "CHECKOUT_SHA_MISMATCH");

  // Fixed read-only endpoint. Never send the Cloudflare credentials to GitHub.
  const response = await fetchMain(mainRefUrl, {
    method: "GET",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  requireCondition(response.ok, "MAIN_LOOKUP_FAILED");
  const main = await response.json();
  requireCondition(
    main?.ref === "refs/heads/main" &&
      main?.object?.type === "commit" &&
      shaPattern.test(main?.object?.sha ?? ""),
    "INVALID_MAIN_RESPONSE",
  );
  requireCondition(main.object.sha === env.GITHUB_SHA, "STALE_MAIN_SHA");

  // Do not pass the GitHub credential to npm/Wrangler or print any secret values.
  const deployEnv = { ...env };
  delete deployEnv.GITHUB_TOKEN;
  const result = runDeploy(
    "npm",
    ["run", "deploy", "--workspace", "@koko/api"],
    {
      env: deployEnv,
      shell: false,
      stdio: "inherit",
    },
  );
  requireCondition(
    !result.error && !result.signal && result.status === 0,
    "DEPLOY_FAILED_CHECK_ACTIVE_VERSION_BEFORE_RETRY",
  );
}

export async function main(args, env, dependencies) {
  requireCondition(args.length === 1, "INVALID_ARGUMENTS");
  if (args[0] === "gate") {
    const allowed = deploymentAllowed(env);
    requireCondition(Boolean(env.GITHUB_OUTPUT), "MISSING_GITHUB_OUTPUT");
    dependencies.writeOutput(env.GITHUB_OUTPUT, `deploy_allowed=${allowed}\n`);
  } else if (args[0] === "deploy") {
    await guardedDeploy(env, dependencies);
  } else {
    throw new DeploymentStopped("INVALID_MODE");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.argv.slice(2), process.env, {
      writeOutput: appendFileSync,
      readHead: () =>
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      fetchMain: globalThis.fetch,
      runDeploy: spawnSync,
    });
  } catch (error) {
    // Network/process errors can contain credentials. Only our fixed reasons are safe.
    const reason =
      error instanceof DeploymentStopped ? error.message : "GUARD_FAILED";
    process.stderr.write(`API deployment stopped: ${reason}\n`);
    process.exitCode = 1;
  }
}
