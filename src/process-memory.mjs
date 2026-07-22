import { createHash } from "node:crypto";
import { getArchitecture } from "./graph-analysis.mjs";
import { getChurnWeightedHotspots } from "./quality-analysis.mjs";
import { getIndexDiagnostics, getRepositoryStats, resolveRepository } from "./queries.mjs";
import { inferExecutionFlows } from "./workflow-analysis.mjs";

const PROCESS_SOURCES = new Set(["configured", "inferred"]);
const START_KINDS = new Set(["api_route", "entry_point", "configured"]);
const DEFAULT_PROCESS_LIMIT = 100;
const MAX_PROCESS_LIMIT = 1_000;
const MAX_STEPS = 100;
const MAX_RETIRED = 10_000;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_EVIDENCE_DEPTH = 20;
const MAX_EVIDENCE_NODES = 10_000;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ANY"]);

const PROCESS_MEMORY_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_process_models (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  process_key TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('configured', 'inferred')),
  active INTEGER NOT NULL DEFAULT 1,
  start_kind TEXT NOT NULL CHECK(start_kind IN ('api_route', 'entry_point', 'configured')),
  start_identity TEXT NOT NULL,
  start_symbol_stable_key TEXT NOT NULL,
  start_file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_evidence_json TEXT NOT NULL,
  aggregate_confidence REAL NOT NULL,
  minimum_confidence REAL NOT NULL,
  terminal_reason TEXT,
  evidence_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE(repo_id, process_key)
);
CREATE INDEX IF NOT EXISTS local_process_models_repo_active_idx
  ON local_process_models(repo_id, active, process_key);

