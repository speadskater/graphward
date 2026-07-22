import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import {
  ensureProcessMemorySchema,
  getCodebaseBriefing,
  getDailyBriefing,
  getProcessFlow,
  getProcessMembership,
  listProcessModels,
  listProcessRefreshes,
  refreshProcessModels,
  retireProcessModel,
  upsertProcessModel,
} from "../src/process-memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "process-memory");

async function workspace(t, repoIds = ["process-a"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-process-memory-test-"));
  const db = openDatabase(path.join(root, "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const repoId of repoIds) {
    const repoRoot = path.join(root, repoId);
    await cp(fixture, repoRoot, { recursive: true });
    await indexDirectory(db, repoRoot, { repoId });
  }
  ensureProcessMemorySchema(db);
  return { db, root };
}

test("refreshes stable named processes idempotently with ordered edge evidence", async (t) => {
  const { db } = await workspace(t);
  const first = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  assert.ok(first.diff.added.length >= 2);
  assert.equal(first.truncated, false);
  assert.equal(first.stale_cleanup.performed, true);

  const listed = listProcessModels(db, { repoId: "process-a", limit: 100 });
  const route = listed.processes.find((process) => process.start.kind === "api_route");
  assert.ok(route);
  assert.match(route.name, /^GET \/orders\/\{\} → /);
  assert.ok(route.name.includes("→"));
  assert.match(route.process_key, /^auto:api_route:/);
  const flow = getProcessFlow(db, { repoId: "process-a", processKey: route.process_key });
  assert.deepEqual(flow.steps.map((step) => step.name), ["handleOrder", "calculateTotal", "addFee"]);
  assert.equal(flow.steps[0].incoming_edge_confidence, null);
  assert.ok(flow.steps.slice(1).every((step) => step.incoming_edge_confidence > 0));
  assert.ok(flow.steps.slice(1).every((step) => step.evidence.kind === "resolved_call_edge"));
  assert.deepEqual(flow.steps.map((step) => step.ordinal), [0, 1, 2]);
  for (let index = 1; index < flow.steps.length; index += 1) {
    assert.equal(flow.steps[index].evidence.details.source.qualified_name, flow.steps[index - 1].qualified_name);
    assert.equal(flow.steps[index].evidence.details.target.qualified_name, flow.steps[index].qualified_name);
  }

  const second = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  assert.equal(second.changed, false);
  assert.equal(second.diff.added.length, 0);
  assert.equal(second.diff.modified.length, 0);
  assert.equal(second.diff.retired.length, 0);
  assert.equal(second.diff.unchanged.length, first.counts.candidates);
  assert.equal(listProcessModels(db, { repoId: "process-a", limit: 100 }).processes
    .find((process) => process.process_key === route.process_key).id, route.id);
  assert.equal(listProcessRefreshes(db, { repoId: "process-a" }).refreshes.length, 1);
});

test("queries symbol, file, and process membership without crossing repository boundaries", async (t) => {
  const { db } = await workspace(t, ["process-a", "process-b"]);
  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  refreshProcessModels(db, { repoId: "process-b", maxProcesses: 50, minConfidence: 0 });
  const process = listProcessModels(db, { repoId: "process-a", limit: 100 }).processes
    .find((item) => item.start.kind === "api_route");
  const flow = getProcessFlow(db, { repoId: "process-a", processKey: process.process_key });
  const handle = flow.steps.find((step) => step.name === "handleOrder");

  const symbolMembership = getProcessMembership(db, {
    repoId: "process-a",
    symbolStableKey: handle.symbol_stable_key,
  });
  assert.ok(symbolMembership.memberships.length >= 1);
  assert.equal(symbolMembership.repo_id, "process-a");
  assert.ok(symbolMembership.memberships.every((item) => item.step.name === "handleOrder"));

  const fileMembership = getProcessMembership(db, { repoId: "process-a", filePath: "src/math.js" });
  assert.ok(fileMembership.memberships.some((item) => item.step.name === "addFee"));
  const processMembership = getProcessMembership(db, { repoId: "process-a", processKey: process.process_key });
  assert.deepEqual(processMembership.memberships.map((item) => item.step.ordinal), [0, 1, 2]);

  const other = listProcessModels(db, { repoId: "process-b", limit: 100 });
  assert.ok(other.processes.length > 0);
  assert.ok(other.processes.every((item) => item.id !== process.id));
});

test("upserts and retires configured static process models deterministically", async (t) => {
  const { db } = await workspace(t);
  const symbols = db.prepare(`
    SELECT s.stable_key, s.name FROM symbols s
    JOIN repositories r ON r.id = s.repo_id
    WHERE r.repo_id = 'process-a' AND s.name IN ('handleOrder', 'calculateTotal')
    ORDER BY CASE s.name WHEN 'handleOrder' THEN 0 ELSE 1 END
  `).all();
  const options = {
    repoId: "process-a",
    processKey: "configured:order-check",
    name: "Configured order check",
    steps: symbols.map((symbol, index) => ({
      symbolStableKey: symbol.stable_key,
      incomingEdgeConfidence: index ? 0.9 : undefined,
      evidence: { kind: index ? "configured_static_edge" : "configured_start", source: "test contract" },
    })),
    evidence: { kind: "configured_static_process", source: "test contract" },
  };
  const created = upsertProcessModel(db, options);
  const repeated = upsertProcessModel(db, options);
  assert.equal(created.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.changed, false);
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: options.processKey }).steps.length, 2);

  const retired = retireProcessModel(db, { repoId: "process-a", processKey: options.processKey });
  const retiredAgain = retireProcessModel(db, { repoId: "process-a", processKey: options.processKey });
  assert.equal(retired.changed, true);
  assert.equal(retiredAgain.changed, false);
  assert.throws(() => getProcessFlow(db, { repoId: "process-a", processKey: options.processKey }), /not found/);
  assert.equal(getProcessFlow(db, {
    repoId: "process-a",
    processKey: options.processKey,
    includeRetired: true,
  }).process.active, false);

  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  const inferredKey = listProcessModels(db, { repoId: "process-a", source: "inferred", limit: 100 }).processes[0].process_key;
  upsertProcessModel(db, {
    ...options,
    processKey: inferredKey,
    name: "Configured override of inferred process",
  });
  const collisionSafe = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  assert.ok(collisionSafe.diagnostics.configured_key_collisions.some((item) => item.process_key === inferredKey));
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: inferredKey }).process.source, "configured");
  retireProcessModel(db, { repoId: "process-a", processKey: inferredKey });
  const explicitRetirement = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  assert.ok(explicitRetirement.diagnostics.configured_key_collisions.some((item) => item.process_key === inferredKey));
  assert.throws(() => getProcessFlow(db, { repoId: "process-a", processKey: inferredKey }), /not found/);
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: inferredKey, includeRetired: true }).process.source, "configured");
  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0, maxRetired: 0 });
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: inferredKey, includeRetired: true }).process.source, "configured");
});

