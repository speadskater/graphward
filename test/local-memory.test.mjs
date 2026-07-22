import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import {
  applyWorktreeMerge,
  createWorktreeOverlay,
  ensureLocalMemorySchema,
  getDecisionMemory,
  getDecisionProvenance,
  getGoverningContracts,
  getWorktreeOverlay,
  listWorktreeOverlays,
  planWorktreeMerge,
  recallDecisionMemory,
  recordStructuredDecision,
  recordWorktreeChanges,
  setDecisionStatus,
  setWorktreeOverlayStatus,
  verifyDecision,
  whyIsThisHere,
} from "../src/local-memory.mjs";
import { recordDecision } from "../src/queries.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "local-memory");

async function workspace(t, repoId) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-memory-test-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId });
  return { root, db };
}

test("records, recalls, verifies, and scopes structured local decisions", async (t) => {
  const { db } = await workspace(t, "memory-decisions");
  const recorded = recordStructuredDecision(db, {
    repoId: "memory-decisions",
    kind: "ban",
    title: "Keep source code local",
    rationale: "Repository contents are private and must not leave this machine.",
    alternatives: ["Self-hosted remote index", { name: "SaaS index", rejected: "privacy" }],
    tags: ["privacy", "indexing"],
    symbols: ["processCode"],
    files: ["src/policy.js"],
    bans: ["Do not upload source code to cloud services."],
    provenance: {
      source_type: "conversation",
      source_id: "task-privacy-1",
      recorded_by: "user",
      observed_at: "2026-07-21T12:00:00Z",
      evidence: { statement: "Keep the implementation local-only." },
    },
  });
  assert.equal(recorded.fact_status, "Observed");
  assert.equal(recorded.decision.kind, "ban");
  assert.ok(recorded.decision.scopes.some((scope) => scope.type === "symbol"));
  assert.equal(recorded.decision.contracts[0].kind, "prohibition");
  assert.equal(getDecisionMemory(db, {
    repoId: "memory-decisions",
    decisionId: recorded.decision.id,
  }).decision.title, "Keep source code local");
  assert.equal(getDecisionProvenance(db, {
    repoId: "memory-decisions",
    decisionId: recorded.decision.id,
  }).verdict, "Evidence");

  const recalled = recallDecisionMemory(db, {
    repoId: "memory-decisions",
    query: "upload cloud code",
  });
  assert.equal(recalled.verdict, "Evidence");
  assert.equal(recalled.fact_status, "StatisticallyRanked");
  assert.equal(recalled.decisions[0].id, recorded.decision.id);

  const missing = recallDecisionMemory(db, {
    repoId: "memory-decisions",
    query: "quantum database migration",
  });
  assert.equal(missing.verdict, "CannotProve");
  assert.match(missing.note, /unknown, not permission/i);

  const contracts = getGoverningContracts(db, {
    repoId: "memory-decisions",
    symbol: "processCode",
  });
  assert.equal(contracts.verdict, "Evidence");
  assert.equal(contracts.target.symbol.name, "processCode");
  assert.ok(contracts.contracts.some((contract) => contract.kind === "prohibition"));
  const removedSymbolContracts = getGoverningContracts(db, {
    repoId: "memory-decisions",
    symbolStableKey: recorded.decision.scopes.find((scope) => scope.type === "symbol").key,
  });
  assert.equal(removedSymbolContracts.verdict, "Evidence");

  const explanation = whyIsThisHere(db, {
    repoId: "memory-decisions",
    symbolId: contracts.target.symbol.id,
  });
  assert.equal(explanation.rationale[0].provenance[0].source_id, "task-privacy-1");

  const unknownVerification = verifyDecision(db, {
    repoId: "memory-decisions",
    decisionId: recorded.decision.id,
  });
  assert.equal(unknownVerification.verdict, "CannotProve");
  assert.match(unknownVerification.note, /active does not imply held/i);

  const held = verifyDecision(db, {
    repoId: "memory-decisions",
    decisionId: recorded.decision.id,
    record: {
      verdict: "held",
      observed_at: "2026-07-21T13:00:00Z",
      evidence: { check: "No outbound network or cloud client dependencies are present." },
      provenance: { source_type: "local_audit", source_id: "audit-1" },
    },
  });
  assert.equal(held.verdict, "Held");
  assert.equal(held.fact_status, "Observed");
  assert.equal(held.evidence[0].details.check.includes("No outbound"), true);
});