CREATE TABLE IF NOT EXISTS local_process_steps (
  id INTEGER PRIMARY KEY,
  process_id INTEGER NOT NULL REFERENCES local_process_models(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  symbol_stable_key TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  incoming_edge_confidence REAL,
  evidence_json TEXT NOT NULL,
  UNIQUE(process_id, ordinal)
);
CREATE INDEX IF NOT EXISTS local_process_steps_symbol_idx
  ON local_process_steps(symbol_stable_key, process_id, ordinal);
CREATE INDEX IF NOT EXISTS local_process_steps_file_idx
  ON local_process_steps(file_path, process_id, ordinal);

CREATE TABLE IF NOT EXISTS local_process_refreshes (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  previous_snapshot_hash TEXT,
  snapshot_hash TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_process_refreshes_repo_time_idx
  ON local_process_refreshes(repo_id, created_at, id);
`;

function compareCodePoints(leftValue, rightValue) {
  const left = [...String(leftValue)];
  const right = [...String(rightValue)];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function confidenceValue(value, fallback = 1) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("confidence must be between 0 and 1");
  return number;
}

function requiredText(value, name, maximum = 4_096) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required and must be a string`);
  const normalized = value.trim().normalize("NFC");
  if (normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${name} must be at most ${maximum} characters and contain no control line characters`);
  }
  return normalized;
}

function optionalText(value, name, maximum = 4_096) {
  if (value == null || value === "") return null;
  return requiredText(value, name, maximum);
}

function normalizeProcessKey(value) {
  const key = requiredText(value, "processKey", 300).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(key)) {
    throw new Error("processKey may contain lowercase letters, numbers, dot, underscore, colon, slash, and hyphen");
  }
  return key;
}

function normalizeFilePath(value) {
  const raw = requiredText(value, "filePath", 4_096).replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) throw new Error("filePath must be repository-relative");
  const normalized = raw.replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || /\/[.]?[.]\//.test(`/${normalized}/`)) {
    throw new Error("filePath must be repository-relative");
  }
  return normalized;
}

function normalizeEvidence(value, name = "evidence") {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error(`${name} must be a non-empty object`);
  }
  const active = new Set();
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > MAX_EVIDENCE_NODES) throw new Error(`${name} exceeds ${MAX_EVIDENCE_NODES} JSON nodes`);
    if (depth > MAX_EVIDENCE_DEPTH) throw new Error(`${name} exceeds maximum nesting depth ${MAX_EVIDENCE_DEPTH}`);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.includes("\0")) throw new Error(`${name} strings must not contain NUL`);
      return item.normalize("NFC");
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${name} numbers must be finite`);
      return item;
    }
    if (typeof item !== "object") throw new Error(`${name} must contain only JSON-compatible values`);
    if (active.has(item)) throw new Error(`${name} must be acyclic JSON`);
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      result = item.map((entry) => visit(entry, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must contain only plain JSON objects`);
      result = Object.create(null);
      for (const key of Object.keys(item).sort(compareCodePoints)) {
        if (key.length > 500 || key.includes("\0")) throw new Error(`${name} keys must be at most 500 characters and contain no NUL`);
        const normalizedKey = key.normalize("NFC");
        if (Object.prototype.hasOwnProperty.call(result, normalizedKey)) throw new Error(`${name} contains duplicate keys after Unicode normalization`);
        result[normalizedKey] = visit(item[key], depth + 1);
      }
    }
    active.delete(item);
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error(`${name} must serialize to at most ${MAX_EVIDENCE_BYTES} bytes`);
  }
  return normalized;
}

function normalizeStaticEvidence(value, name = "evidence") {
  const evidence = normalizeEvidence(value, name);
  let runtimeClaim = false;
  const inspect = (item) => {
    if (runtimeClaim || item == null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      if (nested === true && new Set(["runtime", "observed_runtime", "runtime_observed", "runtime_trace"]).has(normalizedKey)) {
        runtimeClaim = true;
        return;
      }
      if (typeof nested === "string" && new Set(["kind", "source", "evidence_type", "type"]).has(normalizedKey)) {
        const declaredKind = nested.toLowerCase().trim().replace(/[ -]+/g, "_");
        if (/^(?:runtime|runtime_trace|observed_runtime|observed_trace)$/.test(declaredKind)) {
          runtimeClaim = true;
          return;
        }
      }
      inspect(nested);
    }
  };
  inspect(evidence);
  if (runtimeClaim) {
    throw new Error(`${name} must describe static or configured evidence, not observed runtime traces`);
  }
  return evidence;
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

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function repository(db, repoId) {
  return resolveRepository(db, repoId);
}

function publicRepository(row) {
  return { repo_id: row.repo_id, name: row.name, root: row.root, indexed_at: row.indexed_at, head_commit: row.head_commit };
}

function processRow(db, repositoryId, processKey, includeRetired = false) {
  return db.prepare(`
    SELECT p.*, COUNT(steps.id) AS step_count
    FROM local_process_models p
    LEFT JOIN local_process_steps steps ON steps.process_id = p.id
    WHERE p.repo_id = ? AND p.process_key = ? AND (? = 1 OR p.active = 1)
    GROUP BY p.id
  `).get(repositoryId, processKey, includeRetired ? 1 : 0);
}

function publicProcess(row) {
  return {
    id: Number(row.id),
    process_key: row.process_key,
    name: row.name,
    source: row.source,
    active: Boolean(row.active),
    start: {
      kind: row.start_kind,
      identity: row.start_identity,
      symbol_stable_key: row.start_symbol_stable_key,
      file_path: row.start_file_path,
      line: Number(row.start_line),
      evidence: parseJson(row.start_evidence_json, {}),
    },
    aggregate_confidence: Number(row.aggregate_confidence),
    minimum_confidence: Number(row.minimum_confidence),
    terminal_reason: row.terminal_reason,
    evidence: parseJson(row.evidence_json, {}),
    step_count: Number(row.step_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    retired_at: row.retired_at,
  };
}

function publicStep(row) {
  return {
    ordinal: Number(row.ordinal),
    symbol_stable_key: row.symbol_stable_key,
    name: row.symbol_name,
    qualified_name: row.qualified_name,
    kind: row.symbol_kind,
    file_path: row.file_path,
    start_line: Number(row.start_line),
    end_line: Number(row.end_line),
    incoming_edge_confidence: row.incoming_edge_confidence == null ? null : Number(row.incoming_edge_confidence),
    evidence: parseJson(row.evidence_json, {}),
  };
}

function stepsForProcess(db, processId) {
  const rows = db.prepare("SELECT * FROM local_process_steps WHERE process_id = ? ORDER BY ordinal LIMIT ?")
    .all(processId, MAX_STEPS + 1);
  return { steps: rows.slice(0, MAX_STEPS).map(publicStep), truncated: rows.length > MAX_STEPS };
}

function candidateFingerprint(candidate) {
  return digest({
    name: candidate.name,
    source: candidate.source,
    start_kind: candidate.start_kind,
    start_identity: candidate.start_identity,
    start_symbol_stable_key: candidate.start_symbol_stable_key,
    start_file_path: candidate.start_file_path,
    start_line: candidate.start_line,
    start_evidence: candidate.start_evidence,
    aggregate_confidence: candidate.aggregate_confidence,
    minimum_confidence: candidate.minimum_confidence,
    terminal_reason: candidate.terminal_reason,
    evidence: candidate.evidence,
    steps: candidate.steps,
  });
}

function writeSteps(db, processId, steps) {
  db.prepare("DELETE FROM local_process_steps WHERE process_id = ?").run(processId);
  const insert = db.prepare(`
    INSERT INTO local_process_steps(
      process_id, ordinal, symbol_stable_key, symbol_name, qualified_name, symbol_kind,
      file_path, start_line, end_line, incoming_edge_confidence, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const step of steps) {
    insert.run(
      processId, step.ordinal, step.symbol_stable_key, step.name, step.qualified_name,
      step.kind, step.file_path, step.start_line, step.end_line,
      step.incoming_edge_confidence, canonicalJson(step.evidence),
    );
  }
}

function persistCandidate(db, repoRow, candidate, existing, now) {
  const fingerprint = candidateFingerprint(candidate);
  if (existing && existing.fingerprint === fingerprint && Boolean(existing.active) && existing.source === candidate.source) {
    return { id: Number(existing.id), changed: false, fingerprint };
  }
  if (existing) {
    db.prepare(`
      UPDATE local_process_models SET
        name = ?, source = ?, active = 1, start_kind = ?, start_identity = ?,
        start_symbol_stable_key = ?, start_file_path = ?, start_line = ?, start_evidence_json = ?,
        aggregate_confidence = ?, minimum_confidence = ?, terminal_reason = ?, evidence_json = ?,
        fingerprint = ?, updated_at = ?, retired_at = NULL
      WHERE id = ?
    `).run(
      candidate.name, candidate.source, candidate.start_kind, candidate.start_identity,
      candidate.start_symbol_stable_key, candidate.start_file_path, candidate.start_line,
      canonicalJson(candidate.start_evidence), candidate.aggregate_confidence,
      candidate.minimum_confidence, candidate.terminal_reason, canonicalJson(candidate.evidence),
      fingerprint, now, existing.id,
    );
    writeSteps(db, Number(existing.id), candidate.steps);
    return { id: Number(existing.id), changed: true, fingerprint };
  }
  const result = db.prepare(`
    INSERT INTO local_process_models(
      repo_id, process_key, name, source, active, start_kind, start_identity,
      start_symbol_stable_key, start_file_path, start_line, start_evidence_json,
      aggregate_confidence, minimum_confidence, terminal_reason, evidence_json,
      fingerprint, created_at, updated_at, retired_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    repoRow.id, candidate.process_key, candidate.name, candidate.source, candidate.start_kind,
    candidate.start_identity, candidate.start_symbol_stable_key, candidate.start_file_path,
    candidate.start_line, canonicalJson(candidate.start_evidence), candidate.aggregate_confidence,
    candidate.minimum_confidence, candidate.terminal_reason, canonicalJson(candidate.evidence),
    fingerprint, now, now,
  );
  const id = Number(result.lastInsertRowid);
  writeSteps(db, id, candidate.steps);
  return { id, changed: true, fingerprint };
}

function inferredCandidate(flow) {
  if (!Array.isArray(flow.path) || !flow.path.length) return null;
  if (!Array.isArray(flow.edges) || flow.edges.length !== flow.path.length - 1) return null;
  if (flow.edges.some((edge) => !edge || edge.kind !== "calls" || !edge.source || !edge.target || !Number.isFinite(Number(edge.confidence)))) return null;
  const first = flow.path[0];
  const second = flow.path[1] ?? first;
  const terminal = flow.path.at(-1);
  const startKind = START_KINDS.has(flow.start?.kind) ? flow.start.kind : null;
  if (!startKind || startKind === "configured") return null;
  const startEvidence = normalizeEvidence({ ...(flow.start.evidence ?? {}), kind: "static_process_start" }, "start evidence");
  const startIdentity = startKind === "api_route"
    ? `${String(startEvidence.method ?? "ANY").toUpperCase()} ${startEvidence.path ?? first.stable_key}`
    : `entry:${first.stable_key}`;
  const identityDigest = digest(`${startKind}|${startIdentity}|${first.stable_key}|${second.stable_key}|${terminal.stable_key}`).slice(0, 20);
  const processKey = `auto:${startKind}:${identityDigest}`;
  const name = startKind === "api_route"
    ? `${String(startEvidence.method ?? "ANY").toUpperCase()} ${startEvidence.path ?? first.name} → ${terminal.name}`
    : `Startup ${first.name} → ${terminal.name}`;
  const steps = flow.path.slice(0, MAX_STEPS).map((symbol, ordinal) => {
    const incoming = ordinal === 0 ? null : flow.edges[ordinal - 1] ?? null;
    return {
      ordinal,
      symbol_stable_key: symbol.stable_key,
      name: symbol.name,
      qualified_name: symbol.qualified_name,
      kind: symbol.kind,
      file_path: normalizeFilePath(symbol.file_path),
      start_line: boundedInteger(Number(symbol.start_line), 1, 1, 100_000_000, "symbol start line"),
      end_line: boundedInteger(Number(symbol.end_line), 1, 1, 100_000_000, "symbol end line"),
      incoming_edge_confidence: incoming == null ? null : confidenceValue(incoming.confidence),
      evidence: incoming == null
        ? { kind: "static_process_start", details: startEvidence }
        : normalizeStaticEvidence({ kind: "resolved_call_edge", details: incoming }, "resolved edge evidence"),
    };
  });
  return {
    process_key: processKey,
    name: requiredText(name, "process name", 500),
    source: "inferred",
    start_kind: startKind,
    start_identity: requiredText(startIdentity, "start identity", 4_096),
    start_symbol_stable_key: first.stable_key,
    start_file_path: normalizeFilePath(first.file_path),
    start_line: Number(first.start_line),
    start_evidence: startEvidence,
    aggregate_confidence: confidenceValue(flow.aggregate_confidence),
    minimum_confidence: confidenceValue(flow.minimum_confidence),
    terminal_reason: optionalText(flow.terminal_reason, "terminal reason", 100),
    evidence: {
      kind: "static_execution_flow",
      methodology: "route_or_entry_start_following_resolved_call_edges",
      edge_count: flow.edges.length,
      path_truncated: flow.path.length > MAX_STEPS,
    },
    steps,
  };
}

function configuredCandidate(db, repoRow, {
  processKey,
  name,
  startKind = "configured",
  startIdentity = null,
  steps,
  evidence,
  aggregateConfidence = null,
  minimumConfidence = null,
  terminalReason = "configured_boundary",
}) {
  const key = normalizeProcessKey(processKey);
  const kind = String(startKind ?? "configured").toLowerCase();
  if (!START_KINDS.has(kind)) throw new Error("startKind must be api_route, entry_point, or configured");
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) {
    throw new Error(`steps must contain between 1 and ${MAX_STEPS} entries`);
  }
  const normalizedSteps = steps.map((item, ordinal) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each step must be an object");
    const stableKey = requiredText(item.symbolStableKey ?? item.symbol_stable_key, "symbolStableKey", 4_096);
    const symbol = db.prepare(`
      SELECT s.*, f.path AS file_path
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.repo_id = ? AND s.stable_key = ?
    `).get(repoRow.id, stableKey);
    if (!symbol) throw new Error(`Unknown symbolStableKey in repository ${repoRow.repo_id}: ${stableKey}`);
    const incoming = ordinal === 0 ? null : confidenceValue(item.incomingEdgeConfidence ?? item.incoming_edge_confidence, 1);
    return {
      ordinal,
      symbol_stable_key: symbol.stable_key,
      name: symbol.name,
      qualified_name: symbol.qualified_name,
      kind: symbol.kind,
      file_path: symbol.file_path,
      start_line: Number(symbol.start_line),
      end_line: Number(symbol.end_line),
      incoming_edge_confidence: incoming,
      evidence: normalizeStaticEvidence(item.evidence ?? { kind: ordinal === 0 ? "configured_start" : "configured_static_edge" }, "step evidence"),
    };
  });
  const edgeConfidences = normalizedSteps.slice(1).map((step) => step.incoming_edge_confidence);
  const computedAggregate = edgeConfidences.reduce((score, confidence) => score * confidence, 1);
  const computedMinimum = edgeConfidences.reduce((score, confidence) => Math.min(score, confidence), 1);
  const first = normalizedSteps[0];
  return {
    process_key: key,
    name: requiredText(name, "name", 500),
    source: "configured",
    start_kind: kind,
    start_identity: requiredText(startIdentity ?? `configured:${key}`, "startIdentity", 4_096),
    start_symbol_stable_key: first.symbol_stable_key,
    start_file_path: first.file_path,
    start_line: first.start_line,
    start_evidence: normalizeEvidence({ kind: "configured_process_start", process_evidence: evidence }, "start evidence"),
    aggregate_confidence: confidenceValue(aggregateConfidence, computedAggregate),
    minimum_confidence: confidenceValue(minimumConfidence, computedMinimum),
    terminal_reason: optionalText(terminalReason, "terminalReason", 100),
    evidence: normalizeStaticEvidence(evidence),
    steps: normalizedSteps,
  };
}

export function ensureProcessMemorySchema(db) {
  db.exec(PROCESS_MEMORY_SCHEMA);
  return { ok: true, schema: "process-memory-v1" };
}

export function upsertProcessModel(db, options = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, options.repoId ?? null);
  const candidate = configuredCandidate(db, repoRow, options);
  const existing = db.prepare("SELECT * FROM local_process_models WHERE repo_id = ? AND process_key = ?")
    .get(repoRow.id, candidate.process_key);
  const now = new Date().toISOString();
  const result = transaction(db, () => persistCandidate(db, repoRow, candidate, existing, now));
  return {
    ok: true,
    created: !existing,
    changed: result.changed,
    process: publicProcess(processRow(db, repoRow.id, candidate.process_key, true)),
  };
}

export function retireProcessModel(db, { repoId = null, processKey, purge = false } = {}) {
  ensureProcessMemorySchema(db);
  if (typeof purge !== "boolean") throw new Error("purge must be a boolean");
  const repoRow = repository(db, repoId);
  const key = normalizeProcessKey(processKey);
  const existing = db.prepare("SELECT * FROM local_process_models WHERE repo_id = ? AND process_key = ?").get(repoRow.id, key);
  if (!existing) return { ok: true, changed: false, purged: false, repo_id: repoRow.repo_id, process_key: key };
  if (purge) {
    db.prepare("DELETE FROM local_process_models WHERE id = ?").run(existing.id);
    return { ok: true, changed: true, purged: true, repo_id: repoRow.repo_id, process_key: key };
  }
  if (!existing.active) return { ok: true, changed: false, purged: false, repo_id: repoRow.repo_id, process_key: key };
  const now = new Date().toISOString();
  db.prepare("UPDATE local_process_models SET active = 0, retired_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
  return { ok: true, changed: true, purged: false, repo_id: repoRow.repo_id, process_key: key };
}

function pruneRetiredProcesses(db, repoRow, maximum) {
  const stale = db.prepare(`
    SELECT id FROM local_process_models
    WHERE repo_id = ? AND source = 'inferred' AND active = 0
    ORDER BY updated_at DESC, process_key
    LIMIT -1 OFFSET ?
  `).all(repoRow.id, maximum);
  const remove = db.prepare("DELETE FROM local_process_models WHERE id = ?");
  for (const row of stale) remove.run(row.id);
  return stale.length;
}

function currentSnapshotHash(db, repositoryId) {
  const rows = db.prepare(`
    SELECT process_key, fingerprint, active FROM local_process_models
    WHERE repo_id = ? AND source = 'inferred'
    ORDER BY process_key
  `).all(repositoryId);
  return digest(rows.map((row) => ({ process_key: row.process_key, fingerprint: row.fingerprint, active: Boolean(row.active) })));
}

export function refreshProcessModels(db, {
  repoId = null,
  includeRoutes = true,
  includeEntryPoints = true,
  routePath = null,
  method = null,
  maxDepth = 6,
  maxProcesses = DEFAULT_PROCESS_LIMIT,
  maxStarts = 50,
  maxBranching = 8,
  minConfidence = 0.5,
  maxRetired = 1_000,
} = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, repoId);
  if (typeof includeRoutes !== "boolean" || typeof includeEntryPoints !== "boolean") {
    throw new Error("includeRoutes and includeEntryPoints must be booleans");
  }
  const normalizedRoutePath = routePath == null || routePath === "" ? null : requiredText(routePath, "routePath", 4_096);
  const normalizedMethod = method == null || method === "" ? null : requiredText(method, "method", 20).toUpperCase();
  if (normalizedMethod != null && !HTTP_METHODS.has(normalizedMethod)) throw new Error(`Unsupported HTTP method: ${method}`);
  const processLimit = boundedInteger(maxProcesses, DEFAULT_PROCESS_LIMIT, 1, MAX_PROCESS_LIMIT, "maxProcesses");
  const retiredLimit = boundedInteger(maxRetired, 1_000, 0, MAX_RETIRED, "maxRetired");
  const confidenceThreshold = confidenceValue(minConfidence, 0.5);
  const inferred = inferExecutionFlows(db, {
    repoId: repoRow.repo_id,
    includeRoutes,
    includeEntryPoints,
    routePath: normalizedRoutePath,
    method: normalizedMethod,
    maxDepth: boundedInteger(maxDepth, 6, 1, 20, "maxDepth"),
    maxResults: processLimit,
    maxStarts: boundedInteger(maxStarts, 50, 1, 500, "maxStarts"),
    maxBranching: boundedInteger(maxBranching, 8, 1, 50, "maxBranching"),
    minConfidence: confidenceThreshold,
  });
  const observationScope = {
    include_routes: includeRoutes,
    include_entry_points: includeEntryPoints,
    route_path: normalizedRoutePath,
    method: normalizedMethod,
  };
  const refreshBounds = { ...inferred.bounds, observation_scope: observationScope };
  const candidates = new Map();
  let collisions = 0;
  let invalidFlows = 0;
  for (const flow of inferred.flows) {
    const candidate = inferredCandidate(flow);
    if (!candidate) {
      invalidFlows += 1;
      continue;
    }
    const prior = candidates.get(candidate.process_key);
    if (prior && candidateFingerprint(prior) !== candidateFingerprint(candidate)) {
      candidate.process_key = `${candidate.process_key}:${candidateFingerprint(candidate).slice(0, 8)}`;
      collisions += 1;
    }
    candidates.set(candidate.process_key, candidate);
  }
  const allExistingRows = db.prepare(`
    SELECT * FROM local_process_models WHERE repo_id = ? ORDER BY process_key
  `).all(repoRow.id);
  const existingRows = allExistingRows.filter((row) => row.source === "inferred");
  const existingByKey = new Map(allExistingRows.map((row) => [row.process_key, row]));
  const diff = { added: [], modified: [], retired: [], unchanged: [] };
  const configuredCollisions = [];
  const now = new Date().toISOString();
  let pruned = 0;
  const previousRefresh = db.prepare(`
    SELECT * FROM local_process_refreshes WHERE repo_id = ? ORDER BY id DESC LIMIT 1
  `).get(repoRow.id);
  const baselineRefreshes = db.prepare(`
    SELECT * FROM local_process_refreshes
    WHERE repo_id = ? AND truncated = 0
    ORDER BY id DESC LIMIT 1000
  `).all(repoRow.id).map((row) => ({ row, bounds: parseJson(row.bounds_json, {}) }));
  const fullBaselines = baselineRefreshes.filter(({ bounds }) => {
    const scope = bounds.observation_scope;
    return scope?.include_routes === true && scope?.include_entry_points === true
      && scope.route_path == null && scope.method == null;
  });
  const compatibleBaselineEntry = fullBaselines.find(({ bounds }) => confidenceThreshold <= Number(bounds.min_confidence));
  const baselineScope = compatibleBaselineEntry?.bounds.observation_scope ?? null;
  const fullObservationScope = includeRoutes && includeEntryPoints && normalizedRoutePath == null && normalizedMethod == null;
  const compatibleBaseline = baselineScope != null;
  const hasActiveInferred = existingRows.some((row) => Boolean(row.active));
  const retirementSafe = !inferred.truncated && fullObservationScope && (!hasActiveInferred || compatibleBaseline);
  let retirementSkipReason = null;
  if (inferred.truncated) retirementSkipReason = "incomplete_bounded_flow_observation";
  else if (!fullObservationScope) retirementSkipReason = "partial_start_scope";
  else if (hasActiveInferred && !fullBaselines.length) retirementSkipReason = "no_compatible_full_refresh_baseline";
  else if (hasActiveInferred && !compatibleBaseline) retirementSkipReason = "narrower_confidence_observation";
  else if (hasActiveInferred && !compatibleBaseline) retirementSkipReason = "incompatible_refresh_baseline";
  transaction(db, () => {
    for (const candidate of [...candidates.values()].sort((left, right) => compareCodePoints(left.process_key, right.process_key))) {
      const existing = existingByKey.get(candidate.process_key);
      if (existing?.source === "configured") {
        configuredCollisions.push({ process_key: candidate.process_key, configured_name: existing.name, inferred_name: candidate.name });
        continue;
      }
      const result = persistCandidate(db, repoRow, candidate, existing, now);
      const item = { process_key: candidate.process_key, name: candidate.name };
      if (!existing || !existing.active) diff.added.push({ ...item, reactivated: Boolean(existing) });
      else if (result.changed) diff.modified.push(item);
      else diff.unchanged.push(item);
    }
    if (retirementSafe) {
      for (const existing of existingRows) {
        if (!existing.active || candidates.has(existing.process_key)) continue;
        db.prepare("UPDATE local_process_models SET active = 0, retired_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, existing.id);
        diff.retired.push({ process_key: existing.process_key, name: existing.name });
      }
    }
    pruned = pruneRetiredProcesses(db, repoRow, retiredLimit);
    const snapshotHash = currentSnapshotHash(db, repoRow.id);
    const changed = diff.added.length > 0 || diff.modified.length > 0 || diff.retired.length > 0 || !previousRefresh;
    const boundsChanged = !previousRefresh || previousRefresh.bounds_json !== canonicalJson(refreshBounds)
      || Boolean(previousRefresh.truncated) !== Boolean(inferred.truncated);
    if (changed || previousRefresh?.snapshot_hash !== snapshotHash || boundsChanged) {
      db.prepare(`
        INSERT INTO local_process_refreshes(
          repo_id, previous_snapshot_hash, snapshot_hash, diff_json, bounds_json, truncated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        repoRow.id, previousRefresh?.snapshot_hash ?? null, snapshotHash, canonicalJson(diff),
        canonicalJson(refreshBounds), inferred.truncated ? 1 : 0, now,
      );
    }
  });
  const latestRefresh = db.prepare("SELECT id, snapshot_hash FROM local_process_refreshes WHERE repo_id = ? ORDER BY id DESC LIMIT 1").get(repoRow.id);
  return {
    ok: true,
    repo_id: repoRow.repo_id,
    refresh_id: latestRefresh ? Number(latestRefresh.id) : null,
    snapshot_hash: latestRefresh?.snapshot_hash ?? null,
    changed: diff.added.length > 0 || diff.modified.length > 0 || diff.retired.length > 0 || pruned > 0,
    diff,
    counts: {
      observed_flows: inferred.flow_count,
      candidates: candidates.size,
      active: Number(db.prepare("SELECT COUNT(*) AS count FROM local_process_models WHERE repo_id = ? AND active = 1").get(repoRow.id).count),
      retired: Number(db.prepare("SELECT COUNT(*) AS count FROM local_process_models WHERE repo_id = ? AND active = 0").get(repoRow.id).count),
      pruned,
    },
    bounds: refreshBounds,
    truncated: inferred.truncated,
    stale_cleanup: retirementSafe
      ? { performed: true, retired: diff.retired.length, pruned }
      : { performed: false, reason: retirementSkipReason, pruned },
    diagnostics: {
      deterministic_key_collisions: collisions,
      configured_key_collisions: configuredCollisions,
      invalid_flows_without_complete_resolved_edges: invalidFlows,
    },
    methodology: "Persistent process models are inferred only from static route/entry starts and complete resolved call-edge evidence. Truncated, filtered, or confidence-narrower observations never retire unseen processes.",
  };
}

