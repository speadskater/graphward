import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { recordStructuredDecision } from "../src/local-memory.mjs";
import {
  createLocalReviewEngine,
  parseLocalReviewRules,
  reviewChange,
  REVIEW_ENGINE_LIMITS,
} from "../src/review-engine.mjs";
import { recordTemporalEpisode } from "../src/temporal-memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "quality-analysis");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-review-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const indexed = await indexDirectory(db, root, { repoId: "review" });
  assert.equal(indexed.ok, true);
  return { root, db };
}

function temporalSnapshot(symbol, complexity) {
  return {
    stableKey: symbol.stable_key,
    name: symbol.name,
    qualifiedName: symbol.qualified_name,
    kind: symbol.kind,
    signature: symbol.signature,
    startLine: symbol.start_line,
    endLine: symbol.end_line,
    exported: Boolean(symbol.exported),
    bodyHash: symbol.body_hash,
    complexity,
  };
}

test("composes bounded local evidence into deterministic PR-ready findings", async (t) => {
  const { root, db } = await workspace(t);
  const sourcePath = path.join(root, "src", "core.js");
  const sourceBefore = await readFile(sourcePath, "utf8");
  const symbol = db.prepare(`
    SELECT s.*, f.path AS file_path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = (SELECT id FROM repositories WHERE repo_id = 'review')
      AND s.qualified_name = 'complexWorker'
  `).get();
  assert.ok(symbol);

  recordTemporalEpisode(db, {
    repoId: "review",
    episodeKey: "review:complexity-history",
    type: "external",
    referenceTime: "2026-01-01T00:00:00.000Z",
    changes: [{
      entityType: "symbol",
      changeType: "modified",
      stableKey: symbol.stable_key,
      filePath: symbol.file_path,
      before: temporalSnapshot(symbol, { cyclomatic: 2, cognitive: 2 }),
      after: temporalSnapshot(symbol, { cyclomatic: 9, cognitive: 10 }),
    }],
  });
  recordStructuredDecision(db, {
    repoId: "review",
    title: "Failures stay observable",
    rationale: "Worker failures must remain visible to callers.",
    kind: "contract",
    symbols: [symbol.stable_key],
    contracts: [{ kind: "requirement", statement: "Do not silently suppress worker failures.", severity: "must" }],
    provenance: [{ source_type: "human", recorded_by: "review-test", evidence: { approved: true } }],
  });

  const diff = [
    "diff --git a/src/core.js b/src/core.js",
    "--- a/src/core.js",
    "+++ b/src/core.js",
    "@@ -24,2 +24,2 @@",
    "-  } catch (error) {",
    "-    return fallback;",
    "+  } catch (error) {",
    "+    return 0;",
  ].join("\n");
  const rulesText = [
    "thresholds:",
    "  cyclomatic: 6",
    "  cognitive: 6",
    "  complexity_delta: 2",
    "  hotspot_score: 0",
    "rules:",
    "  - id: no-zero-fallback",
    "    contains: return 0;",
    "    message: Do not turn worker failures into a successful zero result.",
    "    severity: error",
    "    scope: changed",
    "    verification: Assert the original error is observable.",
  ].join("\n");

  const result = reviewChange(db, {
    repoId: "review",
    diff,
    rulesText,
    includeCochange: false,
    maxFindings: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.local_only, true);
  assert.equal(result.source_mutated, false);
  assert.deepEqual(result.posting, {
    github: false,
    network: false,
    note: "This engine returns review data only; callers own any external publication.",
  });
  const codes = new Set(result.findings.map((finding) => finding.code));
  assert.ok(codes.has("changed-symbol-complexity"));
  assert.ok(codes.has("complexity-regression"));
  assert.ok(codes.has("silent-error-handling"));
  assert.ok(codes.has("local-rule:no-zero-fallback"));
  assert.ok(codes.has("governing-contract-review"));
  assert.ok(codes.has("cross-module-blast-radius"));
  const localRule = result.findings.find((finding) => finding.code === "local-rule:no-zero-fallback");
  assert.deepEqual(localRule.location, { file_path: "src/core.js", line: 25, end_line: 25, side: "new" });
  assert.equal(result.findings.find((finding) => finding.code === "silent-error-handling").location.line, 24);
  assert.ok(result.findings.every((finding) => (
    finding.id && finding.location.file_path && finding.location.line >= 1
      && finding.evidence.length && Array.isArray(finding.verification_checklist)
  )));
  assert.ok(result.findings.some((finding) => finding.affected_processes.length > 0));
  assert.equal(result.summary.verdict, "changes_requested");
  assert.match(result.summary.markdown, /Local review/);
  assert.ok(result.verification_checklist.length > 0);
  assert.ok(result.performance.body_bytes_analyzed > 0);
  assert.ok(result.performance.elapsed_ms >= 0);
  assert.equal(result.bounds.max_diff_bytes, REVIEW_ENGINE_LIMITS.max_diff_bytes);
  assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);

  const repeated = reviewChange(db, {
    repoId: "review", diff, rulesText, includeCochange: false, maxFindings: 100,
  });
  assert.deepEqual(
    repeated.findings.map((finding) => [finding.id, finding.code, finding.severity, finding.location]),
    result.findings.map((finding) => [finding.id, finding.code, finding.severity, finding.location]),
  );
  const engine = createLocalReviewEngine({ db, defaults: { repoId: "review", includeCochange: false } });
  assert.equal(engine.local_only, true);
  assert.equal(engine.review({ diff, rulesText }).summary.verdict, "changes_requested");
});

