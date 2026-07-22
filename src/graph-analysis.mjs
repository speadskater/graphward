import { resolveRepository } from "./queries.mjs";

function rowToSymbol(row) {
  return {
    id: row.id,
    stable_key: row.stable_key,
    name: row.name,
    qualified_name: row.qualified_name,
    kind: row.kind,
    signature: row.signature,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    exported: Boolean(row.exported),
  };
}

function graphRows(db, repository) {
  const symbols = db.prepare(`
    SELECT s.*, f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ?
    ORDER BY s.id
  `).all(repository.id);
  const edges = db.prepare(`
    SELECT source_symbol_id AS source, target_symbol_id AS target, confidence
    FROM edges
    WHERE repo_id = ? AND kind = 'calls'
      AND source_symbol_id IS NOT NULL AND target_symbol_id IS NOT NULL
  `).all(repository.id);
  return { symbols, edges };
}

function pageRank(symbols, edges, focus = null, iterations = 24, damping = 0.85) {
  if (!symbols.length) return new Map();
  const ids = new Set(symbols.map((symbol) => symbol.id));
  const outgoing = new Map(symbols.map((symbol) => [symbol.id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    outgoing.get(edge.source).push({ target: edge.target, weight: Math.max(0.1, Number(edge.confidence) || 1) });
  }

  const terms = String(focus ?? "").toLowerCase().match(/[a-z0-9_$.-]+/g) ?? [];
  const personal = new Map();
  let personalTotal = 0;
  for (const symbol of symbols) {
    const haystack = `${symbol.name} ${symbol.qualified_name} ${symbol.signature} ${symbol.file_path}`.toLowerCase();
    let weight = 1;
    for (const term of terms) {
      if (symbol.name.toLowerCase() === term || symbol.qualified_name.toLowerCase() === term) weight += 30;
      else if (haystack.includes(term)) weight += 8;
    }
    if (symbol.exported) weight += 0.5;
    personal.set(symbol.id, weight);
    personalTotal += weight;
  }
  for (const id of personal.keys()) personal.set(id, personal.get(id) / personalTotal);

  let ranks = new Map(symbols.map((symbol) => [symbol.id, personal.get(symbol.id)]));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map(symbols.map((symbol) => [symbol.id, (1 - damping) * personal.get(symbol.id)]));
    let dangling = 0;
    for (const symbol of symbols) {
      const links = outgoing.get(symbol.id);
      if (!links.length) {
        dangling += ranks.get(symbol.id);
        continue;
      }
      const totalWeight = links.reduce((sum, link) => sum + link.weight, 0);
      for (const link of links) {
        next.set(link.target, next.get(link.target) + damping * ranks.get(symbol.id) * link.weight / totalWeight);
      }
    }
    if (dangling) {
      for (const symbol of symbols) {
        next.set(symbol.id, next.get(symbol.id) + damping * dangling * personal.get(symbol.id));
      }
    }
    ranks = next;
  }
  return ranks;
}

function topDirectory(filePath) {
  const parts = filePath.split("/");
  if (parts.length <= 1) return ".";
  return parts.length >= 3 ? parts.slice(0, 2).join("/") : parts[0];
}

function presentationScore(symbol, rank, focus = null) {
  let multiplier = 1;
  const testLike = /(^|\/)(?:__tests__|test|tests|e2e|fixtures?)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(symbol.file_path);
  if (testLike && !/\b(?:test|tests|testing|spec|e2e)\b/i.test(String(focus ?? ""))) multiplier *= 0.15;
  if (symbol.name.length <= 2) multiplier *= 0.2;
  if (symbol.name.startsWith("_")) multiplier *= 0.6;
  if (symbol.kind === "Module") multiplier *= 0.5;
  if (symbol.exported) multiplier *= 1.2;
  return rank * multiplier;
}

function isTestPath(filePath) {
  return /(^|\/)(?:__tests__|test|tests|e2e|fixtures?|specs?)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(filePath);
}

function directoryPrefixes(filePath) {
  const parts = String(filePath ?? "").split("/").filter(Boolean);
  const directories = parts.slice(0, -1);
  return directories.map((_, index) => directories.slice(0, index + 1).join("/"));
}

function clusterFiles(files, splitThreshold = 420) {
  const prefixCounts = new Map();
  for (const file of files) {
    for (const prefix of directoryPrefixes(file.path)) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }
  const byFile = new Map();
  for (const file of files) {
    const prefixes = directoryPrefixes(file.path);
    if (!prefixes.length) {
      byFile.set(file.id, ".");
      continue;
    }
    let index = Math.min(1, prefixes.length - 1);
    const maximumIndex = Math.min(prefixes.length - 1, 2);
    while (index < maximumIndex && (prefixCounts.get(prefixes[index]) ?? 0) > splitThreshold) index += 1;
    byFile.set(file.id, prefixes[index]);
  }
  return byFile;
}

function selectGraphNodes(nodes, maximum) {
  if (nodes.length <= maximum) return nodes;
  const buckets = new Map();
  for (const node of nodes) {
    const bucket = buckets.get(node.cluster_id) ?? [];
    bucket.push(node);
    buckets.set(node.cluster_id, bucket);
  }
  const orderedBuckets = [...buckets.entries()]
    .map(([clusterId, rows]) => ({ clusterId, rows: rows.sort((a, b) => b.score - a.score || a.id - b.id), cursor: 0 }))
    .sort((a, b) => b.rows.length - a.rows.length || a.clusterId.localeCompare(b.clusterId));
  const selected = [];
  const selectedIds = new Set();
  let reserve = Math.min(maximum, Math.max(orderedBuckets.length, Math.floor(maximum * 0.22)));
  while (reserve > 0) {
    let progressed = false;
    for (const bucket of orderedBuckets) {
      if (reserve <= 0 || bucket.cursor >= bucket.rows.length) continue;
      const node = bucket.rows[bucket.cursor++];
      selected.push(node);
      selectedIds.add(node.id);
      reserve -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  const remaining = nodes
    .filter((node) => !selectedIds.has(node.id))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  selected.push(...remaining.slice(0, maximum - selected.length));
  return selected.sort((a, b) => a.id - b.id);
}

export function getCodeGraph(db, {
  repoId = null,
  focus = null,
  maxNodes = 8_000,
  maxEdges = 24_000,
  includeTests = true,
  edgeKinds = ["calls", "imports"],
} = {}) {
  const repository = resolveRepository(db, repoId);
  const files = db.prepare("SELECT id, path, language FROM files WHERE repo_id = ? ORDER BY path").all(repository.id);
  const symbols = db.prepare(`
    SELECT s.*, f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ?
    ORDER BY s.id
  `).all(repository.id);
  const allowedKinds = new Set((Array.isArray(edgeKinds) && edgeKinds.length ? edgeKinds : ["calls", "imports"])
    .filter((kind) => kind === "calls" || kind === "imports"));
  const representativeByFile = new Map();
  for (const symbol of symbols) {
    if (!representativeByFile.has(symbol.file_id) || symbol.kind === "Module") representativeByFile.set(symbol.file_id, symbol.id);
  }
  const rawEdges = db.prepare(`
    SELECT id, source_symbol_id, target_symbol_id, source_file_id, target_file_id, kind, label, confidence
    FROM edges
    WHERE repo_id = ? AND kind IN ('calls', 'imports')
    ORDER BY id
  `).all(repository.id).filter((edge) => allowedKinds.has(edge.kind));
  const allEdges = rawEdges.map((edge) => ({
    id: edge.id,
    source: edge.source_symbol_id ?? representativeByFile.get(edge.source_file_id),
    target: edge.target_symbol_id ?? representativeByFile.get(edge.target_file_id),
    kind: edge.kind,
    label: edge.label,
    confidence: edge.confidence,
  })).filter((edge) => edge.source != null && edge.target != null);
  const callEdges = allEdges.filter((edge) => edge.kind === "calls");
  const ranks = pageRank(symbols, callEdges, focus);
  const degrees = new Map(symbols.map((symbol) => [symbol.id, { incoming: 0, outgoing: 0 }]));
  for (const edge of allEdges) {
    if (degrees.has(edge.source)) degrees.get(edge.source).outgoing += 1;
    if (degrees.has(edge.target)) degrees.get(edge.target).incoming += 1;
  }
  const fileClusters = clusterFiles(files);
  const eligible = symbols
    .filter((symbol) => includeTests || !isTestPath(symbol.file_path))
    .map((symbol) => {
      const degree = degrees.get(symbol.id) ?? { incoming: 0, outgoing: 0 };
      const rank = ranks.get(symbol.id) ?? 0;
      return {
        ...rowToSymbol(symbol),
        language: symbol.language,
        cluster_id: fileClusters.get(symbol.file_id) ?? ".",
        test: isTestPath(symbol.file_path),
        pagerank: rank,
        score: presentationScore(symbol, rank, focus) * (1 + Math.log1p(degree.incoming + degree.outgoing)),
        incoming: degree.incoming,
        outgoing: degree.outgoing,
      };
    });
  const nodeLimit = Math.max(50, Math.min(Number(maxNodes) || 8_000, 12_000));
  const edgeLimit = Math.max(100, Math.min(Number(maxEdges) || 24_000, 40_000));
  const nodes = selectGraphNodes(eligible, nodeLimit);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeScores = new Map(nodes.map((node) => [node.id, node.score]));
  const candidateEdges = allEdges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      label: edge.label,
      confidence: Number(edge.confidence) || 0,
      score: (Number(edge.confidence) || 0) * (1 + (nodeScores.get(edge.source) ?? 0) + (nodeScores.get(edge.target) ?? 0)),
    }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  const edges = candidateEdges.slice(0, edgeLimit).sort((a, b) => a.id - b.id).map(({ score: _score, ...edge }) => edge);

  const fileClusterByPath = new Map(files.map((file) => [file.path, fileClusters.get(file.id) ?? "."]));
  const clusters = new Map();
  for (const symbol of eligible) {
    const clusterId = fileClusterByPath.get(symbol.file_path) ?? ".";
    const cluster = clusters.get(clusterId) ?? {
      id: clusterId,
      path: clusterId,
      name: clusterId === "." ? "(root)" : clusterId.split("/").at(-1),
      node_count: 0,
      shown_node_count: 0,
      files: new Set(),
      languages: new Map(),
      tests: true,
    };
    cluster.node_count += 1;
    cluster.files.add(symbol.file_path);
    cluster.languages.set(symbol.language, (cluster.languages.get(symbol.language) ?? 0) + 1);
    cluster.tests = cluster.tests && isTestPath(symbol.file_path);
    clusters.set(clusterId, cluster);
  }
  for (const node of nodes) clusters.get(node.cluster_id).shown_node_count += 1;
  const nameCounts = new Map();
  for (const cluster of clusters.values()) nameCounts.set(cluster.name, (nameCounts.get(cluster.name) ?? 0) + 1);
  const clusterRows = [...clusters.values()]
    .map((cluster) => ({
      id: cluster.id,
      path: cluster.path,
      name: nameCounts.get(cluster.name) > 1 && cluster.path !== "." ? cluster.path : cluster.name,
      node_count: cluster.node_count,
      shown_node_count: cluster.shown_node_count,
      file_count: cluster.files.size,
      languages: [...cluster.languages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([language, count]) => ({ language, count })),
      tests: cluster.tests,
    }))
    .filter((cluster) => cluster.shown_node_count > 0)
    .sort((a, b) => b.shown_node_count - a.shown_node_count || a.path.localeCompare(b.path));

  const nodeCluster = new Map(nodes.map((node) => [node.id, node.cluster_id]));
  const clusterEdgeMap = new Map();
  for (const edge of edges) {
    const source = nodeCluster.get(edge.source);
    const target = nodeCluster.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
    const value = clusterEdgeMap.get(key) ?? { source: source < target ? source : target, target: source < target ? target : source, calls: 0, imports: 0 };
    value[edge.kind] += 1;
    clusterEdgeMap.set(key, value);
  }
  const clusterEdges = [...clusterEdgeMap.values()].sort((a, b) => (b.calls + b.imports) - (a.calls + a.imports));
  return {
    repo_id: repository.repo_id,
    indexed_at: repository.indexed_at,
    focus,
    counts: {
      indexed_nodes: symbols.length,
      eligible_nodes: eligible.length,
      shown_nodes: nodes.length,
      indexed_edges: rawEdges.length,
      projectable_edges: allEdges.length,
      eligible_edges: candidateEdges.length,
      shown_edges: edges.length,
      clusters: clusterRows.length,
    },
    nodes,
    edges,
    clusters: clusterRows,
    cluster_edges: clusterEdges,
    bounds: { max_nodes: nodeLimit, max_edges: edgeLimit, truncated: nodes.length < eligible.length || edges.length < candidateEdges.length },
    methodology: "Weighted call-graph PageRank with deterministic package coverage, adaptive directory clustering, and bounded call/import edge projection.",
  };
}

export function getRepoMap(db, { repoId = null, focus = null, tokenBudget = 2000, maxSymbols = 120 } = {}) {
  const repository = resolveRepository(db, repoId);
  const { symbols, edges } = graphRows(db, repository);
  const ranks = pageRank(symbols, edges, focus);
  const cappedSymbols = Math.max(10, Math.min(Number(maxSymbols) || 120, 500));
  const characterBudget = Math.max(400, Math.min(Number(tokenBudget) || 2000, 20000) * 4);
  const ranked = symbols
    .map((symbol) => ({ ...symbol, rank: ranks.get(symbol.id) ?? 0, score: presentationScore(symbol, ranks.get(symbol.id) ?? 0, focus) }))
    .sort((a, b) => b.score - a.score || b.rank - a.rank || a.file_path.localeCompare(b.file_path) || a.start_line - b.start_line)
    .slice(0, cappedSymbols);

  const byFile = new Map();
  for (const symbol of ranked) {
    const group = byFile.get(symbol.file_path) ?? { file_path: symbol.file_path, score: 0, symbols: [] };
    group.score += symbol.score;
    group.symbols.push(symbol);
    byFile.set(symbol.file_path, group);
  }
  const files = [...byFile.values()].sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path));
  const included = [];
  const lines = [];
  let used = 0;
  for (const file of files) {
    const header = `${file.file_path}:`;
    const symbolLines = file.symbols
      .sort((a, b) => b.score - a.score || b.rank - a.rank || a.start_line - b.start_line)
      .map((symbol) => `  L${symbol.start_line}-${symbol.end_line} ${symbol.kind} ${symbol.qualified_name} :: ${symbol.signature}`);
    const block = [header, ...symbolLines].join("\n");
    if (included.length && used + block.length + 1 > characterBudget) continue;
    const remaining = characterBudget - used - header.length - 1;
    if (!included.length && block.length > characterBudget) {
      const partial = [header];
      let partialLength = header.length;
      for (const line of symbolLines) {
        if (partialLength + line.length + 1 > characterBudget) break;
        partial.push(line);
        partialLength += line.length + 1;
      }
      lines.push(partial.join("\n"));
      included.push({ ...file, symbols: file.symbols.slice(0, Math.max(1, partial.length - 1)).map(rowToSymbol) });
      used += partialLength;
      break;
    }
    lines.push(block);
    included.push({ ...file, symbols: file.symbols.map(rowToSymbol) });
    used += block.length + 1;
  }
  const map = lines.join("\n");
  return {
    repo_id: repository.repo_id,
    focus,
    token_budget: Math.floor(characterBudget / 4),
    estimated_tokens: Math.ceil(map.length / 4),
    files_included: included.length,
    symbols_included: included.reduce((sum, file) => sum + file.symbols.length, 0),
    files: included,
    map,
  };
}