export function listProcessModels(db, {
  repoId = null,
  active = true,
  source = null,
  limit = DEFAULT_PROCESS_LIMIT,
} = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, repoId);
  const capped = boundedInteger(limit, DEFAULT_PROCESS_LIMIT, 1, MAX_PROCESS_LIMIT, "limit");
  const normalizedSource = source == null ? null : String(source).toLowerCase();
  if (normalizedSource != null && !PROCESS_SOURCES.has(normalizedSource)) throw new Error("source must be configured, inferred, or null");
  if (active != null && typeof active !== "boolean") throw new Error("active must be a boolean or null");
  const activeFilter = active == null ? null : Boolean(active) ? 1 : 0;
  const rows = db.prepare(`
    SELECT p.*, COUNT(steps.id) AS step_count
    FROM local_process_models p
    LEFT JOIN local_process_steps steps ON steps.process_id = p.id
    WHERE p.repo_id = ? AND (? IS NULL OR p.active = ?) AND (? IS NULL OR p.source = ?)
    GROUP BY p.id
    ORDER BY p.active DESC, p.name, p.process_key
    LIMIT ?
  `).all(repoRow.id, activeFilter, activeFilter, normalizedSource, normalizedSource, capped + 1);
  return {
    repo_id: repoRow.repo_id,
    processes: rows.slice(0, capped).map(publicProcess),
    truncated: rows.length > capped,
    limits: { requested: limit, applied: capped, maximum: MAX_PROCESS_LIMIT },
  };
}

