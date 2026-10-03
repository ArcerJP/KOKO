import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { URL } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  main,
  originalFragment,
  originalHash,
  patchedFragment,
  patchedHash,
  patchedSource,
  prepareWrangler,
  sha256,
  version,
} from "../scripts/patch-wrangler-r2.mjs";

const requireApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const packageFile = requireApi.resolve("wrangler/package.json");
assert.equal(JSON.parse(readFileSync(packageFile, "utf8")).version, version);
const cliFile = join(dirname(packageFile), "wrangler-dist/cli.js");
const installed = readFileSync(cliFile, "utf8");
assert([originalHash, patchedHash].includes(sha256(installed)));
// Accept either lifecycle state, but reconstruct and verify the pristine bundle
// before executing any extracted pure functions. Never execute the Wrangler CLI.
const source =
  sha256(installed) === patchedHash
    ? installed.replace(patchedFragment, originalFragment)
    : installed;
assert.equal(sha256(source), originalHash);
const fixed = patchedSource(version, source);

function section(bundle, start, end) {
  assert.equal(bundle.split(start).length, 2, "Source marker must be unique");
  const from = bundle.indexOf(start);
  const to = bundle.indexOf(end, from);
  assert(to > from, "End marker missing");
  return bundle.slice(from, to);
}

function comparison(bundle) {
  const slice = (start, end) => section(bundle, start, end);
  const dependencies = {
    structuredClone: globalThis.structuredClone,
    __name: (value) => value,
    init_import_meta_url: () => {},
    __require: (name) => {
      assert.equal(name, "assert");
      return assert;
    },
    __commonJS: (callbacks) => {
      let module;
      return () => {
        if (!module) {
          module = { exports: {} };
          Object.values(callbacks)[0](module.exports, module);
        }
        return module.exports;
      };
    },
    require_safe2: () => ({ green: (value) => value, red: (value) => value }),
    DEFAULT_COMPAT_DATE: "2026-10-01",
  };
  const reorder = bundle.match(/ {4}reorderableBindings = \{[\s\S]*?\n {4}\};/);
  assert(reorder);
  const functions = [
    slice(
      "// ../../node_modules/.pnpm/heap@0.2.7/node_modules/heap/lib/heap.js",
      "// ../../node_modules/.pnpm/colors@1.4.0/",
    ),
    slice(
      "var require_colorize = __commonJS(",
      "// ../deploy-helpers/src/deploy/helpers/diff-json.ts",
    ),
    "var import_json_diff = { default: require_lib4() };",
    slice("function diffJsonObjects(", "var import_json_diff;"),
    slice(
      "function getSubdomainValuesAPIMock(",
      "async function validateSubdomainMixedState(",
    ),
    "var reorderableBindings;",
    reorder[0],
    slice(
      "function mapWorkerMetadataBindings(",
      "var init_map_worker_metadata_bindings",
    ),
    slice(
      "function constructWranglerConfig(",
      "var init_construct_wrangler_config",
    ),
    slice("function getRemoteConfigDiff(", "function getConfigPatch("),
    "return { mapWorkerMetadataBindings, constructWranglerConfig, getRemoteConfigDiff };",
  ].join("\n");
  return compileFunction(
    functions,
    Object.keys(dependencies),
  )(...Object.values(dependencies));
}

