import { readFileSync } from "node:fs";
import path from "node:path";
import { methodsCompatible, normalizeApiPath, normalizeHttpMethod } from "./api-utils.mjs";
import { getIndexFreshness, storedIndexSnapshot } from "./repository-state.mjs";

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToRepository(row) {
  return {
    repo_id: row.repo_id,
    name: row.name,
    root: row.root,
    indexed_at: row.indexed_at,
    head_commit: row.head_commit,
    index_snapshot: storedIndexSnapshot(row),
  };
}

function rowToSymbol(row) {
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
    exported: Boolean(row.exported),
  };
}

export function resolveRepository(db, repoId = null) {
  if (repoId) {
    const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId);
    if (!row) throw new Error(`Unknown repo_id: ${repoId}`);
    return row;
  }
  const rows = db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC").all();
  if (!rows.length) throw new Error("No repositories are indexed. Call index_directory first.");
  if (rows.length > 1) throw new Error("Multiple repositories are indexed; pass repo_id explicitly.");
  return rows[0];
}

export function listIndexedRepositories(db) {
  return db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) AS files,
      (SELECT COUNT(*) FROM symbols s WHERE s.repo_id = r.id) AS symbols,
      (SELECT COUNT(*) FROM edges e WHERE e.repo_id = r.id) AS edges,
      (SELECT COUNT(*) FROM api_operations a WHERE a.repo_id = r.id) AS api_operations,
      (SELECT COUNT(*) FROM episodes ep WHERE ep.repo_id = r.id) AS episodes,
      (SELECT COUNT(*) FROM decisions d WHERE d.repo_id = r.id) AS decisions
    FROM repositories r
    ORDER BY r.indexed_at DESC
  `).all().map((row) => ({ ...rowToRepository(row), files: row.files, symbols: row.symbols, edges: row.edges, api_operations: row.api_operations, episodes: row.episodes, decisions: row.decisions }));
}

export function getRepositoryStats(db, repoId = null) {
  const repository = resolveRepository(db, repoId);
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM files WHERE repo_id = ?) AS files,
      (SELECT COUNT(*) FROM symbols WHERE repo_id = ?) AS symbols,
      (SELECT COUNT(*) FROM edges WHERE repo_id = ?) AS edges,
      (SELECT COUNT(*) FROM code_relationships WHERE repo_id = ?) AS semantic_relationships,
      (SELECT COUNT(*) FROM api_operations WHERE repo_id = ?) AS api_operations,
      (SELECT COUNT(*) FROM episodes WHERE repo_id = ?) AS episodes,
      (SELECT COUNT(*) FROM decisions WHERE repo_id = ?) AS decisions
  `).get(repository.id, repository.id, repository.id, repository.id, repository.id, repository.id, repository.id);
  const languages = db.prepare(`
    SELECT language, COUNT(*) AS files
    FROM files WHERE repo_id = ? GROUP BY language ORDER BY files DESC, language
  `).all(repository.id);
  const edgeKinds = db.prepare(`
    SELECT kind, COUNT(*) AS count
    FROM edges WHERE repo_id = ? GROUP BY kind ORDER BY count DESC, kind
  `).all(repository.id);
  const relationshipKinds = db.prepare(`
    SELECT category, kind, COUNT(*) AS count
    FROM code_relationships WHERE repo_id = ?
    GROUP BY category, kind ORDER BY category, count DESC, kind
  `).all(repository.id);
  return { ...rowToRepository(repository), index_snapshot: getIndexFreshness(repository), ...counts, languages, edge_kinds: edgeKinds, relationship_kinds: relationshipKinds };
}