export function getProcessFlow(db, { repoId = null, processKey, includeRetired = false } = {}) {
  ensureProcessMemorySchema(db);
  if (typeof includeRetired !== "boolean") throw new Error("includeRetired must be a boolean");
  const repoRow = repository(db, repoId);
  const key = normalizeProcessKey(processKey);
  const row = processRow(db, repoRow.id, key, Boolean(includeRetired));
  if (!row) throw new Error(`Process not found: ${key}`);
  const boundedSteps = stepsForProcess(db, row.id);
  return {
    repo_id: repoRow.repo_id,
    process: publicProcess(row),
    steps: boundedSteps.steps,
    truncated: boundedSteps.truncated,
    limits: { steps: MAX_STEPS },
    methodology: "Ordered steps preserve statically resolved call-edge confidence and evidence; they are not observed runtime traces.",
  };
}

export function getProcessMembership(db, {
  repoId = null,
  symbolStableKey = null,
  filePath = null,
  processKey = null,
  includeRetired = false,
  limit = 500,
} = {}) {
  ensureProcessMemorySchema(db);
  if (typeof includeRetired !== "boolean") throw new Error("includeRetired must be a boolean");
  const repoRow = repository(db, repoId);
  if (symbolStableKey == null && filePath == null && processKey == null) {
    throw new Error("symbolStableKey, filePath, or processKey is required");
  }
  const stableKey = symbolStableKey == null ? null : requiredText(symbolStableKey, "symbolStableKey", 4_096);
  const normalizedPath = filePath == null ? null : normalizeFilePath(filePath);
  const normalizedProcess = processKey == null ? null : normalizeProcessKey(processKey);
  const capped = boundedInteger(limit, 500, 1, 5_000, "limit");
  const rows = db.prepare(`
    SELECT p.*, steps.id AS step_id, steps.ordinal, steps.symbol_stable_key, steps.symbol_name,
      steps.qualified_name, steps.symbol_kind, steps.file_path, steps.start_line, steps.end_line,
      steps.incoming_edge_confidence, steps.evidence_json AS step_evidence_json,
      (SELECT COUNT(*) FROM local_process_steps count_steps WHERE count_steps.process_id = p.id) AS step_count
    FROM local_process_steps steps
    JOIN local_process_models p ON p.id = steps.process_id
    WHERE p.repo_id = ? AND (? = 1 OR p.active = 1)
      AND (? IS NULL OR steps.symbol_stable_key = ?)
      AND (? IS NULL OR steps.file_path = ?)
      AND (? IS NULL OR p.process_key = ?)
    ORDER BY p.name, p.process_key, steps.ordinal
    LIMIT ?
  `).all(
    repoRow.id, includeRetired ? 1 : 0,
    stableKey, stableKey, normalizedPath, normalizedPath, normalizedProcess, normalizedProcess,
    capped + 1,
  );
  return {
    repo_id: repoRow.repo_id,
    query: { symbol_stable_key: stableKey, file_path: normalizedPath, process_key: normalizedProcess },
    memberships: rows.slice(0, capped).map((row) => ({
      process: publicProcess(row),
      step: publicStep({ ...row, evidence_json: row.step_evidence_json }),
    })),
    truncated: rows.length > capped,
    limits: { requested: limit, applied: capped, maximum: 5_000 },
  };
}