function fileCommunities(files, edgeRows, resolution = 1) {
  const adjacency = new Map(files.map((file) => [file.id, new Map()]));
  const add = (source, target, weight) => {
    if (source == null || target == null || source === target || !adjacency.has(source) || !adjacency.has(target)) return;
    adjacency.get(source).set(target, (adjacency.get(source).get(target) ?? 0) + weight);
    adjacency.get(target).set(source, (adjacency.get(target).get(source) ?? 0) + weight);
  };
  for (const edge of edgeRows) add(edge.source_file_id, edge.target_file_id, edge.kind === "imports" ? 0.7 : Number(edge.confidence) || 1);
  const degree = new Map(files.map((file) => [file.id, [...adjacency.get(file.id).values()].reduce((sum, value) => sum + value, 0)]));
  const totalDegree = [...degree.values()].reduce((sum, value) => sum + value, 0);
  const community = new Map(files.map((file) => [file.id, file.id]));
  const totals = new Map(files.map((file) => [file.id, degree.get(file.id)]));
  if (totalDegree > 0) {
    for (let pass = 0; pass < 20; pass += 1) {
      let moved = 0;
      for (const file of files) {
        const nodeDegree = degree.get(file.id);
        if (!nodeDegree) continue;
        const current = community.get(file.id);
        totals.set(current, (totals.get(current) ?? 0) - nodeDegree);
        const weights = new Map([[current, 0]]);
        for (const [neighbor, weight] of adjacency.get(file.id)) {
          const label = community.get(neighbor);
          weights.set(label, (weights.get(label) ?? 0) + weight);
        }
        let best = current;
        let bestGain = weights.get(current) - resolution * nodeDegree * (totals.get(current) ?? 0) / totalDegree;
        for (const [candidate, internalWeight] of weights) {
          const gain = internalWeight - resolution * nodeDegree * (totals.get(candidate) ?? 0) / totalDegree;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) < 1e-12 && candidate < best)) {
            best = candidate;
            bestGain = gain;
          }
        }
        community.set(file.id, best);
        totals.set(best, (totals.get(best) ?? 0) + nodeDegree);
        if (best !== current) moved += 1;
      }
      if (!moved) break;
    }
  }
  return { community, adjacency, degree };
}