test("backfills existing decisions and reports lifecycle status deterministically", async (t) => {
  const { db } = await workspace(t, "memory-backfill");
  const legacy = recordDecision(db, {
    repoId: "memory-backfill",
    title: "Use deterministic formatting",
    rationale: "Stable formatting keeps snapshots reviewable.",
    tags: ["formatting"],
    symbols: ["formatResult"],
  });
  assert.equal(ensureLocalMemorySchema(db).schema, "local-memory-v1");
  const recalled = recallDecisionMemory(db, {
    repoId: "memory-backfill",
    query: "deterministic formatting",
  });
  assert.equal(recalled.decisions[0].id, legacy.decision_id);
  assert.equal(recalled.decisions[0].kind, "choice");
  assert.ok(recalled.decisions[0].scopes.some((scope) => scope.type === "symbol"));

  setDecisionStatus(db, {
    repoId: "memory-backfill",
    decisionId: legacy.decision_id,
    status: "superseded",
  });
  const verification = verifyDecision(db, {
    repoId: "memory-backfill",
    decisionId: legacy.decision_id,
  });
  assert.equal(verification.verdict, "Superseded");
  assert.equal(verification.fact_status, "DeterministicallyDerived");
  const noLongerGoverning = getGoverningContracts(db, {
    repoId: "memory-backfill",
    symbol: "formatResult",
  });
  assert.equal(noLongerGoverning.verdict, "CannotProve");
});

test("repairs duplicate and orphaned local FTS rows and keeps scope filters explicit", async (t) => {
  const { db } = await workspace(t, "memory-migration-repair");
  const legacy = recordDecision(db, {
    repoId: "memory-migration-repair",
    title: "Keep migration repair deterministic",
    rationale: "Repeated migrations must converge on one searchable row.",
    symbols: ["formatResult"],
  });
  ensureLocalMemorySchema(db);
  db.prepare(`
    INSERT INTO local_decisions_fts(decision_id, title, rationale, alternatives, tags, kind, clauses, scopes)
    SELECT decision_id, title, rationale, alternatives, tags, kind, clauses, scopes
    FROM local_decisions_fts WHERE decision_id = ?
  `).run(legacy.decision_id);
  db.prepare(`
    INSERT INTO local_decisions_fts(decision_id, title, rationale, alternatives, tags, kind, clauses, scopes)
    VALUES (999999, 'orphan', 'orphan', '', '', 'choice', '', '')
  `).run();

  ensureLocalMemorySchema(db);
  ensureLocalMemorySchema(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_decisions_fts WHERE decision_id = ?").get(legacy.decision_id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_decisions_fts WHERE decision_id = 999999").get().count, 0);
  assert.throws(() => recallDecisionMemory(db, {
    repoId: "memory-migration-repair",
    query: "migration",
    scopeKey: "src/policy.js",
  }), /scopeType is required/);

  db.prepare(`
    UPDATE decisions SET title = ?, rationale = ?, status = 'rejected' WHERE id = ?
  `).run("Rewritten migration title", "Rewritten migration rationale is searchable.", legacy.decision_id);
  ensureLocalMemorySchema(db);
  assert.equal(recallDecisionMemory(db, {
    repoId: "memory-migration-repair",
    query: "rewritten rationale",
    status: null,
  }).decisions[0].id, legacy.decision_id);
  assert.equal(recallDecisionMemory(db, {
    repoId: "memory-migration-repair",
    query: "rewritten rationale",
  }).verdict, "CannotProve");
  db.prepare(`
    INSERT INTO local_decision_contracts(decision_id, kind, statement, severity, metadata_json)
    VALUES (?, 'requirement', 'late-added-clause', 'must', '{}')
  `).run(legacy.decision_id);
  db.prepare(`
    INSERT INTO local_decision_scopes(decision_id, scope_type, scope_key, relationship, metadata_json)
    VALUES (?, 'file', 'src/late-scope.js', 'governs', '{}')
  `).run(legacy.decision_id);
  ensureLocalMemorySchema(db);
  assert.equal(recallDecisionMemory(db, {
    repoId: "memory-migration-repair",
    query: "late added clause",
    status: null,
    scopeType: "file",
    scopeKey: "src/late-scope.js",
  }).decisions[0].id, legacy.decision_id);
  assert.equal(recallDecisionMemory(db, {
    repoId: "memory-migration-repair",
    query: "\" OR * NOT",
    status: null,
  }).verdict, "CannotProve");

  db.prepare("DELETE FROM decisions WHERE id = ?").run(legacy.decision_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_decisions_fts WHERE decision_id = ?").get(legacy.decision_id).count, 0);
});