test("does not retire unseen processes after a truncated refresh, then cleans stale models on a complete refresh", async (t) => {
  const { db } = await workspace(t);
  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  const route = listProcessModels(db, { repoId: "process-a", limit: 100 }).processes
    .find((process) => process.start.kind === "api_route");
  const repoRow = db.prepare("SELECT id FROM repositories WHERE repo_id = 'process-a'").get();
  db.prepare("DELETE FROM api_operations WHERE repo_id = ? AND kind = 'route'").run(repoRow.id);

  const bounded = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 1, minConfidence: 0 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.stale_cleanup.performed, false);
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: route.process_key }).process.active, true);

  const complete = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 100, minConfidence: 0 });
  assert.equal(complete.truncated, false);
  assert.ok(complete.diff.retired.some((item) => item.process_key === route.process_key));
  const all = listProcessModels(db, { repoId: "process-a", active: null, limit: 100 });
  assert.equal(all.processes.find((item) => item.process_key === route.process_key).active, false);
  const pruned = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 100, minConfidence: 0, maxRetired: 0 });
  assert.ok(pruned.counts.pruned >= 1);
  assert.equal(pruned.changed, true);
  assert.throws(() => getProcessFlow(db, { repoId: "process-a", processKey: route.process_key, includeRetired: true }), /not found/);
});

