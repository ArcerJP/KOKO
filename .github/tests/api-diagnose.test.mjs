import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { parse } from "yaml";
import { main } from "../scripts/api-diagnose.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = parse(read("../workflows/api-diagnose.yml"));
const sha = "a".repeat(40);
const canary = "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_APPEAR";
const context = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "ArcerJP/KOKO",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF:
    "ArcerJP/KOKO/.github/workflows/api-diagnose.yml@refs/heads/main",
  GITHUB_SHA: sha,
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_API_TOKEN: canary,
};

function assertWorkflowBoundary(w) {
  assert.deepEqual(w, {
    name: "API Deploy Diagnostics",
    on: { workflow_dispatch: null },
    permissions: { contents: "read" },
    concurrency: {
      group: "koko-api-dev-diagnostics",
      "cancel-in-progress": false,
    },
    jobs: {
      diagnose: {
        name: "Read-only Cloudflare Metadata Diagnostics",
        if:
          "github.repository == 'ArcerJP/KOKO' && github.ref == 'refs/heads/main' && " +
          "github.event_name == 'workflow_dispatch'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        environment: "koko-api-dev",
        steps: [
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
          {
            name: "Read metadata without deploying or exposing response bodies",
            run: "node .github/scripts/api-diagnose.mjs",
            env: {
              CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
              CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
              NODE_OPTIONS: "",
              NODE_DEBUG: "",
              NODE_DEBUG_NATIVE: "",
            },
          },
        ],
      },
    },
  });
}

test("diagnostic workflow is manual, main-only, pinned and has no deploy/install/artifact step", () => {
  assertWorkflowBoundary(workflow);
  const deploy = parse(read("../workflows/api-deploy.yml"));
  assert.notEqual(workflow.concurrency.group, deploy.concurrency.group);
  assert.equal(
    workflow.jobs.diagnose.environment,
    deploy.jobs.deploy.environment,
  );
  assert.equal(
    JSON.parse(read("../../package.json")).scripts["test:deploy-workflow"],
    "node --test .github/tests/*.test.mjs",
  );
  assert(
    parse(read("../workflows/api-check.yml")).jobs.test.steps.some(
      (step) => step.run === "npm run test:deploy-workflow",
    ),
  );
  const script = read("../scripts/api-diagnose.mjs");
  assert.deepEqual(
    [...script.matchAll(/from "([^"]+)"/g)].map((match) => match[1]),
    ["node:child_process", "node:process", "node:url"],
  );
  assert.match(script, /env: \{ PATH: process.env.PATH \}/);
  assert.match(script, /const requestTimeoutMs = 15_000;/);
  assert.match(script, /AbortSignal.timeout\(requestTimeoutMs\)/);
});

const mutations = {
  "push trigger": (w) => {
    w.on.push = { branches: ["main"] };
  },
  "PR trigger": (w) => {
    w.on.pull_request = null;
  },
  "arbitrary URL input": (w) => {
    w.on.workflow_dispatch = { inputs: { url: {} } };
  },
  "unrestricted ref": (w) => {
    w.jobs.diagnose.if = "true";
  },
  "floating checkout": (w) => {
    w.jobs.diagnose.steps[0].with.ref = "main";
  },
  "mutable Action": (w) => {
    w.jobs.diagnose.steps[0].uses = "actions/checkout@v6";
  },
  "persist credentials": (w) => {
    w.jobs.diagnose.steps[0].with["persist-credentials"] = true;
  },
  "write permission": (w) => {
    w.permissions.contents = "write";
  },
  "no environment": (w) => {
    delete w.jobs.diagnose.environment;
  },
  "unbounded job": (w) => {
    delete w.jobs.diagnose["timeout-minutes"];
  },
  "secret in setup": (w) => {
    w.jobs.diagnose.steps[1].env = w.jobs.diagnose.steps[2].env;
  },
  "npm install": (w) => {
    w.jobs.diagnose.steps.splice(2, 0, { run: "npm ci" });
  },
  "deploy command": (w) => {
    w.jobs.diagnose.steps[2].run = "npm run deploy --workspace @koko/api";
  },
  "artifact upload": (w) => {
    w.jobs.diagnose.steps.push({ uses: "actions/upload-artifact@v4" });
  },
  "ignored error": (w) => {
    w.jobs.diagnose["continue-on-error"] = true;
  },
  "cancel deployment queue": (w) => {
    w.concurrency.group = "koko-api-dev-deploy";
  },
  "debug logging": (w) => {
    w.jobs.diagnose.steps[2].env.NODE_DEBUG = "http,https";
  },
  "GitHub token in diagnostic": (w) => {
    w.jobs.diagnose.steps[2].env.GITHUB_TOKEN = "${{ github.token }}";
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`unsafe diagnostic workflow rejected: ${name}`, () => {
    const fixture = globalThis.structuredClone(workflow);
    mutate(fixture);
    assert.throws(() => assertWorkflowBoundary(fixture));
  });
}