test("rolls back decision and both search writes when local FTS synchronization fails", async (t) => {
  const { db } = await workspace(t, "memory-decision-rollback");
  ensureLocalMemorySchema(db);
  db.exec("DROP TABLE local_decisions_fts");
  db.exec(`
    CREATE TABLE local_decisions_fts (
      decision_id TEXT, title TEXT, rationale TEXT, alternatives TEXT, tags TEXT,
      kind TEXT, clauses TEXT CHECK(clauses NOT LIKE '%blocked-clause%'), scopes TEXT
    )
  `);
  const beforeDecisions = db.prepare("SELECT COUNT(*) AS count FROM decisions").get().count;
  const beforeLegacyFts = db.prepare("SELECT COUNT(*) AS count FROM decisions_fts").get().count;
  assert.throws(() => recordStructuredDecision(db, {
    repoId: "memory-decision-rollback",
    title: "Must disappear on rollback",
    rationale: "No partially searchable decision may survive.",
    contracts: ["blocked-clause"],
  }), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM decisions").get().count, beforeDecisions);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM decisions_fts").get().count, beforeLegacyFts);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_decisions_fts WHERE title = 'Must disappear on rollback'").get().count, 0);
});

test("verification selects the latest observation and preserves CannotProve semantics", async (t) => {
  const { db } = await workspace(t, "memory-verification-order");
  const recorded = recordStructuredDecision(db, {
    repoId: "memory-verification-order",
    title: "Keep verification explicit",
    rationale: "Status alone is not evidence that a decision still holds.",
  });
  assert.equal(verifyDecision(db, {
    repoId: "memory-verification-order",
    decisionId: recorded.decision.id,
  }).verdict, "CannotProve");

  verifyDecision(db, {
    repoId: "memory-verification-order",
    decisionId: recorded.decision.id,
    record: { verdict: "held", observed_at: "2026-07-21T10:00:00Z", evidence: { check: "older" } },
  });
  const violated = verifyDecision(db, {
    repoId: "memory-verification-order",
    decisionId: recorded.decision.id,
    record: { verdict: "violated", observed_at: "2026-07-21T11:00:00Z", evidence: { check: "newer" } },
  });
  assert.equal(violated.verdict, "ViolatedAt");
  assert.equal(violated.observed_at, "2026-07-21T11:00:00.000Z");

  const tieWinner = verifyDecision(db, {
    repoId: "memory-verification-order",
    decisionId: recorded.decision.id,
    record: { verdict: "held", observed_at: "2026-07-21T11:00:00Z", evidence: { check: "later insertion" } },
  });
  assert.equal(tieWinner.verdict, "Held");
  assert.equal(tieWinner.evidence[0].details.check, "later insertion");
});

const baseCalculate = {
  stable_key: "src/policy.js#calculate",
  name: "calculate",
  signature: "calculate(value)",
  file_path: "src/policy.js",
  body_hash: "base-body",
  metadata: { owner: "core", reviewed: false },
};

