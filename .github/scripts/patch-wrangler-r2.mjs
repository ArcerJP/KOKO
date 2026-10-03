import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

// Temporary compatibility fix for the exact published 4.147.0 CLI bundle.
// Keep --strict: omit only an undefined R2 jurisdiction introduced by its mapper.
// Remove after verifying an upstream fix; never accept another version/hash here
// without reviewing the changed upstream source and rerunning the real-path tests.
export const version = "4.147.0";
export const originalHash =
  "f2ec95b41d7f7665a42b75fc9631100e95ea6c0dbabc09eb65ae7f772dbc2fed";
export const patchedHash =
  "c6df3fa86283055d4a1d2a5a99290c7a7ef2c921c3d9c6aa2f1d1cdc428ab08e";
export const originalFragment =
  "              bucket_name: binding.bucket_name,\n" +
  "              jurisdiction: binding.jurisdiction";
export const patchedFragment =
  "              bucket_name: binding.bucket_name,\n" +
  "              ...(binding.jurisdiction !== undefined ? { jurisdiction: binding.jurisdiction } : {})";

class CompatibilityStopped extends Error {}

function requireCondition(condition, reason) {
  if (!condition) throw new CompatibilityStopped(reason);
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

// Pure transformation: no environment/credentials, network, CLI execution or writes.
export function patchedSource(installedVersion, source) {
  requireCondition(installedVersion === version, "VERSION_MISMATCH");
  const hash = sha256(source);
  if (hash === patchedHash) return source;
  requireCondition(hash === originalHash, "BUNDLE_HASH_MISMATCH");
  requireCondition(
    source.split(originalFragment).length === 2,
    "PATCH_TARGET_MISMATCH",
  );
  const result = source.replace(originalFragment, patchedFragment);
  requireCondition(sha256(result) === patchedHash, "PATCH_OUTPUT_MISMATCH");
  return result;
}

export function prepareWrangler(
  { readInstalled, writeBundle },
  checkOnly = false,
) {
  const installed = readInstalled();
  const result = patchedSource(installed.version, installed.source);
  if (result === installed.source) return "ALREADY_PATCHED";
  requireCondition(!checkOnly, "PATCH_NOT_APPLIED");
  writeBundle(result);
  const verified = readInstalled();
  requireCondition(
    verified.version === version && sha256(verified.source) === patchedHash,
    "PATCH_WRITE_MISMATCH",
  );
  return "PATCHED";
}

function installedFiles() {
  const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const requireApi = createRequire(
    new URL("../../apps/api/package.json", import.meta.url),
  );
  const packageFile = realpathSync(requireApi.resolve("wrangler/package.json"));
  const cliFile = realpathSync(
    join(dirname(packageFile), "wrangler-dist/cli.js"),
  );
  const packagePath = relative(root, packageFile).split(sep).join("/");
  const cliPath = relative(root, cliFile).split(sep).join("/");
  requireCondition(
    ["node_modules/wrangler/", "apps/api/node_modules/wrangler/"].some(
      (prefix) =>
        packagePath === `${prefix}package.json` &&
        cliPath === `${prefix}wrangler-dist/cli.js`,
    ),
    "INSTALL_PATH_DENIED",
  );
  return {
    readInstalled: () => {
      const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
      requireCondition(pkg.name === "wrangler", "PACKAGE_MISMATCH");
      return { version: pkg.version, source: readFileSync(cliFile, "utf8") };
    },
    // Only the verified generated dependency file is rewritten. A partial write
    // fails verification and later attempts fail closed; recover with npm ci.
    writeBundle: (source) => writeFileSync(cliFile, source, "utf8"),
  };
}

export function main(
  args,
  dependencies = installedFiles,
  writeLine = (line) => process.stdout.write(`${line}\n`),
) {
  try {
    requireCondition(
      args.length === 0 || (args.length === 1 && args[0] === "--check"),
      "INVALID_ARGUMENTS",
    );
    const result = prepareWrangler(dependencies(), args[0] === "--check");
    writeLine(`Wrangler R2 compatibility: ${result}`);
    return 0;
  } catch (error) {
    // Do not echo paths, environment, file contents or unexpected error details.
    const reason =
      error instanceof CompatibilityStopped ? error.message : "PREPARE_FAILED";
    writeLine(`Wrangler R2 compatibility stopped: ${reason}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
