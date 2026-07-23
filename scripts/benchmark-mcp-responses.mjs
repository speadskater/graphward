import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool } from "../src/tools.mjs";

const DEFAULT_QUERIES = [
  "authorization entitlement enforcement competition create modify",
  "judge evaluation normalization aggregation ranking",
  "competition templates default settings persistence",
];

function responseBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function ratio(smaller, larger) {
  return larger ? Number((1 - smaller / larger).toFixed(4)) : 0;
}

async function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const queries = process.argv.slice(3).filter(Boolean);
  const selectedQueries = queries.length ? queries : DEFAULT_QUERIES;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "graphward-mcp-benchmark-"));
  const db = openDatabase(path.join(temporary, "index.sqlite"));
  try {
    await indexDirectory(db, root, { repoId: "response-benchmark" });
    const context = {
      db,
      defaultRoot: root,
      defaultRepoId: "response-benchmark",
      surface: "mcp",
      responseEvidenceHashes: new Set(),
    };
    const results = [];
    for (const query of selectedQueries) {
      const args = { repo_id: "response-benchmark", query, limit: 10, context_lines: 4 };
      const full = await callTool("find_code", { ...args, response_detail: "full" }, context);
      context.responseEvidenceHashes.clear();
      const compact = await callTool("find_code", args, context);
      const repeated = await callTool("find_code", args, context);
      const fullBytes = responseBytes(full);
      const compactBytes = responseBytes(compact);
      const repeatedBytes = responseBytes(repeated);
      results.push({
        query,
        full_bytes: fullBytes,
        compact_bytes: compactBytes,
        compact_reduction: ratio(compactBytes, fullBytes),
        repeated_compact_bytes: repeatedBytes,
        repeated_reduction: ratio(repeatedBytes, fullBytes),
        session_dedup_reduction: ratio(repeatedBytes, compactBytes),
        compact_estimated_tokens: Math.ceil(compactBytes / 4),
        repeated_compact_estimated_tokens: Math.ceil(repeatedBytes / 4),
        full_results: full.results?.length ?? 0,
        compact_results: compact.results?.length ?? 0,
      });
    }
    const totals = results.reduce((sum, item) => ({
      full_bytes: sum.full_bytes + item.full_bytes,
      compact_bytes: sum.compact_bytes + item.compact_bytes,
      repeated_compact_bytes: sum.repeated_compact_bytes + item.repeated_compact_bytes,
    }), { full_bytes: 0, compact_bytes: 0, repeated_compact_bytes: 0 });
    process.stdout.write(`${JSON.stringify({
      root,
      queries: results,
      totals: {
        ...totals,
        compact_reduction: ratio(totals.compact_bytes, totals.full_bytes),
        repeated_reduction: ratio(totals.repeated_compact_bytes, totals.full_bytes),
        session_dedup_reduction: ratio(totals.repeated_compact_bytes, totals.compact_bytes),
        compact_estimated_tokens: Math.ceil(totals.compact_bytes / 4),
        repeated_compact_estimated_tokens: Math.ceil(totals.repeated_compact_bytes / 4),
      },
      methodology: "Pretty-serialized UTF-8 response bytes; compact reduction compares compact with full, while session dedup reduction compares the repeated compact response with the first compact response. Token figures use bytes/4 and are not billing data.",
    }, null, 2)}\n`);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