test("plans deterministic merges and reports add/add and delete/modify conflicts", async (t) => {
  const { db } = await workspace(t, "memory-conflicts");
  for (const name of ["alpha", "beta"]) {
    createWorktreeOverlay(db, {
      repoId: "memory-conflicts",
      name,
      baseReference: "main",
      baseHead: "abc123",
    });
  }
  recordWorktreeChanges(db, {
    repoId: "memory-conflicts",
    name: "alpha",
    changes: [
      {
        change_type: "modified",
        stable_key: baseCalculate.stable_key,
        base: baseCalculate,
        overlay: { ...baseCalculate, signature: "calculate(value, tax)" },
      },
      {
        change_type: "added",
        stable_key: "src/policy.js#newRule",
        overlay: { stable_key: "src/policy.js#newRule", name: "newRule", file_path: "src/policy.js", body_hash: "alpha" },
      },
      {
        change_type: "removed",
        stable_key: "src/policy.js#oldRule",
        base: { stable_key: "src/policy.js#oldRule", name: "oldRule", file_path: "src/policy.js", body_hash: "old" },
      },
    ],
  });
  recordWorktreeChanges(db, {
    repoId: "memory-conflicts",
    name: "beta",
    changes: [
      {
        change_type: "modified",
        stable_key: baseCalculate.stable_key,
        base: baseCalculate,
        overlay: { ...baseCalculate, body_hash: "beta-body" },
      },
      {
        change_type: "added",
        stable_key: "src/policy.js#newRule",
        overlay: { stable_key: "src/policy.js#newRule", name: "newRule", file_path: "src/policy.js", body_hash: "beta" },
      },
      {
        change_type: "modified",
        stable_key: "src/policy.js#oldRule",
        base: { stable_key: "src/policy.js#oldRule", name: "oldRule", file_path: "src/policy.js", body_hash: "old" },
        overlay: { stable_key: "src/policy.js#oldRule", name: "oldRule", file_path: "src/policy.js", body_hash: "updated" },
      },
    ],
  });

  const first = planWorktreeMerge(db, {
    repoId: "memory-conflicts",
    sourceName: "alpha",
    targetName: "beta",
  });
  const second = planWorktreeMerge(db, {
    repoId: "memory-conflicts",
    sourceName: "alpha",
    targetName: "beta",
  });
  assert.deepEqual(first, second);
  assert.equal(first.verdict, "conflicts");
  assert.ok(first.operations.some((operation) => operation.stable_key === baseCalculate.stable_key && operation.action === "auto_merge"));
  assert.ok(first.conflicts.some((conflict) => conflict.type === "add_add"));
  assert.ok(first.conflicts.some((conflict) => conflict.type === "delete_modify"));
  const notApplied = applyWorktreeMerge(db, {
    repoId: "memory-conflicts",
    sourceName: "alpha",
    targetName: "beta",
  });
  assert.equal(notApplied.applied, false);
  assert.match(notApplied.note, /No changes were applied/);
});

