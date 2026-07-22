import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IGNORED_DIRECTORIES } from "./constants.mjs";
import { resolveRealPath, samePath } from "./path-utils.mjs";
import { detectLanguage, parseSource } from "./languages.mjs";

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_COMMITS = 100;
const DEFAULT_MAX_FILES_PER_COMMIT = 100;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BLOB_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_SCAN_COMMITS = 50_000;
const MAX_QUERY_LIMIT = 500;
const MAX_REPLAY_ENTITIES = 50_000;
const MAX_EPISODE_CHANGES = 50_000;
const MAX_KEY_LENGTH = 8_192;
const NOISY_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
  "composer.lock", "Gemfile.lock", "Pipfile.lock",
]);

const TEMPORAL_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS temporal_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temporal_episodes (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  episode_key TEXT NOT NULL,
  type TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  source_id TEXT,
  parent_source_id TEXT,
  branch TEXT,
  author_name TEXT,
  author_email TEXT,
  message TEXT,
  complete INTEGER NOT NULL DEFAULT 1,
  summary_json TEXT NOT NULL DEFAULT '{}',
  ingested_at TEXT NOT NULL,
  UNIQUE(repo_id, sequence),
  UNIQUE(repo_id, episode_key)
);

CREATE INDEX IF NOT EXISTS temporal_episodes_repo_time_idx
  ON temporal_episodes(repo_id, reference_time, sequence);
CREATE INDEX IF NOT EXISTS temporal_episodes_repo_source_idx
  ON temporal_episodes(repo_id, source_id, type);

