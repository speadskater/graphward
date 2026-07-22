import os from "node:os";
import path from "node:path";
import { indexDirectory } from "./indexer.mjs";
import { samePath } from "./path-utils.mjs";
import { getArchitecture, getCodeGraph, getRepoMap } from "./graph-analysis.mjs";
import { getCochangeContext } from "./history.mjs";
import { changePreflight, findDependencyPath, inferExecutionFlows } from "./workflow-analysis.mjs";
import { ADVANCED_TOOL_DEFINITIONS, callAdvancedTool } from "./advanced-tools.mjs";
import { getIndexFreshness } from "./repository-state.mjs";
import { getUsageStats, recordToolUsage } from "./usage.mjs";
import {
  getApiTopology,
  findSymbol,
  getChangesSince,
  getCodeRelationships,
  getImpact,
  getIndexDiagnostics,
  getRepositoryStats,
  getSourceWindow,
  getSymbolContext,
  getTimeline,
  listIndexedRepositories,
  recallDecisions,
  recordDecision,
} from "./queries.mjs";

const stringProperty = (description) => ({ type: "string", description });
const integerProperty = (description, minimum = 1, maximum = 500) => ({ type: "integer", description, minimum, maximum });

const AUTO_INDEX_EXEMPT_TOOLS = new Set(["index_directory", "watch_directory", "unwatch_directory", "list_watched_paths"]);
const AUTO_SCOPE_EXEMPT_TOOLS = new Set(["list_indexed_repositories", "get_cross_repository_topology", "get_service_diagram", "list_service_identities"]);

