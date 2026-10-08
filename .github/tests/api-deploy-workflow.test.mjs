import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  deploymentAllowed,
  guardedDeploy,
  main,
} from "../scripts/api-deploy.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = parse(read("../workflows/api-deploy.yml"));
const sha = "a".repeat(40);
const context = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "ArcerJP/KOKO",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: sha,
  KOKO_API_AUTO_DEPLOY_ENABLED: "true",
  KOKO_API_VERIFY_RESULT: "success",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-test-value",
  CLOUDFLARE_ACCOUNT_ID: "synthetic-account-test-value",
  GITHUB_TOKEN: "synthetic-github-test-value",
};

function simulation(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      readHead: () => sha,
      fetchMain: async (url, options) => {
        calls.push({ kind: "read", url, options });
        return {
          ok: true,
          json: async () => ({
            ref: "refs/heads/main",
            object: { type: "commit", sha },
          }),
        };
      },
      runDeploy: (...args) => {
        calls.push({ kind: "deploy", args });
        return { status: 0 };
      },
      ...overrides,
    },
  };
}

function assertWorkflowBoundary(w) {
  assert.deepEqual(w.on, {
    push: { branches: ["main"] },
    workflow_dispatch: null,
  });
  assert.deepEqual(w.permissions, { contents: "read" });
  assert.deepEqual(w.concurrency, {
    group: "koko-api-dev-deploy",
    "cancel-in-progress": false,
  });
  assert.deepEqual(w.env, {
    HUSKY: "0",
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
  });
  assert.deepEqual(Object.keys(w.jobs).sort(), ["deploy", "verify"]);
  const { verify, deploy } = w.jobs;
  assert.equal(
    verify.if,
    "github.repository == 'ArcerJP/KOKO' && github.ref == 'refs/heads/main' && " +
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  );
  assert.equal(verify.environment, undefined);
  assert.equal(verify.needs, undefined);
  assert.deepEqual(verify.outputs, {
    deploy_allowed: "${{ steps.gate.outputs.deploy_allowed }}",
  });
  assert.equal(deploy.needs, "verify");
  assert.equal(
    deploy.if,
    "needs.verify.result == 'success' && needs.verify.outputs.deploy_allowed == 'true'",
  );
  assert.equal(deploy.environment, "koko-api-dev");
  for (const job of [verify, deploy]) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job["timeout-minutes"], 15);
    for (const forbidden of [
      "env",
      "permissions",
      "continue-on-error",
      "strategy",
      "defaults",
      "uses",
    ]) {
      assert.equal(job[forbidden], undefined);
    }
    assert.deepEqual(
      job.steps.filter((s) => s.uses),
      [
        {
          uses: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
          with: {
            repository: "ArcerJP/KOKO",
            ref: "${{ github.sha }}",
            "persist-credentials": false,
          },
        },
        {
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24", "package-manager-cache": false },
        },
      ],
    );
    for (const step of job.steps) {
      for (const forbidden of [
        "if",
        "continue-on-error",
        "working-directory",
        "shell",
      ]) {
        assert.equal(step[forbidden], undefined);
      }
    }
  }
  assert.deepEqual(
    verify.steps.filter((s) => s.run).map((s) => s.run),
    [
      "node .github/scripts/api-deploy.mjs gate",
      "npm ci --include=dev --strict-peer-deps",
      "npm run test:deploy-workflow",
      "npm run typecheck:api",
      "npm run test:api",
      "npm run build:api",
    ],
  );
  assert.deepEqual(verify.steps.find((s) => s.id === "gate")?.env, {
    KOKO_API_AUTO_DEPLOY_ENABLED: "${{ vars.KOKO_API_AUTO_DEPLOY_ENABLED }}",
  });
  assert.deepEqual(
    deploy.steps.filter((s) => s.run).map((s) => s.run),
    [
      "npm ci --include=dev --strict-peer-deps",
      "npm run build:shared",
      "node .github/scripts/api-deploy.mjs deploy",
    ],
  );
  const writeStep = deploy.steps.at(-1);
  assert.deepEqual(writeStep.env, {
    KOKO_API_AUTO_DEPLOY_ENABLED: "${{ vars.KOKO_API_AUTO_DEPLOY_ENABLED }}",
    KOKO_API_VERIFY_RESULT: "${{ needs.verify.result }}",
    GITHUB_TOKEN: "${{ github.token }}",
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  });
  // No secret reference anywhere except the final write step, including future fields.
  const withoutWrite = globalThis.structuredClone(w);
  withoutWrite.jobs.deploy.steps.pop();
  assert.doesNotMatch(JSON.stringify(withoutWrite), /secrets\s*[.[\]]/i);
}

