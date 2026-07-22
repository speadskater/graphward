import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getApiTopology, getImpact, resolveRepository } from "./queries.mjs";
import { getCochangeContext } from "./history.mjs";

const ENTRY_FILE_PATTERN = /(^|\/)(?:index|main|app|server|cli|entry)\.[^/]+$/i;

function clamp(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(Number.isFinite(number) ? number : fallback, maximum));
}

function publicSymbol(row) {
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

function resolveSymbol(db, repository, target, filePath = null) {
  if (!String(target ?? "").trim()) throw new Error("symbol is required");
  const parameters = [repository.id, target, target];
  let fileCondition = "";
  if (filePath) {
    fileCondition = " AND f.path LIKE ?";
    parameters.push(`%${String(filePath).replaceAll("\\", "/")}%`);
  }
  const row = db.prepare(`
    SELECT s.*, f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND (s.qualified_name = ? OR s.name = ?) ${fileCondition}
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END,
      s.exported DESC, f.path, s.start_line
    LIMIT 1
  `).get(...parameters, target);
  if (!row) throw new Error(`Symbol not found: ${target}`);
  return row;
}

function loadCallGraph(db, repositoryId, minimumConfidence = 0) {
  const rows = db.prepare(`
    SELECT e.id AS edge_id, e.label, e.confidence,
      ss.id AS source_id, ss.stable_key AS source_stable_key, ss.name AS source_name,
      ss.qualified_name AS source_qualified_name, ss.kind AS source_kind,
      ss.signature AS source_signature, ss.start_line AS source_start_line,
      ss.end_line AS source_end_line, ss.exported AS source_exported,
      sf.path AS source_file_path, sf.language AS source_language,
      ts.id AS target_id, ts.stable_key AS target_stable_key, ts.name AS target_name,
      ts.qualified_name AS target_qualified_name, ts.kind AS target_kind,
      ts.signature AS target_signature, ts.start_line AS target_start_line,
      ts.end_line AS target_end_line, ts.exported AS target_exported,
      tf.path AS target_file_path, tf.language AS target_language
    FROM edges e
    JOIN symbols ss ON ss.id = e.source_symbol_id
    JOIN files sf ON sf.id = ss.file_id
    JOIN symbols ts ON ts.id = e.target_symbol_id
    JOIN files tf ON tf.id = ts.file_id
    WHERE e.repo_id = ? AND e.kind = 'calls' AND e.confidence >= ?
    ORDER BY e.source_symbol_id, e.confidence DESC, ts.qualified_name, tf.path
  `).all(repositoryId, minimumConfidence);
  const symbols = new Map();
  const adjacency = new Map();
  const symbolFrom = (row, prefix) => ({
    id: row[`${prefix}_id`],
    stable_key: row[`${prefix}_stable_key`],
    name: row[`${prefix}_name`],
    qualified_name: row[`${prefix}_qualified_name`],
    kind: row[`${prefix}_kind`],
    signature: row[`${prefix}_signature`],
    start_line: row[`${prefix}_start_line`],
    end_line: row[`${prefix}_end_line`],
    exported: row[`${prefix}_exported`],
    file_path: row[`${prefix}_file_path`],
    language: row[`${prefix}_language`],
  });
  for (const row of rows) {
    const source = symbolFrom(row, "source");
    const target = symbolFrom(row, "target");
    symbols.set(source.id, source);
    symbols.set(target.id, target);
    const edges = adjacency.get(source.id) ?? [];
    edges.push({
      id: row.edge_id,
      source_id: source.id,
      target_id: target.id,
      kind: "calls",
      label: row.label,
      confidence: Number(row.confidence),
    });
    adjacency.set(source.id, edges);
  }
  return { symbols, adjacency };
}

function publicEdge(edge, symbols) {
  const source = symbols.get(edge.source_id);
  const target = symbols.get(edge.target_id);
  return {
    kind: edge.kind,
    label: edge.label,
    confidence: edge.confidence,
    source: source ? {
      qualified_name: source.qualified_name,
      file_path: source.file_path,
      line: source.start_line,
    } : null,
    target: target ? {
      qualified_name: target.qualified_name,
      file_path: target.file_path,
      line: target.start_line,
    } : null,
  };
}

/** Find a shortest resolved call path, preferring the highest-confidence path at equal depth. */
export function findDependencyPath(db, {
  repoId = null,
  source = null,
  from = null,
  target = null,
  to = null,
  sourceFilePath = null,
  targetFilePath = null,
  maxDepth = 12,
  minConfidence = 0,
} = {}) {
  const sourceName = source ?? from;
  const targetName = target ?? to;
  if (!String(sourceName ?? "").trim()) throw new Error("source is required");
  if (!String(targetName ?? "").trim()) throw new Error("target is required");
  const repository = resolveRepository(db, repoId);
  const start = resolveSymbol(db, repository, sourceName, sourceFilePath);
  const goal = resolveSymbol(db, repository, targetName, targetFilePath);
  const boundedDepth = clamp(maxDepth, 12, 1, 50);
  const threshold = clamp(minConfidence, 0, 0, 1);
  const { symbols, adjacency } = loadCallGraph(db, repository.id, threshold);
  symbols.set(start.id, start);
  symbols.set(goal.id, goal);

  if (start.id === goal.id) {
    return {
      repo_id: repository.repo_id,
      found: true,
      source: publicSymbol(start),
      target: publicSymbol(goal),
      hops: 0,
      aggregate_confidence: 1,
      minimum_confidence: 1,
      path: [publicSymbol(start)],
      edges: [],
    };
  }

  const depthById = new Map([[start.id, 0]]);
  const scoreById = new Map([[start.id, 1]]);
  const previous = new Map();
  let frontier = [start.id];
  for (let depth = 1; depth <= boundedDepth && frontier.length; depth += 1) {
    const next = new Set();
    for (const sourceId of frontier) {
      for (const edge of adjacency.get(sourceId) ?? []) {
        const candidateScore = (scoreById.get(sourceId) ?? 1) * edge.confidence;
        const knownDepth = depthById.get(edge.target_id);
        if (knownDepth != null && knownDepth < depth) continue;
        if (knownDepth === depth && candidateScore <= (scoreById.get(edge.target_id) ?? 0)) continue;
        depthById.set(edge.target_id, depth);
        scoreById.set(edge.target_id, candidateScore);
        previous.set(edge.target_id, { previousId: sourceId, edge });
        next.add(edge.target_id);
      }
    }
    frontier = [...next];
    if (depthById.has(goal.id)) break;
  }

  if (!depthById.has(goal.id)) {
    return {
      repo_id: repository.repo_id,
      found: false,
      source: publicSymbol(start),
      target: publicSymbol(goal),
      max_depth: boundedDepth,
      min_confidence: threshold,
      reason: "No resolved call path was found within the configured bounds.",
      path: [],
      edges: [],
    };
  }

  const pathIds = [goal.id];
  const pathEdges = [];
  let cursor = goal.id;
  while (cursor !== start.id) {
    const step = previous.get(cursor);
    if (!step) break;
    pathEdges.push(step.edge);
    pathIds.push(step.previousId);
    cursor = step.previousId;
  }
  pathIds.reverse();
  pathEdges.reverse();
  return {
    repo_id: repository.repo_id,
    found: cursor === start.id,
    source: publicSymbol(start),
    target: publicSymbol(goal),
    hops: pathEdges.length,
    aggregate_confidence: pathEdges.reduce((score, edge) => score * edge.confidence, 1),
    minimum_confidence: pathEdges.reduce((score, edge) => Math.min(score, edge.confidence), 1),
    path: pathIds.map((id) => publicSymbol(symbols.get(id))),
    edges: pathEdges.map((edge) => publicEdge(edge, symbols)),
  };
}

function resolveRouteStart(db, repository, route) {
  const file = db.prepare("SELECT id FROM files WHERE repo_id = ? AND path = ?").get(repository.id, route.file_path);
  const handlerName = String(route.handler_name ?? "").split(".").at(-1)?.trim();
  if (handlerName && file) {
    const importedFileIds = db.prepare(`
      SELECT DISTINCT target_file_id AS id
      FROM edges
      WHERE repo_id = ? AND kind = 'imports' AND source_file_id = ? AND target_file_id IS NOT NULL
    `).all(repository.id, file.id).map((row) => row.id);
    const candidates = db.prepare(`
      SELECT s.*, f.path AS file_path, f.language
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.repo_id = ? AND (s.name = ? OR s.qualified_name = ? OR s.qualified_name LIKE ?)
      ORDER BY s.exported DESC, f.path, s.start_line
    `).all(repository.id, handlerName, route.handler_name, `%.${handlerName}`);
    const imported = new Set(importedFileIds);
    candidates.sort((a, b) => {
      const rank = (row) => row.file_id === file.id ? 0 : imported.has(row.file_id) ? 1 : 2;
      return rank(a) - rank(b) || Number(b.exported) - Number(a.exported) || a.file_path.localeCompare(b.file_path);
    });
    if (candidates[0]) return candidates[0];
  }
  if (route.source?.stable_key) {
    return db.prepare(`
      SELECT s.*, f.path AS file_path, f.language
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.repo_id = ? AND s.stable_key = ?
      LIMIT 1
    `).get(repository.id, route.source.stable_key) ?? null;
  }
  return null;
}

function executionStarts(db, repository, { includeRoutes, includeEntryPoints, routePath, method, maxStarts }) {
  const starts = [];
  if (includeRoutes) {
    const topology = getApiTopology(db, { repoId: repository.repo_id, path: routePath, method, limit: 5000 });
    for (const route of topology.routes) {
      const symbol = resolveRouteStart(db, repository, route);
      if (!symbol) continue;
      starts.push({
        key: `route:${route.method}:${route.path}:${symbol.id}`,
        kind: "api_route",
        symbol,
        evidence: {
          method: route.method,
          path: route.path,
          framework: route.framework,
          confidence: route.confidence,
          file_path: route.file_path,
          line: route.line,
          handler_name: route.handler_name,
        },
      });
    }
  }
  if (includeEntryPoints) {
    const files = db.prepare("SELECT id, path FROM files WHERE repo_id = ? ORDER BY path").all(repository.id)
      .filter((file) => ENTRY_FILE_PATTERN.test(file.path));
    for (const file of files) {
      const rows = db.prepare(`
        SELECT s.*, f.path AS file_path, f.language
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.repo_id = ? AND s.file_id = ?
        ORDER BY CASE
          WHEN lower(s.kind) = 'module' THEN 0
          WHEN lower(s.name) IN ('main', 'bootstrap', 'start', 'run', 'serve') THEN 1
          ELSE 2 END,
          s.exported DESC, s.start_line
      `).all(repository.id, file.id);
      const candidates = rows.filter((row) =>
        String(row.kind).toLowerCase() === "module"
        || /^(?:main|bootstrap|start|run|serve)$/i.test(row.name),
      );
      for (const symbol of (candidates.length ? candidates : rows.slice(0, 1))) {
        starts.push({
          key: `entry:${symbol.id}`,
          kind: "entry_point",
          symbol,
          evidence: { file_path: file.path, line: symbol.start_line },
        });
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const start of starts) {
    if (seen.has(start.key)) continue;
    seen.add(start.key);
    unique.push(start);
    if (unique.length >= maxStarts) break;
  }
  return { starts: unique, total: starts.length };
}

/** Infer bounded call flows from statically indexed HTTP routes and conventional entry-point files. */
export function inferExecutionFlows(db, {
  repoId = null,
  includeRoutes = true,
  includeEntryPoints = true,
  routePath = null,
  method = null,
  maxDepth = 6,
  maxResults = 100,
  maxStarts = 50,
  maxBranching = 8,
  minConfidence = 0.5,
} = {}) {
  if (!includeRoutes && !includeEntryPoints) throw new Error("At least one start type must be enabled");
  const repository = resolveRepository(db, repoId);
  const boundedDepth = clamp(maxDepth, 6, 1, 20);
  const resultLimit = clamp(maxResults, 100, 1, 1000);
  const startLimit = clamp(maxStarts, 50, 1, 500);
  const branchLimit = clamp(maxBranching, 8, 1, 50);
  const threshold = clamp(minConfidence, 0.5, 0, 1);
  const { symbols, adjacency } = loadCallGraph(db, repository.id, threshold);
  const { starts, total: totalStarts } = executionStarts(db, repository, {
    includeRoutes, includeEntryPoints, routePath, method, maxStarts: startLimit,
  });
  for (const start of starts) symbols.set(start.symbol.id, start.symbol);
  const flows = [];
  let bounded = false;

  const emit = (start, ids, edges, terminalReason) => {
    flows.push({
      start: { kind: start.kind, evidence: start.evidence },
      terminal_reason: terminalReason,
      depth: edges.length,
      aggregate_confidence: edges.reduce((score, edge) => score * edge.confidence, 1),
      minimum_confidence: edges.reduce((score, edge) => Math.min(score, edge.confidence), 1),
      path: ids.map((id) => publicSymbol(symbols.get(id))),
      edges: edges.map((edge) => publicEdge(edge, symbols)),
    });
  };

  for (const start of starts) {
    if (flows.length >= resultLimit) break;
    const stack = [{ currentId: start.symbol.id, ids: [start.symbol.id], edges: [] }];
    while (stack.length && flows.length < resultLimit) {
      const current = stack.pop();
      if (current.edges.length >= boundedDepth) {
        bounded = true;
        emit(start, current.ids, current.edges, "depth_bound");
        continue;
      }
      const candidates = (adjacency.get(current.currentId) ?? [])
        .filter((edge) => !current.ids.includes(edge.target_id))
        .slice(0, branchLimit);
      if (!candidates.length) {
        const hadCycle = (adjacency.get(current.currentId) ?? []).some((edge) => current.ids.includes(edge.target_id));
        emit(start, current.ids, current.edges, hadCycle ? "cycle_guard" : "leaf");
        continue;
      }
      if ((adjacency.get(current.currentId) ?? []).length > branchLimit) bounded = true;
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const edge = candidates[index];
        stack.push({
          currentId: edge.target_id,
          ids: [...current.ids, edge.target_id],
          edges: [...current.edges, edge],
        });
      }
    }
  }
  if (flows.length >= resultLimit || totalStarts > starts.length) bounded = true;
  return {
    repo_id: repository.repo_id,
    starts: starts.map((start) => ({
      kind: start.kind,
      symbol: publicSymbol(start.symbol),
      evidence: start.evidence,
    })),
    start_count: starts.length,
    flow_count: flows.length,
    flows,
    bounds: {
      max_depth: boundedDepth,
      max_results: resultLimit,
      max_starts: startLimit,
      max_branching: branchLimit,
      min_confidence: threshold,
    },
    truncated: bounded,
    methodology: "Starts are inferred from indexed API routes and conventional entry-point files; flows follow resolved call edges only and stop at leaves, cycles, or configured bounds.",
  };
}

function decodeGitPath(value) {
  let candidate = String(value ?? "").trim().split("\t")[0];
  if (candidate === "/dev/null") return null;
  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    const body = candidate.slice(1, -1).replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    try {
      candidate = JSON.parse(`"${body}"`);
    } catch {
      candidate = body.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
  }
  candidate = candidate.replaceAll("\\", "/");
  if (/^[ab]\//.test(candidate)) candidate = candidate.slice(2);
  candidate = candidate.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!candidate || candidate === ".." || candidate.startsWith("../") || /\/[.][.]\//.test(`/${candidate}/`)) return null;
  return candidate;
}

function mergeChangedRanges(changes) {
  const byFile = new Map();
  for (const change of changes) {
    const filePath = decodeGitPath(change.file_path ?? change.filePath ?? change.path);
    if (!filePath) continue;
    const values = byFile.get(filePath) ?? [];
    const start = change.start_line ?? change.startLine ?? change.line ?? null;
    const end = change.end_line ?? change.endLine ?? change.line ?? start;
    values.push({
      file_path: filePath,
      start_line: start == null ? null : Math.max(1, Number(start) || 1),
      end_line: end == null ? null : Math.max(1, Number(end) || Number(start) || 1),
      source: change.source ?? "provided",
    });
    byFile.set(filePath, values);
  }
  const merged = [];
  for (const [filePath, ranges] of byFile) {
    if (ranges.some((range) => range.start_line == null)) {
      merged.push({ file_path: filePath, start_line: null, end_line: null, source: [...new Set(ranges.map((range) => range.source))].join("+") });
      continue;
    }
    ranges.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous?.file_path === filePath && range.start_line <= previous.end_line + 1) {
        previous.end_line = Math.max(previous.end_line, range.end_line);
        previous.source = [...new Set(`${previous.source}+${range.source}`.split("+"))].join("+");
      } else {
        merged.push({ ...range });
      }
    }
  }
  return merged;
}

/** Parse the changed new-side ranges in a Git-style unified diff. */
export function parseUnifiedDiff(diff) {
  if (!String(diff ?? "").trim()) return [];
  const changes = [];
  let oldPath = null;
  let currentPath = null;
  let fileHadHunk = false;
  let oldLine = null;
  let newLine = null;
  const finishFile = () => {
    if (currentPath && !fileHadHunk) changes.push({ file_path: currentPath, start_line: null, end_line: null, source: "diff" });
  };
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      oldPath = null;
      currentPath = null;
      fileHadHunk = false;
      oldLine = null;
      newLine = null;
    } else if (newLine == null && line.startsWith("--- ")) {
      oldPath = decodeGitPath(line.slice(4));
    } else if (newLine == null && line.startsWith("+++ ")) {
      currentPath = decodeGitPath(line.slice(4)) ?? oldPath;
    } else if (line.startsWith("@@ ") && currentPath) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) continue;
      oldLine = Math.max(1, Number(match[1]) || 1);
      newLine = Math.max(1, Number(match[2]) || 1);
      fileHadHunk = true;
    } else if (newLine != null && line.startsWith("+") && !line.startsWith("+++")) {
      changes.push({ file_path: currentPath, start_line: newLine, end_line: newLine, source: "diff" });
      newLine += 1;
    } else if (newLine != null && line.startsWith("-") && !line.startsWith("---")) {
      changes.push({ file_path: currentPath, start_line: newLine, end_line: newLine, source: "diff" });
      oldLine += 1;
    } else if (newLine != null && line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  finishFile();
  return mergeChangedRanges(changes);
}