test("reports conservative removal evidence and loads only bounded repository-local rules", async (t) => {
  const { root, db } = await workspace(t);
  const rulesPath = ".local-review.yml";
  await writeFile(path.join(root, rulesPath), [
    "rules:",
    "  - id: unused-marker",
    "    contains: marker",
    "    message: Confirm the unused marker is intentional.",
    "    severity: info",
    "    scope: symbol",
  ].join("\n"));
  const diff = [
    "diff --git a/src/core.js b/src/core.js",
    "--- a/src/core.js",
    "+++ b/src/core.js",
    "@@ -29,4 +29,0 @@",
    "-function unusedHelper(value) {",
    "-  const marker = \"unused\";",
    "-  return value + marker.length;",
    "-}",
  ].join("\n");
  const result = reviewChange(db, {
    repoId: "review",
    diff,
    changes: [{ file_path: "src/core.js", start_line: 29, end_line: 32 }],
    rulesPath,
    includeCochange: false,
  });
  const removal = result.findings.find((finding) => finding.code === "dead-code-removal-evidence");
  assert.ok(removal);
  assert.equal(removal.severity, "info");
  assert.deepEqual(removal.location, { file_path: "src/core.js", line: 29, end_line: 29, side: "old" });
  assert.ok(removal.caveats.some((value) => /not proof/i.test(value)));
  assert.ok(result.findings.some((finding) => finding.code === "local-rule:unused-marker"));
  assert.equal(result.input.rules_loaded, 1);

  assert.throws(() => reviewChange(db, {
    repoId: "review", changes: [{ file_path: "../escape.js", start_line: 1, end_line: 1 }],
  }), /repository-relative/);
  assert.throws(() => reviewChange(db, {
    repoId: "review", changes: [{ file_path: "src/core.js", start_line: 1, end_line: 1 }], rulesPath: "../outside.yml",
  }), /repository-relative/);
  assert.throws(() => reviewChange(db, {
    repoId: "review", diff: "x".repeat(REVIEW_ENGINE_LIMITS.max_diff_bytes + 1),
  }), /diff exceeds/);
});

