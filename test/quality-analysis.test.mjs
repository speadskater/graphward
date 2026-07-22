import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import {
  analyzeComplexity,
  findBridgeEntities,
  findDeadCodeCandidates,
  getChurnWeightedHotspots,
  getEmpiricalStyleFingerprint,
} from "../src/quality-analysis.mjs";
import { ensureTemporalSchema, recordTemporalEpisode } from "../src/temporal-memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "quality-analysis");

async function makeIndexedWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-quality-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const indexed = await indexDirectory(db, root, { repoId: "quality" });
  assert.equal(indexed.ok, true);
  return { root, db };
}

test("computes AST-backed JavaScript and Python complexity with evidence", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const result = analyzeComplexity(db, {
    repoId: "quality",
    minimumCyclomatic: 2,
    limit: 100,
    includeUnavailable: true,
  });

  const javascript = result.findings.find((item) => item.qualified_name === "complexWorker");
  assert.equal(javascript.available, true);
  assert.equal(javascript.evidence.parser, "babel-ast");
  assert.ok(javascript.cyclomatic_complexity >= 8);
  assert.ok(javascript.cognitive_complexity >= 8);
  assert.ok(javascript.evidence.decision_points.if >= 2);
  assert.ok(javascript.evidence.decision_points.loop >= 1);
  assert.ok(javascript.confidence >= 0.9);
  assert.ok(javascript.caveats.length >= 1);

  const python = result.findings.find((item) => item.qualified_name === "_complex_python");
  assert.equal(python.available, true);
  assert.equal(python.evidence.parser, "cpython-ast");
  assert.ok(python.cyclomatic_complexity >= 6);
  assert.ok(python.cognitive_complexity >= 6);
  assert.ok(python.evidence.decision_points.except >= 1);

  assert.equal(result.coverage.parse_failures, 0);
  assert.ok(result.coverage.supported_languages.includes("python"));
  assert.match(result.methodology, /Nested callables/);

  const fragmentResult = analyzeComplexity(db, {
    repoId: "quality", filePath: "src/fragment-shapes.js", limit: 100,
  });
  assert.equal(fragmentResult.coverage.parse_failures, 0);
  const parserContexts = new Set(fragmentResult.findings.map((item) => item.evidence.parser_context));
  assert.ok(parserContexts.has("array-element"));
  assert.ok([...parserContexts].some((context) => context?.includes("conditional")));
});