const original = comparison(source);
const patched = comparison(fixed);
const config = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync(
    new URL("../../apps/api/wrangler.jsonc", import.meta.url),
    "utf8",
  ),
);
assert.equal(config.error, undefined);
const local = config.config;
const bindings = local.r2_buckets.map(({ binding, bucket_name }) => ({
  type: "r2_bucket",
  name: binding,
  bucket_name,
}));
function remote(api, input = bindings, overrides = {}) {
  return api.constructWranglerConfig({
    name: local.name,
    entrypoint: local.main,
    compatibility_date: local.compatibility_date,
    routes: [],
    domains: [],
    schedules: [],
    subdomain: { enabled: true, previews_enabled: true },
    bindings: input,
    ...overrides,
  });
}
function compare(api, input = bindings, target = local, overrides = {}) {
  return api.getRemoteConfigDiff(remote(api, input, overrides), target);
}
function noDiff(result) {
  assert.equal(result.diff, null);
  assert.equal(result.nonDestructive, true);
}
function destructive(result) {
  assert.notEqual(result.diff, null);
  assert.equal(result.nonDestructive, false);
}
function memoryInstall(input = source, installedVersion = version) {
  let current = input;
  const writes = [];
  return {
    writes,
    readInstalled: () => ({ version: installedVersion, source: current }),
    writeBundle: (value) => {
      writes.push(value);
      current = value;
    },
  };
}