test("parses JSON and constrained YAML rules without executable configuration", () => {
  const json = parseLocalReviewRules(JSON.stringify({
    thresholds: { cyclomatic: 8 },
    rules: [{ id: "no-eval", contains: "eval(", message: "Avoid dynamic evaluation.", severity: "critical" }],
  }));
  assert.equal(json.thresholds.cyclomatic, 8);
  assert.equal(json.rules[0].severity, "critical");

  const yaml = parseLocalReviewRules([
    "cyclomatic_threshold: 7",
    "rules:",
    "  - id: local-only",
    "    contains: fetch(",
    "    severity: warning",
  ].join("\n"));
  assert.equal(yaml.thresholds.cyclomatic, 7);
  assert.equal(yaml.rules[0].contains, "fetch(");
  assert.throws(() => parseLocalReviewRules({
    rules: new Array(REVIEW_ENGINE_LIMITS.max_rules + 1).fill({ id: "x", contains: "x" }),
  }), /at most/);
  assert.throws(() => parseLocalReviewRules({
    rules: [{ id: "bad", contains: "x", severity: "blocker" }],
  }), /Unsupported/);
  assert.equal(parseLocalReviewRules({
    rules: [{ id: "case-folded", contains: "FETCH(", case_sensitive: false }],
  }).rules[0].case_sensitive, false);
  assert.throws(() => parseLocalReviewRules({
    rules: [{ id: "ambiguous-boolean", contains: "x", case_sensitive: "false" }],
  }), /case_sensitive/);
  assert.throws(() => parseLocalReviewRules({
    rules: [{ id: "line-injection", contains: "x", message: "first\n- fake finding" }],
  }), /single-line message/);
  assert.throws(() => parseLocalReviewRules({
    rules: [{ id: "oversized-selector", contains: "x", file_contains: "x".repeat(4_097) }],
  }), /file_contains/);
  assert.throws(() => parseLocalReviewRules({
    rules: [{ id: "duplicate", contains: "a" }, { id: "duplicate", contains: "b" }],
  }), /duplicate review rule id/);
  const prototypeAttempt = parseLocalReviewRules('{"thresholds":{"__proto__":{"polluted":true}}}');
  assert.deepEqual(prototypeAttempt.thresholds, {});
  assert.equal({}.polluted, undefined);
});