export function listProcessRefreshes(db, { repoId = null, since = null, limit = 100 } = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, repoId);
  const capped = boundedInteger(limit, 100, 1, 1_000, "limit");
  let normalizedSince = null;
  if (since != null) {
    const timestamp = new Date(since);
    if (Number.isNaN(timestamp.getTime())) throw new Error("since must be a valid timestamp");
    normalizedSince = timestamp.toISOString();
  }
  const rows = db.prepare(`
    SELECT * FROM local_process_refreshes
    WHERE repo_id = ? AND (? IS NULL OR created_at >= ?)
    ORDER BY created_at, id
    LIMIT ?
  `).all(repoRow.id, normalizedSince, normalizedSince, capped + 1);
  return {
    repo_id: repoRow.repo_id,
    refreshes: rows.slice(0, capped).map((row) => ({
      id: Number(row.id),
      previous_snapshot_hash: row.previous_snapshot_hash,
      snapshot_hash: row.snapshot_hash,
      diff: parseJson(row.diff_json, {}),
      bounds: parseJson(row.bounds_json, {}),
      truncated: Boolean(row.truncated),
      created_at: row.created_at,
    })),
    truncated: rows.length > capped,
  };
}

function section(status, source, value, { reason = null, truncated = false } = {}) {
  return { status, source, value, reason, truncated: Boolean(truncated) };
}