function response(data, status = 200) {
  return globalThis.Response.json(data, { status });
}

function simulation({
  reply,
  head = sha,
  environment = "production",
  source = "dash",
} = {}) {
  const calls = [];
  const lines = [];
  return {
    calls,
    lines,
    dependencies: {
      readHead: () => head,
      fetchApi: async (url, options) => {
        calls.push({ url, options });
        if (reply) {
          const custom = await reply(calls.length - 1, url, options);
          if (custom) return custom;
        }
        return response({
          success: true,
          result:
            calls.length === 1
              ? {
                  default_environment: {
                    environment,
                    script: { last_deployed_from: source },
                  },
                }
              : [{ text: canary, binding: canary }],
        });
      },
      writeLine: (line) => lines.push(line),
    },
  };
}

function assertNoLeak(sim) {
  const output = sim.lines.join("\n");
  for (const secret of [
    canary,
    context.CLOUDFLARE_ACCOUNT_ID,
    "Bearer",
    "https://",
    "::error::",
  ]) {
    assert(
      !output.includes(secret),
      `unexpected sensitive/dynamic content: ${secret}`,
    );
  }
  for (const line of sim.lines) assert.doesNotThrow(() => JSON.parse(line));
}

const expectedR2Bindings = [
  {
    type: "r2_bucket",
    name: "ORIGINALS_BUCKET",
    bucket_name: "koko-dev-originals",
  },
  {
    type: "r2_bucket",
    name: "DERIVED_BUCKET",
    bucket_name: "koko-dev-derived",
  },
];

async function observeR2(bindings) {
  const sim = simulation({
    reply: (n) =>
      n === 1 ? response({ success: true, result: bindings }) : null,
  });
  assert.equal(await main([], context, sim.dependencies), 0);
  assert.equal(sim.calls.length, 7);
  assertNoLeak(sim);
  const rows = sim.lines
    .map(JSON.parse)
    .filter((row) => row.check === "r2_binding_shape");
  assert.equal(rows.length, 1);
  return rows[0];
}

test("R2 shape reports only expected pairs and missing jurisdiction, without extra requests", async () => {
  const summary = await observeR2([
    ...expectedR2Bindings.toReversed(),
    { type: "secret_text", name: canary, text: canary },
    { type: "plain_text", name: canary, text: canary },
  ]);
  assert.deepEqual(summary, {
    check: "r2_binding_shape",
    result: "OBSERVED",
    r2Count: 2,
    expectedPairsMatch: true,
    bindings: ["ORIGINALS_BUCKET", "DERIVED_BUCKET"].map((binding) => ({
      binding,
      matches: 1,
      bucketMatches: true,
      jurisdiction: "ABSENT",
    })),
  });
});

for (const [value, expected] of [
  [null, "NULL"],
  ["", "EMPTY"],
  ["eu", "EU"],
  ["fedramp", "FEDRAMP"],
  [canary, "OTHER"],
  [`::error::${canary}`, "OTHER"],
  [0, "OTHER"],
  [false, "OTHER"],
  [{ text: canary }, "OTHER"],
  [[canary], "OTHER"],
]) {
  test(`R2 jurisdiction ${expected} is classified without echoing arbitrary values (${typeof value})`, async () => {
    const summary = await observeR2(
      expectedR2Bindings.map((b) => ({ ...b, jurisdiction: value })),
    );
    assert.equal(summary.expectedPairsMatch, true);
    assert.deepEqual(
      summary.bindings.map((b) => b.jurisdiction),
      [expected, expected],
    );
  });
}

test("unknown R2 names and bucket values never leak", async () => {
  const summary = await observeR2([
    { ...expectedR2Bindings[0], bucket_name: canary },
    expectedR2Bindings[1],
    {
      type: "r2_bucket",
      name: canary,
      bucket_name: canary,
      jurisdiction: canary,
    },
  ]);
  assert.equal(summary.r2Count, 3);
  assert.equal(summary.expectedPairsMatch, false);
  assert.equal(summary.bindings[0].bucketMatches, false);
});

test("missing and duplicate expected R2 bindings are not treated as a match", async () => {
  for (const input of [
    [],
    [expectedR2Bindings[0]],
    [expectedR2Bindings[0], expectedR2Bindings[0]],
  ]) {
    const summary = await observeR2(input);
    assert.equal(summary.expectedPairsMatch, false);
    assert.equal(summary.bindings[1].matches, 0);
    assert.equal(summary.bindings[1].jurisdiction, "UNAVAILABLE");
    if (input.length === 2) {
      assert.equal(summary.bindings[0].matches, 2);
      assert.equal(summary.bindings[0].bucketMatches, null);
      assert.equal(summary.bindings[0].jurisdiction, "UNAVAILABLE");
    }
  }
});