test("applies clean source-only, removal, and disjoint-field overlay merges atomically", async (t) => {
  const { db } = await workspace(t, "memory-clean-merge");
  for (const name of ["source-worktree", "target-worktree"]) {
    createWorktreeOverlay(db, {
      repoId: "memory-clean-merge",
      name,
      baseReference: "main",
      baseHead: "def456",
    });
  }
  recordWorktreeChanges(db, {
    repoId: "memory-clean-merge",
    name: "source-worktree",
    changes: [
      {
        change_type: "modified",
        stable_key: baseCalculate.stable_key,
        base: baseCalculate,
        overlay: { ...baseCalculate, signature: "calculate(value, tax)" },
      },
      {
        change_type: "added",
        stable_key: "src/policy.js#sourceOnly",
        overlay: { stable_key: "src/policy.js#sourceOnly", name: "sourceOnly", file_path: "src/policy.js", body_hash: "new" },
      },
      {
        change_type: "removed",
        stable_key: "src/policy.js#removed",
        base: { stable_key: "src/policy.js#removed", name: "removed", file_path: "src/policy.js", body_hash: "old" },
      },
    ],
  });
  recordWorktreeChanges(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    changes: [{
      change_type: "modified",
      stable_key: baseCalculate.stable_key,
      base: baseCalculate,
      overlay: { ...baseCalculate, body_hash: "target-body", metadata: { owner: "core", reviewed: true } },
    }],
  });

  const result = applyWorktreeMerge(db, {
    repoId: "memory-clean-merge",
    sourceName: "source-worktree",
    targetName: "target-worktree",
  });
  assert.equal(result.verdict, "clean");
  assert.equal(result.applied, true);
  assert.equal(result.summary.auto_merge, 1);
  assert.equal(result.summary.apply_source, 2);
  const merged = getWorktreeOverlay(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
  });
  const calculate = merged.changes.find((change) => change.stable_key === baseCalculate.stable_key);
  assert.equal(calculate.overlay.signature, "calculate(value, tax)");
  assert.equal(calculate.overlay.body_hash, "target-body");
  assert.equal(calculate.overlay.metadata.reviewed, true);
  assert.equal(merged.counts.added, 1);
  assert.equal(merged.counts.removed, 1);
  const listed = listWorktreeOverlays(db, { repoId: "memory-clean-merge", status: "open" });
  assert.equal(listed.overlays.length, 2);
  assert.equal(listed.overlays.find((overlay) => overlay.name === "target-worktree").counts.changes, 3);

  const closed = setWorktreeOverlayStatus(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    status: "merged",
  });
  assert.equal(closed.overlay.status, "merged");
  assert.throws(() => recordWorktreeChanges(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    changes: [{ change_type: "added", stable_key: "x", overlay: { stable_key: "x", name: "x", file_path: "src/policy.js" } }],
  }), /not open/);
  assert.throws(() => setWorktreeOverlayStatus(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    status: "open",
  }), /terminal/);
  assert.equal(setWorktreeOverlayStatus(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    status: "merged",
  }).overlay.status, "merged");
  assert.throws(() => setWorktreeOverlayStatus(db, {
    repoId: "memory-clean-merge",
    name: "target-worktree",
    status: "abandoned",
  }), /terminal/);
  assert.throws(() => planWorktreeMerge(db, {
    repoId: "memory-clean-merge",
    sourceName: "source-worktree",
    targetName: "target-worktree",
  }), /not open/);
});

