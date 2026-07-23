import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { findSymbol } from "../src/queries.mjs";
import { WatchManager } from "../src/watcher.mjs";

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 10_000;

async function eventually(predicate, message, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (lastError) throw lastError;
  assert.fail(message);
}

async function waitForQuiescence(value, quietMs = 300, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = value();
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    const current = value();
    if (current !== previous) {
      previous = current;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return current;
    }
  }
  assert.fail("watch activity did not become quiescent before the timeout");
}

async function assertRemains(value, expected, durationMs = 500) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assert.equal(value(), expected);
    await delay(POLL_INTERVAL_MS);
  }
}

async function makeWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-watcher-"));
  const source = path.join(root, "src");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "baseline.js"), "export function baselineSymbol() { return 1; }\n");
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  const logs = [];
  const manager = new WatchManager(db, (message) => logs.push(message));
  t.after(async () => {
    manager.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId: "watcher-fixture" });
  return { root, source, db, logs, manager };
}

function completeLogCount(logs) {
  return logs.filter((message) => message.startsWith("watch index complete:")).length;
}

function hasSymbol(db, name, filePath = null) {
  return findSymbol(db, {
    repoId: "watcher-fixture",
    name,
    fuzzy: false,
    filePath,
  }).some((symbol) => !filePath || symbol.file_path === filePath);
}

test("watches real add, edit, rename, delete, ignored, and debounced filesystem events", async (t) => {
  const { root, source, db, logs, manager } = await makeWorkspace(t);
  const started = await manager.start(root, { repoId: "watcher-fixture", debounceMs: 125 });
  assert.deepEqual(started, {
    ok: true,
    path: path.resolve(root),
    already_watching: false,
  });
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].path, path.resolve(root));
  assert.ok(!Number.isNaN(Date.parse(manager.list()[0].started_at)));

  const duplicate = await manager.start(root, { repoId: "watcher-fixture", debounceMs: 1 });
  assert.deepEqual(duplicate, {
    ok: true,
    path: path.resolve(root),
    already_watching: true,
  });
  assert.equal(manager.list().length, 1);

  const addedPath = path.join(source, "added.js");
  let previousIndexes = completeLogCount(logs);
  await writeFile(addedPath, "export function addedSymbol() { return 1; }\n");
  await eventually(
    () => completeLogCount(logs) > previousIndexes && hasSymbol(db, "addedSymbol", "src/added.js"),
    "added source file was not indexed",
  );
  await waitForQuiescence(() => completeLogCount(logs));

  previousIndexes = completeLogCount(logs);
  await writeFile(addedPath, "export function editedSymbol() { return 2; }\n");
  await eventually(
    () => completeLogCount(logs) > previousIndexes
      && hasSymbol(db, "editedSymbol", "src/added.js")
      && !hasSymbol(db, "addedSymbol"),
    "edited source file did not replace its indexed symbol",
  );
  await waitForQuiescence(() => completeLogCount(logs));

  const renamedPath = path.join(source, "renamed.js");
  previousIndexes = completeLogCount(logs);
  await rename(addedPath, renamedPath);
  await eventually(
    () => completeLogCount(logs) > previousIndexes
      && hasSymbol(db, "editedSymbol", "src/renamed.js")
      && !hasSymbol(db, "editedSymbol", "src/added.js"),
    "renamed source file did not move in the index",
  );
  await waitForQuiescence(() => completeLogCount(logs));

  previousIndexes = completeLogCount(logs);
  await rm(renamedPath);
  await eventually(
    () => completeLogCount(logs) > previousIndexes && !hasSymbol(db, "editedSymbol"),
    "deleted source file remained indexed",
  );
  await waitForQuiescence(() => completeLogCount(logs));

  const rapidPath = path.join(source, "rapid.js");
  previousIndexes = completeLogCount(logs);
  for (let version = 0; version < 6; version += 1) {
    await writeFile(
      rapidPath,
      `export function rapidVersion${version}() { return ${version}; }\n`,
    );
  }
  await eventually(
    () => completeLogCount(logs) > previousIndexes
      && hasSymbol(db, "rapidVersion5", "src/rapid.js"),
    "the final rapid edit was not indexed",
  );
  await waitForQuiescence(() => completeLogCount(logs), 400);
  assert.equal(completeLogCount(logs), previousIndexes + 1);
  for (let version = 0; version < 5; version += 1) {
    assert.equal(hasSymbol(db, `rapidVersion${version}`), false);
  }

  const ignoredRoot = path.join(root, "node_modules", "ignored-package");
  await mkdir(ignoredRoot, { recursive: true });
  await waitForQuiescence(() => completeLogCount(logs));
  previousIndexes = completeLogCount(logs);
  const ignoredEvent = once(manager.watchers.get(path.resolve(root)).watcher, "change", {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await writeFile(
    path.join(ignoredRoot, "ignored.js"),
    "export function ignoredWatcherSymbol() { return 1; }\n",
  );
  await ignoredEvent;
  await assertRemains(() => completeLogCount(logs), previousIndexes);
  assert.equal(hasSymbol(db, "ignoredWatcherSymbol"), false);
  assert.deepEqual(logs.filter((message) => message.startsWith("watch index failed:")), []);
});

test("stop and close cancel pending reindexes and release watcher state", async (t) => {
  const { root, source, db, logs, manager } = await makeWorkspace(t);
  const options = { repoId: "watcher-fixture", debounceMs: 750 };

  await manager.start(root, options);
  let entry = manager.watchers.get(path.resolve(root));
  let nativeEvent = once(entry.watcher, "change", {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await writeFile(
    path.join(source, "pending-stop.js"),
    "export function pendingStopSymbol() { return 1; }\n",
  );
  await nativeEvent;
  assert.deepEqual(manager.stop(root), {
    ok: true,
    path: path.resolve(root),
    was_watching: true,
  });
  assert.deepEqual(manager.stop(root), {
    ok: true,
    path: path.resolve(root),
    was_watching: false,
  });
  assert.deepEqual(manager.list(), []);
  await assertRemains(() => completeLogCount(logs), 0, 1_000);
  assert.equal(hasSymbol(db, "pendingStopSymbol"), false);

  await manager.start(root, options);
  entry = manager.watchers.get(path.resolve(root));
  nativeEvent = once(entry.watcher, "change", {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await writeFile(
    path.join(source, "pending-close.js"),
    "export function pendingCloseSymbol() { return 1; }\n",
  );
  await nativeEvent;
  manager.close();
  assert.deepEqual(manager.list(), []);
  await assertRemains(() => completeLogCount(logs), 0, 1_000);
  assert.equal(hasSymbol(db, "pendingStopSymbol"), false);
  assert.equal(hasSymbol(db, "pendingCloseSymbol"), false);
  assert.deepEqual(logs.filter((message) => message.startsWith("watch index failed:")), []);
});
