import { createHash } from "node:crypto";
import { resolveRepository } from "./queries.mjs";

const DECISION_KINDS = new Set(["choice", "ban", "convention", "contract"]);
const DECISION_STATUSES = new Set(["active", "superseded", "rejected"]);
const SCOPE_TYPES = new Set(["symbol", "file", "repository"]);
const CONTRACT_KINDS = new Set(["requirement", "prohibition", "convention"]);
const OVERLAY_STATUSES = new Set(["open", "merged", "abandoned"]);
const CHANGE_TYPES = new Set(["added", "modified", "removed"]);

const LOCAL_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_decision_details (
  decision_id INTEGER PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'choice' CHECK(kind IN ('choice', 'ban', 'convention', 'contract')),
  superseded_by INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS local_decision_scopes (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('symbol', 'file', 'repository')),
  scope_key TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'governs',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(decision_id, scope_type, scope_key, relationship)
);
CREATE INDEX IF NOT EXISTS local_decision_scopes_lookup_idx
  ON local_decision_scopes(scope_type, scope_key, decision_id);

CREATE TABLE IF NOT EXISTS local_decision_contracts (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('requirement', 'prohibition', 'convention')),
  statement TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'must' CHECK(severity IN ('must', 'should', 'informational')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(decision_id, kind, statement)
);
CREATE INDEX IF NOT EXISTS local_decision_contracts_decision_idx
  ON local_decision_contracts(decision_id);

CREATE TABLE IF NOT EXISTS local_decision_provenance (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_uri TEXT,
  recorded_by TEXT,
  observed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS local_decision_provenance_decision_idx
  ON local_decision_provenance(decision_id, observed_at);

CREATE TABLE IF NOT EXISTS local_decision_verifications (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK(verdict IN ('held', 'violated')),
  observed_at TEXT NOT NULL,
  note TEXT,
  evidence_json TEXT NOT NULL,
  provenance_id INTEGER REFERENCES local_decision_provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS local_decision_verifications_latest_idx
  ON local_decision_verifications(decision_id, observed_at DESC, id DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS local_decisions_fts USING fts5(
  decision_id UNINDEXED,
  title,
  rationale,
  alternatives,
  tags,
  kind,
  clauses,
  scopes,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS local_decisions_fts_delete
AFTER DELETE ON decisions BEGIN
  DELETE FROM local_decisions_fts WHERE decision_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS local_worktree_overlays (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_reference TEXT NOT NULL,
  base_head TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'merged', 'abandoned')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, name)
);
CREATE INDEX IF NOT EXISTS local_worktree_overlays_repo_idx
  ON local_worktree_overlays(repo_id, status, name);

CREATE TABLE IF NOT EXISTS local_worktree_symbols (
  id INTEGER PRIMARY KEY,
  overlay_id INTEGER NOT NULL REFERENCES local_worktree_overlays(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('added', 'modified', 'removed')),
  file_path TEXT,
  base_fingerprint TEXT,
  overlay_fingerprint TEXT,
  base_json TEXT,
  overlay_json TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE(overlay_id, stable_key)
);
CREATE INDEX IF NOT EXISTS local_worktree_symbols_overlay_idx
  ON local_worktree_symbols(overlay_id, stable_key);
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clamp(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(Number.isFinite(number) ? number : fallback, maximum));
}

function nowIso(value = null) {
  if (value == null) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function normalizedFilePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0") || /^[\\/]/.test(raw) || /^[a-z]:[\\/]/i.test(raw)
    || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.length > 4096) {
    throw new Error(`Invalid repository-relative file path: ${value}`);
  }
  const result = raw.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".").join("/");
  if (!result || result.split("/").includes("..")) throw new Error(`Invalid repository-relative file path: ${value}`);
  return result;
}

function normalizedName(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.includes("\0")) throw new Error(`${label} cannot contain a null character`);
  if (result.length > 200) throw new Error(`${label} must be at most 200 characters`);
  return result;
}

function requiredText(value, label, maximum = 20000) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.includes("\0")) throw new Error(`${label} cannot contain a null character`);
  if (result.length > maximum) throw new Error(`${label} must be at most ${maximum} characters`);
  return result;
}

