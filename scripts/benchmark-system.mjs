import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSystemEvaluation } from "./lib/system-evaluation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const root = path.resolve(process.argv[2] ?? path.join(projectRoot, "test", "fixtures", "sample"));
  const specificationPath = path.resolve(process.argv[3] ?? path.join(projectRoot, "benchmarks", "system-evaluation.json"));
  const specification = JSON.parse(await readFile(specificationPath, "utf8"));
  const result = await runSystemEvaluation({ root, specification });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