function decisionsSection(db, repoRow, limit, since = null) {
  if (!tableExists(db, "decisions")) return section("missing", null, null, { reason: "decision_memory_not_available" });
  const clauses = ["d.repo_id = ?"];
  const params = [repoRow.id];
  if (since) {
    clauses.push("d.updated_at >= ?");
    params.push(since);
  }
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE repo_id = ?").get(repoRow.id).count);
  const linksAvailable = tableExists(db, "decision_links");
  const linkedSymbols = linksAvailable
    ? "(SELECT COUNT(*) FROM decision_links links WHERE links.decision_id = d.id)"
    : "NULL";
  const rows = db.prepare(`
    SELECT d.*, ${linkedSymbols} AS linked_symbols
    FROM decisions d
    WHERE ${clauses.join(" AND ")}
    ORDER BY CASE d.status WHEN 'active' THEN 0 ELSE 1 END, d.updated_at DESC, d.id DESC
    LIMIT ?
  `).all(...params, limit + 1);
  const values = rows.slice(0, limit).map((row) => ({
    id: Number(row.id), title: row.title, status: row.status, rationale: row.rationale,
    alternatives: parseJson(row.alternatives_json, []), tags: parseJson(row.tags_json, []),
    linked_symbols: row.linked_symbols == null ? null : Number(row.linked_symbols), created_at: row.created_at, updated_at: row.updated_at,
  }));
  return section(values.length ? "available" : "available_empty", linksAvailable ? "decisions" : "decisions_without_links", values, {
    reason: values.length ? linksAvailable ? null : "decision_links_not_available" : total ? "no_decisions_in_window" : "no_decisions_recorded",
    truncated: rows.length > limit,
  });
}

function temporalCoverage(db, repoRow) {
  if (tableExists(db, "temporal_episodes")) {
    const count = Number(db.prepare("SELECT COUNT(*) AS count FROM temporal_episodes WHERE repo_id = ?").get(repoRow.id).count);
    if (count) return { available: true, source: "temporal_episodes", total: count, changes_available: tableExists(db, "temporal_entity_changes") };
  }
  if (tableExists(db, "episodes")) {
    const legacyCount = Number(db.prepare("SELECT COUNT(*) AS count FROM episodes WHERE repo_id = ?").get(repoRow.id).count);
    if (legacyCount) return { available: true, source: "index_episodes", total: legacyCount, changes_available: tableExists(db, "episode_changes") };
  }
  return { available: false, source: null, total: null, changes_available: false };
}