for (const input of [
  null,
  {},
  canary,
  [null],
  [canary],
  [{}],
  [{ type: 123 }],
  [[]],
]) {
  test("malformed R2 binding envelope produces a fixed observation failure", async () => {
    assert.deepEqual(await observeR2(input), {
      check: "r2_binding_shape",
      result: "INVALID_BINDINGS",
    });
  });
}

test("HTTP and API errors never inspect or report R2 response data", async () => {
  for (const status of [200, 403]) {
    const sim = simulation({
      reply: (n) =>
        n === 1
          ? response(
              {
                success: false,
                result: expectedR2Bindings,
                errors: [{ code: 10000, message: canary }],
              },
              status,
            )
          : null,
    });
    assert.equal(await main([], context, sim.dependencies), 1);
    assert.equal(sim.calls.length, 7);
    assert(
      !sim.lines
        .map(JSON.parse)
        .some((row) => row.check === "r2_binding_shape"),
    );
    assertNoLeak(sim);
  }
});

test("seven exact Cloudflare GETs, derived environment, no redirects, no request body", async () => {
  const sim = simulation({ environment: "staging_2" });
  assert.equal(await main([], context, sim.dependencies), 0);
  const root = `https://api.cloudflare.com/client/v4/accounts/${context.CLOUDFLARE_ACCOUNT_ID}/workers`;
  const service = `${root}/services/koko-api-dev`;
  const base = `${service}/environments/staging_2`;
  assert.deepEqual(
    sim.calls.map((call) => call.url),
    [
      service,
      `${base}/bindings`,
      `${base}/routes?show_zonename=true`,
      `${root}/domains/records?page=0&per_page=5&service=koko-api-dev&environment=staging_2`,
      `${base}/subdomain`,
      base,
      `${root}/scripts/koko-api-dev/schedules`,
    ],
  );
  for (const { options } of sim.calls) {
    assert.deepEqual(Object.keys(options).sort(), [
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof globalThis.AbortSignal);
    assert.deepEqual(options.headers, {
      Accept: "application/json",
      Authorization: `Bearer ${canary}`,
    });
  }
  assert.deepEqual(JSON.parse(sim.lines.at(-1)), {
    check: "diagnostic_result",
    result: "ALL_METADATA_READS_OK",
  });
  assertNoLeak(sim);
});

const deniedContexts = [
  { GITHUB_ACTIONS: undefined },
  { GITHUB_REPOSITORY: "fork/KOKO" },
  { GITHUB_REF: "refs/heads/dev" },
  { GITHUB_REF: "refs/tags/main" },
  { GITHUB_EVENT_NAME: "push" },
  { GITHUB_EVENT_NAME: "pull_request" },
  { GITHUB_EVENT_NAME: "pull_request_target" },
  { GITHUB_EVENT_NAME: "workflow_run" },
  { GITHUB_WORKFLOW_REF: context.GITHUB_WORKFLOW_REF.replace("main", "dev") },
  { GITHUB_WORKFLOW_REF: undefined },
  { GITHUB_SHA: "main" },
  { CLOUDFLARE_ACCOUNT_ID: "../other" },
  { CLOUDFLARE_ACCOUNT_ID: undefined },
  { CLOUDFLARE_API_TOKEN: "" },
  { CLOUDFLARE_API_TOKEN: undefined },
  { CLOUDFLARE_API_TOKEN: ` ${canary}` },
  { CLOUDFLARE_API_TOKEN: `${canary}\nInjected: value` },
];
for (const [index, overrides] of deniedContexts.entries()) {
  test(`diagnostic context ${index + 1} rejected before network`, async () => {
    const sim = simulation();
    assert.equal(
      await main([], { ...context, ...overrides }, sim.dependencies),
      1,
    );
    assert.equal(sim.calls.length, 0);
    assertNoLeak(sim);
  });
}

test("wrong checkout and extra CLI arguments stop before network", async () => {
  for (const [args, head] of [
    [[], "c".repeat(40)],
    [["--url", "https://example.invalid"], sha],
  ]) {
    const sim = simulation({ head });
    assert.equal(await main(args, context, sim.dependencies), 1);
    assert.equal(sim.calls.length, 0);
    assertNoLeak(sim);
  }
});

test("metadata HTTP failure stops without guessing environment or retrying", async () => {
  const sim = simulation({
    reply: () =>
      response(
        { success: false, errors: [{ code: 10000, message: canary }] },
        403,
      ),
  });
  assert.equal(await main([], context, sim.dependencies), 1);
  assert.equal(sim.calls.length, 1);
  assert.deepEqual(JSON.parse(sim.lines[0]), {
    check: "service_metadata",
    httpStatus: 403,
    result: "HTTP_ERROR",
    errorCodes: [10000],
  });
  assertNoLeak(sim);
});

for (let index = 1; index <= 6; index++) {
  test(`metadata endpoint ${index} failure is isolated; all others are checked once`, async () => {
    const status = [401, 403, 404, 429, 500, 503][index - 1];
    const sim = simulation({
      reply: (n) =>
        n === index
          ? response(
              { success: false, errors: [{ code: 10000, message: canary }] },
              status,
            )
          : null,
    });
    assert.equal(await main([], context, sim.dependencies), 1);
    assert.equal(sim.calls.length, 7);
    const failures = sim.lines
      .map(JSON.parse)
      .filter((row) => row.result === "HTTP_ERROR");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].httpStatus, status);
    assert.deepEqual(failures[0].errorCodes, [10000]);
    assert.equal(JSON.parse(sim.lines.at(-1)).result, "METADATA_READ_FAILED");
    assertNoLeak(sim);
  });
}