test("briefings distinguish missing evidence from measured empty windows and enforce bounds", async (t) => {
  const { db } = await workspace(t);
  const repoRow = db.prepare("SELECT id FROM repositories WHERE repo_id = 'process-a'").get();
  db.prepare("DELETE FROM episodes WHERE repo_id = ?").run(repoRow.id);
  const missing = getCodebaseBriefing(db, { repoId: "process-a", hotspotLimit: 5 });
  assert.equal(missing.sections.repository_stats.status, "available");
  assert.equal(missing.sections.temporal_history.status, "missing");
  assert.equal(missing.sections.processes.status, "missing");
  assert.equal(missing.sections.decisions.status, "available_empty");
  assert.ok(missing.evidence_gaps.some((gap) => gap.section === "temporal_history"));

  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  db.prepare(`
    INSERT INTO episodes(repo_id, type, reference_time, source_id, summary_json)
    VALUES (?, 'index', '2026-07-19T00:00:00.000Z', 'old', '{}')
  `).run(repoRow.id);
  const daily = getDailyBriefing(db, {
    repoId: "process-a",
    since: "2030-01-01T00:00:00.000Z",
    now: "2030-01-02T00:00:00.000Z",
    hotspotLimit: 5,
  });
  assert.equal(daily.sections.recent_changes.status, "available_empty");
  assert.equal(daily.sections.recent_changes.value.length, 0);
  assert.equal(daily.sections.active_processes.status, "available");
  assert.equal(daily.sections.process_changes.status, "available_empty");
  assert.throws(() => getCodebaseBriefing(db, { repoId: "process-a", processLimit: 501 }), /processLimit/);
  assert.throws(() => getProcessMembership(db, { repoId: "process-a" }), /required/);
  const symbol = db.prepare(`
    SELECT s.stable_key FROM symbols s JOIN repositories r ON r.id = s.repo_id
    WHERE r.repo_id = 'process-a' ORDER BY s.id LIMIT 1
  `).get();
  assert.throws(() => upsertProcessModel(db, {
    repoId: "process-a",
    processKey: "configured:false-runtime",
    name: "Invalid runtime claim",
    steps: [{ symbolStableKey: symbol.stable_key, evidence: { kind: "configured_start" } }],
    evidence: { kind: "runtime_trace" },
  }), /not observed runtime traces/);
});

test("filtered and confidence-narrower refreshes never retire unseen full-scope processes", async (t) => {
  const { db } = await workspace(t);
  refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 0 });
  const route = listProcessModels(db, { repoId: "process-a", limit: 100 }).processes
    .find((process) => process.start.kind === "api_route");
  assert.ok(route);

  const partial = refreshProcessModels(db, {
    repoId: "process-a", includeRoutes: false, includeEntryPoints: true,
    maxProcesses: 50, minConfidence: 0,
  });
  assert.equal(partial.truncated, false);
  assert.deepEqual(partial.stale_cleanup, { performed: false, reason: "partial_start_scope", pruned: 0 });
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: route.process_key }).process.active, true);

  const narrower = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 50, minConfidence: 1 });
  assert.equal(narrower.truncated, false);
  assert.equal(narrower.stale_cleanup.performed, false);
  assert.equal(narrower.stale_cleanup.reason, "narrower_confidence_observation");
  assert.equal(getProcessFlow(db, { repoId: "process-a", processKey: route.process_key }).process.active, true);

  const repoRow = db.prepare("SELECT id FROM repositories WHERE repo_id = 'process-a'").get();
  db.prepare("DELETE FROM api_operations WHERE repo_id = ? AND kind = 'route'").run(repoRow.id);
  const complete = refreshProcessModels(db, { repoId: "process-a", maxProcesses: 100, minConfidence: 0 });
  assert.equal(complete.stale_cleanup.performed, true);
  assert.ok(complete.diff.retired.some((item) => item.process_key === route.process_key));
});