function recentChangesSection(db, repoRow, since, limit) {
  const coverage = temporalCoverage(db, repoRow);
  if (!coverage.available) return section("missing", null, null, { reason: "no_temporal_episodes_ingested" });
  let rows;
  if (coverage.source === "temporal_episodes") {
    const changeCount = coverage.changes_available
      ? "(SELECT COUNT(*) FROM temporal_entity_changes changes WHERE changes.episode_id = ep.id)"
      : "NULL";
    rows = db.prepare(`
      SELECT ep.*, ${changeCount} AS change_count
      FROM temporal_episodes ep
      WHERE ep.repo_id = ? AND ep.reference_time >= ?
      ORDER BY ep.reference_time DESC, ep.sequence DESC
      LIMIT ?
    `).all(repoRow.id, since, limit + 1).map((row) => ({
      id: Number(row.id), type: row.type, reference_time: row.reference_time, source_id: row.source_id,
      message: row.message, complete: Boolean(row.complete), summary: parseJson(row.summary_json, {}),
      change_count: row.change_count == null ? null : Number(row.change_count),
    }));
  } else {
    const changeCount = coverage.changes_available
      ? "(SELECT COUNT(*) FROM episode_changes changes WHERE changes.episode_id = ep.id)"
      : "NULL";
    rows = db.prepare(`
      SELECT ep.*, ${changeCount} AS change_count
      FROM episodes ep
      WHERE ep.repo_id = ? AND ep.reference_time >= ?
      ORDER BY ep.reference_time DESC, ep.id DESC
      LIMIT ?
    `).all(repoRow.id, since, limit + 1).map((row) => ({
      id: Number(row.id), type: row.type, reference_time: row.reference_time, source_id: row.source_id,
      summary: parseJson(row.summary_json, {}), change_count: row.change_count == null ? null : Number(row.change_count),
    }));
  }
  const selected = rows.slice(0, limit);
  return section(selected.length ? "available" : "available_empty", coverage.source, selected, {
    reason: selected.length ? coverage.changes_available ? null : "entity_change_details_not_available" : "history_available_but_no_changes_in_window",
    truncated: rows.length > limit,
  });
}

function processSection(db, repoRow, limit) {
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM local_process_models WHERE repo_id = ?").get(repoRow.id).count);
  const refreshes = Number(db.prepare("SELECT COUNT(*) AS count FROM local_process_refreshes WHERE repo_id = ?").get(repoRow.id).count);
  if (!total && !refreshes) return section("missing", null, null, { reason: "process_models_have_not_been_refreshed_or_configured" });
  const listed = listProcessModels(db, { repoId: repoRow.repo_id, active: true, limit });
  return section(listed.processes.length ? "available" : "available_empty", "local_process_models", listed.processes, {
    reason: listed.processes.length ? null : "process_refresh_completed_with_no_active_processes",
    truncated: listed.truncated,
  });
}

function processChangesSection(db, repoRow, since, limit) {
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM local_process_refreshes WHERE repo_id = ?").get(repoRow.id).count);
  if (!total) return section("missing", null, null, { reason: "no_process_refresh_history" });
  const rows = db.prepare(`
    SELECT * FROM local_process_refreshes
    WHERE repo_id = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(repoRow.id, since, limit + 1);
  const values = rows.slice(0, limit).map((row) => ({
    id: Number(row.id), diff: parseJson(row.diff_json, {}), bounds: parseJson(row.bounds_json, {}),
    truncated: Boolean(row.truncated), created_at: row.created_at,
  }));
  return section(values.length ? "available" : "available_empty", "local_process_refreshes", values, {
    reason: values.length ? null : "refresh_history_available_but_no_process_changes_in_window",
    truncated: rows.length > limit,
  });
}

function architectureSection(db, repoRow, communityLimit, symbolLimit) {
  const symbolCount = Number(db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE repo_id = ?").get(repoRow.id).count);
  if (!symbolCount) return section("missing", null, null, { reason: "no_indexed_symbols" });
  try {
    const value = getArchitecture(db, { repoId: repoRow.repo_id, maxCommunities: communityLimit, maxSymbols: symbolLimit });
    const empty = !value.communities.length && !value.central_symbols.length;
    return section(empty ? "available_empty" : "available", "static_graph", value, { reason: empty ? "graph_has_no_rankable_structure" : null });
  } catch (error) {
    return section("missing", "static_graph", null, { reason: `architecture_failed:${error.message}` });
  }
}

function hotspotSection(db, repoRow, limit, maxSymbols, maxBodyBytes) {
  const symbolCount = Number(db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE repo_id = ?").get(repoRow.id).count);
  if (!symbolCount) return section("missing", null, null, { reason: "no_indexed_symbols" });
  try {
    const value = getChurnWeightedHotspots(db, {
      repoId: repoRow.repo_id, limit, maxSymbols, maxBodyBytes,
    });
    return section(value.findings.length ? "available" : "available_empty", value.history_source === "none" ? "complexity_only" : value.history_source, value, {
      reason: value.findings.length ? null : "no_analyzable_hotspots",
      truncated: value.truncated,
    });
  } catch (error) {
    return section("missing", null, null, { reason: `hotspot_analysis_failed:${error.message}` });
  }
}

function evidenceGaps(sections) {
  return Object.entries(sections).filter(([, value]) => value?.status === "missing")
    .map(([name, value]) => ({ section: name, reason: value.reason }));
}

function repositoryStatsSection(db, repoRow) {
  const bounded = (value, source, reason = null) => {
    const collectionLimit = 100;
    const collectionSizes = {
      languages: value.languages?.length ?? 0,
      edge_kinds: value.edge_kinds?.length ?? 0,
      relationship_kinds: value.relationship_kinds?.length ?? 0,
    };
    const truncated = Object.values(collectionSizes).some((size) => size > collectionLimit);
    return section("available", source, {
      ...value,
      languages: value.languages?.slice(0, collectionLimit) ?? [],
      edge_kinds: value.edge_kinds?.slice(0, collectionLimit) ?? [],
      relationship_kinds: value.relationship_kinds?.slice(0, collectionLimit) ?? [],
      collection_counts: collectionSizes,
      collection_limit: collectionLimit,
    }, { reason, truncated });
  };
  const requiredTables = ["files", "symbols", "edges", "code_relationships", "api_operations"];
  const optionalTables = ["episodes", "decisions"];
  const missingRequired = requiredTables.filter((name) => !tableExists(db, name));
  if (missingRequired.length) {
    return section("missing", "local_index", null, { reason: `repository_stats_missing_tables:${missingRequired.join(",")}` });
  }
  const missingOptional = optionalTables.filter((name) => !tableExists(db, name));
  if (!missingOptional.length) return bounded(getRepositoryStats(db, repoRow.repo_id), "local_index");
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE repo_id = ?`).get(repoRow.id).count);
  const value = {
    ...publicRepository(repoRow),
    files: count("files"),
    symbols: count("symbols"),
    edges: count("edges"),
    semantic_relationships: count("code_relationships"),
    api_operations: count("api_operations"),
    episodes: tableExists(db, "episodes") ? count("episodes") : null,
    decisions: tableExists(db, "decisions") ? count("decisions") : null,
    languages: db.prepare("SELECT language, COUNT(*) AS files FROM files WHERE repo_id = ? GROUP BY language ORDER BY files DESC, language").all(repoRow.id),
    edge_kinds: db.prepare("SELECT kind, COUNT(*) AS count FROM edges WHERE repo_id = ? GROUP BY kind ORDER BY count DESC, kind").all(repoRow.id),
    relationship_kinds: db.prepare(`
      SELECT category, kind, COUNT(*) AS count FROM code_relationships WHERE repo_id = ?
      GROUP BY category, kind ORDER BY category, count DESC, kind
    `).all(repoRow.id),
  };
  return bounded(value, "local_index_partial", `optional_tables_not_available:${missingOptional.join(",")}`);
}