CREATE TABLE IF NOT EXISTS temporal_entity_changes (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES temporal_episodes(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  change_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  previous_stable_key TEXT,
  file_path TEXT,
  previous_file_path TEXT,
  before_hash TEXT,
  after_hash TEXT,
  before_json TEXT,
  after_json TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS temporal_changes_episode_idx
  ON temporal_entity_changes(episode_id, id);
CREATE INDEX IF NOT EXISTS temporal_changes_stable_idx
  ON temporal_entity_changes(repo_id, entity_type, stable_key);
CREATE INDEX IF NOT EXISTS temporal_changes_previous_idx
  ON temporal_entity_changes(repo_id, entity_type, previous_stable_key);
CREATE INDEX IF NOT EXISTS temporal_changes_file_idx
  ON temporal_entity_changes(repo_id, file_path);

CREATE TABLE IF NOT EXISTS temporal_entity_versions (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  file_path TEXT,
  valid_from_episode_id INTEGER REFERENCES temporal_episodes(id) ON DELETE CASCADE,
  valid_from_sequence INTEGER,
  valid_to_episode_id INTEGER REFERENCES temporal_episodes(id) ON DELETE SET NULL,
  valid_to_sequence INTEGER,
  content_hash TEXT,
  snapshot_json TEXT NOT NULL,
  origin_type TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS temporal_versions_identity_idx
  ON temporal_entity_versions(repo_id, entity_type, stable_key, COALESCE(valid_from_sequence, -1));
CREATE INDEX IF NOT EXISTS temporal_versions_open_idx
  ON temporal_entity_versions(repo_id, entity_type, stable_key, valid_to_sequence);
CREATE INDEX IF NOT EXISTS temporal_versions_validity_idx
  ON temporal_entity_versions(repo_id, valid_from_sequence, valid_to_sequence);
CREATE INDEX IF NOT EXISTS temporal_versions_file_idx
  ON temporal_entity_versions(repo_id, file_path, valid_to_sequence);

CREATE TABLE IF NOT EXISTS temporal_worktree_scan_state (
  repo_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  last_sort_key TEXT,
  updated_at TEXT NOT NULL
);
`;

class TemporalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TemporalError";
    this.code = code;
    this.details = details;
  }
}

function diagnostic(code, message, level = "error", details = {}) {
  return { code, message, level, details };
}

function asNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function limitsFrom(options = {}) {
  return {
    max_commits: asNumber(options.maxCommits, DEFAULT_MAX_COMMITS, 1, 10_000),
    max_files_per_commit: asNumber(options.maxFilesPerCommit, DEFAULT_MAX_FILES_PER_COMMIT, 1, 10_000),
    max_file_bytes: asNumber(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 64 * 1024 * 1024),
    max_total_blob_bytes: asNumber(options.maxTotalBlobBytes, DEFAULT_MAX_TOTAL_BLOB_BYTES, 1024 * 1024, 1024 * 1024 * 1024),
    max_scan_commits: asNumber(options.maxScanCommits, DEFAULT_MAX_SCAN_COMMITS, 1_000, 200_000),
  };
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function normalizeRepoPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)
    || /^[\\/]/.test(value) || /^[a-z]:[\\/]/i.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\//, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function trackable(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized) return false;
  const parts = normalized.split("/");
  const directories = parts.slice(0, -1);
  if (directories.some((part) => part.startsWith(".") || IGNORED_DIRECTORIES.has(part))) return false;
  const basename = parts.at(-1);
  if (NOISY_BASENAMES.has(basename)) return false;
  return !/\.(?:lock|sum|min\.js|min\.css|map|wasm|png|jpe?g|gif|ico|svg|pdf|zip|gz)$/i.test(normalized);
}

function resolveRepository(db, repoId = null) {
  if (repoId != null) {
    const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(String(repoId));
    if (!row) throw new TemporalError("REPOSITORY_NOT_FOUND", `Repository not found: ${repoId}`);
    return row;
  }
  const rows = db.prepare("SELECT * FROM repositories ORDER BY id").all();
  if (rows.length !== 1) throw new TemporalError("REPOSITORY_REQUIRED", "repoId is required when the database contains zero or multiple repositories");
  return rows[0];
}

function runGit(root, args, { input = undefined, encoding = "utf8", maxBuffer = 32 * 1024 * 1024, allowFailure = false } = {}) {
  let result;
  try {
    result = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], {
      cwd: root,
      input,
      encoding,
      windowsHide: true,
      shell: false,
      timeout: 60_000,
      maxBuffer,
    });
  } catch (error) {
    throw new TemporalError("GIT_UNAVAILABLE", `Unable to execute Git: ${error.message}`);
  }
  if (result.error) {
    const code = result.error.code === "ENOENT" ? "GIT_UNAVAILABLE" : "GIT_PROCESS_ERROR";
    throw new TemporalError(code, `Unable to execute Git: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new TemporalError("GIT_COMMAND_FAILED", stderr?.trim() || `Git exited with status ${result.status}`, { args });
  }
  return result;
}

function verifyGitRepositoryRoot(root) {
  let expected;
  try {
    expected = resolveRealPath(realpathSync(root));
  } catch (error) {
    throw new TemporalError("REPOSITORY_ROOT_INVALID", `Repository root is unavailable: ${error.message}`);
  }
  const reported = runGit(root, ["rev-parse", "--show-toplevel"]).stdout.trim();
  let actual;
  try {
    actual = resolveRealPath(realpathSync(reported));
  } catch {
    actual = path.resolve(reported);
  }
  if (!samePath(actual, expected)) {
    throw new TemporalError(
      "REPOSITORY_ROOT_MISMATCH",
      "Configured repository root is not the Git worktree root.",
      { configured_root: expected, git_root: actual },
    );
  }
}

function gitBranch(root) {
  const result = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitShallow(root) {
  const result = runGit(root, ["rev-parse", "--is-shallow-repository"]);
  return result.stdout.trim() === "true";
}

function nextSequence(db, repositoryId) {
  return Number(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM temporal_episodes WHERE repo_id = ?").get(repositoryId).value);
}

function compactSymbol(symbol) {
  return {
    stableKey: symbol.stableKey,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature: symbol.signature,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: Boolean(symbol.exported),
    bodyHash: symbol.bodyHash,
  };
}

function parseSymbols(buffer, filePath) {
  const language = detectLanguage(filePath);
  if (!language || !buffer || buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return [];
  const content = buffer.toString("utf8");
  return parseSource(content, language, filePath).symbols.map(compactSymbol);
}

function stateFromBlob(filePath, blob) {
  if (!blob) return null;
  const language = detectLanguage(filePath);
  const available = Boolean(blob.buffer);
  const file = {
    stableKey: filePath,
    path: filePath,
    language,
    contentHash: available ? hashBuffer(blob.buffer) : `git:${blob.oid}`,
    gitBlob: blob.oid,
    size: blob.size,
    lineCount: available ? blob.buffer.toString("utf8").split(/\r?\n/).length : null,
    contentAvailable: available,
    skippedReason: blob.skippedReason ?? null,
  };
  return { file, symbols: available ? parseSymbols(blob.buffer, filePath) : [] };
}

function stateFromWorktree(root, filePath, maxFileBytes) {
  const absolute = path.resolve(root, ...filePath.split("/"));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(absolute)) return null;
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  if (stats.size > maxFileBytes) {
    return {
      file: {
        stableKey: filePath,
        path: filePath,
        language: detectLanguage(filePath),
        contentHash: `worktree:size:${stats.size}:mtime:${Math.trunc(stats.mtimeMs)}`,
        gitBlob: null,
        size: stats.size,
        lineCount: null,
        contentAvailable: false,
        skippedReason: "max_file_bytes",
      },
      symbols: [],
    };
  }
  const buffer = readFileSync(absolute);
  if (buffer.length > maxFileBytes) {
    return {
      file: {
        stableKey: filePath,
        path: filePath,
        language: detectLanguage(filePath),
        contentHash: `worktree:size:${buffer.length}:mtime:${Math.trunc(stats.mtimeMs)}`,
        gitBlob: null,
        size: buffer.length,
        lineCount: null,
        contentAvailable: false,
        skippedReason: "max_file_bytes",
      },
      symbols: [],
    };
  }
  const file = {
    stableKey: filePath,
    path: filePath,
    language: detectLanguage(filePath),
    contentHash: hashBuffer(buffer),
    gitBlob: null,
    size: buffer.length,
    lineCount: buffer.toString("utf8").split(/\r?\n/).length,
    contentAvailable: true,
    skippedReason: null,
  };
  return { file, symbols: parseSymbols(buffer, filePath) };
}

function symbolFingerprint(symbol) {
  if (!symbol) return null;
  return stableJson({
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature: symbol.signature,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported,
    bodyHash: symbol.bodyHash,
  });
}

function entityHash(entityType, snapshot) {
  return entityType === "file" ? snapshot?.contentHash ?? null : snapshot?.bodyHash ?? null;
}

function compareFileStates(beforeState, afterState, fileChange) {
  const changes = [];
  const beforeFile = beforeState?.file ?? null;
  const afterFile = afterState?.file ?? null;
  if (!beforeFile && !afterFile) return changes;
  let changeType = fileChange.changeType;
  if (!beforeFile && afterFile) changeType = "added";
  if (beforeFile && !afterFile) changeType = "removed";
  if (beforeFile && afterFile && changeType !== "renamed") changeType = "modified";
  changes.push({
    entityType: "file",
    changeType,
    stableKey: afterFile?.stableKey ?? beforeFile.stableKey,
    previousStableKey: changeType === "renamed" ? beforeFile?.stableKey ?? null : null,
    filePath: afterFile?.path ?? beforeFile?.path ?? null,
    previousFilePath: changeType === "renamed" ? beforeFile?.path ?? null : null,
    before: beforeFile,
    after: afterFile,
    details: fileChange.details,
  });

  const before = new Map((beforeState?.symbols ?? []).map((symbol) => [symbol.stableKey, symbol]));
  const after = new Map((afterState?.symbols ?? []).map((symbol) => [symbol.stableKey, symbol]));
  for (const [stableKey, afterSymbol] of after) {
    const beforeSymbol = before.get(stableKey);
    if (!beforeSymbol) continue;
    before.delete(stableKey);
    after.delete(stableKey);
    if (symbolFingerprint(beforeSymbol) !== symbolFingerprint(afterSymbol)) {
      changes.push({
        entityType: "symbol", changeType: "modified", stableKey,
        previousStableKey: null, filePath: afterFile?.path ?? fileChange.newPath,
        previousFilePath: null, before: beforeSymbol, after: afterSymbol,
        details: { evidence: "stable_key", confidence: 1 },
      });
    }
  }

  if (changeType === "renamed") {
    const beforeByIdentity = new Map();
    for (const symbol of before.values()) {
      const key = `${symbol.qualifiedName}\0${symbol.kind}`;
      const values = beforeByIdentity.get(key) ?? [];
      values.push(symbol);
      beforeByIdentity.set(key, values);
    }
    for (const [stableKey, afterSymbol] of [...after]) {
      const key = `${afterSymbol.qualifiedName}\0${afterSymbol.kind}`;
      const candidates = beforeByIdentity.get(key) ?? [];
      if (candidates.length !== 1) continue;
      const beforeSymbol = candidates[0];
      before.delete(beforeSymbol.stableKey);
      after.delete(stableKey);
      beforeByIdentity.delete(key);
      changes.push({
        entityType: "symbol", changeType: "renamed", stableKey,
        previousStableKey: beforeSymbol.stableKey,
        filePath: afterFile?.path ?? fileChange.newPath,
        previousFilePath: beforeFile?.path ?? fileChange.oldPath,
        before: beforeSymbol, after: afterSymbol,
        details: {
          evidence: "git_file_rename+qualified_name+kind",
          confidence: fileChange.details.renameConfidence,
          bodyModified: beforeSymbol.bodyHash !== afterSymbol.bodyHash,
        },
      });
    }
  }

  for (const symbol of before.values()) {
    changes.push({
      entityType: "symbol", changeType: "removed", stableKey: symbol.stableKey,
      previousStableKey: null, filePath: beforeFile?.path ?? fileChange.oldPath,
      previousFilePath: null, before: symbol, after: null,
      details: { evidence: "ast_diff", confidence: 1 },
    });
  }
  for (const symbol of after.values()) {
    changes.push({
      entityType: "symbol", changeType: "added", stableKey: symbol.stableKey,
      previousStableKey: null, filePath: afterFile?.path ?? fileChange.newPath,
      previousFilePath: null, before: null, after: symbol,
      details: { evidence: "ast_diff", confidence: 1 },
    });
  }
  return changes;
}

function parseNameStatus(buffer) {
  const tokens = buffer.toString("utf8").split("\0");
  const result = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = normalizeRepoPath(tokens[index++]);
      const newPath = normalizeRepoPath(tokens[index++]);
      if (!oldPath || !newPath) continue;
      const score = Number(status.slice(1));
      result.push({
        status, oldPath, newPath,
        changeType: code === "R" ? "renamed" : "added",
        details: {
          gitStatus: status,
          evidence: code === "R" ? "git_rename_detection" : "git_copy_detection",
          renameConfidence: Number.isFinite(score) ? score / 100 : null,
        },
      });
    } else {
      const filePath = normalizeRepoPath(tokens[index++]);
      if (!filePath) continue;
      const changeType = code === "A" ? "added" : code === "D" ? "removed" : "modified";
      result.push({
        status, oldPath: filePath, newPath: filePath, changeType,
        details: { gitStatus: status, evidence: "git_name_status", renameConfidence: null },
      });
    }
  }
  return result.filter((item) => trackable(item.oldPath) || trackable(item.newPath));
}

function commitMetadata(root, hashes) {
  const metadata = new Map();
  for (let offset = 0; offset < hashes.length; offset += 200) {
    const chunk = hashes.slice(offset, offset + 200);
    const format = "%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%s%x1e";
    const result = runGit(root, ["log", "--no-walk=unsorted", `--format=${format}`, ...chunk]);
    for (const rawRecord of result.stdout.split("\x1e")) {
      const record = rawRecord.replace(/^\s+/, "").replace(/\s+$/, "");
      if (!record) continue;
      const [hash, parents = "", timestamp = "", authorName = "", authorEmail = "", ...subject] = record.split("\x1f");
      metadata.set(hash, {
        hash,
        parents: parents.split(" ").filter(Boolean),
        referenceTime: new Date((Number(timestamp) || 0) * 1000).toISOString(),
        authorName,
        authorEmail,
        message: subject.join("\x1f"),
      });
    }
  }
  return metadata;
}

function diffForCommit(root, commit) {
  const parent = commit.parents[0] ?? null;
  const args = parent
    ? ["diff", "--name-status", "-z", "-M", parent, commit.hash, "--"]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", commit.hash, "--"];
  const result = runGit(root, args, { encoding: null });
  return parseNameStatus(result.stdout);
}

function inspectGitObjects(root, specs, limits) {
  const uniqueSpecs = [...new Set(specs.filter((value) => value && !/[\r\n]/.test(value)))];
  if (!uniqueSpecs.length) return new Map();
  const checked = runGit(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${uniqueSpecs.join("\n")}\n`,
    maxBuffer: Math.max(1024 * 1024, uniqueSpecs.length * 200),
  }).stdout.split(/\r?\n/);
  const bySpec = new Map();
  const selectedOids = [];
  const selectedSet = new Set();
  let selectedBytes = 0;
  for (let index = 0; index < uniqueSpecs.length; index += 1) {
    const spec = uniqueSpecs[index];
    const line = checked[index] ?? "";
    if (line.endsWith(" missing")) {
      bySpec.set(spec, null);
      continue;
    }
    const [oid, type, rawSize] = line.trim().split(/\s+/);
    const size = Number(rawSize);
    if (!oid || !type || !Number.isFinite(size)) {
      bySpec.set(spec, null);
      continue;
    }
    const value = { oid, type, size, buffer: null, skippedReason: null };
    if (type !== "blob") {
      value.skippedReason = `git_object_type:${type}`;
    } else if (size > limits.max_file_bytes) {
      value.skippedReason = "max_file_bytes";
    } else if (!selectedSet.has(oid) && selectedBytes + size > limits.max_total_blob_bytes) {
      value.skippedReason = "max_total_blob_bytes";
    } else if (!selectedSet.has(oid)) {
      selectedSet.add(oid);
      selectedOids.push(oid);
      selectedBytes += size;
    }
    bySpec.set(spec, value);
  }

  const buffers = new Map();
  if (selectedOids.length) {
    const result = runGit(root, ["cat-file", "--batch"], {
      input: Buffer.from(`${selectedOids.join("\n")}\n`, "utf8"),
      encoding: null,
      maxBuffer: selectedBytes + selectedOids.length * 200 + 1024 * 1024,
    });
    let cursor = 0;
    for (const requestedOid of selectedOids) {
      const newline = result.stdout.indexOf(10, cursor);
      if (newline < 0) throw new TemporalError("GIT_BATCH_PROTOCOL", "Git cat-file returned a truncated header");
      const header = result.stdout.subarray(cursor, newline).toString("utf8");
      cursor = newline + 1;
      const [oid, type, rawSize] = header.split(" ");
      const size = Number(rawSize);
      if (type !== "blob" || !Number.isFinite(size) || cursor + size > result.stdout.length) {
        throw new TemporalError("GIT_BATCH_PROTOCOL", `Unexpected Git cat-file response for ${requestedOid}`);
      }
      buffers.set(oid, result.stdout.subarray(cursor, cursor + size));
      cursor += size + 1;
    }
  }
  for (const value of bySpec.values()) {
    if (value && buffers.has(value.oid)) value.buffer = buffers.get(value.oid);
  }
  return bySpec;
}

function summarizeChanges(changes) {
  const summary = {
    changes: changes.length,
    files: { added: 0, modified: 0, removed: 0, renamed: 0 },
    symbols: { added: 0, modified: 0, removed: 0, renamed: 0 },
  };
  for (const change of changes) {
    const bucket = change.entityType === "file" ? summary.files : summary.symbols;
    if (Object.hasOwn(bucket, change.changeType)) bucket[change.changeType] += 1;
  }
  return summary;
}

function insertVersion(db, repositoryId, episode, entityType, stableKey, filePath, snapshot, fromEpisode = true, toEpisode = false) {
  db.prepare(`
    INSERT INTO temporal_entity_versions(
      repo_id, entity_type, stable_key, file_path,
      valid_from_episode_id, valid_from_sequence, valid_to_episode_id, valid_to_sequence,
      content_hash, snapshot_json, origin_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repositoryId, entityType, stableKey, filePath,
    fromEpisode ? episode.id : null, fromEpisode ? episode.sequence : null,
    toEpisode ? episode.id : null, toEpisode ? episode.sequence : null,
    entityHash(entityType, snapshot), JSON.stringify(snapshot), fromEpisode ? episode.type : "baseline",
  );
}

function applyEntityChange(db, repositoryId, episode, change) {
  const previousKey = change.previousStableKey ?? change.before?.stableKey ?? change.stableKey;
  if (change.before) {
    const open = db.prepare(`
      SELECT id FROM temporal_entity_versions
      WHERE repo_id = ? AND entity_type = ? AND stable_key = ? AND valid_to_sequence IS NULL
      ORDER BY COALESCE(valid_from_sequence, -1) DESC LIMIT 1
    `).get(repositoryId, change.entityType, previousKey);
    if (open) {
      db.prepare(`
        UPDATE temporal_entity_versions
        SET valid_to_episode_id = ?, valid_to_sequence = ?
        WHERE id = ?
      `).run(episode.id, episode.sequence, open.id);
    } else {
      insertVersion(
        db, repositoryId, episode, change.entityType, previousKey,
        change.previousFilePath ?? change.before.path ?? change.filePath,
        change.before, false, true,
      );
    }
  }
  if (change.after) {
    const openAfter = db.prepare(`
      SELECT id FROM temporal_entity_versions
      WHERE repo_id = ? AND entity_type = ? AND stable_key = ? AND valid_to_sequence IS NULL
      ORDER BY COALESCE(valid_from_sequence, -1) DESC LIMIT 1
    `).get(repositoryId, change.entityType, change.stableKey);
    if (openAfter) {
      db.prepare(`UPDATE temporal_entity_versions SET valid_to_episode_id = ?, valid_to_sequence = ? WHERE id = ?`)
        .run(episode.id, episode.sequence, openAfter.id);
    }
    insertVersion(db, repositoryId, episode, change.entityType, change.stableKey, change.filePath, change.after, true, false);
  }
}

function normalizeIntegrationChange(change) {
  if (!change || !["file", "symbol"].includes(change.entityType)) throw new TemporalError("INVALID_CHANGE", "entityType must be file or symbol");
  if (!["added", "modified", "removed", "renamed"].includes(change.changeType)) throw new TemporalError("INVALID_CHANGE", "changeType must be added, modified, removed, or renamed");
  const before = change.before ?? null;
  const after = change.after ?? null;
  const stableKey = String(change.stableKey ?? after?.stableKey ?? before?.stableKey ?? "");
  if (!stableKey || stableKey.length > MAX_KEY_LENGTH || /[\0\r\n]/.test(stableKey)) {
    throw new TemporalError("INVALID_CHANGE", "Every temporal change requires a bounded stable key without control characters");
  }
  const previousStableKey = change.previousStableKey ?? (change.changeType === "renamed" ? before?.stableKey : null) ?? null;
  if (previousStableKey != null && (typeof previousStableKey !== "string" || !previousStableKey
    || previousStableKey.length > MAX_KEY_LENGTH || /[\0\r\n]/.test(previousStableKey))) {
    throw new TemporalError("INVALID_CHANGE", "previousStableKey must be a bounded string without control characters");
  }
  if (change.changeType === "added" && (before != null || after == null)) {
    throw new TemporalError("INVALID_CHANGE", "added changes require after and prohibit before snapshots");
  }
  if (change.changeType === "removed" && (before == null || after != null)) {
    throw new TemporalError("INVALID_CHANGE", "removed changes require before and prohibit after snapshots");
  }
  if (["modified", "renamed"].includes(change.changeType) && (before == null || after == null)) {
    throw new TemporalError("INVALID_CHANGE", `${change.changeType} changes require both before and after snapshots`);
  }
  if (change.changeType === "renamed" && !previousStableKey) {
    throw new TemporalError("INVALID_CHANGE", "renamed changes require previousStableKey or before.stableKey");
  }
  if (after?.stableKey != null && after.stableKey !== stableKey) {
    throw new TemporalError("INVALID_CHANGE", "after.stableKey must match stableKey");
  }
  if (before?.stableKey != null && before.stableKey !== (previousStableKey ?? stableKey)) {
    throw new TemporalError("INVALID_CHANGE", "before.stableKey must match the previous or current stable key");
  }
  const normalizeOptionalPath = (value, label) => {
    if (value == null || value === "") return null;
    const normalized = normalizeRepoPath(value);
    if (!normalized) throw new TemporalError("INVALID_PATH", `${label} must be repository-relative`);
    return normalized;
  };
  const filePath = normalizeOptionalPath(change.filePath ?? after?.path ?? null, "filePath");
  const previousFilePath = normalizeOptionalPath(change.previousFilePath ?? before?.path ?? null, "previousFilePath");
  if (change.entityType === "file" && !filePath && change.changeType !== "removed") {
    throw new TemporalError("INVALID_PATH", "File changes require a repository-relative filePath");
  }
  return {
    entityType: change.entityType,
    changeType: change.changeType,
    stableKey,
    previousStableKey,
    filePath,
    previousFilePath,
    before,
    after,
    details: change.details ?? {},
  };
}

/** Idempotent migration hook. Safe to call after every openDatabase(). */
export function ensureTemporalSchema(db) {
  db.exec(TEMPORAL_SCHEMA);
  const insert = db.prepare("INSERT OR IGNORE INTO temporal_schema_migrations(version, applied_at) VALUES (?, ?)");
  let migrated = false;
  for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
    migrated = Number(insert.run(version, new Date().toISOString()).changes) > 0 || migrated;
  }
  return { schema_version: SCHEMA_VERSION, migrated };
}

/** Generic indexer/watcher integration hook for already-computed compact changes. */
export function recordTemporalEpisode(db, {
  repoId = null,
  episodeKey,
  type,
  referenceTime = null,
  sourceId = null,
  parentSourceId = null,
  branch = null,
  authorName = null,
  authorEmail = null,
  message = null,
  complete = true,
  summary = {},
  changes = [],
} = {}) {
  ensureTemporalSchema(db);
  const repository = resolveRepository(db, repoId);
  if (typeof episodeKey !== "string" || !episodeKey || episodeKey.length > MAX_KEY_LENGTH || /[\0\r\n]/.test(episodeKey)
    || typeof type !== "string" || !type || type.length > 200 || /[\0\r\n]/.test(type)) {
    throw new TemporalError("INVALID_EPISODE", "episodeKey and type must be bounded strings without control characters");
  }
  if (!Array.isArray(changes) || changes.length > MAX_EPISODE_CHANGES) {
    throw new TemporalError("INVALID_EPISODE", `changes must be an array with at most ${MAX_EPISODE_CHANGES} entries`);
  }
  const parsedReferenceTime = new Date(referenceTime ?? Date.now());
  if (Number.isNaN(parsedReferenceTime.getTime())) throw new TemporalError("INVALID_EPISODE", "referenceTime must be a valid timestamp");
  const normalized = changes.map(normalizeIntegrationChange);
  const touched = new Set();
  for (const change of normalized) {
    const identities = [change.stableKey, change.previousStableKey].filter(Boolean)
      .map((key) => `${change.entityType}\0${key}`);
    if (identities.some((identity) => touched.has(identity))) {
      throw new TemporalError("INVALID_CHANGE", "An episode cannot contain duplicate changes to the same current or previous entity identity");
    }
    for (const identity of identities) touched.add(identity);
  }
  const inputFingerprint = hashBuffer(Buffer.from(stableJson({
    type, referenceTime: referenceTime == null ? null : parsedReferenceTime.toISOString(), sourceId, parentSourceId, branch,
    authorName, authorEmail, message, complete: Boolean(complete), summary, changes: normalized,
  })));
  const existing = db.prepare("SELECT * FROM temporal_episodes WHERE repo_id = ? AND episode_key = ?").get(repository.id, episodeKey);
  if (existing) {
    const existingFingerprint = parseJson(existing.summary_json, {}).input_fingerprint ?? null;
    if (existingFingerprint && existingFingerprint !== inputFingerprint) {
      throw new TemporalError("EPISODE_KEY_CONFLICT", `Episode key already exists with different content: ${episodeKey}`);
    }
    return { ok: true, inserted: false, episode: rowToEpisode(existing), changes: 0 };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const sequence = nextSequence(db, repository.id);
    const combinedSummary = { ...summarizeChanges(normalized), ...summary, input_fingerprint: inputFingerprint };
    const inserted = db.prepare(`
      INSERT INTO temporal_episodes(
        repo_id, sequence, episode_key, type, reference_time, source_id, parent_source_id,
        branch, author_name, author_email, message, complete, summary_json, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repository.id, sequence, episodeKey, type, parsedReferenceTime.toISOString(), sourceId, parentSourceId,
      branch, authorName, authorEmail, message, complete ? 1 : 0,
      JSON.stringify(combinedSummary), new Date().toISOString(),
    );
    const episode = {
      id: Number(inserted.lastInsertRowid), sequence, type,
    };
    const insertChange = db.prepare(`
      INSERT INTO temporal_entity_changes(
        episode_id, repo_id, entity_type, change_type, stable_key, previous_stable_key,
        file_path, previous_file_path, before_hash, after_hash, before_json, after_json, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const change of normalized) {
      insertChange.run(
        episode.id, repository.id, change.entityType, change.changeType,
        change.stableKey, change.previousStableKey, change.filePath, change.previousFilePath,
        entityHash(change.entityType, change.before), entityHash(change.entityType, change.after),
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
        JSON.stringify(change.details),
      );
      applyEntityChange(db, repository.id, episode, change);
    }
    db.exec("COMMIT");
    const row = db.prepare("SELECT * FROM temporal_episodes WHERE id = ?").get(episode.id);
    return { ok: true, inserted: true, episode: rowToEpisode(row), changes: normalized.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToEpisode(row) {
  return {
    id: Number(row.id),
    sequence: Number(row.sequence),
    episode_key: row.episode_key,
    type: row.type,
    reference_time: row.reference_time,
    source_id: row.source_id,
    parent_source_id: row.parent_source_id,
    branch: row.branch,
    author_name: row.author_name,
    author_email: row.author_email,
    message: row.message,
    complete: Boolean(row.complete),
    summary: parseJson(row.summary_json, {}),
    ingested_at: row.ingested_at,
  };
}

function rowToChange(row) {
  return {
    id: Number(row.id),
    entity_type: row.entity_type,
    change_type: row.change_type,
    stable_key: row.stable_key,
    previous_stable_key: row.previous_stable_key,
    file_path: row.file_path,
    previous_file_path: row.previous_file_path,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    details: parseJson(row.details_json, {}),
  };
}

function failureResult(error, limits, diagnostics = []) {
  const item = diagnostic(error.code ?? "TEMPORAL_ERROR", error.message, "error", error.details ?? {});
  return { ok: false, truncated: false, truncation: null, limits, diagnostics: [...diagnostics, item] };
}

function clearTemporalRepository(db, repositoryId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM temporal_worktree_scan_state WHERE repo_id = ?").run(repositoryId);
    db.prepare("DELETE FROM temporal_entity_versions WHERE repo_id = ?").run(repositoryId);
    db.prepare("DELETE FROM temporal_episodes WHERE repo_id = ?").run(repositoryId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Bounded, resumable first-parent Git ingestion. No source blobs are persisted. */
export function ingestGitHistory(db, { repoId = null, rebuild = false, onProgress = null, ...options } = {}) {
  const limits = limitsFrom(options);
  const diagnostics = [];
  let progressCallbackFailed = false;
  let repository;
  try {
    ensureTemporalSchema(db);
    repository = resolveRepository(db, repoId);
    verifyGitRepositoryRoot(repository.root);
    if (gitShallow(repository.root)) {
      diagnostics.push(diagnostic(
        "GIT_SHALLOW_HISTORY",
        "Repository history is shallow; temporal results only cover locally available commits.",
        "warning",
      ));
    }
    const head = runGit(repository.root, ["rev-parse", "HEAD"]).stdout.trim();
    const branch = gitBranch(repository.root);
    const last = rebuild ? null : db.prepare(`
      SELECT source_id FROM temporal_episodes
      WHERE repo_id = ? AND type = 'git_commit'
      ORDER BY sequence DESC LIMIT 1
    `).get(repository.id)?.source_id ?? null;
    if (last) {
      const ancestor = runGit(repository.root, ["merge-base", "--is-ancestor", last, head], { allowFailure: true });
      if (ancestor.status !== 0) {
        throw new TemporalError(
          "GIT_HISTORY_DIVERGED",
          "Stored temporal history is not an ancestor of HEAD. Re-run with rebuild=true to establish a new linear history.",
          { last_source_id: last, head },
        );
      }
    }

    let hashes;
    let historyTruncated = false;
    let hasMore = false;
    let availableCommits = 0;
    let omittedCommits = 0;
    let historyLimitReason = null;
    if (last) {
      const firstParentChain = runGit(repository.root, [
        "rev-list", "--first-parent", `--max-count=${limits.max_scan_commits + 1}`, head,
      ]).stdout.split(/\r?\n/).filter(Boolean);
      const lastIndex = firstParentChain.indexOf(last);
      if (lastIndex < 0 && firstParentChain.length > limits.max_scan_commits) {
        throw new TemporalError(
          "GIT_SCAN_LIMIT_EXCEEDED",
          "More commits are pending than max_scan_commits; increase the explicit scan limit or rebuild with a bounded horizon.",
          { max_scan_commits: limits.max_scan_commits },
        );
      }
      if (lastIndex < 0) {
        throw new TemporalError(
          "GIT_FIRST_PARENT_DIVERGED",
          "Stored temporal history is an ancestor of HEAD but is no longer on HEAD's first-parent chain. Re-run with rebuild=true.",
          { last_source_id: last, head },
        );
      }
      const chronological = firstParentChain.slice(0, lastIndex).reverse();
      availableCommits = chronological.length;
      hashes = chronological.slice(0, limits.max_commits);
      hasMore = chronological.length > hashes.length;
      omittedCommits = chronological.length - hashes.length;
      if (hasMore) historyLimitReason = "max_commits_page";
    } else {
      availableCommits = Number(runGit(repository.root, ["rev-list", "--first-parent", "--count", head]).stdout.trim()) || 0;
      const result = runGit(repository.root, [
        "rev-list", "--first-parent", `--max-count=${limits.max_commits + 1}`, head,
      ]);
      const newestFirst = result.stdout.split(/\r?\n/).filter(Boolean);
      historyTruncated = availableCommits > limits.max_commits;
      hashes = newestFirst.slice(0, limits.max_commits).reverse();
      omittedCommits = Math.max(0, availableCommits - hashes.length);
      if (historyTruncated) historyLimitReason = "max_commits_horizon";
    }
    if (!hashes.length) {
      return {
        ok: true, repo_id: repository.repo_id, head, branch, episodes_ingested: 0,
        changes_ingested: 0, commits_selected: 0, history_truncated: false,
        has_more: false, truncated: false,
        truncation: {
          history: { reason: null, available_commits: 0, selected_commits: 0, omitted_commits: 0 },
          files: { skipped_by_commit_limit: 0 },
          blobs: { content_limited_files: 0 },
        },
        limits, diagnostics,
      };
    }

    if (historyLimitReason) diagnostics.push(diagnostic(
      historyTruncated ? "HISTORY_HORIZON_TRUNCATED" : "HISTORY_PAGE_LIMITED",
      historyTruncated
        ? `Only the newest ${hashes.length} of ${availableCommits} first-parent commits are included in this history horizon.`
        : `${hashes.length} of ${availableCommits} pending first-parent commits are included in this ingestion page.`,
      historyTruncated ? "warning" : "info",
      { reason: historyLimitReason, available_commits: availableCommits, selected_commits: hashes.length, omitted_commits: omittedCommits },
    ));

    const metadata = commitMetadata(repository.root, hashes);
    const commits = hashes.map((hash) => metadata.get(hash) ?? {
      hash, parents: [], referenceTime: new Date(0).toISOString(),
      authorName: null, authorEmail: null, message: null,
    });
    for (const commit of commits) {
      const allChanges = diffForCommit(repository.root, commit);
      commit.filesSeen = allChanges.length;
      commit.fileChanges = allChanges.slice(0, limits.max_files_per_commit);
      commit.complete = allChanges.length <= limits.max_files_per_commit;
    }
    const specs = [];
    for (const commit of commits) {
      const parent = commit.parents[0] ?? null;
      for (const change of commit.fileChanges) {
        if (parent && change.changeType !== "added") specs.push(`${parent}:${change.oldPath}`);
        if (change.changeType !== "removed") specs.push(`${commit.hash}:${change.newPath}`);
      }
    }
    const blobs = inspectGitObjects(repository.root, specs, limits);
    const parsedStateCache = new Map();
    const cachedState = (filePath, blob) => {
      if (!blob) return null;
      const key = `${filePath}\0${blob.oid}\0${blob.skippedReason ?? ""}`;
      if (!parsedStateCache.has(key)) parsedStateCache.set(key, stateFromBlob(filePath, blob));
      return parsedStateCache.get(key);
    };
    let episodesIngested = 0;
    let changesIngested = 0;
    let filesSkipped = 0;
    let filesSkippedByCommitLimit = 0;
    if (rebuild) clearTemporalRepository(db, repository.id);
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      filesSkippedByCommitLimit += Math.max(0, commit.filesSeen - commit.fileChanges.length);
      const parent = commit.parents[0] ?? null;
      const episodeChanges = [];
      for (const fileChange of commit.fileChanges) {
        const beforeBlob = parent && fileChange.changeType !== "added"
          ? blobs.get(`${parent}:${fileChange.oldPath}`) ?? null
          : null;
        const afterBlob = fileChange.changeType !== "removed"
          ? blobs.get(`${commit.hash}:${fileChange.newPath}`) ?? null
          : null;
        const beforeState = cachedState(fileChange.oldPath, beforeBlob);
        const afterState = cachedState(fileChange.newPath, afterBlob);
        if (beforeBlob?.skippedReason || afterBlob?.skippedReason) filesSkipped += 1;
        episodeChanges.push(...compareFileStates(beforeState, afterState, fileChange));
      }
      const recorded = recordTemporalEpisode(db, {
        repoId: repository.repo_id,
        episodeKey: `git:${commit.hash}`,
        type: "git_commit",
        referenceTime: commit.referenceTime,
        sourceId: commit.hash,
        parentSourceId: parent,
        branch,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        message: commit.message,
        complete: commit.complete,
        summary: {
          files_seen: commit.filesSeen,
          files_processed: commit.fileChanges.length,
          files_skipped_by_commit_limit: Math.max(0, commit.filesSeen - commit.fileChanges.length),
        },
        changes: episodeChanges,
      });
      if (recorded.inserted) {
        episodesIngested += 1;
        changesIngested += recorded.changes;
      }
      if (typeof onProgress === "function") {
        try {
          onProgress({ current: index + 1, total: commits.length, commit: commit.hash, inserted: recorded.inserted });
        } catch (error) {
          if (!progressCallbackFailed) diagnostics.push(diagnostic(
            "PROGRESS_CALLBACK_FAILED",
            "The progress callback failed; ingestion continued and committed temporal data was preserved.",
            "warning",
            { message: error instanceof Error ? error.message : String(error) },
          ));
          progressCallbackFailed = true;
        }
      }
    }
    if (filesSkipped) diagnostics.push(diagnostic(
      "GIT_BLOB_LIMITS_APPLIED",
      "Some file contents exceeded blob limits; file events were retained but symbol diffs are unavailable for those files.",
      "warning",
      { files: filesSkipped },
    ));
    if (filesSkippedByCommitLimit) diagnostics.push(diagnostic(
      "GIT_COMMIT_FILE_LIMIT_APPLIED",
      "Some commit paths exceeded max_files_per_commit; those paths were not stored in temporal memory.",
      "warning",
      { files: filesSkippedByCommitLimit, max_files_per_commit: limits.max_files_per_commit },
    ));
    return {
      ok: true,
      repo_id: repository.repo_id,
      head,
      branch,
      episodes_ingested: episodesIngested,
      changes_ingested: changesIngested,
      commits_selected: commits.length,
      first_commit: commits[0]?.hash ?? null,
      last_commit: commits.at(-1)?.hash ?? null,
      history_truncated: historyTruncated,
      has_more: hasMore,
      truncated: historyTruncated || hasMore || filesSkippedByCommitLimit > 0 || filesSkipped > 0,
      truncation: {
        history: {
          reason: historyLimitReason,
          available_commits: availableCommits,
          selected_commits: commits.length,
          omitted_commits: omittedCommits,
        },
        files: { skipped_by_commit_limit: filesSkippedByCommitLimit },
        blobs: { content_limited_files: filesSkipped },
      },
      files_content_limited: filesSkipped,
      limits,
      diagnostics,
    };
  } catch (error) {
    return failureResult(error, limits, diagnostics);
  }
}

function openStateForFile(db, repositoryId, filePath) {
  const fileRow = db.prepare(`
    SELECT snapshot_json FROM temporal_entity_versions
    WHERE repo_id = ? AND entity_type = 'file' AND stable_key = ? AND valid_to_sequence IS NULL
    ORDER BY COALESCE(valid_from_sequence, -1) DESC LIMIT 1
  `).get(repositoryId, filePath);
  if (!fileRow) return null;
  const symbols = db.prepare(`
    SELECT snapshot_json FROM temporal_entity_versions
    WHERE repo_id = ? AND entity_type = 'symbol' AND file_path = ? AND valid_to_sequence IS NULL
    ORDER BY stable_key
  `).all(repositoryId, filePath).map((row) => parseJson(row.snapshot_json, {}));
  return { file: parseJson(fileRow.snapshot_json, {}), symbols };
}

function previousWorktreePaths(db, repositoryId) {
  return db.prepare(`
    SELECT DISTINCT v.file_path
    FROM temporal_entity_versions v
    JOIN temporal_episodes ep ON ep.id = v.valid_from_episode_id
    WHERE v.repo_id = ? AND v.valid_to_sequence IS NULL AND ep.type = 'working_tree'
      AND v.file_path IS NOT NULL
    ORDER BY v.file_path
  `).all(repositoryId).map((row) => row.file_path);
}

function worktreeStatusSortKey(change) {
  return stableJson([change.newPath ?? "", change.oldPath ?? "", change.status ?? ""]);
}

function selectWorktreeStatusPage(db, repositoryId, status, limit) {
  const ordered = status.map((change) => ({ change, sortKey: worktreeStatusSortKey(change) }))
    .sort((left, right) => left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0);
  const previousSortKey = db.prepare(
    "SELECT last_sort_key FROM temporal_worktree_scan_state WHERE repo_id = ?",
  ).get(repositoryId)?.last_sort_key ?? null;
  let start = previousSortKey == null ? 0 : ordered.findIndex((entry) => entry.sortKey > previousSortKey);
  if (start < 0) start = 0;
  const selectedEntries = [];
  for (let offset = 0; offset < Math.min(limit, ordered.length); offset += 1) {
    selectedEntries.push(ordered[(start + offset) % ordered.length]);
  }
  return {
    selected: selectedEntries.map((entry) => entry.change),
    previousSortKey,
    nextSortKey: selectedEntries.at(-1)?.sortKey ?? previousSortKey,
  };
}

function advanceWorktreeStatusPage(db, repositoryId, sortKey) {
  if (sortKey == null) return;
  db.prepare(`
    INSERT INTO temporal_worktree_scan_state(repo_id, last_sort_key, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      last_sort_key = excluded.last_sort_key,
      updated_at = excluded.updated_at
  `).run(repositoryId, sortKey, new Date().toISOString());
}

function latestWorktreeFileChange(db, repositoryId, filePath) {
  const row = db.prepare(`
    SELECT ec.before_json, ec.after_json, ec.change_type, ep.sequence
    FROM temporal_entity_changes ec
    JOIN temporal_episodes ep ON ep.id = ec.episode_id
    WHERE ec.repo_id = ? AND ec.entity_type = 'file' AND ep.type = 'working_tree'
      AND (ec.stable_key = ? OR ec.previous_stable_key = ?)
    ORDER BY ep.sequence DESC, ec.id DESC LIMIT 1
  `).get(repositoryId, filePath, filePath);
  return row ? {
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    changeType: row.change_type,
    sequence: Number(row.sequence),
  } : null;
}

/** Captures a durable, content-fingerprinted working-tree episode. */
export function captureWorkingTreeEpisode(db, { repoId = null, message = "Working tree snapshot", ...options } = {}) {
  const limits = limitsFrom({ ...options, maxCommits: 1 });
  const diagnostics = [];
  try {
    ensureTemporalSchema(db);
    const repository = resolveRepository(db, repoId);
    verifyGitRepositoryRoot(repository.root);
    if (gitShallow(repository.root)) diagnostics.push(diagnostic(
      "GIT_SHALLOW_HISTORY", "Repository history is shallow; HEAD baselines may be incomplete.", "warning",
    ));
    const head = runGit(repository.root, ["rev-parse", "HEAD"]).stdout.trim();
    const branch = gitBranch(repository.root);
    const status = parseNameStatus(runGit(repository.root, ["diff", "--name-status", "-z", "-M", "HEAD", "--"], { encoding: null }).stdout);
    const untracked = runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: null })
      .stdout.toString("utf8").split("\0").map(normalizeRepoPath).filter((value) => value && trackable(value));
    for (const filePath of untracked) {
      if (!status.some((item) => item.newPath === filePath)) status.push({
        status: "?", oldPath: filePath, newPath: filePath, changeType: "added",
        details: { gitStatus: "?", evidence: "git_untracked", renameConfidence: null },
      });
    }
    const represented = new Set(status.flatMap((item) => [item.oldPath, item.newPath]));
    for (const filePath of previousWorktreePaths(db, repository.id)) {
      if (!represented.has(filePath)) status.push({
        status: "W", oldPath: filePath, newPath: filePath, changeType: "modified",
        details: { gitStatus: "W", evidence: "working_tree_reconciliation", renameConfidence: null },
      });
    }
    const scanPage = selectWorktreeStatusPage(db, repository.id, status, limits.max_files_per_commit);
    const selected = scanPage.selected;
    const headSpecs = [];
    for (const change of selected) {
      if (change.changeType !== "added" && !openStateForFile(db, repository.id, change.oldPath)) {
        headSpecs.push(`${head}:${change.oldPath}`);
      }
    }
    const blobs = inspectGitObjects(repository.root, headSpecs, limits);
    const episodeChanges = [];
    let contentLimitedFiles = 0;
    for (const fileChange of selected) {
      const openBefore = openStateForFile(db, repository.id, fileChange.oldPath);
      const beforeState = openBefore
        ?? (fileChange.changeType !== "added" ? stateFromBlob(fileChange.oldPath, blobs.get(`${head}:${fileChange.oldPath}`) ?? null) : null);
      const afterState = fileChange.changeType === "removed" ? null : stateFromWorktree(repository.root, fileChange.newPath, limits.max_file_bytes);
      if (beforeState?.file?.skippedReason || afterState?.file?.skippedReason) contentLimitedFiles += 1;
      const latestWorktreeChange = !openBefore && !afterState
        ? latestWorktreeFileChange(db, repository.id, fileChange.oldPath)
        : null;
      if (latestWorktreeChange && latestWorktreeChange.after == null) continue;
      if (fileChange.changeType === "renamed" && !openBefore) {
        const openAfter = openStateForFile(db, repository.id, fileChange.newPath);
        if (openAfter?.file?.contentHash === afterState?.file?.contentHash) continue;
      }
      if (beforeState?.file?.contentHash === afterState?.file?.contentHash && fileChange.changeType !== "renamed") continue;
      episodeChanges.push(...compareFileStates(beforeState, afterState, fileChange));
    }
    if (!episodeChanges.length) {
      advanceWorktreeStatusPage(db, repository.id, scanPage.nextSortKey);
      return {
        ok: true, repo_id: repository.repo_id, head, branch, inserted: false,
        episode: null, changes_ingested: 0, files_seen: status.length,
        truncated: status.length > limits.max_files_per_commit || contentLimitedFiles > 0,
        truncation: {
          files: { skipped_by_commit_limit: Math.max(0, status.length - selected.length) },
          blobs: { content_limited_files: contentLimitedFiles },
        },
        limits, diagnostics,
      };
    }
    const fingerprint = hashBuffer(Buffer.from(stableJson(episodeChanges.map((change) => ({
      entityType: change.entityType,
      changeType: change.changeType,
      stableKey: change.stableKey,
      previousStableKey: change.previousStableKey,
      before: entityHash(change.entityType, change.before),
      after: entityHash(change.entityType, change.after),
    })))));
    const recorded = recordTemporalEpisode(db, {
      repoId: repository.repo_id,
      episodeKey: `worktree:${head}:${fingerprint}`,
      type: "working_tree",
      sourceId: fingerprint,
      parentSourceId: head,
      branch,
      message,
      complete: status.length <= limits.max_files_per_commit,
      summary: {
        files_seen: status.length,
        files_processed: selected.length,
        files_skipped_by_commit_limit: Math.max(0, status.length - selected.length),
        scan_started_after: scanPage.previousSortKey,
        scan_advanced_to: scanPage.nextSortKey,
      },
      changes: episodeChanges,
    });
    advanceWorktreeStatusPage(db, repository.id, scanPage.nextSortKey);
    return {
      ok: true,
      repo_id: repository.repo_id,
      head,
      branch,
      inserted: recorded.inserted,
      episode: recorded.episode,
      changes_ingested: recorded.changes,
      files_seen: status.length,
      truncated: status.length > limits.max_files_per_commit || contentLimitedFiles > 0,
      truncation: {
        files: { skipped_by_commit_limit: Math.max(0, status.length - selected.length) },
        blobs: { content_limited_files: contentLimitedFiles },
      },
      limits,
      diagnostics,
    };
  } catch (error) {
    return failureResult(error, limits, diagnostics);
  }
}

function queryLimit(value, fallback = 100) {
  return asNumber(value, fallback, 1, MAX_QUERY_LIMIT);
}

function episodeChanges(db, episodeId, { entityType = null, filePath = null } = {}) {
  const clauses = ["episode_id = ?"];
  const params = [episodeId];
  if (entityType) {
    clauses.push("entity_type = ?");
    params.push(entityType);
  }
  if (filePath) {
    clauses.push("(file_path = ? OR previous_file_path = ?)");
    params.push(filePath, filePath);
  }
  return db.prepare(`
    SELECT * FROM temporal_entity_changes
    WHERE ${clauses.join(" AND ")}
    ORDER BY id
  `).all(...params).map(rowToChange);
}

/** Cursor/timestamp changes-since query over durable temporal episodes. */
export function getTemporalChangesSince(db, { repoId = null, since = 0, limit = 100, entityType = null, filePath = null } = {}) {
  ensureTemporalSchema(db);
  const repository = resolveRepository(db, repoId);
  if (entityType != null && !["file", "symbol"].includes(entityType)) {
    throw new TemporalError("INVALID_ENTITY_TYPE", "entityType must be file or symbol");
  }
  const normalizedFilePath = filePath == null ? null : normalizeRepoPath(filePath);
  if (filePath != null && !normalizedFilePath) throw new TemporalError("INVALID_PATH", "filePath must be repository-relative");
  const cappedLimit = queryLimit(limit);
  const clauses = ["repo_id = ?"];
  const params = [repository.id];
  if (typeof since === "object" && since?.sequence != null) {
    if (since.repo_id != null && String(since.repo_id) !== repository.repo_id) {
      throw new TemporalError("CURSOR_REPOSITORY_MISMATCH", "Temporal cursor belongs to a different repository");
    }
    const cursorSequence = Number(since.sequence);
    if (!Number.isInteger(cursorSequence) || cursorSequence < 0) throw new TemporalError("INVALID_CURSOR", "Cursor sequence must be a non-negative integer");
    if (since.episode_id != null) {
      const cursorEpisode = db.prepare(`
        SELECT id, sequence, reference_time, episode_key FROM temporal_episodes
        WHERE repo_id = ? AND id = ?
      `).get(repository.id, Number(since.episode_id));
      if (!cursorEpisode) throw new TemporalError("CURSOR_NOT_FOUND", `Temporal cursor episode not found: ${since.episode_id}`);
      if (Number(cursorEpisode.sequence) !== cursorSequence
        || (since.reference_time != null && cursorEpisode.reference_time !== since.reference_time)
        || (since.episode_key != null && cursorEpisode.episode_key !== since.episode_key)) {
        throw new TemporalError("CURSOR_STALE", "Temporal cursor no longer identifies the recorded episode");
      }
    }
    clauses.push("sequence > ?");
    params.push(cursorSequence);
  } else if (typeof since === "number" || /^\d+$/.test(String(since))) {
    const episodeId = Number(since);
    if (!Number.isSafeInteger(episodeId) || episodeId < 0) throw new TemporalError("INVALID_CURSOR", "since must be a non-negative episode id");
    const row = episodeId > 0 ? db.prepare("SELECT sequence FROM temporal_episodes WHERE repo_id = ? AND id = ?").get(repository.id, episodeId) : null;
    if (episodeId > 0 && !row) throw new TemporalError("CURSOR_NOT_FOUND", `Temporal cursor episode not found: ${episodeId}`);
    clauses.push("sequence > ?");
    params.push(row?.sequence ?? 0);
  } else {
    const timestamp = new Date(since);
    if (Number.isNaN(timestamp.getTime())) throw new TemporalError("INVALID_CURSOR", "since must be an episode id, cursor, or valid timestamp");
    clauses.push("reference_time > ?");
    params.push(timestamp.toISOString());
  }
  const rows = db.prepare(`
    SELECT * FROM temporal_episodes
    WHERE ${clauses.join(" AND ")}
    ORDER BY sequence
    LIMIT ?
  `).all(...params, cappedLimit + 1);
  const hasMore = rows.length > cappedLimit;
  const selected = rows.slice(0, cappedLimit);
  const episodes = selected.map((row) => ({
    ...rowToEpisode(row),
    changes: episodeChanges(db, row.id, { entityType, filePath: normalizedFilePath }),
  })).filter((episode) => !entityType && !filePath || episode.changes.length > 0);
  const last = selected.at(-1);
  return {
    repo_id: repository.repo_id,
    episodes,
    cursor: last ? {
      repo_id: repository.repo_id,
      episode_id: Number(last.id),
      episode_key: last.episode_key,
      sequence: Number(last.sequence),
      reference_time: last.reference_time,
    } : null,
    next_since: last ? Number(last.id) : since,
    has_more: hasMore,
    truncated: hasMore,
    truncation: hasMore ? { reason: "query_limit", remaining: "unknown" } : null,
    limits: { requested: Number(limit) || 100, applied: cappedLimit, maximum: MAX_QUERY_LIMIT },
  };
}

function resolveTemporalStableKey(db, repository, { entityType, stableKey, target, filePath }) {
  if (stableKey) {
    if (typeof stableKey !== "string" || stableKey.length > MAX_KEY_LENGTH || /[\0\r\n]/.test(stableKey)) {
      throw new TemporalError("INVALID_CHANGE", "stableKey must be a bounded string without control characters");
    }
    return stableKey;
  }
  const normalizedFile = filePath ? normalizeRepoPath(filePath) : null;
  if (filePath && !normalizedFile) throw new TemporalError("INVALID_PATH", "filePath must be repository-relative");
  if (entityType === "file") {
    const value = normalizeRepoPath(target ?? normalizedFile ?? "");
    if (!value) throw new TemporalError("TEMPORAL_TARGET_REQUIRED", "A file stableKey, target, or filePath is required");
    return value;
  }
  if (!target) throw new TemporalError("TEMPORAL_TARGET_REQUIRED", "A symbol stableKey or target is required");
  const current = db.prepare(`
    SELECT s.stable_key
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND (s.qualified_name = ? OR s.name = ?)
      AND (? IS NULL OR f.path = ?)
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.exported DESC, f.path
    LIMIT 1
  `).get(repository.id, target, target, normalizedFile, normalizedFile, target);
  if (current) return current.stable_key;
  const historical = db.prepare(`
    SELECT stable_key
    FROM temporal_entity_changes
    WHERE repo_id = ? AND entity_type = 'symbol'
      AND (
        json_extract(after_json, '$.qualifiedName') = ? OR json_extract(after_json, '$.name') = ?
        OR json_extract(before_json, '$.qualifiedName') = ? OR json_extract(before_json, '$.name') = ?
      )
      AND (? IS NULL OR file_path = ? OR previous_file_path = ?)
    ORDER BY id DESC LIMIT 1
  `).get(repository.id, target, target, target, target, normalizedFile, normalizedFile, normalizedFile);
  if (!historical) throw new TemporalError("TEMPORAL_TARGET_NOT_FOUND", `Temporal symbol not found: ${target}`);
  return historical.stable_key;
}

function lineageKeys(db, repositoryId, entityType, initial) {
  const keys = new Set([initial]);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const values = [...keys];
    const placeholders = values.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT stable_key, previous_stable_key
      FROM temporal_entity_changes
      WHERE repo_id = ? AND entity_type = ?
        AND (stable_key IN (${placeholders}) OR previous_stable_key IN (${placeholders}))
    `).all(repositoryId, entityType, ...values, ...values);
    const previousSize = keys.size;
    for (const row of rows) {
      if (row.stable_key) keys.add(row.stable_key);
      if (row.previous_stable_key) keys.add(row.previous_stable_key);
    }
    if (keys.size === previousSize || keys.size >= 1000) break;
  }
  return [...keys];
}

/** Lineage-aware file or symbol timeline, including rename evidence. */
export function getTemporalTimeline(db, {
  repoId = null, entityType = "symbol", stableKey = null, target = null,
  filePath = null, from = null, to = null, limit = 100, direction = "asc",
} = {}) {
  ensureTemporalSchema(db);
  if (!["file", "symbol"].includes(entityType)) throw new TemporalError("INVALID_ENTITY_TYPE", "entityType must be file or symbol");
  if (!new Set(["asc", "desc"]).has(direction)) throw new TemporalError("INVALID_DIRECTION", "direction must be asc or desc");
  const repository = resolveRepository(db, repoId);
  const resolved = resolveTemporalStableKey(db, repository, { entityType, stableKey, target, filePath });
  const lineage = lineageKeys(db, repository.id, entityType, resolved);
  const placeholders = lineage.map(() => "?").join(",");
  const clauses = [
    "ec.repo_id = ?", "ec.entity_type = ?",
    `(ec.stable_key IN (${placeholders}) OR ec.previous_stable_key IN (${placeholders}))`,
  ];
  const params = [repository.id, entityType, ...lineage, ...lineage];
  if (from) {
    clauses.push("ep.reference_time >= ?");
    params.push(String(from));
  }
  if (to) {
    clauses.push("ep.reference_time <= ?");
    params.push(String(to));
  }
  const cappedLimit = queryLimit(limit);
  const order = direction === "desc" ? "DESC" : "ASC";
  const rows = db.prepare(`
    SELECT ec.*, ep.sequence, ep.episode_key, ep.type AS episode_type,
      ep.reference_time, ep.source_id, ep.message
    FROM temporal_entity_changes ec
    JOIN temporal_episodes ep ON ep.id = ec.episode_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY ep.sequence ${order}, ec.id ${order}
    LIMIT ?
  `).all(...params, cappedLimit + 1);
  const hasMore = rows.length > cappedLimit;
  const events = rows.slice(0, cappedLimit).map((row) => ({
    episode: {
      id: Number(row.episode_id), sequence: Number(row.sequence), episode_key: row.episode_key,
      type: row.episode_type, reference_time: row.reference_time,
      source_id: row.source_id, message: row.message,
    },
    change: rowToChange(row),
  }));
  return {
    repo_id: repository.repo_id,
    entity_type: entityType,
    requested_stable_key: resolved,
    lineage_stable_keys: lineage,
    events,
    has_more: hasMore,
    truncated: hasMore,
    truncation: hasMore ? { reason: "query_limit", remaining: "unknown" } : null,
    limits: { requested: Number(limit) || 100, applied: cappedLimit, maximum: MAX_QUERY_LIMIT },
  };
}

/** Evolution summary built on the same lineage-aware event stream. */
export function getTemporalEvolution(db, options = {}) {
  const timeline = getTemporalTimeline(db, options);
  const counts = { added: 0, modified: 0, removed: 0, renamed: 0 };
  for (const event of timeline.events) counts[event.change.change_type] += 1;
  return {
    ...timeline,
    counts,
    first_event_at: timeline.events[0]?.episode.reference_time ?? null,
    last_event_at: timeline.events.at(-1)?.episode.reference_time ?? null,
  };
}

/** Replays compact entity state at an episode using valid-from/valid-to intervals. */
export function replayTemporalState(db, { repoId = null, episodeId = null, sequence = null, entityType = null, limit = 10_000 } = {}) {
  ensureTemporalSchema(db);
  const repository = resolveRepository(db, repoId);
  if (entityType != null && !["file", "symbol"].includes(entityType)) {
    throw new TemporalError("INVALID_ENTITY_TYPE", "entityType must be file or symbol");
  }
  let targetSequence = sequence != null ? Number(sequence) : null;
  let episode = null;
  if (episodeId != null) {
    episode = db.prepare("SELECT * FROM temporal_episodes WHERE repo_id = ? AND id = ?").get(repository.id, Number(episodeId));
    if (!episode) throw new TemporalError("EPISODE_NOT_FOUND", `Temporal episode not found: ${episodeId}`);
    targetSequence = Number(episode.sequence);
  }
  if (!Number.isInteger(targetSequence) || targetSequence < 1) throw new TemporalError("EPISODE_REQUIRED", "episodeId or a positive sequence is required");
  if (!episode) episode = db.prepare("SELECT * FROM temporal_episodes WHERE repo_id = ? AND sequence = ?").get(repository.id, targetSequence);
  if (!episode) throw new TemporalError("EPISODE_NOT_FOUND", `Temporal sequence not found: ${targetSequence}`);
  const cappedLimit = asNumber(limit, 10_000, 1, MAX_REPLAY_ENTITIES);
  const rows = db.prepare(`
    SELECT * FROM temporal_entity_versions
    WHERE repo_id = ?
      AND (valid_from_sequence IS NULL OR valid_from_sequence <= ?)
      AND (valid_to_sequence IS NULL OR valid_to_sequence > ?)
      AND (? IS NULL OR entity_type = ?)
    ORDER BY entity_type, stable_key
    LIMIT ?
  `).all(repository.id, targetSequence, targetSequence, entityType, entityType, cappedLimit + 1);
  const hasMore = rows.length > cappedLimit;
  return {
    repo_id: repository.repo_id,
    episode: rowToEpisode(episode),
    entities: rows.slice(0, cappedLimit).map((row) => ({
      entity_type: row.entity_type,
      stable_key: row.stable_key,
      file_path: row.file_path,
      content_hash: row.content_hash,
      valid_from_sequence: row.valid_from_sequence == null ? null : Number(row.valid_from_sequence),
      valid_to_sequence: row.valid_to_sequence == null ? null : Number(row.valid_to_sequence),
      snapshot: parseJson(row.snapshot_json, {}),
      origin_type: row.origin_type,
    })),
    has_more: hasMore,
    truncated: hasMore,
    truncation: hasMore ? { reason: "entity_limit", remaining: "unknown" } : null,
    limits: { requested: Number(limit) || 10_000, applied: cappedLimit, maximum: MAX_REPLAY_ENTITIES },
  };
}

export function getTemporalStats(db, { repoId = null } = {}) {
  ensureTemporalSchema(db);
  const repository = resolveRepository(db, repoId);
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM temporal_episodes WHERE repo_id = ?) AS episodes,
      (SELECT COUNT(*) FROM temporal_entity_changes WHERE repo_id = ?) AS changes,
      (SELECT COUNT(*) FROM temporal_entity_versions WHERE repo_id = ?) AS versions,
      (SELECT COUNT(*) FROM temporal_entity_versions WHERE repo_id = ? AND valid_to_sequence IS NULL) AS open_versions,
      (SELECT MIN(reference_time) FROM temporal_episodes WHERE repo_id = ?) AS first_reference_time,
      (SELECT MAX(reference_time) FROM temporal_episodes WHERE repo_id = ?) AS last_reference_time
  `).get(repository.id, repository.id, repository.id, repository.id, repository.id, repository.id);
  return {
    repo_id: repository.repo_id,
    schema_version: SCHEMA_VERSION,
    episodes: Number(row.episodes),
    changes: Number(row.changes),
    versions: Number(row.versions),
    open_versions: Number(row.open_versions),
    first_reference_time: row.first_reference_time,
    last_reference_time: row.last_reference_time,
    limits: { query_maximum: MAX_QUERY_LIMIT, replay_maximum: MAX_REPLAY_ENTITIES },
  };
}
