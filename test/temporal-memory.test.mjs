import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureRepository, openDatabase } from "../src/db.mjs";
import {
  captureWorkingTreeEpisode,
  ensureTemporalSchema,
  getTemporalChangesSince,
  getTemporalEvolution,
  getTemporalStats,
  getTemporalTimeline,
  ingestGitHistory,
  recordTemporalEpisode,
  replayTemporalState,
} from "../src/temporal-memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "temporal-memory");

function git(root, args, { env = {} } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function fixture(name) {
  return readFile(path.join(fixtures, name), "utf8");
}

async function commit(root, message, timestamp) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message], {
    env: {
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
  return git(root, ["rev-parse", "HEAD"]);
}

async function makeGitRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-temporal-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Temporal Test"]);
  git(root, ["config", "user.email", "temporal@example.test"]);
  await mkdir(path.join(root, "src"), { recursive: true });

  const math = path.join(root, "src", "math.js");
  await writeFile(math, await fixture("commit-1.js"));
  const first = await commit(root, "add arithmetic", "2026-01-01T10:00:00Z");

  await writeFile(math, await fixture("commit-2.js"));
  const second = await commit(root, "support numeric input and doubling", "2026-01-02T10:00:00Z");

  const arithmetic = path.join(root, "src", "arithmetic.js");
  await rename(math, arithmetic);
  const third = await commit(root, "rename math module", "2026-01-03T10:00:00Z");

  await writeFile(arithmetic, await fixture("commit-4.js"));
  const fourth = await commit(root, "truncate operands and remove doubling", "2026-01-04T10:00:00Z");

  return { root, commits: [first, second, third, fourth] };
}

function openTemporalDatabase(root, repoId = "temporal") {
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  ensureRepository(db, root, repoId, "Temporal fixture");
  return db;
}

function fileSnapshot(stableKey, contentHash) {
  return {
    stableKey,
    path: stableKey,
    language: "javascript",
    contentHash,
    gitBlob: null,
    size: 10,
    lineCount: 1,
    contentAvailable: true,
    skippedReason: null,
  };
}