export const TOOL_DEFINITIONS = [
  {
    name: "index_directory",
    description: "Index or incrementally refresh a local source-code repository. All parsing and storage remain on this machine.",
    inputSchema: {
      type: "object",
      properties: {
        path: stringProperty("Absolute or working-directory-relative repository path. Defaults to the configured root."),
        repo_id: stringProperty("Stable repository identifier. Omit to derive one from the path."),
        force: { type: "boolean", description: "Reparse every source file even when its content hash is unchanged." },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_indexed_repositories",
    description: "List repositories currently stored in this Graphward database with graph counts. From MCP, a missing current project is indexed before this result is returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_usage_stats",
    description: "Return measured local tool-call usage and conservatively modeled MCP context efficiency. Token figures are explicitly approximate and never billing data.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Optional repository identifier. Omit for usage across the current local database."),
        period: { type: "string", enum: ["24h", "7d", "30d", "90d", "all"], description: "Reporting window. Defaults to 30d." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_repository_stats",
    description: "Return file, symbol, edge, episode, language, and decision counts for one repository.",
    inputSchema: { type: "object", properties: { repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed.") }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_index_diagnostics",
    description: "Report parser coverage, parse failures, import resolution, and resolved/ambiguous/unresolved call-site counts. Use this before trusting graph completeness.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        limit: integerProperty("Maximum diagnostic samples per category.", 1, 100),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_architecture",
    description: "Return a one-call architecture overview with packages, entry points, PageRank-central symbols, and dependency communities.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        max_communities: integerProperty("Maximum functional communities.", 1, 50),
        max_symbols: integerProperty("Maximum central symbols.", 1, 100),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_code_graph",
    description: "Return a bounded symbol-level program graph for interactive visualization, with adaptive package clusters, call/import edges, PageRank, and explicit total-versus-shown counts.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        focus: stringProperty("Optional task, file, or symbol terms used to prioritize the bounded projection."),
        max_nodes: integerProperty("Maximum symbols returned for rendering.", 50, 12000),
        max_edges: integerProperty("Maximum call/import edges returned for rendering.", 100, 40000),
        include_tests: { type: "boolean", description: "Include test and fixture symbols. Defaults to true." },
        edge_kinds: {
          type: "array",
          description: "Edge kinds to include. Defaults to calls and imports.",
          items: { type: "string", enum: ["calls", "imports"] },
          minItems: 1,
          maxItems: 2,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_repo_map",
    description: "Build a token-budgeted, relevance-ranked repository map from definitions and resolved call relationships.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        focus: stringProperty("Optional task, file, or symbol terms used to personalize ranking."),
        token_budget: integerProperty("Approximate maximum output tokens.", 100, 20000),
        max_symbols: integerProperty("Maximum ranked symbols considered.", 10, 500),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_api_topology",
    description: "Map statically detected HTTP routes and outbound clients, including route-to-client links by normalized method and path.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        path: stringProperty("Optional route path or full URL filter."),
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] },
        limit: integerProperty("Maximum operations loaded.", 1, 5000),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_cochange_context",
    description: "Find indexed files that historically change with a file or symbol using bounded local Git history.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        target: stringProperty("Indexed file path, symbol name, or qualified symbol name."),
        since: stringProperty("Git --since expression. Defaults to '1 year ago'."),
        max_commits: integerProperty("Maximum commits to inspect.", 1, 50000),
        max_files_per_commit: integerProperty("Skip broad commits above this many indexed files.", 2, 200),
        min_cochanges: integerProperty("Minimum shared commits required.", 1, 100),
        limit: integerProperty("Maximum partner files.", 1, 200),
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "find_symbol",
    description: "Find definitions by symbol or qualified name. Returns exact source spans and stable keys.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        name: stringProperty("Symbol or qualified name."),
        fuzzy: { type: "boolean", description: "Allow substring matching. Defaults to true." },
        kind: stringProperty("Optional symbol kind filter."),
        file_path: stringProperty("Optional path substring filter."),
        limit: integerProperty("Maximum results.", 1, 100),
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "find_code",
    description: "Hybrid local search over identifiers, BM25 evidence, code-aware feature vectors, and bounded concept hints. Ranking evidence is returned and no query or result leaves the machine.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        query: stringProperty("Words, identifier, string literal, or behavior to find."),
        file_path: stringProperty("Optional path substring filter."),
        kind: stringProperty("Optional symbol kind filter."),
        limit: integerProperty("Maximum results.", 1, 100),
        cursor: integerProperty("Zero-based result offset returned by a previous page.", 0, 10000),
        context_lines: integerProperty("Source lines shown before and after the best literal match.", 0, 20),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_source_window",
    description: "Read a bounded source window from an indexed repository. Paths cannot escape the repository root.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        file_path: stringProperty("Repository-relative file path."),
        start_line: integerProperty("First 1-based line.", 1, 10000000),
        end_line: integerProperty("Last 1-based line; capped to a 400-line window.", 1, 10000000),
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_symbol_context",
    description: "Return a symbol's direct callers, callees, file imports, and governing decisions.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        symbol: stringProperty("Symbol or qualified name."),
        file_path: stringProperty("Optional path hint for ambiguous names."),
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_code_relationships",
    description: "Inspect indexed exports, re-exports, inheritance, type references, constructor hints, endpoint values, and DOM-selector producers/consumers by symbol or file.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        symbol: stringProperty("Optional symbol or qualified name."),
        file_path: stringProperty("Optional file-path filter or symbol disambiguation hint."),
        category: { type: "string", enum: ["export", "heritage", "type_reference", "member_hint", "endpoint_definition", "endpoint_usage", "dom_selector"] },
        limit: integerProperty("Maximum relationships.", 1, 1000),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_impact",
    description: "Traverse callers and/or callees to estimate the blast radius of changing a symbol.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        target: stringProperty("Symbol or qualified name."),
        file_path: stringProperty("Optional path hint for ambiguous names."),
        direction: { type: "string", enum: ["upstream", "downstream", "both"], description: "upstream finds callers; downstream finds callees." },
        depth: integerProperty("Maximum graph traversal depth.", 1, 15),
        edge_kinds: {
          type: "array",
          description: "Relationship kinds to traverse. Defaults to calls and DOM-selector contracts.",
          items: { type: "string", enum: ["calls", "dom-selector", "extends", "implements", "interface-extends", "type-reference"] },
          minItems: 1,
          maxItems: 6,
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_dependency_path",
    description: "Find a shortest resolved call path between two symbols, preferring higher-confidence evidence at equal depth.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        source: stringProperty("Starting symbol or qualified name."),
        target: stringProperty("Destination symbol or qualified name."),
        source_file_path: stringProperty("Optional source-file hint for ambiguous symbols."),
        target_file_path: stringProperty("Optional target-file hint for ambiguous symbols."),
        max_depth: integerProperty("Maximum call hops.", 1, 50),
        min_confidence: { type: "number", minimum: 0, maximum: 1, description: "Minimum edge confidence." },
      },
      required: ["source", "target"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_execution_flows",
    description: "Infer bounded execution flows from indexed HTTP routes and conventional entry points over resolved call edges.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        include_routes: { type: "boolean", description: "Include API routes as flow starts. Defaults to true." },
        include_entry_points: { type: "boolean", description: "Include conventional entry files/functions. Defaults to true." },
        route_path: stringProperty("Optional normalized route-path filter."),
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] },
        max_depth: integerProperty("Maximum call depth per flow.", 1, 20),
        max_results: integerProperty("Maximum returned flows.", 1, 1000),
        max_starts: integerProperty("Maximum route/entry starts.", 1, 500),
        max_branching: integerProperty("Maximum outgoing branches followed per symbol.", 1, 50),
        min_confidence: { type: "number", minimum: 0, maximum: 1, description: "Minimum resolved-call confidence." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "change_preflight",
    description: "Map exact changed lines to symbols, blast radius, co-change evidence, decisions, risk, and verification targets. When diff text is omitted, Graphward reads the current checkout's tracked and untracked working-tree changes.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier. Optional when only one repository is indexed."),
        diff: stringProperty("Git-style unified diff text. The command never invokes a shell or reads paths from the diff."),
        changes: {
          type: "array",
          description: "Explicit changed file/line ranges when diff text is unavailable.",
          items: {
            type: "object",
            properties: {
              file_path: stringProperty("Indexed repository-relative file path."),
              start_line: integerProperty("First changed line.", 1, 10000000),
              end_line: integerProperty("Last changed line.", 1, 10000000),
            },
            required: ["file_path"],
            additionalProperties: false,
          },
        },
        impact_depth: integerProperty("Maximum upstream impact depth.", 1, 15),
        include_cochange: { type: "boolean", description: "Include bounded local Git co-change evidence. Defaults to true." },
        cochange_since: stringProperty("Git --since expression. Defaults to '1 year ago'."),
        max_changed_symbols: integerProperty("Maximum directly changed symbols analyzed.", 1, 1000),
        max_verification_targets: integerProperty("Maximum verification targets returned.", 1, 200),
        max_commits: integerProperty("Maximum Git commits inspected for co-change.", 1, 50000),
        max_files_per_commit: integerProperty("Skip broad commits above this many indexed files.", 2, 200),
        min_cochanges: integerProperty("Minimum shared commits for a co-change partner.", 1, 100),
        cochange_limit: integerProperty("Maximum co-change partners per changed file.", 1, 200),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_changes_since",
    description: "Return incremental indexing episodes and symbol changes after an ISO timestamp or episode id.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        since: { description: "ISO timestamp or numeric episode id.", anyOf: [{ type: "string" }, { type: "integer" }] },
        limit: integerProperty("Maximum episodes.", 1, 500),
      },
      required: ["since"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_timeline",
    description: "Return the recorded add/modify/remove timeline for a currently indexed symbol.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        symbol: stringProperty("Symbol or qualified name."),
        file_path: stringProperty("Optional path hint."),
        limit: integerProperty("Maximum events.", 1, 500),
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "watch_directory",
    description: "Watch a local repository and incrementally reindex after file changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: stringProperty("Repository path. Defaults to the configured root."),
        repo_id: stringProperty("Optional repository identifier."),
        initial_index: { type: "boolean", description: "Index before watching. Defaults to true." },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "unwatch_directory",
    description: "Stop a watcher started by this MCP process.",
    inputSchema: { type: "object", properties: { path: stringProperty("Repository path. Defaults to the configured root.") }, additionalProperties: false },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_watched_paths",
    description: "List file watchers owned by this MCP process.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "record_decision",
    description: "Record an explicit local architectural decision and optionally link it to indexed symbols.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        title: stringProperty("Short decision title."),
        rationale: stringProperty("Why this decision was made and what constraints it protects."),
        alternatives: { type: "array", items: { type: "string" }, description: "Alternatives considered or rejected." },
        tags: { type: "array", items: { type: "string" }, description: "Searchable topic tags." },
        symbols: { type: "array", items: { type: "string" }, description: "Current symbol names governed by the decision." },
        status: { type: "string", enum: ["active", "superseded", "rejected"] },
      },
      required: ["title", "rationale"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "recall_decisions",
    description: "Search local decision memory by title, rationale, and tags.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: stringProperty("Repository identifier."),
        query: stringProperty("Decision topic or constraint."),
        status: { type: ["string", "null"], enum: ["active", "superseded", "rejected", null], description: "Defaults to active; null searches every status." },
        limit: integerProperty("Maximum decisions.", 1, 100),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ...ADVANCED_TOOL_DEFINITIONS,
];

function normalizeArgs(args = {}) {
  return {
    ...args,
    repoId: args.repo_id ?? null,
    filePath: args.file_path ?? null,
    startLine: args.start_line,
    endLine: args.end_line,
    tokenBudget: args.token_budget,
    maxSymbols: args.max_symbols,
    maxCommunities: args.max_communities,
    maxNodes: args.max_nodes,
    maxEdges: args.max_edges,
    includeTests: args.include_tests,
    edgeKinds: args.edge_kinds,
    maxCommits: args.max_commits,
    maxFilesPerCommit: args.max_files_per_commit,
    minCochanges: args.min_cochanges,
    sourceFilePath: args.source_file_path ?? args.file_path ?? null,
    targetFilePath: args.target_file_path ?? null,
    maxDepth: args.max_depth,
    minConfidence: args.min_confidence,
    includeRoutes: args.include_routes,
    includeEntryPoints: args.include_entry_points,
    routePath: args.route_path,
    maxResults: args.max_results,
    maxStarts: args.max_starts,
    maxBranching: args.max_branching,
    impactDepth: args.impact_depth,
    includeCochange: args.include_cochange,
    cochangeSince: args.cochange_since,
    maxChangedSymbols: args.max_changed_symbols,
    maxVerificationTargets: args.max_verification_targets,
    cochangeLimit: args.cochange_limit,
  };
}

function attachIndexSnapshot(db, value, preferredRepoId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.index_snapshot) return value;
  if (Array.isArray(value.repositories)) {
    return {
      ...value,
      repositories: value.repositories.map((item) => {
        const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(item.repo_id);
        return row ? { ...item, index_snapshot: getIndexFreshness(row) } : item;
      }),
    };
  }
  const repoId = value.repo_id ?? preferredRepoId;
  const repository = repoId
    ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId)
    : db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC, id DESC LIMIT 2").all();
  const row = Array.isArray(repository) ? (repository.length === 1 ? repository[0] : null) : repository;
  return row ? { ...value, index_snapshot: getIndexFreshness(row) } : value;
}

function indexedRepositoryForRoot(db, root) {
  return db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC, id DESC").all()
    .find((repository) => samePath(repository.root, root)) ?? null;
}

function autoIndexJobs(context) {
  if (!(context.autoIndexJobs instanceof Map)) context.autoIndexJobs = new Map();
  return context.autoIndexJobs;
}

async function ensureMcpRepository(name, args, context) {
  if (context?.surface !== "mcp" || context.autoIndex === false || args.repo_id != null || AUTO_INDEX_EXEMPT_TOOLS.has(name)) {
    return { args, autoIndex: null };
  }
  if (!context.defaultRoot) return { args, autoIndex: null };
  const root = path.resolve(context.defaultRoot);
  if (samePath(root, os.homedir()) || path.parse(root).root === root) {
    throw new Error("Graphward MCP is not attached to a project folder. Open the agent from a project or configure --root explicitly.");
  }

  let repository = indexedRepositoryForRoot(context.db, root);
  let indexed = false;
  if (!repository) {
    const jobs = autoIndexJobs(context);
    let job = jobs.get(root);
    if (!job) {
      context.reportProgress?.({ stage: "starting", message: `Graphward is indexing ${root}; wait for this tool call to complete.` });
      job = indexDirectory(context.db, root, {
        onProgress: (progress) => context.reportProgress?.({
          ...progress,
          message: `Graphward indexing ${path.basename(root)}: ${progress.stage}`,
        }),
      }).finally(() => jobs.delete(root));
      jobs.set(root, job);
    }
    const result = await job;
    repository = context.db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(result.repo_id);
    indexed = true;
    if (context.watchManager) {
      await context.watchManager.start(root, { repoId: result.repo_id });
    }
    context.reportProgress?.({ stage: "complete", message: `Graphward finished indexing ${root}.` });
  }

  const scopedArgs = AUTO_SCOPE_EXEMPT_TOOLS.has(name)
    ? args
    : { ...args, repo_id: repository.repo_id };
  return {
    args: scopedArgs,
    autoIndex: indexed ? { performed: true, root, repo_id: repository.repo_id } : null,
  };
}

function attachAutoIndex(value, autoIndex) {
  if (!autoIndex || !value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...value, auto_index: autoIndex };
}

async function dispatchTool(name, args, context) {
  const advanced = await callAdvancedTool(name, args, context);
  if (advanced.handled) return attachIndexSnapshot(context.db, advanced.value, args?.repo_id ?? null);
  const values = normalizeArgs(args);
  switch (name) {
    case "index_directory":
      return indexDirectory(context.db, args.path ?? context.defaultRoot, { repoId: args.repo_id, force: args.force });
    case "list_indexed_repositories":
      return attachIndexSnapshot(context.db, { repositories: listIndexedRepositories(context.db) });
    case "get_usage_stats":
      return getUsageStats(context.db, { repoId: values.repoId, period: args.period ?? "30d" });
    case "get_repository_stats":
      return attachIndexSnapshot(context.db, getRepositoryStats(context.db, values.repoId), values.repoId);
    case "get_index_diagnostics":
      return attachIndexSnapshot(context.db, getIndexDiagnostics(context.db, values), values.repoId);
    case "get_architecture":
      return attachIndexSnapshot(context.db, getArchitecture(context.db, values), values.repoId);
    case "get_code_graph":
      return attachIndexSnapshot(context.db, getCodeGraph(context.db, values), values.repoId);
    case "get_repo_map":
      return attachIndexSnapshot(context.db, getRepoMap(context.db, values), values.repoId);
    case "get_api_topology":
      return attachIndexSnapshot(context.db, getApiTopology(context.db, { ...values, path: args.path, method: args.method }), values.repoId);
    case "get_cochange_context":
      return attachIndexSnapshot(context.db, getCochangeContext(context.db, values), values.repoId);
    case "find_symbol":
      return attachIndexSnapshot(context.db, { repo_id: values.repoId, results: findSymbol(context.db, { ...values, fuzzy: args.fuzzy ?? true }) }, values.repoId);
    case "get_source_window":
      return attachIndexSnapshot(context.db, getSourceWindow(context.db, values), values.repoId);
    case "get_symbol_context":
      return attachIndexSnapshot(context.db, getSymbolContext(context.db, values), values.repoId);
    case "get_code_relationships":
      return attachIndexSnapshot(context.db, getCodeRelationships(context.db, values), values.repoId);
    case "get_impact":
      return attachIndexSnapshot(context.db, getImpact(context.db, { ...values, direction: args.direction ?? "upstream", depth: args.depth ?? 5 }), values.repoId);
    case "get_dependency_path":
      return attachIndexSnapshot(context.db, findDependencyPath(context.db, values), values.repoId);
    case "get_execution_flows":
      return attachIndexSnapshot(context.db, inferExecutionFlows(context.db, values), values.repoId);
    case "change_preflight":
      return attachIndexSnapshot(context.db, changePreflight(context.db, values), values.repoId);
    case "get_changes_since":
      return attachIndexSnapshot(context.db, getChangesSince(context.db, values), values.repoId);
    case "get_timeline":
      return attachIndexSnapshot(context.db, getTimeline(context.db, values), values.repoId);
    case "watch_directory": {
      const watchedPath = args.path ?? context.defaultRoot;
      const indexed = args.initial_index === false ? null : await indexDirectory(context.db, watchedPath, { repoId: args.repo_id });
      const watching = await context.watchManager.start(watchedPath, { repoId: args.repo_id });
      return { ...watching, initial_index: indexed };
    }
    case "unwatch_directory":
      return context.watchManager.stop(args.path ?? context.defaultRoot);
    case "list_watched_paths":
      return { watched_paths: context.watchManager.list() };
    case "record_decision": {
      const decisionRepository = values.repoId
        ? context.db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(values.repoId)
        : context.db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC, id DESC LIMIT 1").get();
      if (decisionRepository) {
        await indexDirectory(context.db, decisionRepository.root, { repoId: decisionRepository.repo_id, episodeType: "working_tree" });
      }
      return attachIndexSnapshot(context.db, recordDecision(context.db, values), values.repoId);
    }
    case "recall_decisions":
      return attachIndexSnapshot(context.db, { repo_id: values.repoId, decisions: recallDecisions(context.db, { ...values, status: args.status === undefined ? "active" : args.status }) }, values.repoId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function callTool(name, args = {}, context) {
  const startedAt = Date.now();
  const recordUsage = context?.surface === "mcp";
  try {
    const prepared = await ensureMcpRepository(name, args, context);
    const output = attachAutoIndex(await dispatchTool(name, prepared.args, context), prepared.autoIndex);
    if (recordUsage) {
      try {
        recordToolUsage(context.db, {
          toolName: name,
          args,
          output,
          context,
          durationMs: Date.now() - startedAt,
          success: true,
        });
      } catch {
        // Usage accounting must never make an otherwise valid Graphward tool fail.
      }
    }
    return output;
  } catch (error) {
    if (recordUsage) {
      try {
        recordToolUsage(context.db, {
          toolName: name,
          args,
          context,
          durationMs: Date.now() - startedAt,
          success: false,
          error,
        });
      } catch {
        // Preserve the original tool error when accounting is unavailable.
      }
    }
    throw error;
  }
}