export function getCodebaseBriefing(db, {
  repoId = null,
  processLimit = 50,
  decisionLimit = 20,
  hotspotLimit = 10,
  communityLimit = 8,
  centralSymbolLimit = 15,
  hotspotMaxSymbols = 2_000,
  hotspotMaxBodyBytes = 16 * 1024 * 1024,
} = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, repoId);
  const processCap = boundedInteger(processLimit, 50, 1, 500, "processLimit");
  const decisionCap = boundedInteger(decisionLimit, 20, 1, 100, "decisionLimit");
  const hotspotCap = boundedInteger(hotspotLimit, 10, 1, 100, "hotspotLimit");
  const communityCap = boundedInteger(communityLimit, 8, 1, 50, "communityLimit");
  const centralCap = boundedInteger(centralSymbolLimit, 15, 1, 100, "centralSymbolLimit");
  const diagnostics = getIndexDiagnostics(db, { repoId: repoRow.repo_id, limit: 10 });
  const coverage = temporalCoverage(db, repoRow);
  const sections = {
    repository_stats: repositoryStatsSection(db, repoRow),
    index_diagnostics: section("available", "local_index", diagnostics),
    architecture: architectureSection(db, repoRow, communityCap, centralCap),
    processes: processSection(db, repoRow, processCap),
    hotspots: hotspotSection(
      db, repoRow, hotspotCap,
      boundedInteger(hotspotMaxSymbols, 2_000, 1, 20_000, "hotspotMaxSymbols"),
      boundedInteger(hotspotMaxBodyBytes, 16 * 1024 * 1024, 1_024, 256 * 1024 * 1024, "hotspotMaxBodyBytes"),
    ),
    decisions: decisionsSection(db, repoRow, decisionCap),
    temporal_history: coverage.available
      ? section("available", coverage.source, { episodes: coverage.total, entity_changes_available: coverage.changes_available }, {
        reason: coverage.changes_available ? null : "entity_change_details_not_available",
      })
      : section("missing", null, null, { reason: "no_temporal_episodes_ingested" }),
  };
  return {
    repo_id: repoRow.repo_id,
    repository: publicRepository(repoRow),
    sections,
    evidence_gaps: evidenceGaps(sections),
    methodology: "Codebase briefing composes local index statistics, static graph architecture, persistent static processes, quality analysis, recorded decisions, and temporal coverage. Missing evidence is never converted to a zero count.",
  };
}

export function getDailyBriefing(db, {
  repoId = null,
  since = null,
  now = null,
  changeLimit = 50,
  processChangeLimit = 20,
  decisionLimit = 20,
  processLimit = 25,
  hotspotLimit = 10,
} = {}) {
  ensureProcessMemorySchema(db);
  const repoRow = repository(db, repoId);
  const generatedAt = now == null ? new Date() : new Date(now);
  if (Number.isNaN(generatedAt.getTime())) throw new Error("now must be a valid timestamp");
  const windowStart = since == null ? new Date(generatedAt.getTime() - 86_400_000) : new Date(since);
  if (Number.isNaN(windowStart.getTime())) throw new Error("since must be a valid timestamp");
  if (windowStart > generatedAt) throw new Error("since must not be later than now");
  const normalizedSince = windowStart.toISOString();
  const codebase = getCodebaseBriefing(db, {
    repoId: repoRow.repo_id,
    processLimit: boundedInteger(processLimit, 25, 1, 500, "processLimit"),
    decisionLimit: boundedInteger(decisionLimit, 20, 1, 100, "decisionLimit"),
    hotspotLimit: boundedInteger(hotspotLimit, 10, 1, 100, "hotspotLimit"),
  });
  const sections = {
    repository_stats: codebase.sections.repository_stats,
    architecture: codebase.sections.architecture,
    recent_changes: recentChangesSection(db, repoRow, normalizedSince, boundedInteger(changeLimit, 50, 1, 500, "changeLimit")),
    process_changes: processChangesSection(db, repoRow, normalizedSince, boundedInteger(processChangeLimit, 20, 1, 200, "processChangeLimit")),
    active_processes: codebase.sections.processes,
    hotspots: codebase.sections.hotspots,
    decisions: decisionsSection(db, repoRow, boundedInteger(decisionLimit, 20, 1, 100, "decisionLimit"), normalizedSince),
  };
  return {
    repo_id: repoRow.repo_id,
    generated_at: generatedAt.toISOString(),
    window: { since: normalizedSince, until: generatedAt.toISOString() },
    sections,
    evidence_gaps: evidenceGaps(sections),
    methodology: "Daily briefing reports locally indexed evidence within the requested time window plus current architecture/process/hotspot context. Available-empty means measured zero in the window; missing means the supporting evidence was never ingested.",
  };
}
