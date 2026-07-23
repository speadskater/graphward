import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool } from "../src/tools.mjs";

function matchesExpected(result, expected) {
  if (expected.file_path && result.file_path !== expected.file_path) return false;
  if (expected.name && result.name !== expected.name) return false;
  if (expected.kind && result.kind !== expected.kind) return false;
  if (expected.line != null) {
    if (Number(result.start_line) > expected.line || Number(result.end_line) < expected.line) return false;
  }
  return true;
}

export function evaluateRetrievalResults(results, expected) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("retrieval cases must declare at least one expected target");
  }
  const targets = expected.map((target) => {
    const index = results.findIndex((result) => matchesExpected(result, target));
    return {
      ...target,
      hit: index >= 0,
      rank: index >= 0 ? index + 1 : null,
    };
  });
  const targetHits = targets.filter((target) => target.hit).length;
  return {
    hit: targetHits === targets.length,
    target_hits: targetHits,
    target_count: targets.length,
    target_recall: ratio(targetHits, targets.length),
    mean_reciprocal_rank: Number((targets.reduce((sum, target) => (
      sum + (target.rank ? 1 / target.rank : 0)
    ), 0) / targets.length).toFixed(4)),
    targets,
  };
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}

async function runCases(specification, repoId, context) {
  const results = [];
  for (const benchmarkCase of specification.cases) {
    const response = await callTool("find_code", {
      repo_id: repoId,
      query: benchmarkCase.query,
      limit: benchmarkCase.limit ?? 5,
      context_lines: benchmarkCase.context_lines ?? 4,
    }, context);
    results.push({
      id: benchmarkCase.id,
      query: benchmarkCase.query,
      ...evaluateRetrievalResults(response.results, benchmarkCase.expected),
      response_bytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
      returned_results: response.results.length,
      returned: response.results.map((result) => ({
        name: result.name,
        kind: result.kind,
        file_path: result.file_path,
        start_line: result.start_line,
        end_line: result.end_line,
      })),
    });
  }
  return results;
}

function summarizeResults(results) {
  const hits = results.filter((result) => result.hit).length;
  const targetHits = results.reduce((sum, result) => sum + result.target_hits, 0);
  const targets = results.reduce((sum, result) => sum + result.target_count, 0);
  const responseBytes = results.reduce((sum, result) => sum + result.response_bytes, 0);
  const reciprocalRank = results.reduce((sum, result) => (
    sum + result.mean_reciprocal_rank * result.target_count
  ), 0);
  return {
    calls: results.length,
    hits,
    cases: results.length,
    recall_at_compact_page: ratio(hits, results.length),
    target_hits: targetHits,
    targets,
    target_recall_at_compact_page: ratio(targetHits, targets),
    mean_reciprocal_rank: Number((reciprocalRank / targets).toFixed(4)),
    response_bytes: responseBytes,
    estimated_tokens: Math.ceil(responseBytes / 4),
  };
}

function evaluateBudget(metrics, requested = {}) {
  return {
    max_calls: requested.max_calls ?? null,
    min_recall: requested.min_recall ?? null,
    min_target_recall: requested.min_target_recall ?? null,
    min_mean_reciprocal_rank: requested.min_mean_reciprocal_rank ?? null,
    max_response_bytes: requested.max_response_bytes ?? null,
    calls_pass: requested.max_calls == null || metrics.calls <= requested.max_calls,
    recall_pass: requested.min_recall == null || metrics.recall_at_compact_page >= requested.min_recall,
    target_recall_pass: requested.min_target_recall == null
      || metrics.target_recall_at_compact_page >= requested.min_target_recall,
    mean_reciprocal_rank_pass: requested.min_mean_reciprocal_rank == null
      || metrics.mean_reciprocal_rank >= requested.min_mean_reciprocal_rank,
    bytes_pass: requested.max_response_bytes == null || metrics.response_bytes <= requested.max_response_bytes,
  };
}

function budgetPassed(budget) {
  return budget.calls_pass
    && budget.recall_pass
    && budget.target_recall_pass
    && budget.mean_reciprocal_rank_pass
    && budget.bytes_pass;
}

async function main() {
  const rootArgument = process.argv[2];
  const casesArgument = process.argv[3];
  if (!rootArgument || !casesArgument) {
    throw new Error("usage: node scripts/benchmark-retrieval-quality.mjs <repository-root> <cases.json>");
  }
  const root = path.resolve(rootArgument);
  const casesPath = path.resolve(casesArgument);
  const specification = JSON.parse(await readFile(casesPath, "utf8"));
  if (!Array.isArray(specification.cases) || !specification.cases.length) {
    throw new Error("cases.json must contain a non-empty cases array");
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "graphward-retrieval-benchmark-"));
  const db = openDatabase(path.join(temporary, "index.sqlite"));
  try {
    const repoId = "retrieval-benchmark";
    const indexed = await indexDirectory(db, root, { repoId });
    const context = {
      db,
      defaultRoot: root,
      defaultRepoId: repoId,
      surface: "mcp",
      responseEvidenceHashes: new Set(),
    };
    const results = await runCases(specification, repoId, context);
    const metrics = summarizeResults(results);
    const budget = evaluateBudget(metrics, specification.budget);
    const output = {
      name: specification.name ?? path.basename(casesPath),
      root,
      indexed: { files: indexed.files, symbols: indexed.symbols, edges: indexed.edges },
      metrics,
      budget,
      cases: results,
      methodology: "Each natural-language case makes one compact find_code call. A case hit requires every expected source target on the first compact page; target recall and mean reciprocal rank score each target separately. Bytes are serialized UTF-8 response bytes; token figures use bytes/4 and are not billing data.",
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!budgetPassed(output.budget)) process.exitCode = 2;
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