test("original full metadata path reproduces the empty destructive R2 diff", () => {
  const result = compare(original);
  destructive(result);
  assert.deepEqual(result.diff.r2_buckets, [
    ["~", { jurisdiction__deleted: undefined }],
    ["~", { jurisdiction__deleted: undefined }],
  ]);
  assert.equal(
    result.diff
      .toString()
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean)
      .join("\n"),
    "{\nr2_buckets: [\n{\n}\n{\n}\n]\n}",
  );
});
test("fixed actual mapper and comparison omit only undefined and preserve order independence", () => {
  noDiff(compare(patched));
  noDiff(compare(patched, [...bindings].reverse()));
  for (const binding of patched.mapWorkerMetadataBindings(bindings)
    .r2_buckets) {
    assert(!Object.hasOwn(binding, "jurisdiction"));
  }
});
test("API bindings and local configuration are not mutated", () => {
  const input = globalThis.structuredClone(bindings);
  const target = globalThis.structuredClone(local);
  compare(patched, input, target);
  assert.deepEqual(input, bindings);
  assert.deepEqual(target, local);
});
for (const value of [undefined, null, "", "eu", "fedramp"]) {
  test(`jurisdiction ${String(value)} is preserved unless undefined`, () => {
    const input = bindings.map((b) => ({ ...b, jurisdiction: value }));
    const mapped = patched.mapWorkerMetadataBindings(input).r2_buckets;
    for (const binding of mapped) {
      assert.equal(Object.hasOwn(binding, "jurisdiction"), value !== undefined);
      if (value !== undefined) assert.equal(binding.jurisdiction, value);
    }
    if (value === undefined) noDiff(compare(patched, input));
    else destructive(compare(patched, input));
  });
}
for (const [name, change] of [
  [
    "bucket rename",
    (c) => {
      c.r2_buckets[0].bucket_name = "other-bucket";
    },
  ],
  [
    "binding rename",
    (c) => {
      c.r2_buckets[0].binding = "OTHER_BUCKET";
    },
  ],
  [
    "one removal",
    (c) => {
      c.r2_buckets.pop();
    },
  ],
  [
    "all removals",
    (c) => {
      c.r2_buckets = [];
    },
  ],
]) {
  test(`real R2 change remains destructive: ${name}`, () => {
    const target = globalThis.structuredClone(local);
    change(target);
    destructive(compare(patched, bindings, target));
  });
}
for (const [from, to] of [
  ["eu", "fedramp"],
  ["eu", undefined],
  ["", undefined],
  [null, undefined],
]) {
  test(`explicit jurisdiction ${String(from)} -> ${String(to)} remains destructive`, () => {
    const input = bindings.map((b) => ({ ...b, jurisdiction: from }));
    const target = globalThis.structuredClone(local);
    if (to !== undefined)
      target.r2_buckets = target.r2_buckets.map((b) => ({
        ...b,
        jurisdiction: to,
      }));
    destructive(compare(patched, input, target));
  });
}
test("identical explicit jurisdiction is unchanged", () => {
  const input = bindings.map((b) => ({ ...b, jurisdiction: "eu" }));
  const target = globalThis.structuredClone(local);
  target.r2_buckets = target.r2_buckets.map((b) => ({
    ...b,
    jurisdiction: "eu",
  }));
  noDiff(compare(patched, input, target));
});
test("other binding, route and compatibility-date deletions/changes still stop", () => {
  destructive(
    compare(patched, [
      ...bindings,
      { type: "plain_text", name: "FIXTURE", text: "value" },
    ]),
  );
  destructive(
    compare(patched, bindings, local, {
      routes: [{ pattern: "example.invalid/*", zone_name: "example.invalid" }],
    }),
  );
  destructive(
    compare(patched, bindings, local, { compatibility_date: "2026-01-01" }),
  );
});
test("Secret metadata remains excluded and empty jurisdiction is not a workaround", () => {
  const input = [
    ...bindings,
    { type: "secret_text", name: "FIXTURE", text: "SECRET_CANARY" },
  ];
  noDiff(compare(patched, input));
  assert(!JSON.stringify(remote(patched, input)).includes("SECRET_CANARY"));
  const target = globalThis.structuredClone(local);
  target.r2_buckets = target.r2_buckets.map((b) => ({
    ...b,
    jurisdiction: "",
  }));
  destructive(compare(original, bindings, target));
});
test("patch changes exactly one fixed fragment and is idempotent", () => {
  assert.equal(sha256(fixed), patchedHash);
  assert.equal(fixed.replace(patchedFragment, originalFragment), source);
  const fixture = memoryInstall();
  assert.equal(prepareWrangler(fixture), "PATCHED");
  assert.equal(prepareWrangler(fixture), "ALREADY_PATCHED");
  assert.equal(prepareWrangler(fixture, true), "ALREADY_PATCHED");
  assert.equal(fixture.writes.length, 1);
});
for (const [name, value, installedVersion] of [
  ["unexpected version", source, "4.147.1"],
  ["other bundle", `${source}\n`, version],
  ["changed target", source.replace(originalFragment, ""), version],
  ["duplicate target", source + originalFragment, version],
  ["changed patched bundle", fixed + "\n", version],
]) {
  test(`${name} is rejected without a write`, () => {
    const fixture = memoryInstall(value, installedVersion);
    assert.throws(
      () => prepareWrangler(fixture),
      /VERSION_MISMATCH|BUNDLE_HASH_MISMATCH/,
    );
    assert.equal(fixture.writes.length, 0);
  });
}
test("check mode refuses an unpatched bundle without modifying it", () => {
  const fixture = memoryInstall();
  assert.throws(() => prepareWrangler(fixture, true), /PATCH_NOT_APPLIED/);
  assert.equal(fixture.writes.length, 0);
});
test("failed or partial writes fail closed without retries", () => {
  const fixture = memoryInstall();
  let writes = 0;
  fixture.writeBundle = () => {
    writes++;
  };
  assert.throws(() => prepareWrangler(fixture), /PATCH_WRITE_MISMATCH/);
  assert.equal(writes, 1);
});
test("CLI arguments and exceptions never echo environment, paths or secret canaries", () => {
  for (const [args, dependencies, reason] of [
    [
      ["SECRET_CANARY"],
      () => {
        throw new Error("must not execute");
      },
      "INVALID_ARGUMENTS",
    ],
    [
      [],
      () => {
        throw new Error("SECRET_CANARY");
      },
      "PREPARE_FAILED",
    ],
    [["--check"], () => memoryInstall(), "PATCH_NOT_APPLIED"],
    [[], () => memoryInstall(source, "SECRET_CANARY"), "VERSION_MISMATCH"],
  ]) {
    const output = [];
    assert.equal(
      main(args, dependencies, (line) => output.push(line)),
      1,
    );
    assert.deepEqual(output, [`Wrangler R2 compatibility stopped: ${reason}`]);
    assert(!output.join().includes("SECRET_CANARY"));
  }
});
test("test execution never modifies the installed CLI", () => {
  assert.equal(readFileSync(cliFile, "utf8"), installed);
});