test("isolates repositories and rejects hostile repository-relative paths", async (t) => {
  const { db } = await workspace(t, "memory-isolation-a");
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-memory-repo-b-"));
  await cp(fixture, secondRoot, { recursive: true });
  await writeFile(path.join(secondRoot, "src", "beta-only.js"), "export function betaOnly() {}\n");
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  await indexDirectory(db, secondRoot, { repoId: "memory-isolation-b" });

  const decisionA = recordStructuredDecision(db, {
    repoId: "memory-isolation-a",
    title: "Isolation marker alpha",
    rationale: "Alpha decisions must remain in alpha.",
    scopes: [{ type: "repository" }],
    contracts: ["Alpha-only contract"],
  });
  const decisionB = recordStructuredDecision(db, {
    repoId: "memory-isolation-b",
    title: "Isolation marker beta",
    rationale: "Beta decisions must remain in beta.",
    scopes: [{ type: "repository" }],
    contracts: ["Beta-only contract"],
  });
  assert.deepEqual(recallDecisionMemory(db, {
    repoId: "memory-isolation-a",
    query: "isolation marker",
  }).decisions.map((decision) => decision.id), [decisionA.decision.id]);
  assert.throws(() => getDecisionMemory(db, {
    repoId: "memory-isolation-a",
    decisionId: decisionB.decision.id,
  }), /Decision not found/);
  const foreignStableKey = db.prepare(`
    SELECT s.stable_key FROM symbols s JOIN repositories r ON r.id = s.repo_id
    WHERE r.repo_id = 'memory-isolation-b' AND s.name = 'betaOnly'
  `).get().stable_key;
  assert.throws(() => recordStructuredDecision(db, {
    repoId: "memory-isolation-a",
    title: "Reject cross repository symbol scope",
    rationale: "Known symbols from another repository cannot govern this one.",
    scopes: [{ type: "symbol", stable_key: foreignStableKey }],
  }), /different repository/);

  createWorktreeOverlay(db, { repoId: "memory-isolation-a", name: "same-name", baseReference: "main" });
  createWorktreeOverlay(db, { repoId: "memory-isolation-b", name: "same-name", baseReference: "main" });
  createWorktreeOverlay(db, { repoId: "memory-isolation-b", name: "only-in-beta", baseReference: "main" });
  assert.equal(listWorktreeOverlays(db, { repoId: "memory-isolation-a" }).overlays.length, 1);
  assert.equal(listWorktreeOverlays(db, { repoId: "memory-isolation-b" }).overlays.length, 2);
  assert.throws(() => planWorktreeMerge(db, {
    repoId: "memory-isolation-a",
    sourceName: "same-name",
    targetName: "only-in-beta",
  }), /not found/);

  for (const hostilePath of ["../outside.js", "/absolute.js", "C:\\absolute.js", "\\\\server\\share.js", "https://host/source.js", "src/has\0null.js"]) {
    assert.throws(() => recordStructuredDecision(db, {
      repoId: "memory-isolation-a",
      title: "Reject hostile repository path",
      rationale: "Hostile paths cannot become scopes.",
      files: [hostilePath],
    }), /Invalid repository-relative file path/);
  }
  const beforeInvalidMetadata = db.prepare("SELECT COUNT(*) AS count FROM decisions").get().count;
  assert.throws(() => recordStructuredDecision(db, {
    repoId: "memory-isolation-a",
    title: "Reject non JSON metadata",
    rationale: "Canonical memory cannot silently collapse hostile values.",
    metadata: { created: new Date("2026-07-21T00:00:00Z") },
  }), /plain JSON objects/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM decisions").get().count, beforeInvalidMetadata);
});

test("treats unknown overlay heads as incompatible and preserves canonical merged paths", async (t) => {
  const { db } = await workspace(t, "memory-overlay-canonical");
  createWorktreeOverlay(db, { repoId: "memory-overlay-canonical", name: "unknown-head", baseReference: "main" });
  createWorktreeOverlay(db, { repoId: "memory-overlay-canonical", name: "known-head", baseReference: "main", baseHead: "abc123" });
  assert.equal(planWorktreeMerge(db, {
    repoId: "memory-overlay-canonical",
    sourceName: "unknown-head",
    targetName: "known-head",
  }).conflicts[0].type, "overlay_base_mismatch");
  assert.throws(() => createWorktreeOverlay(db, {
    repoId: "memory-overlay-canonical",
    name: "unknown-head",
    baseReference: "main",
    baseHead: "abc123",
  }), /different base/);

  for (const name of ["move-source", "move-target"]) {
    createWorktreeOverlay(db, {
      repoId: "memory-overlay-canonical",
      name,
      baseReference: "main",
      baseHead: "move-base",
    });
  }
  const movedBase = { ...baseCalculate, file_path: "src/old.js" };
  recordWorktreeChanges(db, {
    repoId: "memory-overlay-canonical",
    name: "move-source",
    changes: [{
      change_type: "modified",
      stable_key: movedBase.stable_key,
      base: movedBase,
      overlay: { ...movedBase, signature: "calculate(value, tax)" },
    }],
  });
  recordWorktreeChanges(db, {
    repoId: "memory-overlay-canonical",
    name: "move-target",
    changes: [{
      change_type: "modified",
      stable_key: movedBase.stable_key,
      base: movedBase,
      overlay: { ...movedBase, file_path: "src/new.js" },
    }],
  });
  const applied = applyWorktreeMerge(db, {
    repoId: "memory-overlay-canonical",
    sourceName: "move-source",
    targetName: "move-target",
  });
  assert.equal(applied.applied, true);
  const change = applied.target_after.changes[0];
  assert.equal(change.file_path, "src/new.js");
  assert.equal(change.overlay.file_path, "src/new.js");

  assert.throws(() => recordWorktreeChanges(db, {
    repoId: "memory-overlay-canonical",
    name: "move-target",
    replace: true,
    changes: [
      { change_type: "added", stable_key: "valid", overlay: { stable_key: "valid", name: "valid", file_path: "src/valid.js" } },
      { change_type: "added", stable_key: "invalid", overlay: { stable_key: "invalid", name: "invalid", file_path: "../invalid.js" } },
    ],
  }), /Invalid repository-relative file path/);
  assert.equal(getWorktreeOverlay(db, {
    repoId: "memory-overlay-canonical",
    name: "move-target",
  }).changes[0].stable_key, movedBase.stable_key);
});
