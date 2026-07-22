import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRealPath, samePath } from "./path-utils.mjs";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT,
  head_commit TEXT,
  branch TEXT,
  git_common_dir TEXT,
  git_dir TEXT,
  worktree_id TEXT,
  is_linked_worktree INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,
  dirty_file_count INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  index_generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  content_hash TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(repo_id, path)
);

CREATE INDEX IF NOT EXISTS files_repo_path_idx ON files(repo_id, path);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  body_hash TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, stable_key)
);

CREATE INDEX IF NOT EXISTS symbols_repo_name_idx ON symbols(repo_id, name);
CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_qualified_idx ON symbols(repo_id, qualified_name);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  symbol_id UNINDEXED,
  repo_row_id UNINDEXED,
  name,
  qualified_name,
  signature,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS file_imports (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  imported_names TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS imports_repo_file_idx ON file_imports(repo_id, file_id);

CREATE TABLE IF NOT EXISTS symbol_calls (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_stable_key TEXT NOT NULL,
  callee_name TEXT NOT NULL,
  qualifier TEXT,
  call_line INTEGER,
  syntax TEXT NOT NULL DEFAULT 'call',
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolution_status TEXT NOT NULL DEFAULT 'pending',
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  confidence REAL
);

CREATE INDEX IF NOT EXISTS symbol_calls_repo_source_idx ON symbol_calls(repo_id, source_stable_key);
CREATE INDEX IF NOT EXISTS symbol_calls_repo_status_idx ON symbol_calls(repo_id, resolution_status);

CREATE TABLE IF NOT EXISTS file_diagnostics (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  parser_mode TEXT NOT NULL,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  indexed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS file_diagnostics_repo_mode_idx ON file_diagnostics(repo_id, parser_mode);

CREATE TABLE IF NOT EXISTS code_relationships (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_stable_key TEXT,
  source_name TEXT,
  target_name TEXT,
  specifier TEXT,
  start_line INTEGER,
  end_line INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS code_relationships_repo_category_idx
  ON code_relationships(repo_id, category, kind);
CREATE INDEX IF NOT EXISTS code_relationships_file_idx
  ON code_relationships(file_id, category);
CREATE INDEX IF NOT EXISTS code_relationships_source_idx
  ON code_relationships(repo_id, source_stable_key);

CREATE TABLE IF NOT EXISTS api_operations (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_stable_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  framework TEXT NOT NULL,
  line INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  handler_name TEXT
);

CREATE INDEX IF NOT EXISTS api_operations_repo_path_idx ON api_operations(repo_id, normalized_path, method);
CREATE INDEX IF NOT EXISTS api_operations_source_idx ON api_operations(repo_id, source_stable_key);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  source_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS edges_source_symbol_idx ON edges(repo_id, source_symbol_id, kind);
CREATE INDEX IF NOT EXISTS edges_target_symbol_idx ON edges(repo_id, target_symbol_id, kind);
CREATE INDEX IF NOT EXISTS edges_source_file_idx ON edges(repo_id, source_file_id, kind);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  source_id TEXT,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS episodes_repo_time_idx ON episodes(repo_id, reference_time);

CREATE TABLE IF NOT EXISTS episode_changes (
  id INTEGER PRIMARY KEY,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS changes_episode_idx ON episode_changes(episode_id);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rationale TEXT NOT NULL,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS decisions_repo_status_idx ON decisions(repo_id, status);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  decision_id UNINDEXED,
  repo_row_id UNINDEXED,
  title,
  rationale,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS decision_links (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  symbol_stable_key TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'governs',
  UNIQUE(decision_id, symbol_stable_key, relationship)
);

CREATE INDEX IF NOT EXISTS decision_links_symbol_idx ON decision_links(symbol_stable_key);

CREATE TABLE IF NOT EXISTS tool_usage_events (
  id INTEGER PRIMARY KEY,
  repo_id TEXT,
  tool_name TEXT NOT NULL,
  surface TEXT NOT NULL,
  called_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  estimated_output_tokens INTEGER NOT NULL,
  referenced_file_count INTEGER NOT NULL DEFAULT 0,
  baseline_file_bytes INTEGER NOT NULL DEFAULT 0,
  estimated_context_tokens_avoided INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tool_usage_repo_time_idx ON tool_usage_events(repo_id, called_at);
CREATE INDEX IF NOT EXISTS tool_usage_tool_time_idx ON tool_usage_events(tool_name, called_at);
CREATE INDEX IF NOT EXISTS tool_usage_surface_time_idx ON tool_usage_events(surface, called_at);
`;

export function openDatabase(databasePath) {
  const resolved = path.resolve(databasePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  const repositoryColumns = new Set(db.prepare("PRAGMA table_info(repositories)").all().map((column) => column.name));
  const repositoryMigrations = [
    ["branch", "ALTER TABLE repositories ADD COLUMN branch TEXT"],
    ["git_common_dir", "ALTER TABLE repositories ADD COLUMN git_common_dir TEXT"],
    ["git_dir", "ALTER TABLE repositories ADD COLUMN git_dir TEXT"],
    ["worktree_id", "ALTER TABLE repositories ADD COLUMN worktree_id TEXT"],
    ["is_linked_worktree", "ALTER TABLE repositories ADD COLUMN is_linked_worktree INTEGER NOT NULL DEFAULT 0"],
    ["dirty", "ALTER TABLE repositories ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0"],
    ["dirty_file_count", "ALTER TABLE repositories ADD COLUMN dirty_file_count INTEGER NOT NULL DEFAULT 0"],
    ["snapshot_id", "ALTER TABLE repositories ADD COLUMN snapshot_id TEXT"],
    ["snapshot_json", "ALTER TABLE repositories ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'"],
    ["index_generation", "ALTER TABLE repositories ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, sql] of repositoryMigrations) {
    if (!repositoryColumns.has(column)) db.exec(sql);
  }
  const callColumns = new Set(db.prepare("PRAGMA table_info(symbol_calls)").all().map((column) => column.name));
  if (!callColumns.has("occurrences")) db.exec("ALTER TABLE symbol_calls ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1");
  return db;
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function ensureRepository(db, root, repoId, name) {
  const now = new Date().toISOString();
  const resolvedRoot = resolveRealPath(root);
  const byId = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId);
  if (byId && !samePath(byId.root, resolvedRoot)) {
    throw new Error(`repo_id '${repoId}' already belongs to a different checkout: ${byId.root}. Use a distinct repo_id for ${resolvedRoot}.`);
  }
  const byRoot = db.prepare("SELECT * FROM repositories ORDER BY id").all()
    .find((repository) => samePath(repository.root, resolvedRoot));
  if (byRoot && byRoot.repo_id !== repoId) {
    throw new Error(`Checkout ${resolvedRoot} is already indexed as repo_id '${byRoot.repo_id}'. Reuse that identifier.`);
  }
  db.prepare(`
    INSERT INTO repositories(repo_id, root, name, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET root = excluded.root, name = excluded.name
  `).run(repoId, resolvedRoot, name, now);
  return db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId);
}

export function rebuildFtsRow(db, symbol) {
  db.prepare("DELETE FROM symbols_fts WHERE symbol_id = ?").run(symbol.id);
  db.prepare(`
    INSERT INTO symbols_fts(symbol_id, repo_row_id, name, qualified_name, signature, body_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    symbol.id,
    symbol.repo_id,
    symbol.name,
    symbol.qualified_name,
    symbol.signature,
    symbol.body_text,
  );
}

export function deleteFtsForFile(db, fileId) {
  db.prepare(`
    DELETE FROM symbols_fts
    WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)
  `).run(fileId);
}