test("enforces temporal interval, cursor, isolation, bounds, and rollback invariants", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-temporal-direct-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-temporal-other-"));
  const db = openTemporalDatabase(root, "direct-a");
  ensureRepository(db, otherRoot, "direct-b", "Other temporal fixture");
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  assert.equal(ensureTemporalSchema(db).migrated, true);
  assert.equal(ensureTemporalSchema(db).migrated, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM temporal_schema_migrations WHERE version = 1").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM temporal_schema_migrations WHERE version = 2").get().count, 1);

  const firstState = fileSnapshot("src/a.js", "one");
  const secondState = fileSnapshot("src/a.js", "two");
  const first = recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "direct:1",
    type: "integration",
    referenceTime: "2026-01-01T00:00:00Z",
    changes: [{ entityType: "file", changeType: "added", stableKey: "src/a.js", filePath: "src/a.js", before: null, after: firstState }],
  });
  const duplicate = recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "direct:1",
    type: "integration",
    referenceTime: "2026-01-01T00:00:00Z",
    changes: [{ entityType: "file", changeType: "added", stableKey: "src/a.js", filePath: "src/a.js", before: null, after: firstState }],
  });
  assert.equal(duplicate.inserted, false);
  assert.throws(() => recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "direct:1",
    type: "integration",
    referenceTime: "2026-01-01T00:00:00Z",
    changes: [{ entityType: "file", changeType: "added", stableKey: "src/b.js", filePath: "src/b.js", before: null, after: fileSnapshot("src/b.js", "other") }],
  }), /different content/);

  const implicitTime = recordTemporalEpisode(db, {
    repoId: "direct-a", episodeKey: "direct:implicit-time", type: "integration", changes: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const implicitTimeRetry = recordTemporalEpisode(db, {
    repoId: "direct-a", episodeKey: "direct:implicit-time", type: "integration", changes: [],
  });
  assert.equal(implicitTime.inserted, true);
  assert.equal(implicitTimeRetry.inserted, false);

  const second = recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "direct:2",
    type: "integration",
    referenceTime: "2026-01-02T00:00:00Z",
    changes: [{ entityType: "file", changeType: "modified", stableKey: "src/a.js", filePath: "src/a.js", before: firstState, after: secondState }],
  });
  const third = recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "direct:3",
    type: "integration",
    referenceTime: "2026-01-03T00:00:00Z",
    changes: [{ entityType: "file", changeType: "removed", stableKey: "src/a.js", filePath: "src/a.js", before: secondState, after: null }],
  });
  assert.equal(replayTemporalState(db, { repoId: "direct-a", episodeId: first.episode.id }).entities[0].content_hash, "one");
  assert.equal(replayTemporalState(db, { repoId: "direct-a", episodeId: second.episode.id }).entities[0].content_hash, "two");
  assert.equal(replayTemporalState(db, { repoId: "direct-a", episodeId: third.episode.id }).entities.length, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM temporal_entity_versions
    WHERE repo_id = (SELECT id FROM repositories WHERE repo_id = 'direct-a')
      AND valid_from_sequence IS NOT NULL AND valid_to_sequence IS NOT NULL
      AND valid_to_sequence <= valid_from_sequence
  `).get().count, 0);

  const other = recordTemporalEpisode(db, {
    repoId: "direct-b",
    episodeKey: "other:1",
    type: "integration",
    referenceTime: "2026-01-01T00:00:00Z",
    changes: [],
  });
  assert.throws(() => getTemporalChangesSince(db, { repoId: "direct-a", since: other.episode.id }), /cursor episode not found/);
  assert.throws(() => getTemporalChangesSince(db, {
    repoId: "direct-a",
    since: { repo_id: "direct-b", sequence: 0 },
  }), /different repository/);
  assert.throws(() => getTemporalChangesSince(db, { repoId: "direct-a", since: { sequence: -1 } }), /non-negative integer/);
  assert.throws(() => getTemporalTimeline(db, { repoId: "direct-a", entityType: "file", stableKey: "src/a.js", direction: "sideways" }), /asc or desc/);
  assert.throws(() => replayTemporalState(db, { repoId: "direct-a", episodeId: first.episode.id, entityType: "process" }), /file or symbol/);

  for (const invalid of [
    { entityType: "file", changeType: "added", stableKey: "src/a.js", filePath: "C:\\escape.js", before: null, after: firstState },
    { entityType: "file", changeType: "removed", stableKey: "src/a.js", filePath: "src/a.js", before: null, after: null },
    { entityType: "file", changeType: "added", stableKey: "src/a.js", filePath: "src/a.js", before: firstState, after: secondState },
  ]) {
    assert.throws(() => recordTemporalEpisode(db, {
      repoId: "direct-a", episodeKey: `invalid:${invalid.filePath}:${invalid.changeType}`, type: "integration", changes: [invalid],
    }), /repository-relative|require|prohibit/);
  }
  assert.throws(() => recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "duplicate-change",
    type: "integration",
    changes: [
      { entityType: "file", changeType: "added", stableKey: "src/x.js", filePath: "src/x.js", before: null, after: fileSnapshot("src/x.js", "x") },
      { entityType: "file", changeType: "added", stableKey: "src/x.js", filePath: "src/x.js", before: null, after: fileSnapshot("src/x.js", "x") },
    ],
  }), /duplicate/);
  assert.throws(() => recordTemporalEpisode(db, {
    repoId: "direct-a", episodeKey: "too-many", type: "integration", changes: new Array(50_001).fill(null),
  }), /at most 50000/);

  const beforeRollback = getTemporalStats(db, { repoId: "direct-a" });
  db.exec(`
    CREATE TRIGGER temporal_test_failure BEFORE INSERT ON temporal_entity_changes
    WHEN NEW.stable_key = 'src/fail.js' BEGIN SELECT RAISE(ABORT, 'forced temporal failure'); END
  `);
  assert.throws(() => recordTemporalEpisode(db, {
    repoId: "direct-a",
    episodeKey: "rollback",
    type: "integration",
    changes: [{
      entityType: "file", changeType: "added", stableKey: "src/fail.js", filePath: "src/fail.js",
      before: null, after: fileSnapshot("src/fail.js", "fail"),
    }],
  }), /forced temporal failure/);
  assert.deepEqual(getTemporalStats(db, { repoId: "direct-a" }), beforeRollback);
  const firstPage = getTemporalChangesSince(db, { repoId: "direct-a", since: 0, limit: 1 });
  assert.equal(firstPage.cursor.episode_key, "direct:1");
  db.prepare("UPDATE temporal_episodes SET reference_time = ? WHERE id = ?")
    .run("2026-01-01T00:00:01.000Z", firstPage.cursor.episode_id);
  assert.throws(() => getTemporalChangesSince(db, {
    repoId: "direct-a",
    since: firstPage.cursor,
  }), /no longer identifies/);
});

test("keeps Git ingestion idempotent and rejects ancestry outside the first-parent chain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-temporal-first-parent-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Temporal Test"]);
  git(root, ["config", "user.email", "temporal@example.test"]);
  await writeFile(path.join(root, "base.js"), "export const base = 1;\n");
  await commit(root, "base", "2026-02-01T00:00:00Z");
  git(root, ["checkout", "-b", "side"]);
  await writeFile(path.join(root, "side.js"), "export const side = 1;\n");
  const sideCommit = await commit(root, "side work", "2026-02-02T00:00:00Z");

  const db = openTemporalDatabase(root, "first-parent");
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = ingestGitHistory(db, { repoId: "first-parent", maxCommits: 10 });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(first.last_commit, sideCommit);
  const firstStats = getTemporalStats(db, { repoId: "first-parent" });
  const repeat = ingestGitHistory(db, { repoId: "first-parent", maxCommits: 10 });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.episodes_ingested, 0);
  assert.deepEqual(getTemporalStats(db, { repoId: "first-parent" }), firstStats);

  const nestedRoot = path.join(root, "nested");
  await mkdir(nestedRoot);
  ensureRepository(db, nestedRoot, "nested-root", "Invalid nested root");
  const nested = ingestGitHistory(db, { repoId: "nested-root", maxCommits: 10 });
  assert.equal(nested.ok, false);
  assert.ok(nested.diagnostics.some((item) => item.code === "REPOSITORY_ROOT_MISMATCH"));

  const cloneParent = await mkdtemp(path.join(os.tmpdir(), "graphward-temporal-shallow-parent-"));
  const shallowRoot = path.join(cloneParent, "clone");
  git(cloneParent, ["clone", "--depth", "1", "--branch", "side", pathToFileURL(root).href, shallowRoot]);
  const shallowDb = openTemporalDatabase(shallowRoot, "shallow");
  t.after(async () => {
    shallowDb.close();
    await rm(cloneParent, { recursive: true, force: true });
  });
  const shallow = ingestGitHistory(shallowDb, { repoId: "shallow", maxCommits: 10 });
  assert.equal(shallow.ok, true, JSON.stringify(shallow.diagnostics));
  assert.ok(shallow.diagnostics.some((item) => item.code === "GIT_SHALLOW_HISTORY"));

  git(root, ["checkout", "main"]);
  await writeFile(path.join(root, "main.js"), "export const main = 1;\n");
  await commit(root, "main work", "2026-02-03T00:00:00Z");
  git(root, ["merge", "--no-ff", "side", "-m", "merge side"]);
  const diverged = ingestGitHistory(db, { repoId: "first-parent", maxCommits: 10 });
  assert.equal(diverged.ok, false);
  assert.ok(diverged.diagnostics.some((item) => item.code === "GIT_FIRST_PARENT_DIVERGED"));
  assert.deepEqual(getTemporalStats(db, { repoId: "first-parent" }), firstStats);

  const rebuilt = ingestGitHistory(db, { repoId: "first-parent", maxCommits: 10, rebuild: true });
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.diagnostics));
  assert.equal(rebuilt.episodes_ingested, 3);
  const progressIsolated = ingestGitHistory(db, {
    repoId: "first-parent",
    maxCommits: 10,
    rebuild: true,
    onProgress: () => { throw new Error("progress sink unavailable"); },
  });
  assert.equal(progressIsolated.ok, true, JSON.stringify(progressIsolated.diagnostics));
  assert.equal(progressIsolated.episodes_ingested, 3);
  assert.ok(progressIsolated.diagnostics.some((item) => item.code === "PROGRESS_CALLBACK_FAILED"));
  assert.equal(getTemporalStats(db, { repoId: "first-parent" }).episodes, 3);
});

test("ingests Git commits into replayable file and symbol validity intervals", async (t) => {
  const workspace = await makeGitRepository();
  const db = openTemporalDatabase(workspace.root);
  t.after(async () => {
    db.close();
    await rm(workspace.root, { recursive: true, force: true });
  });

  assert.equal(ensureTemporalSchema(db).schema_version, 2);
  assert.equal(ensureTemporalSchema(db).schema_version, 2);
  const ingested = ingestGitHistory(db, {
    repoId: "temporal",
    maxCommits: 10,
    maxFilesPerCommit: 20,
    maxFileBytes: 100_000,
    maxTotalBlobBytes: 2_000_000,
  });

  assert.equal(ingested.ok, true, JSON.stringify(ingested.diagnostics));
  assert.equal(ingested.episodes_ingested, 4);
  assert.equal(ingested.commits_selected, 4);
  assert.equal(ingested.history_truncated, false);
  assert.equal(ingested.has_more, false);
  assert.equal(ingested.limits.max_commits, 10);
  assert.deepEqual(ingested.diagnostics, []);

  const changes = getTemporalChangesSince(db, { repoId: "temporal", since: 0, limit: 20 });
  assert.equal(changes.episodes.length, 4);
  assert.equal(changes.has_more, false);
  assert.equal(changes.limits.applied, 20);
  assert.deepEqual(changes.episodes.map((episode) => episode.source_id), workspace.commits);

  const allChanges = changes.episodes.flatMap((episode) => episode.changes);
  const fileRename = allChanges.find((change) => change.entity_type === "file" && change.change_type === "renamed");
  assert.equal(fileRename.previous_stable_key, "src/math.js");
  assert.equal(fileRename.stable_key, "src/arithmetic.js");
  assert.equal(fileRename.details.evidence, "git_rename_detection");
  assert.equal(fileRename.details.renameConfidence, 1);

  const symbolRename = allChanges.find((change) => (
    change.entity_type === "symbol"
      && change.change_type === "renamed"
      && change.after?.name === "add"
  ));
  assert.match(symbolRename.previous_stable_key, /^src\/math\.js:/);
  assert.match(symbolRename.stable_key, /^src\/arithmetic\.js:/);
  assert.equal(symbolRename.details.evidence, "git_file_rename+qualified_name+kind");
  assert.equal(symbolRename.details.confidence, 1);

  assert.ok(allChanges.some((change) => change.entity_type === "symbol" && change.change_type === "added" && change.after?.name === "double"));
  assert.ok(allChanges.some((change) => change.entity_type === "symbol" && change.change_type === "removed" && change.before?.name === "double"));
  assert.ok(allChanges.some((change) => change.entity_type === "symbol" && change.change_type === "modified" && change.after?.name === "add"));

  const atSecond = replayTemporalState(db, {
    repoId: "temporal",
    episodeId: changes.episodes[1].id,
    limit: 100,
  });
  assert.ok(atSecond.entities.some((entity) => entity.entity_type === "file" && entity.stable_key === "src/math.js"));
  assert.ok(atSecond.entities.some((entity) => entity.entity_type === "symbol" && entity.snapshot.name === "double"));
  assert.equal(atSecond.entities.some((entity) => entity.stable_key.startsWith("src/arithmetic.js:")), false);

  const atThird = replayTemporalState(db, {
    repoId: "temporal",
    sequence: changes.episodes[2].sequence,
    limit: 100,
  });
  assert.ok(atThird.entities.some((entity) => entity.entity_type === "file" && entity.stable_key === "src/arithmetic.js"));
  assert.equal(atThird.entities.some((entity) => entity.entity_type === "file" && entity.stable_key === "src/math.js"), false);
  assert.ok(atThird.entities.every((entity) => !Object.hasOwn(entity.snapshot, "bodyText")));

  const finalAdd = allChanges.findLast((change) => change.entity_type === "symbol" && change.after?.name === "add");
  const timeline = getTemporalTimeline(db, {
    repoId: "temporal",
    entityType: "symbol",
    stableKey: finalAdd.stable_key,
    limit: 100,
  });
  assert.ok(timeline.lineage_stable_keys.some((key) => key.startsWith("src/math.js:")));
  assert.ok(timeline.lineage_stable_keys.some((key) => key.startsWith("src/arithmetic.js:")));
  assert.deepEqual(timeline.events.map((event) => event.change.change_type), ["added", "modified", "renamed", "modified"]);

  const evolution = getTemporalEvolution(db, {
    repoId: "temporal",
    entityType: "symbol",
    stableKey: finalAdd.stable_key,
    limit: 100,
  });
  assert.deepEqual(evolution.counts, { added: 1, modified: 2, removed: 0, renamed: 1 });
  assert.equal(evolution.first_event_at, "2026-01-01T10:00:00.000Z");
  assert.equal(evolution.last_event_at, "2026-01-04T10:00:00.000Z");

  const sinceSecond = getTemporalChangesSince(db, {
    repoId: "temporal",
    since: changes.episodes[1].id,
    limit: 10,
  });
  assert.equal(sinceSecond.episodes.length, 2);
  assert.equal(sinceSecond.cursor.sequence, 4);

  const repeat = ingestGitHistory(db, { repoId: "temporal", maxCommits: 10 });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.episodes_ingested, 0);
  assert.equal(repeat.commits_selected, 0);
  const afterRepeat = getTemporalChangesSince(db, { repoId: "temporal", since: 0, limit: 20 });
  assert.deepEqual(afterRepeat.cursor, changes.cursor);

  const stats = getTemporalStats(db, { repoId: "temporal" });
  assert.equal(stats.episodes, 4);
  assert.ok(stats.changes >= 10);
  assert.ok(stats.versions >= stats.open_versions);
  assert.equal(stats.limits.replay_maximum, 50_000);
});

test("captures idempotent working-tree episodes and a later reversion", async (t) => {
  const workspace = await makeGitRepository();
  const db = openTemporalDatabase(workspace.root, "worktree");
  t.after(async () => {
    db.close();
    await rm(workspace.root, { recursive: true, force: true });
  });
  const baseline = ingestGitHistory(db, { repoId: "worktree", maxCommits: 10 });
  assert.equal(baseline.ok, true);

  await writeFile(path.join(workspace.root, "src", "arithmetic.js"), await fixture("working-tree.js"));
  await writeFile(path.join(workspace.root, "src", "new.js"), "export function newFeature() { return 42; }\n");
  const captured = captureWorkingTreeEpisode(db, {
    repoId: "worktree",
    maxFilesPerCommit: 20,
    maxFileBytes: 100_000,
  });
  assert.equal(captured.ok, true, JSON.stringify(captured.diagnostics));
  assert.equal(captured.inserted, true);
  assert.equal(captured.episode.type, "working_tree");
  assert.equal(captured.limits.max_files_per_commit, 20);

  const worktreeChanges = getTemporalChangesSince(db, {
    repoId: "worktree",
    since: captured.episode.id - 1,
    limit: 10,
  }).episodes.flatMap((episode) => episode.changes);
  assert.ok(worktreeChanges.some((change) => change.entity_type === "symbol" && change.change_type === "modified" && change.after?.name === "add"));
  assert.ok(worktreeChanges.some((change) => change.entity_type === "symbol" && change.change_type === "added" && change.after?.name === "newFeature"));

  const duplicate = captureWorkingTreeEpisode(db, { repoId: "worktree", maxFilesPerCommit: 20 });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.changes_ingested, 0);

  await writeFile(path.join(workspace.root, "src", "arithmetic.js"), await fixture("commit-4.js"));
  await rm(path.join(workspace.root, "src", "new.js"));
  const reverted = captureWorkingTreeEpisode(db, { repoId: "worktree", maxFilesPerCommit: 20 });
  assert.equal(reverted.ok, true);
  assert.equal(reverted.inserted, true);
  const revertedChanges = getTemporalChangesSince(db, {
    repoId: "worktree",
    since: captured.episode.id,
    limit: 10,
  }).episodes.flatMap((episode) => episode.changes);
  assert.ok(revertedChanges.some((change) => change.entity_type === "symbol" && change.change_type === "removed" && change.before?.name === "newFeature"));
  assert.ok(revertedChanges.some((change) => change.entity_type === "symbol" && change.change_type === "modified" && change.after?.name === "add"));

  await rm(path.join(workspace.root, "src", "arithmetic.js"));
  const deleted = captureWorkingTreeEpisode(db, { repoId: "worktree", maxFilesPerCommit: 20 });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.inserted, true);
  const duplicateDeletion = captureWorkingTreeEpisode(db, { repoId: "worktree", maxFilesPerCommit: 20 });
  assert.equal(duplicateDeletion.ok, true);
  assert.equal(duplicateDeletion.inserted, false);
});

test("rotates bounded working-tree pages so later dirty paths are never starved", async (t) => {
  const workspace = await makeGitRepository();
  const db = openTemporalDatabase(workspace.root, "worktree-pages");
  t.after(async () => {
    db.close();
    await rm(workspace.root, { recursive: true, force: true });
  });
  const baseline = ingestGitHistory(db, { repoId: "worktree-pages", maxCommits: 10 });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.diagnostics));
  const baselineCursor = getTemporalChangesSince(db, { repoId: "worktree-pages", since: 0, limit: 100 }).cursor;

  const dirtyPaths = [];
  for (let index = 0; index < 5; index += 1) {
    const filePath = `src/starvation-${index}.js`;
    dirtyPaths.push(filePath);
    await writeFile(path.join(workspace.root, ...filePath.split("/")), `export const item${index} = ${index};\n`);
  }
  const pages = [];
  for (let page = 0; page < 3; page += 1) {
    pages.push(captureWorkingTreeEpisode(db, {
      repoId: "worktree-pages", maxFilesPerCommit: 2, maxFileBytes: 100_000,
    }));
  }
  assert.ok(pages.every((result) => result.ok), JSON.stringify(pages));
  assert.ok(pages.every((result) => result.inserted));
  const pagedChanges = getTemporalChangesSince(db, {
    repoId: "worktree-pages", since: baselineCursor, limit: 100,
  }).episodes.flatMap((episode) => episode.changes);
  const addedPaths = new Set(pagedChanges
    .filter((change) => change.entity_type === "file" && change.change_type === "added")
    .map((change) => change.file_path));
  assert.deepEqual([...addedPaths].sort(), dirtyPaths);

  const beforeModification = getTemporalChangesSince(db, {
    repoId: "worktree-pages", since: 0, limit: 100,
  }).cursor;
  await writeFile(path.join(workspace.root, "src", "starvation-4.js"), "export const item4 = 99;\n");
  const noOpPage = captureWorkingTreeEpisode(db, { repoId: "worktree-pages", maxFilesPerCommit: 2 });
  assert.equal(noOpPage.ok, true);
  assert.equal(noOpPage.inserted, false);
  const laterPage = captureWorkingTreeEpisode(db, { repoId: "worktree-pages", maxFilesPerCommit: 2 });
  assert.equal(laterPage.ok, true, JSON.stringify(laterPage.diagnostics));
  assert.equal(laterPage.inserted, true);
  const laterChanges = getTemporalChangesSince(db, {
    repoId: "worktree-pages", since: beforeModification, limit: 100,
  }).episodes.flatMap((episode) => episode.changes);
  assert.ok(laterChanges.some((change) => (
    change.entity_type === "file"
      && change.change_type === "modified"
      && change.file_path === "src/starvation-4.js"
  )));
});

test("enforces a bounded initial history horizon and reports Git failures structurally", async (t) => {
  const workspace = await makeGitRepository();
  const db = openTemporalDatabase(workspace.root, "bounded");
  t.after(async () => {
    db.close();
    await rm(workspace.root, { recursive: true, force: true });
  });

  const bounded = ingestGitHistory(db, {
    repoId: "bounded",
    maxCommits: 2,
    maxFilesPerCommit: 20,
  });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.episodes_ingested, 2);
  assert.equal(bounded.history_truncated, true);
  assert.equal(bounded.first_commit, workspace.commits[2]);
  assert.equal(bounded.last_commit, workspace.commits[3]);
  assert.equal(bounded.limits.max_commits, 2);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.truncation.history, {
    reason: "max_commits_horizon",
    available_commits: 4,
    selected_commits: 2,
    omitted_commits: 2,
  });
  assert.ok(bounded.diagnostics.some((item) => item.code === "HISTORY_HORIZON_TRUNCATED"));

  const nonGitRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-not-git-"));
  const failedDb = openTemporalDatabase(nonGitRoot, "not-git");
  t.after(async () => {
    failedDb.close();
    await rm(nonGitRoot, { recursive: true, force: true });
  });
  recordTemporalEpisode(failedDb, {
    repoId: "not-git",
    episodeKey: "preserve-on-failed-rebuild",
    type: "integration",
    referenceTime: "2026-01-01T00:00:00Z",
    changes: [],
  });
  const failed = ingestGitHistory(failedDb, { repoId: "not-git", maxCommits: 2, rebuild: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.limits.max_commits, 2);
  assert.ok(failed.diagnostics.some((item) => item.code === "GIT_COMMAND_FAILED"));
  assert.equal(getTemporalStats(failedDb, { repoId: "not-git" }).episodes, 1);
});
