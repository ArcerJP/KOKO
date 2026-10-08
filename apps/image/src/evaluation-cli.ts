import { summarizeEvaluation } from "./evaluation.js";

/** Reads de-identified JSON from stdin only. Never echoes raw input, sample IDs or paths. */
async function main() {
  if (process.argv.length !== 2) throw new Error();
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error();
    chunks.push(bytes);
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
  const result = summarizeEvaluation(JSON.parse(decoded));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch(() => {
  process.stderr.write("INVALID_EVALUATION_INPUT\n");
  process.exitCode = 1;
});