function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Values must be plain JSON objects and arrays");
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Values cannot contain non-finite numbers");
  if (["bigint", "function", "symbol"].includes(typeof value)) throw new Error(`Values cannot contain ${typeof value}`);
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return value == null ? null : createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function ftsQuery(value) {
  const tokens = String(value ?? "").normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.slice(0, 20).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function resolveCurrentSymbol(db, repository, target) {
  if (typeof target === "number") {
    return db.prepare(`
      SELECT s.*, f.path AS file_path, f.language
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.repo_id = ? AND s.id = ?
    `).get(repository.id, target) ?? null;
  }
  const name = String(target ?? "").trim();
  if (!name) return null;
  return db.prepare(`
    SELECT s.*, f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND (s.stable_key = ? OR s.qualified_name = ? OR s.name = ?)
    ORDER BY CASE WHEN s.stable_key = ? THEN 0 WHEN s.qualified_name = ? THEN 1 ELSE 2 END,
      s.exported DESC, f.path, s.start_line
    LIMIT 1
  `).get(repository.id, name, name, name, name, name) ?? null;
}

function publicCurrentSymbol(row) {
  if (!row) return null;
  return {
    id: row.id,
    stable_key: row.stable_key,
    name: row.name,
    qualified_name: row.qualified_name,
    kind: row.kind,
    signature: row.signature,
    file_path: row.file_path,
    language: row.language,
    start_line: row.start_line,
    end_line: row.end_line,
    body_hash: row.body_hash,
  };
}

function indexedSymbolSnapshot(db, repository, stableKey) {
  const row = resolveCurrentSymbol(db, repository, stableKey);
  if (!row) return null;
  return {
    stable_key: row.stable_key,
    name: row.name,
    qualified_name: row.qualified_name,
    kind: row.kind,
    signature: row.signature,
    file_path: row.file_path,
    language: row.language,
    start_line: row.start_line,
    end_line: row.end_line,
    exported: Boolean(row.exported),
    body_hash: row.body_hash,
    body_text: row.body_text,
  };
}

export function ensureLocalMemorySchema(db) {
  db.exec(LOCAL_MEMORY_SCHEMA);
  db.prepare(`
    INSERT OR IGNORE INTO local_decision_details(decision_id, kind, metadata_json)
    SELECT id, 'choice', '{}' FROM decisions
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO local_decision_scopes(decision_id, scope_type, scope_key, relationship, metadata_json)
    SELECT decision_id, 'symbol', symbol_stable_key, relationship, '{}' FROM decision_links
  `).run();
  db.prepare(`
    DELETE FROM local_decisions_fts
    WHERE CAST(decision_id AS INTEGER) NOT IN (SELECT id FROM decisions)
  `).run();
  const indexedRows = new Map();
  for (const row of db.prepare("SELECT * FROM local_decisions_fts ORDER BY rowid").all()) {
    const id = Number(row.decision_id);
    const values = indexedRows.get(id) ?? [];
    values.push(row);
    indexedRows.set(id, values);
  }
  for (const { id } of db.prepare("SELECT id FROM decisions ORDER BY id").all()) {
    const expected = decisionSearchValues(db, id);
    const actual = indexedRows.get(id) ?? [];
    if (actual.length !== 1 || !decisionSearchMatches(actual[0], expected)) syncDecisionSearch(db, id);
  }
  return { ok: true, schema: "local-memory-v1" };
}

function normalizeScope(db, repository, scope) {
  const type = String(scope?.type ?? scope?.scope_type ?? "").toLowerCase();
  if (!SCOPE_TYPES.has(type)) throw new Error(`Unsupported decision scope type: ${type}`);
  const relationship = requiredText(scope.relationship ?? "governs", "scope relationship", 200);
  if (type === "repository") return { type, key: "*", relationship, metadata: scope.metadata ?? {} };
  if (type === "file") return { type, key: normalizedFilePath(scope.key ?? scope.file_path ?? scope.filePath), relationship, metadata: scope.metadata ?? {} };
  const explicitStableKey = scope.stable_key ?? scope.stableKey ?? null;
  if (explicitStableKey != null) {
    const key = normalizedName(explicitStableKey, "symbol stable_key");
    const local = db.prepare("SELECT 1 FROM symbols WHERE repo_id = ? AND stable_key = ? LIMIT 1").get(repository.id, key);
    const foreign = local ? null : db.prepare("SELECT 1 FROM symbols WHERE repo_id <> ? AND stable_key = ? LIMIT 1").get(repository.id, key);
    if (foreign) throw new Error(`Symbol stable_key belongs to a different repository: ${key}`);
    return { type, key, relationship, metadata: scope.metadata ?? {} };
  }
  const target = scope.key ?? scope.symbol;
  const symbol = resolveCurrentSymbol(db, repository, target);
  if (!symbol) throw new Error(`Indexed symbol not found for scope: ${target}`);
  return { type, key: symbol.stable_key, relationship, metadata: scope.metadata ?? {} };
}

function normalizeContracts({ contracts = [], bans = [], conventions = [] }) {
  const values = [
    ...bans.map((statement) => ({ kind: "prohibition", statement, severity: "must" })),
    ...conventions.map((statement) => ({ kind: "convention", statement, severity: "should" })),
    ...contracts.map((contract) => typeof contract === "string" ? { kind: "requirement", statement: contract } : contract),
  ];
  return values.map((contract) => {
    const kind = String(contract.kind ?? "requirement").toLowerCase();
    if (!CONTRACT_KINDS.has(kind)) throw new Error(`Unsupported contract kind: ${kind}`);
    const statement = requiredText(contract.statement, "Contract statement");
    const severity = String(contract.severity ?? (kind === "convention" ? "should" : "must")).toLowerCase();
    if (!new Set(["must", "should", "informational"]).has(severity)) throw new Error(`Unsupported contract severity: ${severity}`);
    return { kind, statement, severity, metadata: contract.metadata ?? {} };
  });
}

function normalizeProvenance(provenance) {
  const values = Array.isArray(provenance) ? provenance : provenance ? [provenance] : [];
  return values.map((item) => ({
    source_type: normalizedName(item.source_type ?? item.sourceType, "provenance source_type"),
    source_id: item.source_id ?? item.sourceId ?? null,
    source_uri: item.source_uri ?? item.sourceUri ?? null,
    recorded_by: item.recorded_by ?? item.recordedBy ?? null,
    observed_at: nowIso(item.observed_at ?? item.observedAt),
    evidence: item.evidence ?? {},
  }));
}

function decisionSearchValues(db, decisionId) {
  const decision = db.prepare(`
    SELECT d.*, COALESCE(ld.kind, 'choice') AS kind
    FROM decisions d LEFT JOIN local_decision_details ld ON ld.decision_id = d.id
    WHERE d.id = ?
  `).get(decisionId);
  if (!decision) return null;
  const clauses = db.prepare("SELECT kind, statement FROM local_decision_contracts WHERE decision_id = ? ORDER BY id").all(decisionId);
  const scopes = db.prepare("SELECT scope_type, scope_key FROM local_decision_scopes WHERE decision_id = ? ORDER BY id").all(decisionId);
  return {
    decision_id: decision.id,
    title: decision.title,
    rationale: decision.rationale,
    alternatives: parseJson(decision.alternatives_json, []).map((item) => typeof item === "string" ? item : canonicalJson(item)).join(" "),
    tags: parseJson(decision.tags_json, []).join(" "),
    kind: decision.kind,
    clauses: clauses.map((item) => `${item.kind} ${item.statement}`).join(" "),
    scopes: scopes.map((item) => `${item.scope_type} ${item.scope_key}`).join(" "),
  };
}

function decisionSearchMatches(actual, expected) {
  return expected != null && ["decision_id", "title", "rationale", "alternatives", "tags", "kind", "clauses", "scopes"]
    .every((key) => String(actual[key] ?? "") === String(expected[key] ?? ""));
}

function syncDecisionSearch(db, decisionId) {
  const values = decisionSearchValues(db, decisionId);
  if (!values) return;
  db.prepare("DELETE FROM local_decisions_fts WHERE decision_id = ?").run(decisionId);
  db.prepare(`
    INSERT INTO local_decisions_fts(decision_id, title, rationale, alternatives, tags, kind, clauses, scopes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.decision_id,
    values.title,
    values.rationale,
    values.alternatives,
    values.tags,
    values.kind,
    values.clauses,
    values.scopes,
  );
}

function decisionById(db, repository, decisionId) {
  const row = db.prepare(`
    SELECT d.*, COALESCE(ld.kind, 'choice') AS kind, ld.superseded_by, ld.metadata_json
    FROM decisions d LEFT JOIN local_decision_details ld ON ld.decision_id = d.id
    WHERE d.repo_id = ? AND d.id = ?
  `).get(repository.id, Number(decisionId));
  if (!row) throw new Error(`Decision not found: ${decisionId}`);
  return {
    id: row.id,
    repo_id: repository.repo_id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    rationale: row.rationale,
    alternatives: parseJson(row.alternatives_json, []),
    tags: parseJson(row.tags_json, []),
    metadata: parseJson(row.metadata_json, {}),
    superseded_by: row.superseded_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    scopes: db.prepare(`
      SELECT scope_type AS type, scope_key AS key, relationship, metadata_json
      FROM local_decision_scopes WHERE decision_id = ? ORDER BY scope_type, scope_key, relationship
    `).all(row.id).map(({ metadata_json: metadataJson, ...scope }) => ({ ...scope, metadata: parseJson(metadataJson, {}) })),
    contracts: db.prepare(`
      SELECT id, kind, statement, severity, metadata_json
      FROM local_decision_contracts WHERE decision_id = ? ORDER BY id
    `).all(row.id).map(({ metadata_json: metadataJson, ...contract }) => ({ ...contract, metadata: parseJson(metadataJson, {}) })),
    provenance: db.prepare(`
      SELECT id, source_type, source_id, source_uri, recorded_by, observed_at, evidence_json
      FROM local_decision_provenance WHERE decision_id = ? ORDER BY observed_at, id
    `).all(row.id).map(({ evidence_json: evidenceJson, ...source }) => ({ ...source, evidence: parseJson(evidenceJson, {}) })),
  };
}

export function getDecisionMemory(db, { repoId = null, decisionId } = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  return { repo_id: repository.repo_id, fact_status: "Observed", decision: decisionById(db, repository, decisionId) };
}

export function getDecisionProvenance(db, { repoId = null, decisionId } = {}) {
  const result = getDecisionMemory(db, { repoId, decisionId });
  return {
    repo_id: result.repo_id,
    decision_id: result.decision.id,
    verdict: result.decision.provenance.length ? "Evidence" : "CannotProve",
    fact_status: result.decision.provenance.length ? "Observed" : "CannotProve",
    provenance: result.decision.provenance,
    note: result.decision.provenance.length ? "Provenance is explicitly recorded local evidence." : "No provenance was recorded; do not infer rationale from code or Git history.",
  };
}

export function recordStructuredDecision(db, {
  repoId = null,
  title,
  rationale,
  kind = "choice",
  status = "active",
  alternatives = [],
  tags = [],
  symbols = [],
  files = [],
  scopes = [],
  contracts = [],
  bans = [],
  conventions = [],
  provenance = [],
  metadata = {},
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const normalizedTitle = normalizedName(title, "title");
  const normalizedRationale = requiredText(rationale, "rationale");
  const normalizedKind = String(kind).toLowerCase();
  if (!DECISION_KINDS.has(normalizedKind)) throw new Error(`Unsupported decision kind: ${kind}`);
  const normalizedStatus = String(status).toLowerCase();
  if (!DECISION_STATUSES.has(normalizedStatus)) throw new Error(`Unsupported decision status: ${status}`);
  if (!Array.isArray(alternatives) || !Array.isArray(tags) || !Array.isArray(symbols) || !Array.isArray(files)
    || !Array.isArray(scopes) || !Array.isArray(contracts) || !Array.isArray(bans) || !Array.isArray(conventions)) {
    throw new Error("alternatives, tags, symbols, files, scopes, contracts, bans, and conventions must be arrays");
  }
  const normalizedTags = tags.map((tag) => requiredText(tag, "tag", 100));
  const normalizedScopes = [
    ...symbols.map((symbol) => ({ type: "symbol", key: symbol })),
    ...files.map((file) => ({ type: "file", key: file })),
    ...scopes,
  ].map((scope) => normalizeScope(db, repository, scope));
  const normalizedClauses = normalizeContracts({ contracts, bans, conventions });
  const normalizedSources = normalizeProvenance(provenance);
  const now = new Date().toISOString();
  const decisionId = transaction(db, () => {
    const result = db.prepare(`
      INSERT INTO decisions(repo_id, title, status, rationale, alternatives_json, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repository.id, normalizedTitle, normalizedStatus, normalizedRationale, canonicalJson(alternatives), canonicalJson(normalizedTags), now, now);
    const id = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO local_decision_details(decision_id, kind, metadata_json) VALUES (?, ?, ?)")
      .run(id, normalizedKind, canonicalJson(metadata));
    const insertScope = db.prepare(`
      INSERT OR IGNORE INTO local_decision_scopes(decision_id, scope_type, scope_key, relationship, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertLegacyLink = db.prepare(`
      INSERT OR IGNORE INTO decision_links(decision_id, symbol_stable_key, relationship) VALUES (?, ?, ?)
    `);
    for (const scope of normalizedScopes) {
      insertScope.run(id, scope.type, scope.key, scope.relationship, canonicalJson(scope.metadata));
      if (scope.type === "symbol") insertLegacyLink.run(id, scope.key, scope.relationship);
    }
    const insertContract = db.prepare(`
      INSERT INTO local_decision_contracts(decision_id, kind, statement, severity, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const contract of normalizedClauses) insertContract.run(id, contract.kind, contract.statement, contract.severity, canonicalJson(contract.metadata));
    const insertSource = db.prepare(`
      INSERT INTO local_decision_provenance(decision_id, source_type, source_id, source_uri, recorded_by, observed_at, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const source of normalizedSources) {
      insertSource.run(id, source.source_type, source.source_id, source.source_uri, source.recorded_by, source.observed_at, canonicalJson(source.evidence));
    }
    db.prepare("INSERT INTO decisions_fts(decision_id, repo_row_id, title, rationale, tags) VALUES (?, ?, ?, ?, ?)")
      .run(id, repository.id, normalizedTitle, normalizedRationale, [...normalizedTags, normalizedKind].join(" "));
    syncDecisionSearch(db, id);
    return id;
  });
  return { ok: true, fact_status: "Observed", decision: decisionById(db, repository, decisionId) };
}

export function recallDecisionMemory(db, {
  repoId = null,
  query,
  status = "active",
  kind = null,
  scopeType = null,
  scopeKey = null,
  limit = 20,
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const match = ftsQuery(requiredText(query, "query", 2000));
  const normalizedStatus = status == null ? null : String(status).toLowerCase();
  const normalizedKind = kind == null ? null : String(kind).toLowerCase();
  const normalizedScopeType = scopeType == null ? null : String(scopeType).toLowerCase();
  if (normalizedStatus != null && !DECISION_STATUSES.has(normalizedStatus)) throw new Error(`Unsupported decision status: ${status}`);
  if (normalizedKind != null && !DECISION_KINDS.has(normalizedKind)) throw new Error(`Unsupported decision kind: ${kind}`);
  if (normalizedScopeType != null && !SCOPE_TYPES.has(normalizedScopeType)) throw new Error(`Unsupported decision scope type: ${scopeType}`);
  if (scopeKey != null && normalizedScopeType == null) throw new Error("scopeType is required when scopeKey is provided");
  const normalizedScopeKey = scopeKey == null ? null : (normalizedScopeType === "file" ? normalizedFilePath(scopeKey) : String(scopeKey));
  const rows = db.prepare(`
    SELECT d.id, bm25(local_decisions_fts) AS score
    FROM local_decisions_fts
    JOIN decisions d ON d.id = CAST(local_decisions_fts.decision_id AS INTEGER)
    JOIN local_decision_details ld ON ld.decision_id = d.id
    WHERE d.repo_id = ? AND local_decisions_fts MATCH ?
      AND (? IS NULL OR d.status = ?)
      AND (? IS NULL OR ld.kind = ?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM local_decision_scopes ls
        WHERE ls.decision_id = d.id AND ls.scope_type = ? AND (? IS NULL OR ls.scope_key = ?)
      ))
    ORDER BY score, d.updated_at DESC, d.id DESC
    LIMIT ?
  `).all(
    repository.id, match,
    normalizedStatus, normalizedStatus,
    normalizedKind, normalizedKind,
    normalizedScopeType, normalizedScopeType, normalizedScopeKey, normalizedScopeKey,
    clamp(limit, 20, 1, 100),
  );
  const decisions = rows.map((row) => ({ ...decisionById(db, repository, row.id), score: row.score }));
  return {
    repo_id: repository.repo_id,
    verdict: decisions.length ? "Evidence" : "CannotProve",
    fact_status: decisions.length ? "StatisticallyRanked" : "CannotProve",
    decisions,
    note: decisions.length ? "Ranked matches are backed by locally recorded decisions." : "No matching local decision was recorded; this is unknown, not permission.",
  };
}

export function setDecisionStatus(db, {
  repoId = null,
  decisionId,
  status,
  supersededBy = null,
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const decision = decisionById(db, repository, decisionId);
  const normalizedStatus = String(status ?? "").toLowerCase();
  if (!DECISION_STATUSES.has(normalizedStatus)) throw new Error(`Unsupported decision status: ${status}`);
  if (Number(supersededBy) === decision.id) throw new Error("A decision cannot supersede itself");
  if (normalizedStatus === "superseded" && supersededBy != null) decisionById(db, repository, supersededBy);
  const now = new Date().toISOString();
  transaction(db, () => {
    db.prepare("UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?").run(normalizedStatus, now, decision.id);
    db.prepare("UPDATE local_decision_details SET superseded_by = ? WHERE decision_id = ?")
      .run(normalizedStatus === "superseded" ? supersededBy : null, decision.id);
  });
  return { ok: true, fact_status: "Observed", decision: decisionById(db, repository, decision.id) };
}

export function verifyDecision(db, {
  repoId = null,
  decisionId,
  record = null,
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const decision = decisionById(db, repository, decisionId);
  if (record) {
    if (decision.status !== "active") throw new Error(`Cannot record verification for ${decision.status} decision ${decision.id}`);
    const verdict = String(record.verdict ?? "").toLowerCase();
    if (!new Set(["held", "violated"]).has(verdict)) throw new Error("Verification verdict must be held or violated");
    if (!record.evidence || (typeof record.evidence === "object" && !Object.keys(record.evidence).length)) {
      throw new Error("Verification evidence is required; use an unrecorded check to return CannotProve");
    }
    const observedAt = nowIso(record.observed_at ?? record.observedAt);
    let provenanceId = null;
    transaction(db, () => {
      if (record.provenance) {
        const source = normalizeProvenance({ ...record.provenance, observed_at: observedAt })[0];
        const result = db.prepare(`
          INSERT INTO local_decision_provenance(decision_id, source_type, source_id, source_uri, recorded_by, observed_at, evidence_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(decision.id, source.source_type, source.source_id, source.source_uri, source.recorded_by, source.observed_at, canonicalJson(source.evidence));
        provenanceId = Number(result.lastInsertRowid);
      }
      db.prepare(`
        INSERT INTO local_decision_verifications(decision_id, verdict, observed_at, note, evidence_json, provenance_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(decision.id, verdict, observedAt, record.note ?? null, canonicalJson(record.evidence), provenanceId);
    });
  }
  const refreshed = decisionById(db, repository, decision.id);
  if (refreshed.status === "superseded") {
    return { repo_id: repository.repo_id, decision: refreshed, verdict: "Superseded", fact_status: "DeterministicallyDerived", evidence: [{ type: "decision_status", status: refreshed.status, superseded_by: refreshed.superseded_by }] };
  }
  if (refreshed.status === "rejected") {
    return { repo_id: repository.repo_id, decision: refreshed, verdict: "Rejected", fact_status: "DeterministicallyDerived", evidence: [{ type: "decision_status", status: refreshed.status }] };
  }
  const latest = db.prepare(`
    SELECT * FROM local_decision_verifications
    WHERE decision_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(refreshed.id);
  if (!latest) {
    return { repo_id: repository.repo_id, decision: refreshed, verdict: "CannotProve", fact_status: "CannotProve", evidence: [], note: "No local verification evidence has been recorded; active does not imply held." };
  }
  return {
    repo_id: repository.repo_id,
    decision: refreshed,
    verdict: latest.verdict === "held" ? "Held" : "ViolatedAt",
    fact_status: "Observed",
    observed_at: latest.observed_at,
    evidence: [{
      verification_id: latest.id,
      verdict: latest.verdict,
      note: latest.note,
      details: parseJson(latest.evidence_json, {}),
      provenance_id: latest.provenance_id,
    }],
  };
}

function governingDecisionRows(db, repository, {
  symbol = null,
  symbolId = null,
  symbolStableKey = null,
  stableKey = null,
  filePath = null,
} = {}) {
  const current = symbolId != null || symbol != null ? resolveCurrentSymbol(db, repository, symbolId ?? symbol) : null;
  if ((symbolId != null || symbol != null) && !current) throw new Error(`Indexed symbol not found: ${symbolId ?? symbol}`);
  const explicitStableKey = symbolStableKey ?? stableKey;
  const normalizedFile = filePath ? normalizedFilePath(filePath) : current?.file_path ?? null;
  if (!current && !explicitStableKey && !normalizedFile) throw new Error("symbol, symbolId, symbolStableKey, or filePath is required");
  const keys = [{ type: "repository", key: "*" }];
  if (normalizedFile) keys.push({ type: "file", key: normalizedFile });
  if (current || explicitStableKey) keys.push({ type: "symbol", key: current?.stable_key ?? String(explicitStableKey) });
  const clauses = keys.map(() => "(ls.scope_type = ? AND ls.scope_key = ?)").join(" OR ");
  const parameters = keys.flatMap((key) => [key.type, key.key]);
  const rows = db.prepare(`
    SELECT DISTINCT d.id
    FROM decisions d JOIN local_decision_scopes ls ON ls.decision_id = d.id
    WHERE d.repo_id = ? AND d.status = 'active' AND (${clauses})
    ORDER BY d.updated_at DESC, d.id DESC
  `).all(repository.id, ...parameters);
  return { current, stableKey: current?.stable_key ?? explicitStableKey ?? null, filePath: normalizedFile, rows };
}

export function getGoverningContracts(db, args = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const { current, stableKey, filePath, rows } = governingDecisionRows(db, repository, args);
  const decisions = rows.map((row) => decisionById(db, repository, row.id));
  const contracts = decisions.flatMap((decision) => {
    const explicit = decision.contracts.map((contract) => ({ ...contract, decision_id: decision.id, decision_title: decision.title }));
    if (decision.kind === "ban" && !explicit.some((contract) => contract.kind === "prohibition")) {
      explicit.push({ kind: "prohibition", severity: "must", statement: decision.title, decision_id: decision.id, decision_title: decision.title, implicit_from_kind: true });
    }
    if (decision.kind === "convention" && !explicit.some((contract) => contract.kind === "convention")) {
      explicit.push({ kind: "convention", severity: "should", statement: decision.title, decision_id: decision.id, decision_title: decision.title, implicit_from_kind: true });
    }
    return explicit;
  });
  return {
    repo_id: repository.repo_id,
    target: { symbol: publicCurrentSymbol(current), symbol_stable_key: stableKey, file_path: filePath },
    verdict: decisions.length ? "Evidence" : "CannotProve",
    fact_status: decisions.length ? "Observed" : "CannotProve",
    decisions,
    contracts,
    note: decisions.length ? "Contracts are from active, explicitly scoped local decisions." : "No governing local decision was recorded; this is unknown, not unconstrained.",
  };
}

export function whyIsThisHere(db, args = {}) {
  const result = getGoverningContracts(db, args);
  return {
    ...result,
    rationale: result.decisions.map((decision) => ({
      decision_id: decision.id,
      title: decision.title,
      rationale: decision.rationale,
      provenance: decision.provenance,
    })),
  };
}

function overlayByName(db, repository, name) {
  const row = db.prepare("SELECT * FROM local_worktree_overlays WHERE repo_id = ? AND name = ?").get(repository.id, name);
  if (!row) throw new Error(`Worktree overlay not found: ${name}`);
  return row;
}

function publicOverlay(row) {
  return {
    id: row.id,
    name: row.name,
    base_reference: row.base_reference,
    base_head: row.base_head,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicOverlayChange(row) {
  return {
    stable_key: row.stable_key,
    change_type: row.change_type,
    file_path: row.file_path,
    base_fingerprint: row.base_fingerprint,
    overlay_fingerprint: row.overlay_fingerprint,
    base: parseJson(row.base_json, null),
    overlay: parseJson(row.overlay_json, null),
    recorded_at: row.recorded_at,
  };
}

export function createWorktreeOverlay(db, {
  repoId = null,
  name,
  baseReference = "HEAD",
  baseHead = null,
  metadata = {},
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const normalizedOverlayName = normalizedName(name, "worktree name");
  const normalizedBase = normalizedName(baseReference, "baseReference");
  const existing = db.prepare("SELECT * FROM local_worktree_overlays WHERE repo_id = ? AND name = ?").get(repository.id, normalizedOverlayName);
  if (existing) {
    if (existing.base_reference !== normalizedBase || (baseHead != null && existing.base_head !== String(baseHead))) {
      throw new Error(`Worktree overlay ${normalizedOverlayName} already exists with a different base`);
    }
    return { ok: true, created: false, repo_id: repository.repo_id, overlay: publicOverlay(existing) };
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO local_worktree_overlays(repo_id, name, base_reference, base_head, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(repository.id, normalizedOverlayName, normalizedBase, baseHead == null ? null : String(baseHead), canonicalJson(metadata), now, now);
  const overlay = db.prepare("SELECT * FROM local_worktree_overlays WHERE id = ?").get(Number(result.lastInsertRowid));
  return { ok: true, created: true, repo_id: repository.repo_id, overlay: publicOverlay(overlay) };
}

function writeOverlayChange(db, overlayId, change, recordedAt) {
  db.prepare(`
    INSERT INTO local_worktree_symbols(
      overlay_id, stable_key, change_type, file_path, base_fingerprint, overlay_fingerprint,
      base_json, overlay_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(overlay_id, stable_key) DO UPDATE SET
      change_type = excluded.change_type,
      file_path = excluded.file_path,
      base_fingerprint = excluded.base_fingerprint,
      overlay_fingerprint = excluded.overlay_fingerprint,
      base_json = excluded.base_json,
      overlay_json = excluded.overlay_json,
      recorded_at = excluded.recorded_at
  `).run(
    overlayId,
    change.stable_key,
    change.change_type,
    change.file_path,
    change.base_fingerprint,
    change.overlay_fingerprint,
    change.base == null ? null : canonicalJson(change.base),
    change.overlay == null ? null : canonicalJson(change.overlay),
    recordedAt,
  );
}

function normalizedOverlayChange(db, repository, raw) {
  const changeType = String(raw.change_type ?? raw.changeType ?? "").toLowerCase();
  if (!CHANGE_TYPES.has(changeType)) throw new Error(`Unsupported overlay change type: ${changeType}`);
  let base = raw.base === undefined ? undefined : canonicalize(raw.base);
  let overlay = raw.overlay === undefined ? undefined : canonicalize(raw.overlay);
  const stableKey = requiredText(raw.stable_key ?? raw.stableKey ?? overlay?.stable_key ?? base?.stable_key, "Overlay change stable_key", 4096);
  if (changeType !== "added" && base === undefined) base = indexedSymbolSnapshot(db, repository, stableKey);
  if (changeType === "added" && raw.base === undefined && indexedSymbolSnapshot(db, repository, stableKey)) {
    throw new Error(`added symbol already exists in the indexed base: ${stableKey}`);
  }
  if (changeType === "added") base = null;
  if (changeType === "removed") overlay = null;
  if (changeType !== "removed" && (overlay == null || typeof overlay !== "object")) throw new Error(`${changeType} change requires an overlay symbol snapshot`);
  if (changeType !== "added" && base == null) throw new Error(`${changeType} change requires a base symbol snapshot or a currently indexed stable_key`);
  if (overlay && overlay.stable_key && overlay.stable_key !== stableKey) throw new Error("Overlay snapshot stable_key does not match change stable_key");
  if (base && base.stable_key && base.stable_key !== stableKey) throw new Error("Base snapshot stable_key does not match change stable_key");
  if (overlay) overlay = { ...overlay, stable_key: stableKey };
  if (base) base = { ...base, stable_key: stableKey };
  const baseFingerprint = fingerprint(base);
  const overlayFingerprint = fingerprint(overlay);
  const filePath = raw.file_path ?? raw.filePath ?? overlay?.file_path ?? base?.file_path ?? null;
  return {
    stable_key: stableKey,
    change_type: changeType,
    file_path: filePath == null ? null : normalizedFilePath(filePath),
    base_fingerprint: baseFingerprint,
    overlay_fingerprint: overlayFingerprint,
    base,
    overlay,
    noop: changeType === "modified" && baseFingerprint === overlayFingerprint,
  };
}

export function recordWorktreeChanges(db, {
  repoId = null,
  name,
  changes,
  replace = false,
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const overlay = overlayByName(db, repository, normalizedName(name, "worktree name"));
  if (overlay.status !== "open") throw new Error(`Worktree overlay ${overlay.name} is ${overlay.status}, not open`);
  if (!Array.isArray(changes) || !changes.length) throw new Error("changes must be a non-empty array");
  const normalized = changes.map((change) => normalizedOverlayChange(db, repository, change));
  if (new Set(normalized.map((change) => change.stable_key)).size !== normalized.length) throw new Error("changes contains duplicate stable_key values");
  const now = new Date().toISOString();
  transaction(db, () => {
    if (replace) db.prepare("DELETE FROM local_worktree_symbols WHERE overlay_id = ?").run(overlay.id);
    for (const change of normalized) {
      if (change.noop) db.prepare("DELETE FROM local_worktree_symbols WHERE overlay_id = ? AND stable_key = ?").run(overlay.id, change.stable_key);
      else writeOverlayChange(db, overlay.id, change, now);
    }
    db.prepare("UPDATE local_worktree_overlays SET updated_at = ? WHERE id = ?").run(now, overlay.id);
  });
  return {
    ok: true,
    repo_id: repository.repo_id,
    worktree: overlay.name,
    recorded: normalized.filter((change) => !change.noop).length,
    omitted_noops: normalized.filter((change) => change.noop).map((change) => change.stable_key),
  };
}

export function getWorktreeOverlay(db, { repoId = null, name } = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const row = overlayByName(db, repository, normalizedName(name, "worktree name"));
  const changes = db.prepare("SELECT * FROM local_worktree_symbols WHERE overlay_id = ? ORDER BY stable_key").all(row.id).map(publicOverlayChange);
  return {
    repo_id: repository.repo_id,
    overlay: publicOverlay(row),
    counts: Object.fromEntries(["added", "modified", "removed"].map((type) => [type, changes.filter((change) => change.change_type === type).length])),
    changes,
  };
}

export function listWorktreeOverlays(db, { repoId = null, status = null } = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const normalizedStatus = status == null ? null : String(status).toLowerCase();
  if (normalizedStatus != null && !OVERLAY_STATUSES.has(normalizedStatus)) throw new Error(`Unsupported overlay status: ${status}`);
  const rows = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM local_worktree_symbols s WHERE s.overlay_id = o.id) AS symbol_changes,
      (SELECT COUNT(*) FROM local_worktree_symbols s WHERE s.overlay_id = o.id AND s.change_type = 'added') AS symbols_added,
      (SELECT COUNT(*) FROM local_worktree_symbols s WHERE s.overlay_id = o.id AND s.change_type = 'modified') AS symbols_modified,
      (SELECT COUNT(*) FROM local_worktree_symbols s WHERE s.overlay_id = o.id AND s.change_type = 'removed') AS symbols_removed
    FROM local_worktree_overlays o
    WHERE o.repo_id = ? AND (? IS NULL OR o.status = ?)
    ORDER BY o.name
  `).all(repository.id, normalizedStatus, normalizedStatus);
  return {
    repo_id: repository.repo_id,
    overlays: rows.map((row) => ({
      ...publicOverlay(row),
      counts: {
        changes: row.symbol_changes,
        added: row.symbols_added,
        modified: row.symbols_modified,
        removed: row.symbols_removed,
      },
    })),
  };
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function threeWayValue(base, target, source, fieldPath = "") {
  const targetChanged = !deepEqual(target, base);
  const sourceChanged = !deepEqual(source, base);
  if (!targetChanged && !sourceChanged) return { value: base, conflicts: [] };
  if (!targetChanged) return { value: source, conflicts: [] };
  if (!sourceChanged || deepEqual(target, source)) return { value: target, conflicts: [] };
  if (isPlainObject(base) && isPlainObject(target) && isPlainObject(source)) {
    const merged = {};
    const conflicts = [];
    const keys = [...new Set([...Object.keys(base), ...Object.keys(target), ...Object.keys(source)])].sort();
    for (const key of keys) {
      const result = threeWayValue(base[key], target[key], source[key], fieldPath ? `${fieldPath}.${key}` : key);
      if (result.value !== undefined) merged[key] = result.value;
      conflicts.push(...result.conflicts);
    }
    return { value: merged, conflicts };
  }
  return { value: target, conflicts: [{ field: fieldPath || "$", base, target, source }] };
}

function mergePair(source, target) {
  if (source.change_type === target.change_type
    && source.base_fingerprint === target.base_fingerprint
    && source.overlay_fingerprint === target.overlay_fingerprint) {
    return { action: "noop", reason: "identical_change" };
  }
  if (source.change_type === "removed" && target.change_type === "removed") return { action: "noop", reason: "both_removed" };
  if (source.change_type === "removed" || target.change_type === "removed") {
    return { conflict: { type: "delete_modify", source_change: source.change_type, target_change: target.change_type } };
  }
  if (source.change_type === "added" || target.change_type === "added") {
    if (source.change_type === "added" && target.change_type === "added") {
      return { conflict: { type: "add_add", source_fingerprint: source.overlay_fingerprint, target_fingerprint: target.overlay_fingerprint } };
    }
    return { conflict: { type: "change_type_mismatch", source_change: source.change_type, target_change: target.change_type } };
  }
  if (!source.base || !target.base) return { conflict: { type: "missing_base_snapshot" } };
  if (source.base_fingerprint !== target.base_fingerprint) {
    return { conflict: { type: "symbol_base_mismatch", source_base: source.base_fingerprint, target_base: target.base_fingerprint } };
  }
  const merged = threeWayValue(source.base, target.overlay, source.overlay);
  if (merged.conflicts.length) return { conflict: { type: "edit_edit", fields: merged.conflicts } };
  return {
    action: "auto_merge",
    reason: "disjoint_symbol_fields",
    change: {
      stable_key: source.stable_key,
      change_type: "modified",
      file_path: merged.value?.file_path ?? source.file_path ?? target.file_path,
      base_fingerprint: source.base_fingerprint,
      overlay_fingerprint: fingerprint(merged.value),
      base: source.base,
      overlay: merged.value,
    },
  };
}

function overlayRevision(db, overlayId) {
  const overlay = db.prepare("SELECT * FROM local_worktree_overlays WHERE id = ?").get(overlayId);
  const changes = db.prepare(`
    SELECT stable_key, change_type, file_path, base_fingerprint, overlay_fingerprint,
      base_json, overlay_json, recorded_at
    FROM local_worktree_symbols WHERE overlay_id = ? ORDER BY stable_key
  `).all(overlayId);
  return fingerprint({ overlay, changes });
}

export function planWorktreeMerge(db, {
  repoId = null,
  sourceName,
  targetName,
} = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const source = getWorktreeOverlay(db, { repoId: repository.repo_id, name: sourceName });
  const target = getWorktreeOverlay(db, { repoId: repository.repo_id, name: targetName });
  if (source.overlay.name === target.overlay.name) throw new Error("sourceName and targetName must differ");
  if (source.overlay.status !== "open") throw new Error(`Source worktree overlay ${source.overlay.name} is ${source.overlay.status}, not open`);
  if (target.overlay.status !== "open") throw new Error(`Target worktree overlay ${target.overlay.name} is ${target.overlay.status}, not open`);
  const operations = [];
  const conflicts = [];
  if (source.overlay.base_reference !== target.overlay.base_reference
    || source.overlay.base_head !== target.overlay.base_head) {
    conflicts.push({
      type: "overlay_base_mismatch",
      source_base: { reference: source.overlay.base_reference, head: source.overlay.base_head },
      target_base: { reference: target.overlay.base_reference, head: target.overlay.base_head },
    });
  } else {
    const sourceByKey = new Map(source.changes.map((change) => [change.stable_key, change]));
    const targetByKey = new Map(target.changes.map((change) => [change.stable_key, change]));
    const stableKeys = [...new Set([...sourceByKey.keys(), ...targetByKey.keys()])].sort();
    for (const stableKey of stableKeys) {
      const sourceChange = sourceByKey.get(stableKey);
      const targetChange = targetByKey.get(stableKey);
      if (!sourceChange) {
        operations.push({ stable_key: stableKey, action: "keep_target", reason: "target_only" });
        continue;
      }
      if (!targetChange) {
        operations.push({ stable_key: stableKey, action: "apply_source", reason: "source_only", change: sourceChange });
        continue;
      }
      const result = mergePair(sourceChange, targetChange);
      if (result.conflict) conflicts.push({ stable_key: stableKey, ...result.conflict });
      else operations.push({ stable_key: stableKey, ...result });
    }
  }
  conflicts.sort((a, b) => String(a.stable_key ?? "").localeCompare(String(b.stable_key ?? "")) || a.type.localeCompare(b.type));
  return {
    repo_id: repository.repo_id,
    source: source.overlay,
    target: target.overlay,
    source_revision: overlayRevision(db, source.overlay.id),
    target_revision: overlayRevision(db, target.overlay.id),
    verdict: conflicts.length ? "conflicts" : "clean",
    deterministic: true,
    operations,
    conflicts,
    summary: {
      apply_source: operations.filter((item) => item.action === "apply_source").length,
      auto_merge: operations.filter((item) => item.action === "auto_merge").length,
      keep_target: operations.filter((item) => item.action === "keep_target").length,
      noop: operations.filter((item) => item.action === "noop").length,
      conflicts: conflicts.length,
    },
  };
}

export function applyWorktreeMerge(db, args = {}) {
  const plan = planWorktreeMerge(db, args);
  if (plan.conflicts.length) return { ...plan, applied: false, note: "No changes were applied because deterministic conflicts remain." };
  const repository = resolveRepository(db, args.repoId ?? null);
  const target = overlayByName(db, repository, plan.target.name);
  if (target.status !== "open") throw new Error(`Target worktree overlay ${target.name} is ${target.status}, not open`);
  const now = new Date().toISOString();
  transaction(db, () => {
    const currentSource = overlayByName(db, repository, plan.source.name);
    const currentTarget = overlayByName(db, repository, plan.target.name);
    if (overlayRevision(db, currentSource.id) !== plan.source_revision
      || overlayRevision(db, currentTarget.id) !== plan.target_revision) {
      throw new Error("A worktree overlay changed while the merge was being planned; recompute the plan");
    }
    for (const operation of plan.operations) {
      if (!new Set(["apply_source", "auto_merge"]).has(operation.action)) continue;
      const change = operation.change;
      writeOverlayChange(db, target.id, {
        stable_key: change.stable_key,
        change_type: change.change_type,
        file_path: change.file_path,
        base_fingerprint: change.base_fingerprint,
        overlay_fingerprint: change.overlay_fingerprint,
        base: change.base,
        overlay: change.overlay,
      }, now);
    }
    db.prepare("UPDATE local_worktree_overlays SET updated_at = ? WHERE id = ?").run(now, target.id);
  });
  return { ...plan, applied: true, target_after: getWorktreeOverlay(db, { repoId: repository.repo_id, name: target.name }) };
}

export function setWorktreeOverlayStatus(db, { repoId = null, name, status } = {}) {
  ensureLocalMemorySchema(db);
  const repository = resolveRepository(db, repoId);
  const overlay = overlayByName(db, repository, normalizedName(name, "worktree name"));
  const normalizedStatus = String(status ?? "").toLowerCase();
  if (!OVERLAY_STATUSES.has(normalizedStatus)) throw new Error(`Unsupported overlay status: ${status}`);
  if (overlay.status === normalizedStatus) {
    return { ok: true, repo_id: repository.repo_id, overlay: publicOverlay(overlay) };
  }
  if (overlay.status !== "open" && overlay.status !== normalizedStatus) {
    throw new Error(`Worktree overlay ${overlay.name} is terminal (${overlay.status}) and cannot transition to ${normalizedStatus}`);
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE local_worktree_overlays SET status = ?, updated_at = ? WHERE id = ?").run(normalizedStatus, now, overlay.id);
  return { ok: true, repo_id: repository.repo_id, overlay: publicOverlay(db.prepare("SELECT * FROM local_worktree_overlays WHERE id = ?").get(overlay.id)) };
}