test("actual workflow preserves the deployment and credential boundaries", () => {
  assertWorkflowBoundary(workflow);
  const checks = parse(read("../workflows/api-check.yml"));
  assert.deepEqual(
    Object.values(checks.jobs).map((j) => j.name),
    ["API Type Check", "API Tests", "API Build"],
  );
  assert(
    checks.jobs.test.steps.some(
      (s) => s.run === "npm run test:deploy-workflow",
    ),
  );
  assert(checks.jobs.test.steps.some((s) => s.run === "npm run test:api"));
  const pkg = JSON.parse(read("../../package.json"));
  assert(pkg.scripts.test.includes("npm run test:deploy-workflow"));
  assert.equal(
    JSON.parse(read("../../apps/api/package.json")).scripts.deploy,
    "wrangler deploy --strict",
  );
  for (const lifecycle of ["prebuild", "predeploy"]) {
    assert.equal(
      JSON.parse(read("../../apps/api/package.json")).scripts[lifecycle],
      "node ../../.github/scripts/patch-wrangler-r2.mjs",
    );
  }
  assert.equal(
    parse(read("../../apps/api/wrangler.jsonc")).name,
    "koko-api-dev",
  );
});

const mutations = {
  "missing deployment contract build": (w) => {
    w.jobs.deploy.steps = w.jobs.deploy.steps.filter(
      (s) => s.run !== "npm run build:shared",
    );
  },
  "credentials in contract build": (w) => {
    w.jobs.deploy.steps.find((s) => s.run === "npm run build:shared").env = {
      TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    };
  },
  "PR trigger": (w) => {
    w.on.pull_request = null;
  },
  "manual ref input": (w) => {
    w.on.workflow_dispatch = { inputs: { ref: {} } };
  },
  "other branch": (w) => {
    w.on.push.branches.push("dev");
  },
  "repository guard": (w) => {
    w.jobs.verify.if = "true";
  },
  "unconditional deploy": (w) => {
    w.jobs.deploy.if = "always()";
  },
  "no verification dependency": (w) => {
    delete w.jobs.deploy.needs;
  },
  "credentials in verification": (w) => {
    w.jobs.verify.env = { TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" };
  },
  "credentials in install": (w) => {
    w.jobs.deploy.steps[2].env = {
      TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    };
  },
  "mutable Action": (w) => {
    w.jobs.deploy.steps[0].uses = "actions/checkout@v6";
  },
  "floating source": (w) => {
    w.jobs.deploy.steps[0].with.ref = "main";
  },
  "persist Git credentials": (w) => {
    w.jobs.verify.steps[0].with["persist-credentials"] = true;
  },
  "write permission": (w) => {
    w.permissions.contents = "write";
  },
  "missing environment": (w) => {
    delete w.jobs.deploy.environment;
  },
  "cancel a running deployment": (w) => {
    w.concurrency["cancel-in-progress"] = true;
  },
  "manual/auto separate concurrency": (w) => {
    w.concurrency.group += "-${{ github.event_name }}";
  },
  "ignore failing tests": (w) => {
    w.jobs.verify.steps.at(-2)["continue-on-error"] = true;
  },
  "skip tests": (w) => {
    w.jobs.verify.steps.at(-2).if = "false";
  },
  "bypass runtime guard": (w) => {
    w.jobs.deploy.steps.at(-1).run = "npm run deploy --workspace @koko/api";
  },
  "unbounded job": (w) => {
    delete w.jobs.deploy["timeout-minutes"];
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`unsafe workflow fixture rejected: ${name}`, () => {
    const fixture = globalThis.structuredClone(workflow);
    mutate(fixture);
    assert.throws(() => assertWorkflowBoundary(fixture));
  });
}

function assertApiPreparation(pkg, command, workspaceCommand) {
  assert.equal(
    pkg.scripts["build:contract"],
    "npm run build --workspace @koko/contract",
  );
  assert.equal(
    pkg.scripts["build:processing"],
    "npm run build --workspace @koko/processing",
  );
  assert.equal(
    pkg.scripts["build:shared"],
    "npm run build:contract && npm run build:processing",
  );
  assert.equal(
    pkg.scripts[command],
    `npm run build:shared && npm run ${workspaceCommand} --workspace @koko/api`,
  );
}

for (const [command, workspaceCommand] of [
  ["typecheck:api", "typecheck"],
  ["test:api", "test"],
  ["build:api", "build"],
]) {
  test(`${command} builds the contract before the isolated API command`, () => {
    assertApiPreparation(
      JSON.parse(read("../../package.json")),
      command,
      workspaceCommand,
    );
  });
  for (const [name, script] of [
    ["missing build", `npm run ${workspaceCommand} --workspace @koko/api`],
    [
      "reversed order",
      `npm run ${workspaceCommand} --workspace @koko/api && npm run build:shared`,
    ],
    [
      "ignored build failure",
      `npm run build:shared ; npm run ${workspaceCommand} --workspace @koko/api`,
    ],
  ]) {
    test(`${command} rejects ${name}`, () => {
      const fixture = JSON.parse(read("../../package.json"));
      fixture.scripts[command] = script;
      assert.throws(() =>
        assertApiPreparation(fixture, command, workspaceCommand),
      );
    });
  }
}

for (const flag of [
  undefined,
  "",
  "false",
  "TRUE",
  "True",
  " true",
  "true ",
  "1",
  "yes",
]) {
  test(`automatic deployment fails closed for flag ${JSON.stringify(flag)}`, async () => {
    const env = { ...context, KOKO_API_AUTO_DEPLOY_ENABLED: flag };
    assert.equal(deploymentAllowed(env), false);
    const sim = simulation();
    await assert.rejects(
      guardedDeploy(env, sim.dependencies),
      /AUTO_DEPLOY_DISABLED/,
    );
    assert.deepEqual(sim.calls, []);
  });
}

for (const event of ["push", "workflow_dispatch"]) {
  test(`verified latest main is deployed exactly once: ${event}`, async () => {
    const env = { ...context, GITHUB_EVENT_NAME: event };
    if (event === "workflow_dispatch") delete env.KOKO_API_AUTO_DEPLOY_ENABLED;
    const sim = simulation();
    await guardedDeploy(env, sim.dependencies);
    assert.deepEqual(
      sim.calls.map((c) => c.kind),
      ["read", "deploy"],
    );
    assert.equal(
      sim.calls[0].url,
      "https://api.github.com/repos/ArcerJP/KOKO/git/ref/heads/main",
    );
    assert.equal(sim.calls[0].options.method, "GET");
    assert.equal(sim.calls[0].options.redirect, "error");
    assert.doesNotMatch(JSON.stringify(sim.calls[0]), /synthetic-cloudflare/);
    const [command, args, options] = sim.calls[1].args;
    assert.equal(command, "npm");
    assert.deepEqual(args, ["run", "deploy", "--workspace", "@koko/api"]);
    assert.equal(options.shell, false);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
    assert.equal(env.GITHUB_TOKEN, context.GITHUB_TOKEN);
  });
}

const deniedContexts = [
  { GITHUB_ACTIONS: undefined },
  { GITHUB_REPOSITORY: "fork/KOKO" },
  { GITHUB_REF: "refs/heads/dev" },
  { GITHUB_REF: "refs/tags/main" },
  { GITHUB_EVENT_NAME: "pull_request" },
  { GITHUB_EVENT_NAME: "pull_request_target" },
  { GITHUB_EVENT_NAME: "workflow_run" },
  { GITHUB_EVENT_NAME: "repository_dispatch" },
  { GITHUB_SHA: "main" },
  { KOKO_API_VERIFY_RESULT: "failure" },
  { KOKO_API_VERIFY_RESULT: "cancelled" },
  { KOKO_API_VERIFY_RESULT: "skipped" },
  { KOKO_API_VERIFY_RESULT: undefined },
  { CLOUDFLARE_API_TOKEN: "" },
  { CLOUDFLARE_ACCOUNT_ID: "   " },
  { GITHUB_TOKEN: undefined },
];
for (const overrides of deniedContexts) {
  test(`context denied before network/write: ${JSON.stringify(overrides)}`, async () => {
    const sim = simulation();
    await assert.rejects(
      guardedDeploy({ ...context, ...overrides }, sim.dependencies),
    );
    assert.deepEqual(sim.calls, []);
  });
}

test("checkout mismatch stops before network/write", async () => {
  const sim = simulation({ readHead: () => "b".repeat(40) });
  await assert.rejects(
    guardedDeploy(context, sim.dependencies),
    /CHECKOUT_SHA_MISMATCH/,
  );
  assert.deepEqual(sim.calls, []);
});

for (const [name, fetchMain] of Object.entries({
  "HTTP failure": async () => ({ ok: false }),
  "network failure": async () => {
    throw new Error("synthetic transport error");
  },
  "malformed JSON": async () => ({
    ok: true,
    json: async () => {
      throw new Error("invalid JSON");
    },
  }),
  "unexpected schema": async () => ({ ok: true, json: async () => ({ sha }) }),
  "wrong ref": async () => ({
    ok: true,
    json: async () => ({
      ref: "refs/tags/main",
      object: { type: "commit", sha },
    }),
  }),
  "old commit": async () => ({
    ok: true,
    json: async () => ({
      ref: "refs/heads/main",
      object: { type: "commit", sha: "b".repeat(40) },
    }),
  }),
})) {
  test(`${name} never invokes deployment`, async () => {
    const sim = simulation({ fetchMain });
    await assert.rejects(guardedDeploy(context, sim.dependencies));
    assert.deepEqual(sim.calls, []);
  });
}

for (const result of [
  { status: 1 },
  { status: null, signal: "SIGTERM" },
  { error: new Error("spawn failed") },
]) {
  test(`deployment failure is not retried: ${JSON.stringify(result)}`, async () => {
    let attempts = 0;
    const sim = simulation({
      runDeploy: () => {
        attempts++;
        return result;
      },
    });
    await assert.rejects(
      guardedDeploy(context, sim.dependencies),
      /CHECK_ACTIVE_VERSION_BEFORE_RETRY/,
    );
    assert.equal(attempts, 1);
  });
}

test("gate outputs a boolean without credentials or deployment", async () => {
  for (const flag of ["true", "false", undefined]) {
    const output = [];
    const env = {
      ...context,
      GITHUB_OUTPUT: "synthetic-output",
      KOKO_API_AUTO_DEPLOY_ENABLED: flag,
    };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.GITHUB_TOKEN;
    await main(["gate"], env, { writeOutput: (...args) => output.push(args) });
    assert.deepEqual(output, [
      ["synthetic-output", `deploy_allowed=${flag === "true"}\n`],
    ]);
  }
});

test("CLI rejects extra inputs and unknown modes", async () => {
  await assert.rejects(
    main(["deploy", "--ref", "dev"], context, {}),
    /INVALID_ARGUMENTS/,
  );
  await assert.rejects(main(["unexpected"], context, {}), /INVALID_MODE/);
});

test("actual CLI fails closed and does not log credentials on invalid context", () => {
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/api-deploy.mjs", import.meta.url)),
      "deploy",
    ],
    {
      env: { ...process.env, ...context, GITHUB_REF: "refs/heads/dev" },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REF_DENIED/);
  assert.doesNotMatch(run.stdout + run.stderr, /synthetic-|Bearer/);
});