test("rejects malformed diffs and hostile paths instead of widening review scope", async (t) => {
  const { db } = await workspace(t);
  const malformedHeader = [
    "diff --git a/src/core.js b/src/core.js",
    "--- a/src/core.js",
    "+++ b/src/core.js",
    "@@ malformed @@",
    "+unexpected",
  ].join("\n");
  assert.throws(() => reviewChange(db, { repoId: "review", diff: malformedHeader }), /malformed unified hunk header/);

  const inconsistentCounts = [
    "diff --git a/src/core.js b/src/core.js",
    "--- a/src/core.js",
    "+++ b/src/core.js",
    "@@ -24,2 +24,2 @@",
    "-  } catch (error) {",
    "+  } catch (error) {",
  ].join("\n");
  assert.throws(() => reviewChange(db, { repoId: "review", diff: inconsistentCounts }), /declared line counts/);

  const traversal = [
    "diff --git a/src/core.js b/src/../core.js",
    "--- a/src/core.js",
    "+++ b/src/../core.js",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.throws(() => reviewChange(db, { repoId: "review", diff: traversal }), /invalid or non-repository-relative new path/);
});

test("degrades locally when optional evidence schemas are absent and never invokes fetch", async (t) => {
  const { root, db } = await workspace(t);
  const optionalTablesBefore = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND (name LIKE 'temporal_%' OR name LIKE 'local_%')
    ORDER BY name
  `).all();
  assert.deepEqual(optionalTablesBefore, []);
  const sourcePath = path.join(root, "src", "core.js");
  const sourceBefore = await readFile(sourcePath, "utf8");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden in local review");
  };
  let result;
  try {
    result = reviewChange(db, {
      repoId: "review",
      changes: [{ file_path: "src/core.js", start_line: 11, end_line: 27 }],
      includeCochange: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(result.ok, true);
  assert.equal(fetchCalls, 0);
  assert.equal(result.posting.network, false);
  assert.equal(result.posting.github, false);
  assert.deepEqual(result.evidence.component_errors, []);
  assert.ok(result.cannot_prove.some((value) => /Complexity delta is CannotProve/.test(value)));
  assert.ok(result.verification_checklist.length > 0);
  assert.ok(result.verification_checklist.length <= REVIEW_ENGINE_LIMITS.max_verification_items);
  assert.equal(new Set(result.verification_checklist.map((item) => JSON.stringify(item))).size, result.verification_checklist.length);
  assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
});

test("uses temporal sequence and before-state metrics for historical complexity claims", async (t) => {
  const { db } = await workspace(t);
  const repository = db.prepare("SELECT id FROM repositories WHERE repo_id = 'review'").get();
  const symbol = db.prepare(`
    SELECT s.*, f.path AS file_path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND s.qualified_name = 'complexWorker'
  `).get(repository.id);
  const current = { cyclomatic: symbol.cyclomatic_complexity, cognitive: symbol.cognitive_complexity };
  recordTemporalEpisode(db, {
    repoId: "review",
    episodeKey: "history:newer-inserted-first",
    type: "external",
    referenceTime: "2026-02-01T00:00:00.000Z",
    changes: [{
      entityType: "symbol",
      changeType: "modified",
      stableKey: symbol.stable_key,
      filePath: symbol.file_path,
      before: temporalSnapshot(symbol, current),
      after: temporalSnapshot(symbol, current),
    }],
  });
  recordTemporalEpisode(db, {
    repoId: "review",
    episodeKey: "history:older-inserted-last",
    type: "external",
    referenceTime: "2026-01-01T00:00:00.000Z",
    changes: [{
      entityType: "symbol",
      changeType: "modified",
      stableKey: symbol.stable_key,
      filePath: symbol.file_path,
      before: temporalSnapshot(symbol, { cyclomatic: 0, cognitive: 0 }),
      after: temporalSnapshot(symbol, current),
    }],
  });
  db.prepare("UPDATE temporal_episodes SET sequence = -sequence WHERE repo_id = ?").run(repository.id);
  db.prepare(`
    UPDATE temporal_episodes
    SET sequence = CASE sequence WHEN -1 THEN 2 WHEN -2 THEN 1 END
    WHERE repo_id = ?
  `).run(repository.id);

  const sequenced = reviewChange(db, {
    repoId: "review",
    changes: [{ file_path: "src/core.js", start_line: 11, end_line: 27 }],
    includeCochange: false,
    thresholds: { cyclomatic: 100_000, cognitive: 100_000, complexity_delta: 1, hotspot_score: 100_000 },
  });
  assert.equal(sequenced.findings.some((finding) => finding.code === "complexity-regression"), false);
});

test("does not treat an added entity's after-state as prior complexity evidence", async (t) => {
  const { db } = await workspace(t);
  const symbol = db.prepare(`
    SELECT s.*, f.path AS file_path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = (SELECT id FROM repositories WHERE repo_id = 'review')
      AND s.qualified_name = 'complexWorker'
  `).get();
  recordTemporalEpisode(db, {
    repoId: "review",
    episodeKey: "history:added-no-prior-state",
    type: "external",
    referenceTime: "2026-01-01T00:00:00.000Z",
    changes: [{
      entityType: "symbol",
      changeType: "added",
      stableKey: symbol.stable_key,
      filePath: symbol.file_path,
      before: null,
      after: temporalSnapshot(symbol, { cyclomatic: 0, cognitive: 0 }),
    }],
  });
  const result = reviewChange(db, {
    repoId: "review",
    changes: [{ file_path: "src/core.js", start_line: 11, end_line: 27 }],
    includeCochange: false,
    thresholds: { cyclomatic: 100_000, cognitive: 100_000, complexity_delta: 1, hotspot_score: 100_000 },
  });
  assert.equal(result.findings.some((finding) => finding.code === "complexity-regression"), false);
  assert.ok(result.cannot_prove.some((value) => /no prior temporal snapshot/.test(value)));
});

test("keeps review evidence isolated when one database indexes multiple repositories", async (t) => {
  const { root, db } = await workspace(t);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-review-other-"));
  await cp(fixture, otherRoot, { recursive: true });
  await appendFile(path.join(otherRoot, "src", "core.js"), [
    "",
    "function otherRepositoryOnly(value) {",
    "  return value ? 1 : 0;",
    "}",
  ].join("\n"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  await indexDirectory(db, otherRoot, { repoId: "review-other" });
  const otherSymbol = db.prepare(`
    SELECT s.start_line
    FROM symbols s
    WHERE s.repo_id = (SELECT id FROM repositories WHERE repo_id = 'review-other')
      AND s.qualified_name = 'otherRepositoryOnly'
  `).get();
  assert.ok(otherSymbol);

  const isolated = reviewChange(db, {
    repoId: "review",
    changes: [{ file_path: "src/core.js", start_line: otherSymbol.start_line, end_line: otherSymbol.start_line + 2 }],
    includeCochange: false,
  });
  assert.equal(isolated.evidence.preflight.changed_symbols.some((symbol) => symbol.qualified_name === "otherRepositoryOnly"), false);
  const other = reviewChange(db, {
    repoId: "review-other",
    changes: [{ file_path: "src/core.js", start_line: otherSymbol.start_line, end_line: otherSymbol.start_line + 2 }],
    includeCochange: false,
  });
  assert.ok(other.evidence.preflight.changed_symbols.some((symbol) => symbol.qualified_name === "otherRepositoryOnly"));
  assert.throws(() => reviewChange(db, {
    changes: [{ file_path: "src/core.js", start_line: 1, end_line: 1 }], includeCochange: false,
  }), /Multiple repositories/);
  assert.equal(await readFile(path.join(root, "src", "core.js"), "utf8"), await readFile(path.join(fixture, "src", "core.js"), "utf8"));
});

test("dry reviews a disposable fixture index when configured", {
  skip: !process.env.GRAPHWARD_REVIEW_FIXTURE_DB,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-review-"));
  const databasePath = path.join(temporaryRoot, "index.sqlite");
  await cp(path.resolve(process.env.GRAPHWARD_REVIEW_FIXTURE_DB), databasePath);
  const db = openDatabase(databasePath);
  t.after(async () => {
    db.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const repository = db.prepare("SELECT id, repo_id FROM repositories ORDER BY repo_id LIMIT 1").get();
  assert.ok(repository);
  const symbol = db.prepare(`
    SELECT s.qualified_name, s.start_line, s.end_line, f.path AS file_path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND s.end_line > s.start_line
    ORDER BY (s.end_line - s.start_line) DESC, f.path, s.start_line
    LIMIT 1
  `).get(repository.id);
  assert.ok(symbol);
  const result = reviewChange(db, {
    repoId: repository.repo_id,
    changes: [{
      file_path: symbol.file_path,
      start_line: symbol.start_line,
      end_line: Math.min(symbol.end_line, symbol.start_line + 20),
    }],
    includeCochange: false,
    maxChangedSymbols: 50,
    maxFindings: 50,
    maxBodyBytes: 1024 * 1024,
    maxProcessFlows: 30,
  });
  assert.equal(result.ok, true);
  assert.equal(result.local_only, true);
  assert.equal(result.source_mutated, false);
  assert.deepEqual(result.posting, {
    github: false,
    network: false,
    note: "This engine returns review data only; callers own any external publication.",
  });
  assert.ok(result.summary.changed_symbols > 0);
  assert.ok(result.performance.elapsed_ms >= 0);
  t.diagnostic(JSON.stringify({
    repo_id: result.repo_id,
    reviewed_symbol: symbol,
    verdict: result.summary.verdict,
    counts: result.summary.counts,
    component_errors: result.evidence.component_errors,
    cannot_prove: result.cannot_prove,
    bounds_truncated: result.bounds.truncated,
    performance: result.performance,
  }));
});