function currentWorkingTreeChanges(root) {
  const diffResult = spawnSync("git", ["-c", `safe.directory=${root}`, "diff", "--no-ext-diff", "--no-color", "--unified=0", "HEAD", "--"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const diff = diffResult.status === 0 ? diffResult.stdout : "";
  const untrackedResult = spawnSync("git", ["-c", `safe.directory=${root}`, "ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const untracked = [];
  if (untrackedResult.status === 0) {
    for (const rawPath of untrackedResult.stdout.split("\0").filter(Boolean)) {
      const filePath = decodeGitPath(rawPath);
      if (!filePath) continue;
      const absolute = path.resolve(root, filePath);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      try {
        const lineCount = readFileSync(absolute, "utf8").split(/\r?\n/).length;
        untracked.push({ file_path: filePath, start_line: 1, end_line: Math.max(1, lineCount), source: "working_tree_untracked" });
      } catch {
        untracked.push({ file_path: filePath, start_line: null, end_line: null, source: "working_tree_untracked" });
      }
    }
  }
  return { diff, untracked };
}

function normalizeProvidedChanges(changes) {
  const normalized = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    if (Array.isArray(change?.ranges)) {
      for (const range of change.ranges) normalized.push({ ...change, ...range, ranges: undefined });
    } else if (Array.isArray(change?.lines)) {
      for (const line of change.lines) normalized.push({ ...change, line, lines: undefined });
    } else {
      normalized.push(change ?? {});
    }
  }
  return normalized;
}

function mappedSymbolsForChanges(db, repository, changedRanges) {
  const mapped = new Map();
  const unmapped = [];
  for (const range of changedRanges) {
    const indexedFile = db.prepare("SELECT id FROM files WHERE repo_id = ? AND path = ?").get(repository.id, range.file_path);
    if (!indexedFile) {
      unmapped.push({ ...range, reason: "file_not_indexed" });
      continue;
    }
    const rows = range.start_line == null
      ? db.prepare(`
          SELECT s.*, f.path AS file_path, f.language
          FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.repo_id = ? AND s.file_id = ?
          ORDER BY s.start_line, s.end_line - s.start_line, s.qualified_name
        `).all(repository.id, indexedFile.id)
      : db.prepare(`
          SELECT s.*, f.path AS file_path, f.language
          FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.repo_id = ? AND s.file_id = ? AND s.start_line <= ? AND s.end_line >= ?
          ORDER BY s.end_line - s.start_line, s.start_line, s.qualified_name
        `).all(repository.id, indexedFile.id, range.end_line, range.start_line);
    const mostSpecific = range.start_line == null
      ? rows
      : rows.filter((row) => !rows.some((other) =>
        other.id !== row.id
        && other.start_line >= row.start_line
        && other.end_line <= row.end_line
        && (other.start_line > row.start_line || other.end_line < row.end_line),
      ));
    if (!mostSpecific.length) {
      unmapped.push({ ...range, reason: "no_symbol_at_changed_lines" });
      continue;
    }
    for (const row of mostSpecific) {
      const current = mapped.get(row.id) ?? { ...publicSymbol(row), changed_ranges: [] };
      current.changed_ranges.push(range);
      mapped.set(row.id, current);
    }
  }
  return { symbols: [...mapped.values()], unmapped };
}

function aggregateRisk({ changedSymbols, changedFiles, affectedSymbols, affectedFiles, strongPartners, unmapped, decisions }) {
  const levels = ["low", "medium", "high", "critical"];
  let level = affectedSymbols >= 40 || affectedFiles >= 15
    ? 3
    : affectedSymbols >= 15 || affectedFiles >= 7
      ? 2
      : affectedSymbols >= 5 || affectedFiles >= 3
        ? 1
        : 0;
  const factors = [];
  if (affectedSymbols) factors.push(`${affectedSymbols} upstream symbols in the bounded blast radius`);
  if (affectedFiles) factors.push(`${affectedFiles} files contain affected symbols`);
  if (changedSymbols >= 10 || changedFiles >= 5) {
    level = Math.max(level, 2);
    factors.push(`broad edit maps to ${changedSymbols} symbols across ${changedFiles} files`);
  }
  if (strongPartners >= 3) {
    level = Math.min(3, Math.max(1, level + 1));
    factors.push(`${strongPartners} strong historical co-change partners`);
  } else if (strongPartners) {
    level = Math.max(level, 1);
    factors.push(`${strongPartners} strong historical co-change partner${strongPartners === 1 ? "" : "s"}`);
  }
  if (unmapped) {
    level = Math.max(level, 1);
    factors.push(`${unmapped} changed range${unmapped === 1 ? "" : "s"} could not be mapped to indexed symbols`);
  }
  if (decisions) {
    level = Math.max(level, 1);
    factors.push(`${decisions} active architectural decision${decisions === 1 ? "" : "s"} govern changed symbols`);
  }
  if (!factors.length) factors.push("No resolved callers or strong historical coupling were found within the configured bounds");
  return { risk: levels[level], factors };
}

/** Map a supplied diff/change set to symbols, static blast radius, historical coupling, and checks. */
export function changePreflight(db, {
  repoId = null,
  diff = null,
  changes = [],
  impactDepth = 5,
  maxChangedSymbols = 100,
  maxVerificationTargets = 40,
  includeCochange = true,
  cochangeSince = "1 year ago",
  maxCommits = 10000,
  maxFilesPerCommit = 20,
  minCochanges = 2,
  cochangeLimit = 20,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const workingTree = diff == null ? currentWorkingTreeChanges(repository.root) : { diff: "", untracked: [] };
  const effectiveDiff = diff == null ? workingTree.diff : diff;
  const diffRanges = parseUnifiedDiff(effectiveDiff);
  const exactDiffFiles = new Set(diffRanges.map((range) => range.file_path));
  const providedChanges = normalizeProvidedChanges(changes)
    .map((change) => ({ ...change, source: change.source ?? "provided" }))
    .filter((change) => (change.start_line ?? change.startLine ?? change.line) != null || !exactDiffFiles.has(decodeGitPath(change.file_path ?? change.filePath ?? change.path)));
  const changedRanges = mergeChangedRanges([
    ...diffRanges,
    ...workingTree.untracked,
    ...providedChanges,
  ]);
  if (!changedRanges.length) throw new Error("No working-tree diff or explicit changed ranges were found");
  const { symbols: allChangedSymbols, unmapped } = mappedSymbolsForChanges(db, repository, changedRanges);
  const symbolLimit = clamp(maxChangedSymbols, 100, 1, 1000);
  const changedSymbols = allChangedSymbols.slice(0, symbolLimit);
  const impactMap = new Map();
  const impactErrors = [];
  for (const symbol of changedSymbols) {
    try {
      const impact = getImpact(db, {
        repoId: repository.repo_id,
        target: symbol.qualified_name,
        filePath: symbol.file_path,
        direction: "upstream",
        depth: clamp(impactDepth, 5, 1, 15),
      });
      for (const result of impact.results) {
        const current = impactMap.get(result.id);
        const evidence = {
          changed_symbol: symbol.qualified_name,
          changed_file: symbol.file_path,
          depth: result.depth,
          path: result.path,
        };
        if (!current || result.depth < current.depth) {
          impactMap.set(result.id, { ...result, evidence: [evidence] });
        } else if (current.evidence.length < 5) {
          current.evidence.push(evidence);
        }
      }
    } catch (error) {
      impactErrors.push({ symbol: symbol.qualified_name, file_path: symbol.file_path, error: error.message });
    }
  }
  for (const symbol of changedSymbols) impactMap.delete(symbol.id);
  const affected = [...impactMap.values()].sort((a, b) => a.depth - b.depth || a.file_path.localeCompare(b.file_path) || a.qualified_name.localeCompare(b.qualified_name));

  const changedFiles = [...new Set(changedRanges.map((range) => range.file_path))];
  const indexedChangedFiles = changedFiles.filter((filePath) =>
    db.prepare("SELECT 1 FROM files WHERE repo_id = ? AND path = ?").get(repository.id, filePath),
  );
  const cochangeByFile = [];
  const cochangeErrors = [];
  if (includeCochange) {
    for (const filePath of indexedChangedFiles) {
      try {
        cochangeByFile.push(getCochangeContext(db, {
          repoId: repository.repo_id,
          target: filePath,
          since: String(cochangeSince),
          maxCommits: clamp(maxCommits, 10000, 1, 50000),
          maxFilesPerCommit: clamp(maxFilesPerCommit, 20, 2, 200),
          minCochanges: clamp(minCochanges, 2, 1, 100),
          limit: clamp(cochangeLimit, 20, 1, 200),
        }));
      } catch (error) {
        cochangeErrors.push({ file_path: filePath, error: error.message });
      }
    }
  }
  const partnerMap = new Map();
  for (const context of cochangeByFile) {
    for (const result of context.results) {
      if (changedFiles.includes(result.file_path)) continue;
      const current = partnerMap.get(result.file_path) ?? { ...result, target_files: [] };
      current.cochanges = Math.max(current.cochanges, result.cochanges);
      current.coupling = Math.max(current.coupling, result.coupling);
      current.jaccard = Math.max(current.jaccard, result.jaccard);
      current.target_files.push(context.target_file);
      partnerMap.set(result.file_path, current);
    }
  }
  const partners = [...partnerMap.values()].sort((a, b) => b.coupling - a.coupling || b.cochanges - a.cochanges || a.file_path.localeCompare(b.file_path));

  const decisions = changedSymbols.length
    ? db.prepare(`
        SELECT DISTINCT d.id, d.title, d.rationale, d.status, dl.symbol_stable_key, dl.relationship
        FROM decisions d JOIN decision_links dl ON dl.decision_id = d.id
        WHERE d.repo_id = ? AND d.status = 'active'
          AND dl.symbol_stable_key IN (${changedSymbols.map(() => "?").join(",")})
        ORDER BY d.updated_at DESC, d.id DESC
      `).all(repository.id, ...changedSymbols.map((symbol) => symbol.stable_key))
    : [];
  const affectedFiles = new Set(affected.map((item) => item.file_path)).size;
  const strongPartners = partners.filter((partner) => partner.coupling >= 0.5 && partner.cochanges >= 2).length;
  const verdict = aggregateRisk({
    changedSymbols: changedSymbols.length,
    changedFiles: changedFiles.length,
    affectedSymbols: affected.length,
    affectedFiles,
    strongPartners,
    unmapped: unmapped.length,
    decisions: decisions.length,
  });

  const verificationLimit = clamp(maxVerificationTargets, 40, 1, 200);
  const verificationTargets = [];
  for (const symbol of changedSymbols) {
    verificationTargets.push({
      type: "changed_symbol",
      symbol: symbol.qualified_name,
      file_path: symbol.file_path,
      line: symbol.start_line,
      reason: "Exercise the directly changed symbol with focused tests.",
    });
  }
  for (const result of affected.filter((item) => item.depth <= 2)) {
    verificationTargets.push({
      type: "affected_caller",
      symbol: result.qualified_name,
      file_path: result.file_path,
      line: result.start_line,
      depth: result.depth,
      reason: `Verify a resolved caller at impact depth ${result.depth}.`,
    });
  }
  for (const partner of partners) {
    verificationTargets.push({
      type: "cochange_file",
      file_path: partner.file_path,
      coupling: partner.coupling,
      cochanges: partner.cochanges,
      reason: "Review this historically coupled file even if the static graph does not connect it.",
    });
  }
  for (const decision of decisions) {
    verificationTargets.push({
      type: "governing_decision",
      decision_id: decision.id,
      title: decision.title,
      reason: "Confirm the change still satisfies this active recorded decision.",
    });
  }
  const deduplicatedTargets = [];
  const targetKeys = new Set();
  for (const targetItem of verificationTargets) {
    const key = `${targetItem.type}:${targetItem.symbol ?? targetItem.file_path ?? targetItem.decision_id}`;
    if (targetKeys.has(key)) continue;
    targetKeys.add(key);
    deduplicatedTargets.push(targetItem);
    if (deduplicatedTargets.length >= verificationLimit) break;
  }

  return {
    repo_id: repository.repo_id,
    risk: verdict.risk,
    risk_factors: verdict.factors,
    input: {
      source: diff == null ? "working_tree" : "provided_diff",
      changed_ranges: changedRanges,
      changed_files: changedFiles.length,
      symbol_mapping_truncated: allChangedSymbols.length > changedSymbols.length,
    },
    changed_symbols: changedSymbols,
    unmapped_changes: unmapped,
    blast_radius: {
      direction: "upstream",
      max_depth: clamp(impactDepth, 5, 1, 15),
      affected_symbols: affected.length,
      affected_files: affectedFiles,
      results: affected,
      errors: impactErrors,
    },
    cochange: {
      enabled: Boolean(includeCochange),
      files_analyzed: cochangeByFile.length,
      partners,
      errors: cochangeErrors,
    },
    governing_decisions: decisions,
    verification_targets: deduplicatedTargets,
    methodology: "Changed lines are mapped to the most-specific indexed symbols. Risk combines bounded upstream call impact, edit breadth, active decisions, unmapped ranges, and file-level Git co-change evidence.",
  };
}