for (const [name, reply, expected] of [
  [
    "transport error",
    () => {
      throw new Error(`${canary} Authorization: Bearer ${canary}`);
    },
    "REQUEST_FAILED",
  ],
  [
    "timeout",
    () => {
      throw new globalThis.DOMException(canary, "TimeoutError");
    },
    "REQUEST_FAILED",
  ],
  [
    "redirect rejected",
    (_n, _url, options) => {
      assert.equal(options.redirect, "error");
      throw new TypeError(canary);
    },
    "REQUEST_FAILED",
  ],
  [
    "redirect response",
    () =>
      new globalThis.Response(canary, {
        status: 302,
        headers: { Location: "https://example.invalid/" },
      }),
    "HTTP_ERROR",
  ],
  ["malformed JSON", () => new globalThis.Response(canary), "INVALID_BODY"],
  [
    "oversized body",
    () => new globalThis.Response(canary.repeat(9000)),
    "BODY_TOO_LARGE",
  ],
  ["missing envelope", () => response({ message: canary }), "INVALID_RESPONSE"],
  ["missing result", () => response({ success: true }), "INVALID_RESPONSE"],
  [
    "200 API error",
    () =>
      response({ success: false, errors: [{ code: 10000, message: canary }] }),
    "API_ERROR",
  ],
]) {
  test(`${name} is classified without dumping sensitive data`, async () => {
    const sim = simulation({ reply });
    assert.equal(await main([], context, sim.dependencies), 1);
    assert.equal(sim.calls.length, 1);
    assert.equal(JSON.parse(sim.lines[0]).result, expected);
    assertNoLeak(sim);
  });
}

for (const environment of [
  undefined,
  null,
  "",
  "../production",
  "production/../../else",
  "https://example.invalid",
  "a?secret=value",
  "a".repeat(65),
  123,
]) {
  test(`unsafe remote environment rejected: ${JSON.stringify(environment)}`, async () => {
    const sim = simulation({
      reply: () =>
        response({
          success: true,
          result: { default_environment: { environment } },
        }),
    });
    assert.equal(await main([], context, sim.dependencies), 1);
    assert.equal(sim.calls.length, 1);
    assert.equal(
      JSON.parse(sim.lines.at(-1)).result,
      "INVALID_REMOTE_ENVIRONMENT",
    );
    assertNoLeak(sim);
  });
}

test("raw deployment source is never echoed and error codes must be bounded numbers", async () => {
  const sim = simulation({
    source: `::error::${canary}`,
    reply: (n) =>
      n === 3
        ? response({
            success: false,
            errors: [
              { code: canary },
              { code: "10000" },
              { code: -1 },
              { code: 1e12 },
              { code: 1.5 },
              { code: 10000, message: canary },
              { code: 10000 },
              null,
            ],
          })
        : null,
  });
  assert.equal(await main([], context, sim.dependencies), 1);
  assert.equal(JSON.parse(sim.lines[1]).source, "other");
  assert.deepEqual(
    sim.lines.map(JSON.parse).find((row) => row.check === "custom_domains")
      .errorCodes,
    [10000],
  );
  assertNoLeak(sim);
});

test("Git read error and real CLI denial never print credentials or exception text", async () => {
  const sim = simulation();
  sim.dependencies.readHead = () => {
    throw new Error(canary);
  };
  assert.equal(await main([], context, sim.dependencies), 1);
  assert.equal(sim.calls.length, 0);
  assert.equal(JSON.parse(sim.lines[0]).result, "GUARD_FAILED");
  assertNoLeak(sim);
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/api-diagnose.mjs", import.meta.url))],
    {
      env: { ...context, GITHUB_ACTIONS: "false" },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  assert.equal(JSON.parse(child.stdout).result, "NOT_GITHUB_ACTIONS");
  assert(!child.stdout.includes(canary));
});