test("counts logical sequences and Python comprehension conditions exactly and reports hostile bodies", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const repo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'quality'").get();
  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = 'unusedHelper'").run(`
function unusedHelper(a, b, c, other) {
  if (a && b && c) return other.unusedHelper();
  return 0;
}`, repo.id);
  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = '_unused_python'").run(`
def _unused_python(values):
    return [value for value in values if value > 0 and value < 10]
`, repo.id);

  const result = analyzeComplexity(db, { repoId: "quality", limit: 100, includeUnavailable: true });
  const javascript = result.findings.find((item) => item.qualified_name === "unusedHelper");
  assert.equal(javascript.cyclomatic_complexity, 4);
  assert.equal(javascript.cognitive_complexity, 2);
  assert.equal(javascript.evidence.decision_points.recursion, undefined);
  const python = result.findings.find((item) => item.qualified_name === "_unused_python");
  assert.equal(python.cyclomatic_complexity, 4);
  assert.equal(python.cognitive_complexity, 3);
  assert.equal(python.evidence.decision_points.boolean_operator, 1);

  const callableCount = db.prepare(`
    SELECT COUNT(*) AS count FROM symbols
    WHERE repo_id = ? AND kind IN ('Function', 'Method', 'Constructor')
  `).get(repo.id).count;
  const bounded = analyzeComplexity(db, { repoId: "quality", maxSymbols: 1, limit: 100 });
  assert.equal(bounded.coverage.symbols_skipped_by_limit, callableCount - 1);

  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = 'reflectedOnly'")
    .run("function reflectedOnly( {", repo.id);
  const hostile = analyzeComplexity(db, { repoId: "quality", includeUnavailable: true, limit: 100 });
  const unavailable = hostile.findings.find((item) => item.qualified_name === "reflectedOnly");
  assert.equal(unavailable.available, false);
  assert.match(unavailable.evidence.diagnostic.message, /could not be parsed/);
  assert.ok(unavailable.evidence.diagnostic.attempts.length >= 1);

  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = 'unusedHelper'")
    .run(`function unusedHelper() { return "${"x".repeat(2 * 1024 * 1024 + 1)}"; }`, repo.id);
  const oversized = analyzeComplexity(db, {
    repoId: "quality", filePath: "src/core.js", maxSymbols: 100,
    maxBodyBytes: 10 * 1024 * 1024, includeUnavailable: true, limit: 100,
  });
  assert.equal(oversized.coverage.symbols_skipped_by_individual_body_limit, 1);
  assert.equal(oversized.findings.some((item) => item.qualified_name === "unusedHelper"), false);
  const zeroRequested = analyzeComplexity(db, { repoId: "quality", limit: 0 });
  assert.equal(zeroRequested.limits.findings.requested, 0);
  assert.equal(zeroRequested.limits.findings.applied, 1);
});

test("weights complexity with temporal churn and preserves evidence", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const symbol = db.prepare(`
    SELECT s.stable_key, s.name, s.qualified_name, s.kind, s.signature,
      s.start_line, s.end_line, s.exported, s.body_hash
    FROM symbols s
    WHERE s.repo_id = (SELECT id FROM repositories WHERE repo_id = 'quality')
      AND s.qualified_name = 'complexWorker'
  `).get();
  const snapshot = {
    stableKey: symbol.stable_key,
    name: symbol.name,
    qualifiedName: symbol.qualified_name,
    kind: symbol.kind,
    signature: symbol.signature,
    startLine: symbol.start_line,
    endLine: symbol.end_line,
    exported: Boolean(symbol.exported),
    bodyHash: symbol.body_hash,
  };
  for (let index = 0; index < 3; index += 1) {
    recordTemporalEpisode(db, {
      repoId: "quality",
      episodeKey: `quality-churn-${index}`,
      type: "working_tree",
      referenceTime: `2026-01-0${index + 1}T12:00:00.000Z`,
      changes: [{
        entityType: "symbol",
        changeType: "modified",
        stableKey: symbol.stable_key,
        filePath: "src/core.js",
        before: { ...snapshot, bodyHash: `before-${index}` },
        after: { ...snapshot, bodyHash: `after-${index}` },
        details: { evidence: "test episode" },
      }],
    });
  }
  const repoRow = db.prepare("SELECT id FROM repositories WHERE repo_id = 'quality'").get();
  const invalidEpisode = db.prepare(`
    INSERT INTO temporal_episodes(
      repo_id, sequence, episode_key, type, reference_time, complete, summary_json, ingested_at
    ) VALUES (?, 4, 'quality-invalid-time', 'working_tree', 'not-a-timestamp', 1, '{}', '2026-01-04T12:00:00.000Z')
  `).run(repoRow.id);
  db.prepare(`
    INSERT INTO temporal_entity_changes(
      episode_id, repo_id, entity_type, change_type, stable_key, details_json
    ) VALUES (?, ?, 'symbol', 'modified', ?, '{}')
  `).run(Number(invalidEpisode.lastInsertRowid), repoRow.id, symbol.stable_key);

  const hotspots = getChurnWeightedHotspots(db, { repoId: "quality", limit: 100 });
  const worker = hotspots.findings.find((item) => item.qualified_name === "complexWorker");
  const unused = hotspots.findings.find((item) => item.qualified_name === "unusedHelper");
  assert.equal(hotspots.history_source, "temporal");
  assert.equal(worker.churn_events, 3);
  assert.ok(worker.weighted_churn > 2);
  assert.ok(worker.hotspot_score > unused.hotspot_score);
  assert.match(worker.evidence.formula, /90-day/);
  assert.ok(worker.confidence >= 0.9);
  assert.ok(worker.caveats.some((item) => /history horizon/.test(item)));
  assert.equal(hotspots.history_diagnostics.invalid_timestamps, 1);
  assert.equal(worker.evidence.history_diagnostics.invalid_timestamps, 1);
});

test("falls back to valid legacy churn when durable temporal timestamps are unusable", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  ensureTemporalSchema(db);
  const repo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'quality'").get();
  const symbol = db.prepare("SELECT stable_key FROM symbols WHERE repo_id = ? AND qualified_name = 'complexWorker'").get(repo.id);
  const invalidEpisode = db.prepare(`
    INSERT INTO temporal_episodes(
      repo_id, sequence, episode_key, type, reference_time, complete, summary_json, ingested_at
    ) VALUES (?, 1, 'invalid-only', 'working_tree', 'invalid', 1, '{}', '2026-01-01T00:00:00.000Z')
  `).run(repo.id);
  db.prepare(`
    INSERT INTO temporal_entity_changes(
      episode_id, repo_id, entity_type, change_type, stable_key, details_json
    ) VALUES (?, ?, 'symbol', 'modified', ?, '{}')
  `).run(Number(invalidEpisode.lastInsertRowid), repo.id, symbol.stable_key);
  const result = getChurnWeightedHotspots(db, { repoId: "quality", limit: 100 });
  assert.equal(result.history_source, "legacy");
  assert.equal(result.history_diagnostics.invalid_timestamps, 1);
  assert.ok(result.findings.some((item) => item.churn_events > 0));
  db.prepare("DELETE FROM temporal_episodes WHERE repo_id = ?").run(repo.id);
  db.prepare("DELETE FROM episodes WHERE repo_id = ?").run(repo.id);
  const noHistory = getChurnWeightedHotspots(db, { repoId: "quality", limit: 100 });
  const repeated = getChurnWeightedHotspots(db, { repoId: "quality", limit: 100 });
  assert.equal(noHistory.history_source, "none");
  assert.deepEqual(repeated, noHistory);
});

test("reports conservative dead-code candidates and explicit exclusion reasons", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const result = findDeadCodeCandidates(db, { repoId: "quality", limit: 100 });
  const names = new Set(result.findings.map((item) => item.qualified_name));

  assert.ok(names.has("unusedHelper"));
  assert.ok(names.has("_unused_python"));
  assert.ok(names.has("InternalWorker._unusedMethod"));
  assert.equal(names.has("exportedApi"), false);
  assert.equal(names.has("routeHandler"), false);
  assert.equal(names.has("reflectedOnly"), false);
  assert.equal(names.has("loader"), false);
  assert.equal(names.has("unusedTestHelper"), false);

  const unused = result.findings.find((item) => item.qualified_name === "unusedHelper");
  assert.equal(unused.evidence.incoming_relationships, 0);
  assert.ok(unused.confidence >= 0.7);
  assert.ok(unused.caveats.some((item) => /not proof/.test(item)));
  assert.ok(result.exclusion_summary.exported_or_public_api >= 1);
  assert.ok(result.exclusion_summary.route_or_handler >= 1);
  assert.ok(result.exclusion_summary.framework_hook_name >= 1);
  assert.ok(result.exclusion_summary.reflection_or_registry_string >= 1);
  assert.ok(result.exclusion_summary.test_or_fixture_file >= 1);
  assert.ok(result.exclusion_summary.constructor_or_initializer >= 1);
  assert.match(result.methodology, /conservative/i);

  const boundedReflection = findDeadCodeCandidates(db, {
    repoId: "quality", limit: 100, maxSymbols: 100, maxBodyBytes: 1,
  });
  const boundedUnused = boundedReflection.findings.find((item) => item.qualified_name === "unusedHelper");
  assert.equal(boundedUnused.evidence.reflection_scan_complete, false);
  assert.ok(boundedUnused.caveats.some((item) => /Reflection and registry scanning was bounded/.test(item)));
  assert.ok(boundedUnused.confidence < unused.confidence);
});

test("finds observed graph bridge symbols and files using articulation evidence", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const edgeParts = db.prepare(`
    SELECT r.id AS repo_id, source.id AS source_id, target.id AS target_id,
      source.file_id AS source_file_id, target.file_id AS target_file_id
    FROM repositories r
    JOIN symbols source ON source.repo_id = r.id AND source.qualified_name = 'unusedHelper'
    JOIN symbols target ON target.repo_id = r.id AND target.qualified_name = 'coordinator'
    WHERE r.repo_id = 'quality'
  `).get();
  db.prepare(`
    INSERT INTO edges(
      repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id,
      kind, label, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, 'inbound_probe', 'review', 1, '2026-01-01T00:00:00.000Z')
  `).run(edgeParts.repo_id, edgeParts.source_id, edgeParts.target_id, edgeParts.source_file_id, edgeParts.target_file_id);
  const result = findBridgeEntities(db, { repoId: "quality", entityType: "both", limit: 100 });
  const core = result.findings.find((item) => item.entity_type === "file" && item.file_path === "src/core.js");
  assert.ok(core);
  assert.equal(core.classification, "articulation");
  assert.ok(core.evidence.separated_partitions >= 2);
  assert.ok(core.evidence.degree >= 2);
  assert.ok(core.confidence >= 0.9);
  assert.ok(core.caveats.length >= 1);

  const coordinator = result.findings.find((item) => item.entity_type === "symbol" && item.qualified_name === "coordinator");
  assert.ok(coordinator);
  assert.equal(coordinator.classification, "articulation");
  assert.ok(coordinator.evidence.degree >= 2);
  assert.ok(coordinator.evidence.observed_edge_kinds.includes("inbound_probe"));
  assert.match(result.methodology, /Tarjan/);

  const bounded = findBridgeEntities(db, {
    repoId: "quality", entityType: "both", limit: 100, maxNodes: 2, maxEdges: 1,
  });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.coverage.symbols.nodes_total > bounded.coverage.symbols.nodes_analyzed);
  assert.equal(bounded.limits.graph.maxNodes, 2);
  assert.throws(() => findBridgeEntities(db, { repoId: "quality", minimumDegree: -1 }), /minimumDegree/);
});

test("handles long articulation chains iteratively without stack overflow", async (t) => {
  const { db } = await makeIndexedWorkspace(t);
  const repo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'quality'").get();
  const file = db.prepare("SELECT id FROM files WHERE repo_id = ? AND path = 'src/core.js'").get(repo.id);
  const insertSymbol = db.prepare(`
    INSERT INTO symbols(
      repo_id, file_id, stable_key, name, qualified_name, kind, signature,
      start_line, end_line, exported, body_hash, body_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Function', 'function chain()', 1, 1, 0, ?, '', ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges(
      repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id,
      kind, label, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, 'calls', 'chain', 1, ?)
  `);
  const now = "2026-01-01T00:00:00.000Z";
  let previous = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 6_000; index += 1) {
      const key = `review-chain:${index}`;
      const result = insertSymbol.run(repo.id, file.id, key, `chain${index}`, `chain${index}`, key, now, now);
      const current = Number(result.lastInsertRowid);
      if (previous != null) insertEdge.run(repo.id, previous, current, file.id, file.id, now);
      previous = current;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const result = findBridgeEntities(db, {
    repoId: "quality", entityType: "symbol", minimumDegree: 2, limit: 5,
    maxNodes: 10_000, maxEdges: 10_000,
  });
  assert.equal(result.coverage.symbols.nodes_analyzed, result.coverage.symbols.nodes_total);
  assert.equal(result.coverage.symbols.edges_scanned, result.coverage.symbols.edges_total);
  assert.ok(result.findings.every((item) => item.classification === "articulation"));
});

test("derives an empirical style fingerprint only from observed conventions", async (t) => {
  const { db, root } = await makeIndexedWorkspace(t);
  const result = getEmpiricalStyleFingerprint(db, { repoId: "quality", maxSymbols: 100 });
  const byDimension = new Map(result.findings.map((item) => [item.dimension, item]));

  assert.equal(byDimension.get("js.variable_declaration").preferred, "const");
  assert.equal(byDimension.get("js.quote_style").preferred, "double");
  assert.ok(byDimension.get("js.quote_style").evidence.total >= 5);
  assert.ok(byDimension.get("js.quote_style").confidence > 0.5);
  assert.ok(byDimension.get("js.quote_style").caveats.length >= 1);
  assert.ok(byDimension.has("python.execution_style"));
  assert.equal(result.sample.javascript_typescript_symbols > 0, true);
  assert.equal(result.sample.python_symbols > 0, true);
  assert.match(result.methodology, /Empirical lexical counts/);
  assert.deepEqual(getEmpiricalStyleFingerprint(db, { repoId: "quality", maxSymbols: 100 }), result);

  const repo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'quality'").get();
  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = 'feature'")
    .run("function feature() { const only = 1; return only; }", repo.id);
  const small = getEmpiricalStyleFingerprint(db, {
    repoId: "quality", filePath: "src/feature.js", maxSymbols: 1,
  });
  const declaration = small.findings.find((item) => item.dimension === "js.variable_declaration");
  assert.equal(declaration.evidence.total, 1);
  assert.ok(declaration.confidence < 0.5);
  const requestedZero = getEmpiricalStyleFingerprint(db, { repoId: "quality", maxSymbols: 0 });
  assert.equal(requestedZero.limits.requested_symbols, 0);
  assert.equal(requestedZero.limits.applied_symbols, 1);

  db.prepare("UPDATE symbols SET body_text = ? WHERE repo_id = ? AND qualified_name = '_unused_python'")
    .run("async def _unused_python(value):\n    first = await value\n    return await first", repo.id);
  const pythonStyle = getEmpiricalStyleFingerprint(db, { repoId: "quality", language: "python", maxSymbols: 100 });
  const execution = pythonStyle.findings.find((item) => item.dimension === "python.execution_style");
  assert.equal(execution.evidence.counts["async-await"], 1);

  const secondRoot = path.join(root, "isolated-copy");
  await cp(fixture, secondRoot, { recursive: true });
  await indexDirectory(db, secondRoot, { repoId: "quality-b" });
  const isolated = analyzeComplexity(db, { repoId: "quality-b", limit: 100 });
  assert.equal(isolated.repo_id, "quality-b");
  assert.ok(isolated.findings.every((item) => !item.file_path.startsWith("isolated-copy/")));
  assert.throws(() => analyzeComplexity(db, { limit: 10 }), /repoId is required/);
});