export function getIndexDiagnostics(db, { repoId = null, limit = 25 } = {}) {
  const repository = resolveRepository(db, repoId);
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const parserModes = db.prepare(`
    SELECT parser_mode, COUNT(*) AS files, SUM(diagnostic_count) AS diagnostics
    FROM file_diagnostics
    WHERE repo_id = ?
    GROUP BY parser_mode
    ORDER BY files DESC, parser_mode
  `).all(repository.id);
  const callStatuses = db.prepare(`
    SELECT resolution_status, SUM(occurrences) AS calls, COUNT(*) AS relationships
    FROM symbol_calls
    WHERE repo_id = ?
    GROUP BY resolution_status
    ORDER BY calls DESC, resolution_status
  `).all(repository.id);
  const callTotals = db.prepare(`
    SELECT SUM(occurrences) AS total,
      SUM(CASE WHEN resolution_status = 'resolved' THEN occurrences ELSE 0 END) AS resolved,
      SUM(CASE WHEN resolution_status = 'resolved' AND confidence >= 0.9 THEN occurrences ELSE 0 END) AS high_confidence,
      COUNT(*) AS relationships
    FROM symbol_calls
    WHERE repo_id = ?
  `).get(repository.id);
  const parseErrors = db.prepare(`
    SELECT f.path AS file_path, f.language, d.parser_mode, d.diagnostic_count, d.diagnostics_json
    FROM file_diagnostics d JOIN files f ON f.id = d.file_id
    WHERE d.repo_id = ? AND d.diagnostic_count > 0
    ORDER BY d.diagnostic_count DESC, f.path
    LIMIT ?
  `).all(repository.id, cappedLimit).map((row) => ({
    file_path: row.file_path,
    language: row.language,
    parser_mode: row.parser_mode,
    diagnostic_count: row.diagnostic_count,
    diagnostics: parseJson(row.diagnostics_json, []),
  }));
  const unresolvedCalls = db.prepare(`
    SELECT f.path AS file_path, s.qualified_name AS source_symbol,
      c.callee_name, c.qualifier, c.call_line, c.syntax, c.occurrences, c.resolution_status
    FROM symbol_calls c
    JOIN files f ON f.id = c.file_id
    LEFT JOIN symbols s ON s.stable_key = c.source_stable_key AND s.repo_id = c.repo_id
    WHERE c.repo_id = ? AND c.resolution_status != 'resolved'
    ORDER BY CASE c.resolution_status WHEN 'ambiguous' THEN 0 ELSE 1 END, f.path, c.call_line
    LIMIT ?
  `).all(repository.id, cappedLimit);
  const importTotals = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM edges e
        WHERE e.repo_id = fi.repo_id AND e.kind = 'imports'
          AND e.source_file_id = fi.file_id AND e.label = fi.specifier
      ) THEN 1 ELSE 0 END) AS resolved
    FROM file_imports fi
    WHERE fi.repo_id = ?
  `).get(repository.id);
  const unresolvedImports = db.prepare(`
    SELECT f.path AS file_path, fi.specifier
    FROM file_imports fi JOIN files f ON f.id = fi.file_id
    WHERE fi.repo_id = ? AND NOT EXISTS (
      SELECT 1 FROM edges e
      WHERE e.repo_id = fi.repo_id AND e.kind = 'imports'
        AND e.source_file_id = fi.file_id AND e.label = fi.specifier
    )
    ORDER BY f.path, fi.specifier
    LIMIT ?
  `).all(repository.id, cappedLimit);
  const resolvedCalls = Number(callTotals.resolved ?? 0);
  const totalCalls = Number(callTotals.total ?? 0);
  const resolvedImports = Number(importTotals.resolved ?? 0);
  const totalImports = Number(importTotals.total ?? 0);
  const semanticRelationships = db.prepare(`
    SELECT category, kind, COUNT(*) AS count
    FROM code_relationships WHERE repo_id = ?
    GROUP BY category, kind ORDER BY category, count DESC, kind
  `).all(repository.id);
  return {
    repo_id: repository.repo_id,
    indexed_at: repository.indexed_at,
    index_snapshot: getIndexFreshness(repository),
    parser_modes: parserModes,
    parse_error_files: parseErrors,
    calls: {
      total: totalCalls,
      resolved: resolvedCalls,
      high_confidence: Number(callTotals.high_confidence ?? 0),
      relationships: Number(callTotals.relationships ?? 0),
      resolution_rate: totalCalls ? resolvedCalls / totalCalls : 1,
      by_status: callStatuses,
      unresolved_samples: unresolvedCalls,
    },
    imports: {
      total: totalImports,
      resolved: resolvedImports,
      resolution_rate: totalImports ? resolvedImports / totalImports : 1,
      unresolved_samples: unresolvedImports,
    },
    semantic_relationships: semanticRelationships,
    note: "Unresolved calls include language built-ins, package APIs, and dynamic dispatch; the rate is a transparency metric, not a standalone accuracy score.",
  };
}

export function getApiTopology(db, { repoId = null, path: requestedPath = null, method = null, limit = 5000 } = {}) {
  const repository = resolveRepository(db, repoId);
  const normalizedPath = requestedPath ? normalizeApiPath(requestedPath) : null;
  const normalizedMethod = method ? normalizeHttpMethod(method) : null;
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 5000, 5000));
  const conditions = ["a.repo_id = ?"];
  const parameters = [repository.id];
  if (normalizedMethod) {
    conditions.push("(a.kind = 'mount' OR a.method = ? OR a.method = 'ANY')");
    parameters.push(normalizedMethod);
  }
  parameters.push(cappedLimit);
  const operations = db.prepare(`
    SELECT a.*, f.path AS file_path, s.name AS source_name, s.qualified_name AS source_qualified_name,
      s.kind AS source_kind, s.start_line AS source_start_line, s.end_line AS source_end_line
    FROM api_operations a
    JOIN files f ON f.id = a.file_id
    LEFT JOIN symbols s ON s.repo_id = a.repo_id AND s.stable_key = a.source_stable_key
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.normalized_path, a.method, a.kind DESC, f.path, a.line
    LIMIT ?
  `).all(...parameters).map((row) => ({
    id: row.id,
    file_id: row.file_id,
    kind: row.kind,
    method: row.method,
    path: row.normalized_path,
    raw_path: row.raw_path,
    framework: row.framework,
    confidence: row.confidence,
    handler_name: row.handler_name,
    file_path: row.file_path,
    line: row.line,
    source: row.source_name ? {
      stable_key: row.source_stable_key,
      name: row.source_name,
      qualified_name: row.source_qualified_name,
      kind: row.source_kind,
      start_line: row.source_start_line,
      end_line: row.source_end_line,
    } : null,
  }));
  const mounts = operations.filter((operation) => operation.kind === "mount");
  const imports = db.prepare(`
    SELECT fi.file_id AS source_file_id, fi.imported_names, e.target_file_id
    FROM file_imports fi
    JOIN edges e ON e.repo_id = fi.repo_id AND e.kind = 'imports'
      AND e.source_file_id = fi.file_id AND e.label = fi.specifier
    WHERE fi.repo_id = ?
  `).all(repository.id);
  const importsBySource = new Map();
  for (const imported of imports) {
    const values = importsBySource.get(imported.source_file_id) ?? [];
    values.push({ ...imported, bindings: parseJson(imported.imported_names, []) });
    importsBySource.set(imported.source_file_id, values);
  }
  const joinPaths = (prefix, suffix) => normalizeApiPath(`${prefix && prefix !== "/" ? prefix : ""}/${suffix && suffix !== "/" ? suffix.replace(/^\/+/, "") : ""}`);
  const prefixesByFile = new Map();
  const addPrefix = (fileId, prefix) => {
    const values = prefixesByFile.get(fileId) ?? new Set();
    const size = values.size;
    values.add(prefix);
    prefixesByFile.set(fileId, values);
    return values.size !== size;
  };
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (const mount of mounts) {
      const local = mount.handler_name?.split(".")[0];
      if (!local) continue;
      const sourcePrefixes = prefixesByFile.get(mount.file_id) ?? new Set([""]);
      const targets = (importsBySource.get(mount.file_id) ?? [])
        .filter((imported) => imported.bindings.some((binding) => binding?.local === local))
        .map((imported) => imported.target_file_id);
      for (const targetFileId of targets) {
        for (const sourcePrefix of sourcePrefixes) {
          if (addPrefix(targetFileId, joinPaths(sourcePrefix, mount.path))) changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const publicOperation = (operation) => {
    const { file_id: _fileId, ...result } = operation;
    return result;
  };
  let routes = operations.filter((operation) => operation.kind === "route").flatMap((operation) => {
    const prefixes = prefixesByFile.get(operation.file_id);
    if (!prefixes?.size) return [{ ...operation, instance_id: String(operation.id) }];
    return [...prefixes].map((prefix, index) => ({
      ...operation,
      raw_path: `${prefix}${operation.raw_path}`,
      path: joinPaths(prefix, operation.path),
      instance_id: `${operation.id}:${index}`,
    }));
  });
  let clients = operations.filter((operation) => operation.kind === "client");
  if (normalizedPath) {
    routes = routes.filter((operation) => operation.path === normalizedPath);
    clients = clients.filter((operation) => operation.path === normalizedPath);
  }
  const routesByPath = new Map();
  for (const route of routes) {
    const values = routesByPath.get(route.path) ?? [];
    values.push(route);
    routesByPath.set(route.path, values);
  }
  const links = [];
  const linkedClientIds = new Set();
  const linkedRouteIds = new Set();
  for (const client of clients) {
    for (const route of routesByPath.get(client.path) ?? []) {
      if (!methodsCompatible(client.method, route.method)) continue;
      linkedClientIds.add(client.id);
      linkedRouteIds.add(route.instance_id);
      links.push({
        method: client.method === "ANY" ? route.method : client.method,
        path: client.path,
        confidence: Math.min(client.confidence, route.confidence),
        client: publicOperation(client),
        route: publicOperation(route),
      });
    }
  }
  return {
    repo_id: repository.repo_id,
    filter: { path: normalizedPath, method: normalizedMethod },
    counts: { operations: operations.length, mounts: mounts.length, routes: routes.length, clients: clients.length, linked: links.length },
    routes: routes.map(publicOperation),
    clients: clients.map(publicOperation),
    links,
    unmatched_routes: routes.filter((route) => !linkedRouteIds.has(route.instance_id)).map(publicOperation),
    unmatched_clients: clients.filter((client) => !linkedClientIds.has(client.id)).map(publicOperation),
    truncated: operations.length === cappedLimit,
    note: "Express-style mount prefixes are composed through resolved imports. Only statically recoverable paths are included; dynamic URL construction remains intentionally unresolved.",
  };
}

export function findSymbol(db, { repoId = null, name, fuzzy = true, kind = null, filePath = null, limit = 20 }) {
  if (!name?.trim()) throw new Error("name is required");
  const repository = resolveRepository(db, repoId);
  const conditions = ["s.repo_id = ?"];
  const parameters = [repository.id];
  if (fuzzy) {
    conditions.push("(s.name LIKE ? OR s.qualified_name LIKE ?)");
    parameters.push(`%${name}%`, `%${name}%`);
  } else {
    conditions.push("(s.name = ? OR s.qualified_name = ?)");
    parameters.push(name, name);
  }
  if (kind) {
    conditions.push("LOWER(s.kind) = LOWER(?)");
    parameters.push(kind);
  }
  if (filePath) {
    conditions.push("f.path LIKE ?");
    parameters.push(`%${filePath.replaceAll("\\", "/")}%`);
  }
  parameters.push(Math.max(1, Math.min(Number(limit) || 20, 100)));
  return db.prepare(`
    SELECT s.*, f.path AS file_path, f.language,
      CASE
        WHEN s.qualified_name = ? THEN 0
        WHEN s.name = ? THEN 1
        WHEN s.name LIKE ? THEN 2
        ELSE 3
      END AS match_rank
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY match_rank, s.name, f.path, s.start_line
    LIMIT ?
  `).all(name, name, `${name}%`, ...parameters).map(rowToSymbol);
}

function ftsQuery(query) {
  const terms = query.match(/[\p{L}\p{N}_$.-]+/gu) ?? [];
  return terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function findCode(db, { repoId = null, query, filePath = null, kind = null, limit = 20, offset = 0 }) {
  if (!query?.trim()) throw new Error("query is required");
  const repository = resolveRepository(db, repoId);
  const match = ftsQuery(query);
  if (!match) return [];
  const conditions = ["s.repo_id = ?", "symbols_fts MATCH ?"];
  const parameters = [repository.id, match];
  if (filePath) {
    conditions.push("f.path LIKE ?");
    parameters.push(`%${filePath.replaceAll("\\", "/")}%`);
  }
  if (kind) {
    conditions.push("LOWER(s.kind) = LOWER(?)");
    parameters.push(kind);
  }
  parameters.push(Math.max(1, Math.min(Number(limit) || 20, 1000)));
  parameters.push(Math.max(0, Math.min(Number(offset) || 0, 10000)));
  const rows = db.prepare(`
    SELECT s.*, f.path AS file_path, f.language, bm25(symbols_fts) AS score,
      CASE
        WHEN s.name = ? OR s.qualified_name = ? THEN 0
        WHEN s.name LIKE ? THEN 1
        ELSE 2
      END AS match_rank
    FROM symbols_fts
    JOIN symbols s ON s.id = CAST(symbols_fts.symbol_id AS INTEGER)
    JOIN files f ON f.id = s.file_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY match_rank, score, s.name
    LIMIT ? OFFSET ?
  `).all(query, query, `${query}%`, ...parameters);
  return rows.map((row) => ({ ...rowToSymbol(row), score: row.score }));
}

function resolveSymbolRow(db, repository, target, filePath = null) {
  const parameters = [repository.id, target, target];
  let fileCondition = "";
  if (filePath) {
    fileCondition = " AND f.path LIKE ?";
    parameters.push(`%${filePath.replaceAll("\\", "/")}%`);
  }
  const row = db.prepare(`
    SELECT s.*, f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND (s.qualified_name = ? OR s.name = ?) ${fileCondition}
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.exported DESC, f.path, s.start_line
    LIMIT 1
  `).get(...parameters, target);
  if (!row) throw new Error(`Symbol not found: ${target}`);
  return row;
}

function relatedSymbols(db, repositoryId, symbolId, relation, edgeKinds = ["calls"]) {
  const isCaller = relation === "callers";
  const joinId = isCaller ? "e.source_symbol_id" : "e.target_symbol_id";
  const whereId = isCaller ? "e.target_symbol_id" : "e.source_symbol_id";
  const kinds = [...new Set(edgeKinds)].filter((kind) => ["calls", "dom-selector", "extends", "implements", "interface-extends", "type-reference"].includes(kind));
  if (!kinds.length) return [];
  return db.prepare(`
    SELECT s.*, f.path AS file_path, f.language, e.confidence, e.kind AS edge_kind, e.label AS edge_label
    FROM edges e
    JOIN symbols s ON s.id = ${joinId}
    JOIN files f ON f.id = s.file_id
    WHERE e.repo_id = ? AND e.kind IN (${kinds.map(() => "?").join(",")}) AND ${whereId} = ?
    ORDER BY e.confidence DESC, s.name, f.path
  `).all(repositoryId, ...kinds, symbolId).map((row) => ({
    ...rowToSymbol(row),
    confidence: row.confidence,
    edge_kind: row.edge_kind,
    edge_label: row.edge_label,
  }));
}

export function getSymbolContext(db, { repoId = null, symbol, filePath = null }) {
  if (!symbol?.trim()) throw new Error("symbol is required");
  const repository = resolveRepository(db, repoId);
  const row = resolveSymbolRow(db, repository, symbol, filePath);
  const fileImports = db.prepare(`
    SELECT tf.path AS target_file, e.label AS specifier, e.confidence
    FROM edges e JOIN files tf ON tf.id = e.target_file_id
    WHERE e.repo_id = ? AND e.kind = 'imports' AND e.source_file_id = ?
    ORDER BY tf.path
  `).all(repository.id, row.file_id);
  const governing = db.prepare(`
    SELECT d.*, dl.relationship
    FROM decision_links dl JOIN decisions d ON d.id = dl.decision_id
    WHERE dl.symbol_stable_key = ? AND d.status = 'active'
    ORDER BY d.updated_at DESC
  `).all(row.stable_key).map((decision) => ({
    id: decision.id,
    title: decision.title,
    rationale: decision.rationale,
    relationship: decision.relationship,
    tags: parseJson(decision.tags_json, []),
  }));
  return {
    repo_id: repository.repo_id,
    symbol: rowToSymbol(row),
    callers: relatedSymbols(db, repository.id, row.id, "callers"),
    callees: relatedSymbols(db, repository.id, row.id, "callees"),
    imports: fileImports,
    governing_decisions: governing,
  };
}

export function getSourceWindow(db, { repoId = null, filePath, startLine = 1, endLine = null }) {
  if (!filePath) throw new Error("file_path is required");
  const repository = resolveRepository(db, repoId);
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const absolute = path.resolve(repository.root, normalized);
  const relative = path.relative(repository.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("file_path escapes the repository root");
  const indexedFile = db.prepare("SELECT 1 FROM files WHERE repo_id = ? AND path = ?").get(repository.id, normalized);
  if (!indexedFile) throw new Error(`file_path is not an indexed source file: ${normalized}`);
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  const first = Math.max(1, Number(startLine) || 1);
  const requestedEnd = endLine == null ? first + 119 : Number(endLine);
  const last = Math.min(lines.length, Math.max(first, Math.min(requestedEnd, first + 399)));
  return {
    repo_id: repository.repo_id,
    file_path: normalized,
    start_line: first,
    end_line: last,
    total_lines: lines.length,
    has_more: last < lines.length,
    next_start_line: last < lines.length ? last + 1 : null,
    previous_start_line: first > 1 ? Math.max(1, first - 400) : null,
    content: lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join("\n"),
  };
}

export function getCodeRelationships(db, {
  repoId = null,
  symbol = null,
  filePath = null,
  category = null,
  limit = 200,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const conditions = ["r.repo_id = ?"];
  const parameters = [repository.id];
  let resolvedSymbol = null;
  if (symbol?.trim()) {
    resolvedSymbol = resolveSymbolRow(db, repository, symbol, filePath);
    conditions.push("(r.source_stable_key = ? OR r.source_name = ? OR r.target_name = ?)");
    parameters.push(resolvedSymbol.stable_key, resolvedSymbol.qualified_name, resolvedSymbol.name);
  } else if (filePath?.trim()) {
    conditions.push("f.path LIKE ?");
    parameters.push(`%${filePath.replaceAll("\\", "/")}%`);
  }
  if (category?.trim()) {
    conditions.push("r.category = ?");
    parameters.push(category);
  }
  parameters.push(cappedLimit);
  const rows = db.prepare(`
    SELECT r.*, f.path AS file_path
    FROM code_relationships r JOIN files f ON f.id = r.file_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY f.path, r.start_line, r.category, r.kind, r.id
    LIMIT ?
  `).all(...parameters).map((row) => ({
    id: row.id,
    category: row.category,
    kind: row.kind,
    source_stable_key: row.source_stable_key,
    source_name: row.source_name,
    target_name: row.target_name,
    specifier: row.specifier,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    confidence: row.confidence,
    details: parseJson(row.details_json, {}),
  }));
  return {
    repo_id: repository.repo_id,
    symbol: resolvedSymbol ? rowToSymbol(resolvedSymbol) : null,
    category,
    results: rows,
    truncated: rows.length === cappedLimit,
  };
}

export function getImpact(db, { repoId = null, target, filePath = null, direction = "upstream", depth = 5, edgeKinds = ["calls", "dom-selector"] }) {
  if (!target?.trim()) throw new Error("target is required");
  if (!["upstream", "downstream", "both"].includes(direction)) throw new Error("direction must be upstream, downstream, or both");
  const repository = resolveRepository(db, repoId);
  const start = resolveSymbolRow(db, repository, target, filePath);
  const maxDepth = Math.max(1, Math.min(Number(depth) || 5, 15));
  const traversedKinds = Array.isArray(edgeKinds) && edgeKinds.length ? edgeKinds : ["calls", "dom-selector"];
  const visited = new Set([start.id]);
  let frontier = [{ id: start.id, path: [start.qualified_name] }];
  const affected = [];
  for (let currentDepth = 1; currentDepth <= maxDepth && frontier.length; currentDepth += 1) {
    const next = [];
    for (const current of frontier) {
      const directions = direction === "both" ? ["callers", "callees"] : [direction === "upstream" ? "callers" : "callees"];
      for (const relation of directions) {
        for (const row of relatedSymbols(db, repository.id, current.id, relation, traversedKinds)) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          const pathValue = [...current.path, row.qualified_name];
          affected.push({ ...row, depth: currentDepth, relation, path: pathValue });
          next.push({ id: row.id, path: pathValue });
        }
      }
    }
    frontier = next;
  }
  const fileCount = new Set(affected.map((item) => item.file_path)).size;
  const risk = affected.length >= 40 || fileCount >= 15
    ? "critical"
    : affected.length >= 15 || fileCount >= 7
      ? "high"
      : affected.length >= 5 || fileCount >= 3
        ? "medium"
        : "low";
  return {
    repo_id: repository.repo_id,
    target: rowToSymbol(start),
    direction,
    max_depth: maxDepth,
    edge_kinds: traversedKinds,
    risk,
    affected_symbols: affected.length,
    affected_files: fileCount,
    results: affected,
  };
}

export function getChangesSince(db, { repoId = null, since, limit = 100 }) {
  if (since == null) throw new Error("since is required (ISO timestamp or episode id)");
  const repository = resolveRepository(db, repoId);
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const numeric = typeof since === "number" || /^\d+$/.test(String(since));
  const rows = db.prepare(`
    SELECT * FROM episodes
    WHERE repo_id = ? AND ${numeric ? "id > ?" : "reference_time > ?"}
    ORDER BY reference_time, id
    LIMIT ?
  `).all(repository.id, numeric ? Number(since) : String(since), cappedLimit);
  return {
    repo_id: repository.repo_id,
    episodes: rows.map((episode) => ({
      id: episode.id,
      type: episode.type,
      reference_time: episode.reference_time,
      source_id: episode.source_id,
      summary: parseJson(episode.summary_json, {}),
      changes: db.prepare("SELECT change_type, entity_type, stable_key, detail_json FROM episode_changes WHERE episode_id = ? ORDER BY id").all(episode.id).map((change) => ({
        change_type: change.change_type,
        entity_type: change.entity_type,
        stable_key: change.stable_key,
        detail: parseJson(change.detail_json, {}),
      })),
    })),
    next_since: rows.at(-1)?.id ?? since,
  };
}

export function getTimeline(db, { repoId = null, symbol, filePath = null, limit = 100 }) {
  const repository = resolveRepository(db, repoId);
  const current = resolveSymbolRow(db, repository, symbol, filePath);
  const events = db.prepare(`
    SELECT ep.id AS episode_id, ep.type, ep.reference_time, ep.source_id,
      ec.change_type, ec.detail_json
    FROM episode_changes ec JOIN episodes ep ON ep.id = ec.episode_id
    WHERE ep.repo_id = ? AND ec.stable_key = ?
    ORDER BY ep.reference_time, ep.id
    LIMIT ?
  `).all(repository.id, current.stable_key, Math.max(1, Math.min(Number(limit) || 100, 500)));
  return {
    repo_id: repository.repo_id,
    symbol: rowToSymbol(current),
    events: events.map((event) => ({
      episode_id: event.episode_id,
      type: event.type,
      reference_time: event.reference_time,
      source_id: event.source_id,
      change_type: event.change_type,
      detail: parseJson(event.detail_json, {}),
    })),
  };
}

export function recordDecision(db, { repoId = null, title, rationale, alternatives = [], tags = [], symbols = [], status = "active" }) {
  if (!title?.trim() || !rationale?.trim()) throw new Error("title and rationale are required");
  if (!["active", "superseded", "rejected"].includes(status)) throw new Error("status must be active, superseded, or rejected");
  const repository = resolveRepository(db, repoId);
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO decisions(repo_id, title, status, rationale, alternatives_json, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repository.id, title.trim(), status, rationale.trim(), JSON.stringify(alternatives), JSON.stringify(tags), now, now);
    const decisionId = Number(result.lastInsertRowid);
    db.prepare("INSERT INTO decisions_fts(decision_id, repo_row_id, title, rationale, tags) VALUES (?, ?, ?, ?, ?)")
      .run(decisionId, repository.id, title.trim(), rationale.trim(), tags.join(" "));
    const insertLink = db.prepare("INSERT OR IGNORE INTO decision_links(decision_id, symbol_stable_key, relationship) VALUES (?, ?, 'governs')");
    for (const symbolName of symbols) {
      const symbol = resolveSymbolRow(db, repository, symbolName);
      insertLink.run(decisionId, symbol.stable_key);
    }
    db.exec("COMMIT");
    return { ok: true, decision_id: decisionId, repo_id: repository.repo_id, title, status, linked_symbols: symbols };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recallDecisions(db, { repoId = null, query, status = "active", limit = 20 }) {
  if (!query?.trim()) throw new Error("query is required");
  const repository = resolveRepository(db, repoId);
  const match = ftsQuery(query);
  if (!match) return [];
  return db.prepare(`
    SELECT d.*, bm25(decisions_fts) AS score
    FROM decisions_fts JOIN decisions d ON d.id = CAST(decisions_fts.decision_id AS INTEGER)
    WHERE d.repo_id = ? AND decisions_fts MATCH ? AND (? IS NULL OR d.status = ?)
    ORDER BY score, d.updated_at DESC
    LIMIT ?
  `).all(repository.id, match, status, status, Math.max(1, Math.min(Number(limit) || 20, 100))).map((decision) => ({
    id: decision.id,
    title: decision.title,
    status: decision.status,
    rationale: decision.rationale,
    alternatives: parseJson(decision.alternatives_json, []),
    tags: parseJson(decision.tags_json, []),
    created_at: decision.created_at,
    updated_at: decision.updated_at,
    score: decision.score,
    symbols: db.prepare("SELECT symbol_stable_key, relationship FROM decision_links WHERE decision_id = ?").all(decision.id),
  }));
}