export function getArchitecture(db, { repoId = null, maxCommunities = 12, maxSymbols = 20 } = {}) {
  const repository = resolveRepository(db, repoId);
  const { symbols, edges } = graphRows(db, repository);
  const ranks = pageRank(symbols, edges);
  const files = db.prepare("SELECT * FROM files WHERE repo_id = ? ORDER BY path").all(repository.id);
  const edgeRows = db.prepare(`
    SELECT kind, source_file_id, target_file_id, confidence
    FROM edges
    WHERE repo_id = ? AND source_file_id IS NOT NULL AND target_file_id IS NOT NULL
      AND kind IN ('calls', 'imports')
  `).all(repository.id);
  const { community, adjacency, degree } = fileCommunities(files, edgeRows);
  const clustersById = new Map();
  for (const file of files) {
    const id = community.get(file.id);
    const cluster = clustersById.get(id) ?? { id, files: [], internal_weight: 0, boundary_weight: 0 };
    cluster.files.push(file);
    clustersById.set(id, cluster);
  }
  for (const [source, neighbors] of adjacency) {
    for (const [target, weight] of neighbors) {
      if (source >= target) continue;
      const sourceCluster = clustersById.get(community.get(source));
      if (community.get(source) === community.get(target)) sourceCluster.internal_weight += weight;
      else {
        sourceCluster.boundary_weight += weight;
        clustersById.get(community.get(target)).boundary_weight += weight;
      }
    }
  }
  const symbolCounts = new Map(db.prepare("SELECT file_id, COUNT(*) AS count FROM symbols WHERE repo_id = ? GROUP BY file_id").all(repository.id).map((row) => [row.file_id, row.count]));
  const communities = [...clustersById.values()]
    .map((cluster) => {
      const packages = new Map();
      for (const file of cluster.files) packages.set(topDirectory(file.path), (packages.get(topDirectory(file.path)) ?? 0) + 1);
      const totalWeight = cluster.internal_weight + cluster.boundary_weight;
      return {
        id: cluster.id,
        file_count: cluster.files.length,
        symbol_count: cluster.files.reduce((sum, file) => sum + Number(symbolCounts.get(file.id) ?? 0), 0),
        cohesion: totalWeight ? cluster.internal_weight / totalWeight : 1,
        packages: [...packages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, count]) => ({ name, files: count })),
        top_files: cluster.files.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.path.localeCompare(b.path)).slice(0, 8).map((file) => file.path),
      };
    })
    .filter((cluster) => cluster.file_count > 1)
    .sort((a, b) => b.file_count - a.file_count || b.cohesion - a.cohesion)
    .slice(0, Math.max(1, Math.min(Number(maxCommunities) || 12, 50)));

  const languages = db.prepare("SELECT language, COUNT(*) AS files FROM files WHERE repo_id = ? GROUP BY language ORDER BY files DESC, language").all(repository.id);
  const packages = new Map();
  for (const file of files) packages.set(topDirectory(file.path), (packages.get(topDirectory(file.path)) ?? 0) + 1);
  const centralSymbols = symbols
    .map((symbol) => ({
      ...rowToSymbol(symbol),
      score: presentationScore(symbol, ranks.get(symbol.id) ?? 0),
      pagerank: ranks.get(symbol.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path))
    .slice(0, Math.max(1, Math.min(Number(maxSymbols) || 20, 100)));
  const entryPoints = files.filter((file) => /(^|\/)(?:index|main|app|server|cli|entry)\.[^.]+$/i.test(file.path) || /(^|\/)bin\//i.test(file.path)).map((file) => file.path).slice(0, 50);
  return {
    repo_id: repository.repo_id,
    indexed_at: repository.indexed_at,
    files: files.length,
    symbols: symbols.length,
    languages,
    packages: [...packages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, count]) => ({ name, files: count })),
    entry_points: entryPoints,
    central_symbols: centralSymbols,
    communities,
    methodology: "Weighted PageRank over resolved calls; single-level modularity optimization over file call/import edges.",
  };
}