test("bounds process flow output and rejects hostile paths, evidence, and refresh filters", async (t) => {
  const { db } = await workspace(t);
  assert.deepEqual(ensureProcessMemorySchema(db), ensureProcessMemorySchema(db));
  const symbol = db.prepare(`
    SELECT s.* FROM symbols s JOIN repositories r ON r.id = s.repo_id
    WHERE r.repo_id = 'process-a' ORDER BY s.id LIMIT 1
  `).get();
  const configured = upsertProcessModel(db, {
    repoId: "process-a", processKey: "configured:bounded", name: "Bounded",
    steps: [{ symbolStableKey: symbol.stable_key, evidence: { kind: "configured_start" } }],
    evidence: { kind: "configured_static_process" },
  });
  for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
    db.prepare(`
      INSERT INTO local_process_steps(
        process_id, ordinal, symbol_stable_key, symbol_name, qualified_name, symbol_kind,
        file_path, start_line, end_line, incoming_edge_confidence, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{"kind":"hostile_extra_step"}')
    `).run(
      configured.process.id, ordinal, symbol.stable_key, symbol.name, symbol.qualified_name,
      symbol.kind, "src/extra.js", symbol.start_line, symbol.end_line,
    );
  }
  const bounded = getProcessFlow(db, { repoId: "process-a", processKey: "configured:bounded" });
  assert.equal(bounded.steps.length, 100);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.limits, { steps: 100 });

  for (const filePath of ["/absolute.js", "C:\\absolute.js", "../escape.js", "\\\\server\\share.js"]) {
    assert.throws(() => getProcessMembership(db, { repoId: "process-a", filePath }), /repository-relative/);
  }
  assert.throws(() => refreshProcessModels(db, { repoId: "process-a", includeRoutes: "false" }), /must be booleans/);
  assert.throws(() => refreshProcessModels(db, { repoId: "process-a", method: "TRACE" }), /Unsupported HTTP method/);
  assert.throws(() => retireProcessModel(db, { repoId: "process-a", processKey: "configured:bounded", purge: "false" }), /purge must be a boolean/);
  assert.throws(() => getProcessFlow(db, { repoId: "process-a", processKey: "configured:bounded", includeRetired: "false" }), /includeRetired must be a boolean/);
  assert.throws(() => getProcessMembership(db, { repoId: "process-a", processKey: "configured:bounded", includeRetired: 1 }), /includeRetired must be a boolean/);

  const cyclicEvidence = { kind: "configured_static_process" };
  cyclicEvidence.self = cyclicEvidence;
  assert.throws(() => upsertProcessModel(db, {
    repoId: "process-a", processKey: "configured:cyclic", name: "Cyclic",
    steps: [{ symbolStableKey: symbol.stable_key }], evidence: cyclicEvidence,
  }), /acyclic JSON/);
  assert.throws(() => upsertProcessModel(db, {
    repoId: "process-a", processKey: "configured:oversized", name: "Oversized",
    steps: [{ symbolStableKey: symbol.stable_key }],
    evidence: { kind: "configured_static_process", body: "x".repeat(70_000) },
  }), /at most 65536 bytes/);
  assert.throws(() => upsertProcessModel(db, {
    repoId: "process-a", processKey: "configured:nested-runtime", name: "Nested runtime",
    steps: [{ symbolStableKey: symbol.stable_key, evidence: { kind: "configured_start" } }],
    evidence: { kind: "configured_static_process", details: { evidence_type: "observed trace" } },
  }), /not observed runtime traces/);
});

test("briefings degrade optional decision and temporal details without inventing zero counts", async (t) => {
  const { db } = await workspace(t);
  const repoRow = db.prepare("SELECT id FROM repositories WHERE repo_id = 'process-a'").get();
  db.prepare(`
    INSERT INTO decisions(repo_id, title, status, rationale, alternatives_json, tags_json, created_at, updated_at)
    VALUES (?, 'Keep static', 'active', 'Static evidence only', '[]', '[]', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')
  `).run(repoRow.id);
  db.exec("DROP TABLE decision_links");
  const withoutLinks = getCodebaseBriefing(db, { repoId: "process-a", hotspotLimit: 5 });
  assert.equal(withoutLinks.sections.decisions.status, "available");
  assert.equal(withoutLinks.sections.decisions.source, "decisions_without_links");
  assert.equal(withoutLinks.sections.decisions.value[0].linked_symbols, null);
  assert.equal(withoutLinks.sections.decisions.reason, "decision_links_not_available");

  db.exec(`
    CREATE TABLE temporal_episodes (
      id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, sequence INTEGER NOT NULL,
      type TEXT NOT NULL, reference_time TEXT NOT NULL, source_id TEXT,
      message TEXT, complete INTEGER NOT NULL, summary_json TEXT NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO temporal_episodes(repo_id, sequence, type, reference_time, source_id, message, complete, summary_json)
    VALUES (?, 1, 'working_tree', '2026-07-20T12:00:00.000Z', 'static', 'Static change', 1, '{}')
  `).run(repoRow.id);
  const daily = getDailyBriefing(db, {
    repoId: "process-a", since: "2026-07-20T00:00:00.000Z", now: "2026-07-21T00:00:00.000Z",
    hotspotLimit: 5,
  });
  assert.equal(daily.sections.recent_changes.status, "available");
  assert.equal(daily.sections.recent_changes.value[0].change_count, null);
  assert.equal(daily.sections.recent_changes.reason, "entity_change_details_not_available");

  db.exec("DROP TABLE decisions");
  const withoutDecisions = getCodebaseBriefing(db, { repoId: "process-a", hotspotLimit: 5 });
  assert.equal(withoutDecisions.sections.decisions.status, "missing");
  assert.equal(withoutDecisions.sections.decisions.reason, "decision_memory_not_available");
  assert.ok(withoutDecisions.evidence_gaps.some((gap) => gap.section === "decisions"));
});
