import { createHybridSearchIndex, tokenizeCodeText } from "./semantic-search.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyWorktreeMerge,
  createWorktreeOverlay,
  getDecisionMemory,
  getDecisionProvenance,
  getGoverningContracts,
  getWorktreeOverlay,
  listWorktreeOverlays,
  planWorktreeMerge,
  recallDecisionMemory,
  recordStructuredDecision,
  recordWorktreeChanges,
  setDecisionStatus,
  setWorktreeOverlayStatus,
  verifyDecision,
  whyIsThisHere,
} from "./local-memory.mjs";
import { findCode } from "./queries.mjs";
import {
  captureWorkingTreeEpisode,
  getTemporalChangesSince,
  getTemporalEvolution,
  getTemporalStats,
  getTemporalTimeline,
  ingestGitHistory,
  recordTemporalEpisode,
  replayTemporalState,
} from "./temporal-memory.mjs";
import {
  getCrossRepositoryTopology,
  getServiceCallers,
  getServiceDiagram,
  linkRepositoryService,
  listServiceIdentities,
  recordServiceOperations,
  refreshServiceIdentities,
  unlinkRepositoryService,
  upsertServiceIdentity,
} from "./service-topology.mjs";
import {
  analyzeComplexity,
  findBridgeEntities,
  findDeadCodeCandidates,
  getChurnWeightedHotspots,
  getEmpiricalStyleFingerprint,
} from "./quality-analysis.mjs";
import {
  getCodebaseBriefing,
  getDailyBriefing,
  getProcessFlow,
  getProcessMembership,
  listProcessModels,
  listProcessRefreshes,
  refreshProcessModels,
  retireProcessModel,
  upsertProcessModel,
} from "./process-memory.mjs";
import { reviewChange } from "./review-engine.mjs";
import { FLEET_TOOL_DEFINITIONS, callFleetTool } from "./fleet.mjs";
import { indexDirectory } from "./indexer.mjs";

const semanticCaches = new WeakMap();
const MAX_HYBRID_DOCUMENTS = 50_000;
const HYBRID_BODY_LIMIT = 3_000;

const string = (description) => ({ type: "string", description });
const integer = (description, minimum = 1, maximum = 100) => ({ type: "integer", minimum, maximum, description });
const stringArray = (description) => ({ type: "array", items: { type: "string" }, description });
const objectArray = (description) => ({ type: "array", items: { type: "object" }, description });
const temporalCursor = (description, { nullable = false } = {}) => ({
  description,
  anyOf: [
    { type: "integer", minimum: 0 },
    { type: "string" },
    {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        episode_id: { type: "integer", minimum: 1 },
        episode_key: { type: "string" },
        sequence: { type: "integer", minimum: 0 },
        reference_time: { type: "string" },
      },
      required: ["sequence"],
      additionalProperties: false,
    },
    ...(nullable ? [{ type: "null" }] : []),
  ],
});
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const localWrite = { destructiveHint: false, idempotentHint: false, openWorldHint: false };
const localRefresh = { destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localDestructive = { destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const ADVANCED_TOOL_DEFINITIONS = [
  {
    name: "get_decision",
    description: "Read one structured local decision, including scopes, contracts, provenance, and verification evidence.",
    inputSchema: {
      type: "object",
      properties: { repo_id: string("Repository identifier."), decision_id: integer("Decision row identifier.", 1, Number.MAX_SAFE_INTEGER) },
      required: ["decision_id"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "get_decision_provenance",
    description: "Read only the explicitly recorded evidence and provenance for one local decision.",
    inputSchema: {
      type: "object",
      properties: { repo_id: string("Repository identifier."), decision_id: integer("Decision row identifier.", 1, Number.MAX_SAFE_INTEGER) },
      required: ["decision_id"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "record_structured_decision",
    description: "Record a private local choice, ban, convention, or contract with explicit scope and provenance.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        title: string("Short decision title."),
        rationale: string("Why the decision exists."),
        kind: { type: "string", enum: ["choice", "ban", "convention", "contract"] },
        status: { type: "string", enum: ["active", "superseded", "rejected"] },
        alternatives: stringArray("Alternatives considered."),
        tags: stringArray("Search tags."),
        symbols: stringArray("Indexed symbol names or stable keys governed by this decision."),
        files: stringArray("Repository-relative file scopes."),
        scopes: objectArray("Additional typed scopes."),
        contracts: objectArray("Structured contract clauses."),
        bans: { type: "array", items: {}, description: "Prohibited approaches as strings or structured clauses." },
        conventions: { type: "array", items: {}, description: "Conventions as strings or structured clauses." },
        provenance: objectArray("Explicit evidence sources."),
        metadata: { type: "object", description: "JSON metadata." },
      },
      required: ["title", "rationale"],
      additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "recall_decision",
    description: "Recall ranked local decisions, bans, conventions, and contracts. An empty result is CannotProve, not permission.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        query: string("Decision topic or constraint."),
        status: { type: ["string", "null"], enum: ["active", "superseded", "rejected", null] },
        kind: { type: ["string", "null"], enum: ["choice", "ban", "convention", "contract", null] },
        scope_type: { type: ["string", "null"], enum: ["repository", "file", "symbol", "process", "api", null] },
        scope_key: { type: ["string", "null"] },
        limit: integer("Maximum decisions.", 1, 100),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "set_decision_status",
    description: "Transition a local decision to active, superseded, or rejected.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        decision_id: integer("Decision row identifier.", 1, Number.MAX_SAFE_INTEGER),
        status: { type: "string", enum: ["active", "superseded", "rejected"] },
        superseded_by: integer("Replacement decision identifier.", 1, Number.MAX_SAFE_INTEGER),
      },
      required: ["decision_id", "status"],
      additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "verify_intent",
    description: "Return Held, ViolatedAt, or CannotProve for a decision; optionally record explicit observed evidence.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        decision_id: integer("Decision row identifier.", 1, Number.MAX_SAFE_INTEGER),
        record: { type: ["object", "null"], description: "Optional evidence record with verdict held|violated." },
      },
      required: ["decision_id"],
      additionalProperties: false,
    },
    annotations: localWrite,
  },
  ...["governing_contracts", "why_is_this_here"].map((name) => ({
    name,
    description: name === "governing_contracts"
      ? "Return active local contracts explicitly scoped to a symbol, file, or repository."
      : "Explain a symbol or file through explicitly recorded local rationale and provenance.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        symbol: { type: ["string", "integer"] },
        symbol_stable_key: string("Stable key, including for a removed symbol."),
        file_path: string("Repository-relative file path."),
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  })),
  {
    name: "create_worktree_overlay",
    description: "Create a named local symbol overlay without mutating the canonical graph.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), name: string("Overlay name."),
        base_reference: string("Base reference, normally HEAD."), base_head: { type: ["string", "null"] },
        metadata: { type: "object" },
      },
      required: ["name"], additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "record_worktree_changes",
    description: "Record added, modified, or removed symbol snapshots in a named overlay.",
    inputSchema: {
      type: "object",
      properties: { repo_id: string("Repository identifier."), name: string("Overlay name."), changes: objectArray("Symbol changes."), replace: { type: "boolean" } },
      required: ["name", "changes"], additionalProperties: false,
    },
    annotations: localWrite,
  },
  ...["get_worktree_overlay", "list_worktrees"].map((name) => ({
    name,
    description: name === "get_worktree_overlay" ? "Read a named local worktree overlay." : "List local worktree overlays and symbol-change counts.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."),
        name: string("Overlay name; required by get_worktree_overlay."),
        status: { type: ["string", "null"], enum: ["open", "merged", "abandoned", null] },
      },
      ...(name === "get_worktree_overlay" ? { required: ["name"] } : {}),
      additionalProperties: false,
    },
    annotations: readOnly,
  })),
  ...["plan_worktree_merge", "apply_worktree_merge"].map((name) => ({
    name,
    description: name === "plan_worktree_merge"
      ? "Deterministically plan a three-way merge between two symbol overlays."
      : "Atomically apply a conflict-free symbol-overlay merge; canonical source files are never changed.",
    inputSchema: {
      type: "object",
      properties: { repo_id: string("Repository identifier."), source_name: string("Source overlay."), target_name: string("Target overlay.") },
      required: ["source_name", "target_name"], additionalProperties: false,
    },
    annotations: name === "plan_worktree_merge" ? readOnly : localWrite,
  })),
  {
    name: "set_worktree_status",
    description: "Mark an open worktree overlay as merged or abandoned; terminal overlays cannot reopen.",
    inputSchema: {
      type: "object",
      properties: { repo_id: string("Repository identifier."), name: string("Overlay name."), status: { type: "string", enum: ["open", "merged", "abandoned"] } },
      required: ["name", "status"], additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "replay_history",
    description: "Explicitly ingest bounded first-parent Git history into local temporal memory. This can take tens of seconds and never runs during normal indexing.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), rebuild: { type: "boolean" },
        max_commits: integer("Maximum commits to ingest.", 1, 5000),
        max_files_per_commit: integer("Maximum changed files per commit.", 1, 10000),
        max_file_bytes: integer("Maximum bytes parsed from one file.", 1, 100000000),
        max_total_blob_bytes: integer("Maximum Git blob bytes per ingestion.", 1, 1000000000),
      },
      additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "capture_working_tree_episode",
    description: "Capture a bounded durable episode for current tracked and untracked working-tree changes.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), message: string("Episode message."),
        max_files_per_commit: integer("Maximum dirty files processed per capture.", 1, 10000),
        max_file_bytes: integer("Maximum bytes parsed from one file.", 1, 100000000),
      },
      additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "record_temporal_episode",
    description: "Record an externally computed compact local episode with explicit file/symbol changes.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), episode_key: string("Idempotency key."), type: string("Episode type."),
        reference_time: string("ISO timestamp."), source_id: string("Source identifier."), parent_source_id: string("Parent identifier."),
        branch: string("Branch name."), author_name: string("Author name."), author_email: string("Author email."),
        message: string("Episode message."), complete: { type: "boolean" }, summary: { type: "object" },
        changes: objectArray("Compact file and symbol changes."),
      },
      required: ["episode_key", "type", "changes"], additionalProperties: false,
    },
    annotations: localWrite,
  },
  {
    name: "get_temporal_changes_since",
    description: "Read durable temporal episodes after a repository-bound cursor, episode id, or timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), since: temporalCursor("Repository-bound cursor, episode id, or timestamp."), limit: integer("Maximum episodes.", 1, 500),
        entity_type: { type: ["string", "null"], enum: ["file", "symbol", null] }, file_path: string("Repository-relative file filter."),
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  ...["get_temporal_timeline", "get_evolution"].map((name) => ({
    name,
    description: name === "get_evolution" ? "Summarize lineage-aware durable symbol or file evolution." : "Read lineage-aware durable symbol or file history across renames.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), entity_type: { type: "string", enum: ["file", "symbol"] },
        stable_key: string("Temporal stable key."), target: string("Current symbol name or stable key."), file_path: string("Repository-relative file path."),
        from: name === "get_evolution"
          ? temporalCursor("Inclusive timestamp, episode id, or structured cursor for repository-wide evolution.")
          : string("Inclusive start timestamp."),
        to: string("Inclusive end timestamp."), limit: integer("Maximum events.", 1, 500),
        direction: { type: "string", enum: ["asc", "desc"] },
        ...(name === "get_evolution" ? {
          mode: { type: "string", enum: ["recent", "compound", "summary", "overview"] },
          kind: { type: ["string", "null"] },
          cursor: temporalCursor("Continuation cursor for repository-wide evolution.", { nullable: true }),
        } : {}),
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  })),
  {
    name: "get_episode_replay",
    description: "Replay compact file/symbol state at a stored temporal episode or sequence.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: string("Repository identifier."), episode_id: integer("Temporal episode id.", 1, Number.MAX_SAFE_INTEGER),
        sequence: integer("Repository-local temporal sequence.", 1, Number.MAX_SAFE_INTEGER),
        entity_type: { type: ["string", "null"], enum: ["file", "symbol", null] }, limit: integer("Maximum entities.", 1, 50000),
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "get_temporal_stats",
    description: "Return durable temporal episode, change, version, range, and query-bound statistics.",
    inputSchema: { type: "object", properties: { repo_id: string("Repository identifier.") }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "upsert_service_identity",
    description: "Create or update a configured local service identity and its base URLs.",
    inputSchema: { type: "object", properties: {
      service_key: string("Stable service key."), name: string("Display name."), base_urls: stringArray("Canonical base URLs."),
      confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "object" },
    }, required: ["service_key", "evidence"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "link_repository_service",
    description: "Link an indexed repository to a service as provider, consumer, or both.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), service_key: string("Service key."), role: { type: "string", enum: ["provider", "consumer", "both"] },
      confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "object" },
    }, required: ["repo_id", "service_key", "role", "evidence"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "unlink_repository_service",
    description: "Remove a repository/service role and its role-owned configured operations.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), service_key: string("Service key."),
      role: { type: ["string", "null"], enum: ["provider", "consumer", "both", null] }, prune_orphan_service: { type: "boolean" },
    }, required: ["repo_id", "service_key"], additionalProperties: false },
    annotations: localDestructive,
  },
  {
    name: "refresh_service_identities",
    description: "Idempotently infer repository service identities from indexed static API evidence.",
    inputSchema: { type: "object", properties: { repo_ids: stringArray("Optional repository identifiers.") }, additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "record_service_operations",
    description: "Record configured HTTP, GraphQL, gRPC, WebSocket, or queue contracts for a repository/service.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), service_key: { type: ["string", "null"] }, operations: objectArray("Static operations."),
      evidence: { type: ["object", "null"] }, replace: { type: "boolean" },
    }, required: ["repo_id", "operations"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "list_service_identities",
    description: "List bounded configured and inferred service identities and repository links.",
    inputSchema: { type: "object", properties: {
      repo_ids: stringArray("Repository identifiers."), include_unlinked: { type: "boolean" }, limit: integer("Maximum services and links.", 1, 5000),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_cross_repository_topology",
    description: "Match static clients to endpoints across indexed repositories with confidence and ambiguity evidence. By default this idempotently refreshes inferred local service identities first.",
    inputSchema: { type: "object", properties: {
      repo_ids: stringArray("Repository identifiers."), protocol: { type: ["string", "null"], enum: ["http", "graphql", "grpc", "websocket", "queue", null] },
      min_confidence: { type: "number", minimum: 0, maximum: 1 }, limit: integer("Maximum matches.", 1, 5000),
      relationship_limit: integer("Maximum static relationship records.", 1, 20000),
      max_candidates_per_operation: integer("Maximum candidates per operation.", 1, 100),
      max_operations: integer("Maximum operations analyzed.", 1, 50000), refresh_identities: { type: "boolean" },
    }, additionalProperties: false },
    annotations: localRefresh,
  },
  {
    name: "get_service_diagram",
    description: "Return repository/service nodes and static call/identity edges after idempotently refreshing inferred local service identities.",
    inputSchema: { type: "object", properties: {
      repo_ids: stringArray("Repository identifiers."), protocol: { type: ["string", "null"], enum: ["http", "graphql", "grpc", "websocket", "queue", null] },
      min_confidence: { type: "number", minimum: 0, maximum: 1 }, limit: integer("Maximum matches.", 1, 5000),
    }, additionalProperties: false },
    annotations: localRefresh,
  },
  {
    name: "get_service_callers",
    description: "Return bounded inbound, outbound, and unresolved static callers after idempotently refreshing inferred local service identities.",
    inputSchema: { type: "object", properties: {
      repo_id: { type: ["string", "null"] }, service_key: { type: ["string", "null"] },
      direction: { type: "string", enum: ["inbound", "outbound", "both"] },
      protocol: { type: ["string", "null"], enum: ["http", "graphql", "grpc", "websocket", "queue", null] },
      min_confidence: { type: "number", minimum: 0, maximum: 1 }, limit: integer("Maximum rows per section.", 1, 2000),
    }, additionalProperties: false },
    annotations: localRefresh,
  },
  {
    name: "calculate_cyclomatic_complexity",
    description: "Compute bounded AST-backed cyclomatic and cognitive complexity for indexed JS/TS and Python callables.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), file_path: string("Optional repository-relative path filter."), language: string("Optional language filter."),
      minimum_cyclomatic: { type: "number", minimum: 0 }, minimum_cognitive: { type: "number", minimum: 0 },
      include_unavailable: { type: "boolean" }, limit: integer("Maximum findings.", 1, 500),
      max_symbols: integer("Maximum callables analyzed.", 1, 20000), max_body_bytes: integer("Aggregate body-byte budget.", 1, 134217728),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "find_hotspots",
    description: "Rank complexity by recency-decayed local symbol churn with explicit history coverage.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), file_path: string("Optional path filter."), language: string("Optional language filter."),
      minimum_score: { type: "number", minimum: 0 }, limit: integer("Maximum findings.", 1, 500),
      max_symbols: integer("Maximum callables analyzed.", 1, 20000), max_body_bytes: integer("Aggregate body-byte budget.", 1, 134217728),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "find_dead_code",
    description: "Return conservative zero-observed-incoming-use candidates with exclusions and uncertainty evidence; this is not runtime proof.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), file_path: string("Optional path filter."), language: string("Optional language filter."),
      limit: integer("Maximum candidates.", 1, 500), max_symbols: integer("Maximum symbols examined.", 1, 20000),
      max_body_bytes: integer("Aggregate body-byte budget.", 1, 134217728),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "find_bridge_symbols",
    description: "Find articulation and boundary brokers in a bounded resolved symbol/file graph projection.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), entity_type: { type: "string", enum: ["both", "symbol", "file"], description: "Graph projection; defaults to both." },
      minimum_degree: { type: "number", minimum: 0 }, limit: integer("Maximum findings.", 1, 500),
      max_nodes: integer("Maximum graph nodes.", 1, 100000), max_edges: integer("Maximum graph edges.", 1, 1000000),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_style_fingerprint",
    description: "Measure bounded empirical JS/TS and Python style conventions with counts, confidence, and lexical caveats.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), file_path: string("Optional path filter."), language: string("Optional language filter."),
      max_symbols: integer("Maximum callable sample.", 1, 20000), max_body_bytes: integer("Aggregate body-byte budget.", 1, 134217728),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "upsert_process_model",
    description: "Create or replace a configured static process from ordered indexed symbol keys and explicit evidence.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), process_key: string("Stable configured process key."), name: string("Process name."),
      start_kind: { type: "string", enum: ["api_route", "entry_point", "configured"] }, start_identity: string("Start identity."),
      steps: objectArray("Ordered steps containing symbol_stable_key and optional static edge evidence."), evidence: { type: "object" },
      aggregate_confidence: { type: "number", minimum: 0, maximum: 1 }, minimum_confidence: { type: "number", minimum: 0, maximum: 1 },
      terminal_reason: string("Static terminal reason."),
    }, required: ["process_key", "name", "steps", "evidence"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "retire_process_model",
    description: "Retire a configured or inferred process without deleting its evidence.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), process_key: string("Stable process key."),
    }, required: ["process_key"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "refresh_processes",
    description: "Refresh persistent static execution processes from bounded route and entry-point call flows.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), include_routes: { type: "boolean" }, include_entry_points: { type: "boolean" },
      route_path: { type: ["string", "null"] }, method: { type: ["string", "null"] },
      max_depth: integer("Maximum call depth.", 1, 20), max_processes: integer("Maximum process candidates.", 1, 1000),
      max_starts: integer("Maximum starting symbols.", 1, 500), max_branching: integer("Maximum callees per step.", 1, 50),
      min_confidence: { type: "number", minimum: 0, maximum: 1 }, max_retired: integer("Maximum retained inferred retirements.", 0, 10000),
    }, additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "list_processes",
    description: "List bounded persistent static processes with source, confidence, and step counts.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), active: { type: ["boolean", "null"] },
      source: { type: ["string", "null"], enum: ["configured", "inferred", null] }, limit: integer("Maximum processes.", 1, 1000),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_process_flow",
    description: "Read one ordered static process flow and its resolved-edge evidence.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), process_key: string("Stable process key."), include_retired: { type: "boolean" },
    }, required: ["process_key"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_process_membership",
    description: "Find processes containing a symbol, repository-relative file, or process key.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), symbol_stable_key: string("Indexed symbol stable key."),
      file_path: string("Repository-relative path."), process_key: string("Stable process key."),
      include_retired: { type: "boolean" }, limit: integer("Maximum memberships.", 1, 5000),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "list_process_refreshes",
    description: "List bounded process refresh diffs and observation scopes.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), since: { type: ["string", "null"] }, limit: integer("Maximum refreshes.", 1, 1000),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_codebase_briefing",
    description: "Compose a bounded local architecture, process, quality, decision, temporal, and index briefing without inventing missing evidence.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), process_limit: integer("Maximum processes.", 1, 500),
      decision_limit: integer("Maximum decisions.", 1, 100), hotspot_limit: integer("Maximum hotspots.", 1, 100),
      community_limit: integer("Maximum communities.", 1, 50), central_symbol_limit: integer("Maximum central symbols.", 1, 100),
      hotspot_max_symbols: integer("Maximum symbols analyzed for hotspots.", 1, 20000),
      hotspot_max_body_bytes: integer("Hotspot body-byte budget.", 1024, 268435456),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_daily_briefing",
    description: "Summarize a local time window plus current architecture, process, hotspot, and decision context.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), since: { type: ["string", "null"] }, now: { type: ["string", "null"] },
      change_limit: integer("Maximum recent changes.", 1, 500), process_change_limit: integer("Maximum process changes.", 1, 200),
      decision_limit: integer("Maximum decisions.", 1, 100), process_limit: integer("Maximum processes.", 1, 500),
      hotspot_limit: integer("Maximum hotspots.", 1, 100),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "review_change",
    description: "Review a diff or changed ranges locally using graph impact, history, quality, processes, contracts, and bounded non-executable rules; never post or mutate source.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), diff: { type: ["string", "null"], description: "Unified diff, capped at 2 MiB and 50,000 lines." },
      changes: objectArray("Repository-relative changed line ranges when no diff is available."),
      rules: objectArray("Optional non-executable literal review rules."), rules_text: { type: ["string", "null"], description: "Optional bounded JSON or YAML-subset rule configuration." },
      rules_path: { type: ["string", "null"], description: "Optional repository-local rule file path." }, thresholds: { type: ["object", "null"] },
      impact_depth: integer("Maximum upstream impact depth.", 1, 15), include_cochange: { type: "boolean" },
      max_changed_symbols: integer("Maximum changed symbols analyzed.", 1, 500), max_findings: integer("Maximum findings.", 1, 500),
      max_body_bytes: integer("Aggregate source-body budget.", 1024, 8388608), max_process_flows: integer("Maximum process flows.", 1, 200),
    }, additionalProperties: false },
    annotations: readOnly,
  },
  ...FLEET_TOOL_DEFINITIONS,
];

function resolveRepository(db, repoId = null) {
  if (repoId != null) {
    const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId);
    if (!row) throw new Error(`Repository not indexed: ${repoId}`);
    return row;
  }
  const rows = db.prepare("SELECT * FROM repositories ORDER BY indexed_at DESC, id DESC").all();
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new Error("No indexed repository found");
  throw new Error("repo_id is required when the database contains multiple repositories");
}

function semanticSnapshot(db, repository) {
  const row = db.prepare(`
    SELECT COUNT(*) AS symbols, COALESCE(MAX(updated_at), '') AS newest
    FROM symbols WHERE repo_id = ?
  `).get(repository.id);
  return {
    generation: `${repository.indexed_at ?? ""}:${row.symbols}:${row.newest}`,
    documents: Number(row.symbols),
  };
}

async function semanticIndex(db, repository) {
  let byRepository = semanticCaches.get(db);
  if (!byRepository) {
    byRepository = new Map();
    semanticCaches.set(db, byRepository);
  }
  const snapshot = semanticSnapshot(db, repository);
  const { generation } = snapshot;
  const cached = byRepository.get(repository.id);
  if (cached?.generation === generation) return { ...cached, cacheHit: true };
  if (snapshot.documents > MAX_HYBRID_DOCUMENTS) {
    const value = {
      generation,
      index: null,
      documents: snapshot.documents,
      indexedDocuments: 0,
      buildMs: 0,
      overflow: true,
      cacheHit: false,
    };
    byRepository.set(repository.id, value);
    return value;
  }
  const documents = db.prepare(`
    SELECT s.id, s.stable_key, s.name, s.qualified_name, s.kind, s.signature,
      SUBSTR(s.body_text, 1, ?) AS body_text, s.start_line, s.end_line, s.exported,
      f.path AS file_path, f.language
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? ORDER BY s.id
    LIMIT ?
  `).all(HYBRID_BODY_LIMIT, repository.id, MAX_HYBRID_DOCUMENTS);
  const started = performance.now();
  const index = await createHybridSearchIndex(documents, {
    bodyLimit: HYBRID_BODY_LIMIT,
    maxDocuments: MAX_HYBRID_DOCUMENTS,
  });
  const value = {
    generation,
    index,
    documents: snapshot.documents,
    indexedDocuments: documents.length,
    buildMs: Number((performance.now() - started).toFixed(1)),
    overflow: false,
    cacheHit: false,
  };
  byRepository.set(repository.id, value);
  return value;
}

function bestTermEvidence(lines, firstLine, lastLine, query) {
  const queryTerms = [...new Set(tokenizeCodeText(query).filter((term) => term.length >= 3))];
  let best = null;
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const source = lines[lineNumber - 1] ?? "";
    const lowerLine = source.toLocaleLowerCase();
    const lineTerms = new Set(tokenizeCodeText(source.slice(0, 100_000)));
    const matchedTerms = queryTerms.filter((term) => lineTerms.has(term));
    if (matchedTerms.length > (best?.matchedTerms.length ?? 0)) best = { line: lineNumber, source, matchedTerms };
  }
  return best?.matchedTerms.slice(0, 3).map((term) => {
    const column = best.source.toLocaleLowerCase().indexOf(term);
    return {
      line: best.line,
      column: column + 1,
      end_column: column + term.length + 1,
      exact: false,
      preview: best.source.trim().slice(0, 500),
    };
  }) ?? [];
}

function resultEvidence(repository, result, query, contextLines) {
  const absolute = path.resolve(repository.root, result.file_path);
  const relative = path.relative(repository.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { literal_matches: [], source_context: null };
  let lines;
  try {
    lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  } catch {
    return { literal_matches: [], source_context: null };
  }
  const firstLine = Math.max(1, Number(result.start_line) || 1);
  const lastLine = Math.min(lines.length, Math.max(firstLine, Number(result.end_line) || firstLine));
  const exactMatches = [];
  const insensitiveMatches = [];
  const lowerQuery = query.toLocaleLowerCase();
  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    let column = line.indexOf(query);
    while (column >= 0 && exactMatches.length < 20) {
      exactMatches.push({ line: lineNumber, column: column + 1, end_column: column + query.length + 1, exact: true, preview: line.trim().slice(0, 500) });
      column = line.indexOf(query, column + Math.max(1, query.length));
    }
    if (!exactMatches.length) {
      const insensitiveColumn = line.toLocaleLowerCase().indexOf(lowerQuery);
      if (insensitiveColumn >= 0 && insensitiveMatches.length < 20) {
        insensitiveMatches.push({ line: lineNumber, column: insensitiveColumn + 1, end_column: insensitiveColumn + query.length + 1, exact: false, preview: line.trim().slice(0, 500) });
      }
    }
  }
  const termMatches = bestTermEvidence(lines, firstLine, lastLine, query);
  const literalMatches = exactMatches.length ? exactMatches : (insensitiveMatches.length ? insensitiveMatches : termMatches);
  const center = literalMatches[0]?.line ?? firstLine;
  const contextStart = Math.max(1, center - contextLines);
  const contextEnd = Math.min(lines.length, center + contextLines);
  return {
    literal_matches: literalMatches,
    source_context: {
      start_line: contextStart,
      end_line: contextEnd,
      content: lines.slice(contextStart - 1, contextEnd).map((line, index) => `${contextStart + index}: ${line}`).join("\n"),
    },
  };
}

function callGraphPromotionCandidates(db, repository, rankedResults, pageSize) {
  const anchors = rankedResults.slice(0, Math.min(3, pageSize));
  const visibleIds = new Set(rankedResults.slice(0, pageSize).map((result) => result.id));
  const candidateById = new Map(rankedResults.map((result, index) => [result.id, { result, index }]));
  const anchorIndex = new Map(anchors.map((result, index) => [result.id, index]));
  const rows = db.prepare(`
    SELECT e.source_symbol_id, e.target_symbol_id, e.label, e.confidence
    FROM edges e
    WHERE e.repo_id = ? AND e.kind = 'calls'
      AND e.source_symbol_id IN (${anchors.map(() => "?").join(",")})
    ORDER BY e.confidence DESC, e.id
  `).all(repository.id, ...anchors.map((result) => result.id));
  return rows.map((row) => {
    const candidate = candidateById.get(row.target_symbol_id);
    const anchor = candidateById.get(row.source_symbol_id);
    if (!candidate || !anchor || visibleIds.has(row.target_symbol_id)) return null;
    if (candidate.result.score < anchor.result.score * 0.25) return null;
    return {
      ...row,
      anchor_index: anchorIndex.get(row.source_symbol_id),
      candidate_index: candidate.index,
      result: candidate.result,
    };
  }).filter(Boolean).sort((left, right) => left.anchor_index - right.anchor_index
    || left.candidate_index - right.candidate_index
    || right.confidence - left.confidence
    || left.target_symbol_id - right.target_symbol_id);
}

function selectGraphPromotions(eligible, pageSize) {
  const promotionLimit = Math.max(1, Math.min(2, Math.floor(pageSize / 3)));
  const promoted = [];
  const promotedIds = new Set();
  for (const item of eligible) {
    if (promoted.length >= promotionLimit) break;
    if (promotedIds.has(item.target_symbol_id)) continue;
    promotedIds.add(item.target_symbol_id);
    promoted.push({
      source_symbol_id: item.source_symbol_id,
      result: {
        ...item.result,
        graph_promotion: {
          kind: "calls",
          source_symbol_id: item.source_symbol_id,
          label: item.label,
          confidence: item.confidence,
        },
      },
    });
  }
  return { promoted, promotedIds };
}

function reorderWithGraphPromotions(rankedResults, promoted, promotedIds) {
  const promotionsBySource = new Map();
  for (const promotion of promoted) {
    const matching = promotionsBySource.get(promotion.source_symbol_id) ?? [];
    matching.push(promotion.result);
    promotionsBySource.set(promotion.source_symbol_id, matching);
  }
  const reordered = [];
  for (const result of rankedResults) {
    if (promotedIds.has(result.id)) continue;
    reordered.push(result);
    reordered.push(...(promotionsBySource.get(result.id) ?? []));
  }
  return reordered;
}

function promoteCallGraphNeighbors(db, repository, rankedResults, pageSize) {
  if (rankedResults.length <= 1 || pageSize <= 1) return rankedResults;
  const eligible = callGraphPromotionCandidates(db, repository, rankedResults, pageSize);
  const { promoted, promotedIds } = selectGraphPromotions(eligible, pageSize);
  return promoted.length
    ? reorderWithGraphPromotions(rankedResults, promoted, promotedIds)
    : rankedResults;
}

const HYBRID_GRAPH_WINDOW_LIMIT = 101;
const GRAPH_PROMOTION_RANKING_SIZE = 6;

async function stableHybridSearchPage(index, db, repository, query, searchOptions, cursor, requested) {
  if (cursor >= HYBRID_GRAPH_WINDOW_LIMIT) {
    return index.search(query, { ...searchOptions, limit: requested, offset: cursor });
  }
  const rankedWindow = await index.search(query, {
    ...searchOptions,
    limit: HYBRID_GRAPH_WINDOW_LIMIT,
    offset: 0,
  });
  const rerankedWindow = promoteCallGraphNeighbors(
    db,
    repository,
    rankedWindow,
    GRAPH_PROMOTION_RANKING_SIZE,
  );
  const page = rerankedWindow.slice(
    cursor,
    Math.min(HYBRID_GRAPH_WINDOW_LIMIT, cursor + requested),
  );
  if (rankedWindow.length < HYBRID_GRAPH_WINDOW_LIMIT || page.length >= requested) return page;
  const tail = await index.search(query, {
    ...searchOptions,
    limit: requested - page.length,
    offset: HYBRID_GRAPH_WINDOW_LIMIT,
  });
  return [...page, ...tail];
}

function normalizedFindCodeRequest(args) {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required and must be a string");
  if (args.query.length > 4_096) throw new Error("query must be at most 4096 UTF-16 code units");
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  const cursor = Math.max(0, Math.min(Number(args.cursor) || 0, 10_000));
  const contextLines = Math.max(0, Math.min(args.context_lines == null ? 4 : Number(args.context_lines) || 0, 20));
  return { limit, cursor, contextLines, requested: Math.min(101, limit + 1) };
}

function findCodeFilters(args) {
  return {
    filePath: args.file_path ?? null,
    kind: args.kind ?? null,
  };
}

function lexicalFallbackPage(db, repository, args, filters, cached, request) {
  const lexicalPage = findCode(db, {
    repoId: repository.repo_id,
    query: args.query,
    ...filters,
    limit: request.requested,
    offset: request.cursor,
  });
  const hasMore = lexicalPage.length > request.limit;
  const results = lexicalPage.slice(0, request.limit).map((result) => ({
    ...result,
    ...resultEvidence(repository, result, args.query, request.contextLines),
  }));
  return {
    repo_id: repository.repo_id,
    mode: "lexical-local-fallback",
    index: {
      documents: cached.documents,
      indexed_documents: 0,
      cache_hit: cached.cacheHit,
      build_ms: cached.buildMs,
      truncated: true,
      reason: "max_hybrid_documents",
      maximum: MAX_HYBRID_DOCUMENTS,
    },
    query_ms: 0,
    page: {
      cursor: request.cursor,
      next_cursor: hasMore ? request.cursor + results.length : null,
      has_more: hasMore,
    },
    results,
  };
}

async function hybridFindCode(db, args) {
  const repository = resolveRepository(db, args.repo_id ?? null);
  const request = normalizedFindCodeRequest(args);
  const filters = findCodeFilters(args);
  const lexicalResults = findCode(db, {
    repoId: repository.repo_id,
    query: args.query,
    ...filters,
    // Keep the lexical fusion set fixed across cursor calls. Growing it with the
    // cursor changes scores between pages and can duplicate or skip results.
    limit: 1000,
  });
  const cached = await semanticIndex(db, repository);
  if (cached.overflow) return lexicalFallbackPage(db, repository, args, filters, cached, request);
  const started = performance.now();
  const searchOptions = { lexicalResults };
  if (filters.filePath != null) searchOptions.filePath = filters.filePath;
  if (filters.kind != null) searchOptions.kind = filters.kind;
  const pageResults = await stableHybridSearchPage(
    cached.index,
    db,
    repository,
    args.query,
    searchOptions,
    request.cursor,
    request.requested,
  );
  const hasMore = pageResults.length > request.limit;
  const results = pageResults.slice(0, request.limit).map((result) => ({
    id: result.id,
    stable_key: result.stableKey,
    name: result.name,
    qualified_name: result.qualifiedName,
    kind: result.kind,
    signature: result.signature,
    file_path: result.filePath,
    language: result.language,
    start_line: result.startLine,
    end_line: result.endLine,
    exported: result.exported,
    score: result.score,
    scores: result.scores,
    embedding_provider: result.embeddingProvider,
    embedding_provider_trust: result.embeddingProviderTrust,
    concept_expansion: result.conceptExpansion,
    ...resultEvidence(repository, { file_path: result.filePath, start_line: result.startLine, end_line: result.endLine }, args.query, request.contextLines),
  }));
  return {
    repo_id: repository.repo_id,
    mode: "hybrid-local",
    index: {
      documents: cached.documents,
      indexed_documents: cached.indexedDocuments,
      cache_hit: cached.cacheHit,
      build_ms: cached.buildMs,
      truncated: false,
      maximum: MAX_HYBRID_DOCUMENTS,
    },
    query_ms: Number((performance.now() - started).toFixed(1)),
    page: {
      cursor: request.cursor,
      next_cursor: hasMore ? request.cursor + results.length : null,
      has_more: hasMore,
    },
    results,
  };
}

function rankedCounts(map, key) {
  return [...map.entries()]
    .map(([name, count]) => ({ [key]: name, count }))
    .sort((left, right) => right.count - left.count || (String(left[key]) < String(right[key]) ? -1 : String(left[key]) > String(right[key]) ? 1 : 0))
    .slice(0, 50);
}

function repositoryEvolution(db, args) {
  const mode = args.mode === "overview" ? "summary" : (args.mode ?? "recent");
  if (!new Set(["recent", "compound", "summary"]).has(mode)) throw new Error(`Unsupported evolution mode: ${args.mode}`);
  if (args.cursor != null && args.from != null) throw new Error("Use either cursor or from for repository evolution, not both");
  const since = args.cursor ?? args.from ?? 0;
  const result = getTemporalChangesSince(db, {
    repoId: args.repo_id ?? null,
    since,
    limit: args.limit ?? 100,
    filePath: args.file_path ?? null,
  });
  const to = args.to == null ? null : new Date(args.to);
  if (to && Number.isNaN(to.getTime())) throw new Error("to must be a valid timestamp");
  const episodes = result.episodes.filter((episode) => (!args.kind || episode.type === args.kind)
    && (!to || new Date(episode.reference_time) <= to));
  const totals = { episodes: episodes.length, changes: 0, added: 0, modified: 0, removed: 0, renamed: 0 };
  const files = new Map();
  const symbols = new Map();
  for (const episode of episodes) {
    for (const change of episode.changes) {
      totals.changes += 1;
      if (Object.hasOwn(totals, change.change_type)) totals[change.change_type] += 1;
      const path = change.file_path ?? change.previous_file_path;
      if (path) files.set(path, (files.get(path) ?? 0) + 1);
      if (change.entity_type === "symbol") symbols.set(change.stable_key, (symbols.get(change.stable_key) ?? 0) + 1);
    }
  }
  const common = {
    repo_id: result.repo_id,
    mode,
    from: since,
    to: args.to ?? null,
    totals,
    first_episode: episodes[0] ?? null,
    last_episode: episodes.at(-1) ?? null,
    cursor: result.cursor,
    has_more: result.has_more,
    truncated: result.truncated,
    truncation: result.truncation,
    limits: result.limits,
  };
  if (mode === "recent") return { ...common, episodes };
  if (mode === "summary") return common;
  return { ...common, top_changed_files: rankedCounts(files, "file_path"), top_touched_symbols: rankedCounts(symbols, "stable_key") };
}

function evolutionTool(db, args) {
  if (args.stable_key || args.target || args.entity_type) {
    if (args.cursor != null) throw new Error("cursor is only supported for repository-wide evolution");
    if (args.mode != null || args.kind != null) throw new Error("mode and kind are only supported for repository-wide evolution");
    if (args.from != null && typeof args.from !== "string") throw new Error("lineage evolution from must be a timestamp string");
    return getTemporalEvolution(db, memoryArgs(args));
  }
  return repositoryEvolution(db, args);
}

function temporalSnapshot(snapshot) {
  if (snapshot == null || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  return {
    ...snapshot,
    stableKey: snapshot.stableKey ?? snapshot.stable_key,
    qualifiedName: snapshot.qualifiedName ?? snapshot.qualified_name,
    startLine: snapshot.startLine ?? snapshot.start_line,
    endLine: snapshot.endLine ?? snapshot.end_line,
    bodyHash: snapshot.bodyHash ?? snapshot.body_hash,
    contentHash: snapshot.contentHash ?? snapshot.content_hash,
    lineCount: snapshot.lineCount ?? snapshot.line_count,
    contentAvailable: snapshot.contentAvailable ?? snapshot.content_available,
    skippedReason: snapshot.skippedReason ?? snapshot.skipped_reason,
    gitBlob: snapshot.gitBlob ?? snapshot.git_blob,
  };
}

function memoryArgs(args = {}) {
  const changes = Array.isArray(args.changes) ? args.changes.map((change) => ({
    ...change,
    entityType: change.entityType ?? change.entity_type,
    changeType: change.changeType ?? change.change_type,
    stableKey: change.stableKey ?? change.stable_key,
    previousStableKey: change.previousStableKey ?? change.previous_stable_key ?? null,
    filePath: change.filePath ?? change.file_path ?? null,
    previousFilePath: change.previousFilePath ?? change.previous_file_path ?? null,
    before: temporalSnapshot(change.before),
    after: temporalSnapshot(change.after),
  })) : args.changes;
  return {
    ...args,
    repoId: args.repo_id ?? null,
    decisionId: args.decision_id,
    supersededBy: args.superseded_by ?? null,
    scopeType: args.scope_type ?? null,
    scopeKey: args.scope_key ?? null,
    symbolStableKey: args.symbol_stable_key ?? null,
    filePath: args.file_path ?? null,
    baseReference: args.base_reference ?? "HEAD",
    baseHead: args.base_head ?? null,
    sourceName: args.source_name,
    targetName: args.target_name,
    episodeKey: args.episode_key,
    referenceTime: args.reference_time ?? null,
    sourceId: args.source_id ?? null,
    parentSourceId: args.parent_source_id ?? null,
    authorName: args.author_name ?? null,
    authorEmail: args.author_email ?? null,
    maxCommits: args.max_commits,
    maxFilesPerCommit: args.max_files_per_commit,
    maxFileBytes: args.max_file_bytes,
    maxTotalBlobBytes: args.max_total_blob_bytes,
    entityType: args.entity_type,
    stableKey: args.stable_key ?? null,
    episodeId: args.episode_id ?? null,
    serviceKey: args.service_key ?? null,
    baseUrls: args.base_urls,
    repoIds: args.repo_ids ?? null,
    pruneOrphanService: args.prune_orphan_service ?? false,
    includeUnlinked: args.include_unlinked ?? false,
    minConfidence: args.min_confidence,
    relationshipLimit: args.relationship_limit,
    maxCandidatesPerOperation: args.max_candidates_per_operation,
    maxOperations: args.max_operations,
    refreshIdentities: args.refresh_identities,
    minimumCyclomatic: args.minimum_cyclomatic,
    minimumCognitive: args.minimum_cognitive,
    includeUnavailable: args.include_unavailable,
    minimumScore: args.minimum_score,
    minimumDegree: args.minimum_degree,
    maxSymbols: args.max_symbols,
    maxBodyBytes: args.max_body_bytes,
    maxNodes: args.max_nodes,
    maxEdges: args.max_edges,
    processKey: args.process_key,
    startKind: args.start_kind,
    startIdentity: args.start_identity,
    aggregateConfidence: args.aggregate_confidence,
    minimumConfidence: args.minimum_confidence,
    terminalReason: args.terminal_reason,
    includeRoutes: args.include_routes,
    includeEntryPoints: args.include_entry_points,
    routePath: args.route_path,
    maxDepth: args.max_depth,
    maxProcesses: args.max_processes,
    maxStarts: args.max_starts,
    maxBranching: args.max_branching,
    maxRetired: args.max_retired,
    includeRetired: args.include_retired,
    processLimit: args.process_limit,
    decisionLimit: args.decision_limit,
    hotspotLimit: args.hotspot_limit,
    communityLimit: args.community_limit,
    centralSymbolLimit: args.central_symbol_limit,
    hotspotMaxSymbols: args.hotspot_max_symbols,
    hotspotMaxBodyBytes: args.hotspot_max_body_bytes,
    changeLimit: args.change_limit,
    processChangeLimit: args.process_change_limit,
    rulesText: args.rules_text,
    rulesPath: args.rules_path,
    impactDepth: args.impact_depth,
    includeCochange: args.include_cochange,
    maxChangedSymbols: args.max_changed_symbols,
    maxFindings: args.max_findings,
    maxProcessFlows: args.max_process_flows,
    changes,
  };
}

const ADVANCED_TOOL_CALLS = new Map([
  ["get_decision", (db, values) => getDecisionMemory(db, values)],
  ["get_decision_provenance", (db, values) => getDecisionProvenance(db, values)],
  ["record_structured_decision", (db, values) => recordStructuredDecision(db, values)],
  ["recall_decision", (db, values) => recallDecisionMemory(db, values)],
  ["set_decision_status", (db, values) => setDecisionStatus(db, values)],
  ["verify_intent", (db, values) => verifyDecision(db, values)],
  ["governing_contracts", (db, values) => getGoverningContracts(db, values)],
  ["why_is_this_here", (db, values) => whyIsThisHere(db, values)],
  ["create_worktree_overlay", (db, values) => createWorktreeOverlay(db, values)],
  ["record_worktree_changes", (db, values) => recordWorktreeChanges(db, values)],
  ["get_worktree_overlay", (db, values) => getWorktreeOverlay(db, values)],
  ["list_worktrees", (db, values) => listWorktreeOverlays(db, values)],
  ["plan_worktree_merge", (db, values) => planWorktreeMerge(db, values)],
  ["apply_worktree_merge", (db, values) => applyWorktreeMerge(db, values)],
  ["set_worktree_status", (db, values) => setWorktreeOverlayStatus(db, values)],
  ["replay_history", (db, values) => ingestGitHistory(db, values)],
  ["capture_working_tree_episode", (db, values) => captureWorkingTreeEpisode(db, values)],
  ["record_temporal_episode", (db, values) => recordTemporalEpisode(db, values)],
  ["get_temporal_changes_since", (db, values) => getTemporalChangesSince(db, values)],
  ["get_temporal_timeline", (db, values) => getTemporalTimeline(db, values)],
  ["get_evolution", (db, _values, args) => evolutionTool(db, args)],
  ["get_episode_replay", (db, values) => replayTemporalState(db, values)],
  ["get_temporal_stats", (db, values) => getTemporalStats(db, values)],
  ["upsert_service_identity", (db, values) => upsertServiceIdentity(db, values)],
  ["link_repository_service", (db, values) => linkRepositoryService(db, values)],
  ["unlink_repository_service", (db, values) => unlinkRepositoryService(db, values)],
  ["refresh_service_identities", (db, values) => refreshServiceIdentities(db, values)],
  ["record_service_operations", (db, values) => recordServiceOperations(db, values)],
  ["list_service_identities", (db, values) => listServiceIdentities(db, values)],
  ["get_cross_repository_topology", (db, values) => getCrossRepositoryTopology(db, values)],
  ["get_service_diagram", (db, values) => getServiceDiagram(db, values)],
  ["get_service_callers", (db, values) => getServiceCallers(db, values)],
  ["calculate_cyclomatic_complexity", (db, values) => analyzeComplexity(db, values)],
  ["find_hotspots", (db, values) => getChurnWeightedHotspots(db, values)],
  ["find_dead_code", (db, values) => findDeadCodeCandidates(db, values)],
  ["find_bridge_symbols", (db, values) => findBridgeEntities(db, values)],
  ["get_style_fingerprint", (db, values) => getEmpiricalStyleFingerprint(db, values)],
  ["upsert_process_model", (db, values) => upsertProcessModel(db, values)],
  ["retire_process_model", (db, values) => retireProcessModel(db, values)],
  ["refresh_processes", (db, values) => refreshProcessModels(db, values)],
  ["list_processes", (db, values) => listProcessModels(db, values)],
  ["get_process_flow", (db, values) => getProcessFlow(db, values)],
  ["get_process_membership", (db, values) => getProcessMembership(db, values)],
  ["list_process_refreshes", (db, values) => listProcessRefreshes(db, values)],
  ["get_codebase_briefing", (db, values) => getCodebaseBriefing(db, values)],
  ["get_daily_briefing", (db, values) => getDailyBriefing(db, values)],
  ["review_change", (db, values) => reviewChange(db, values)],
]);

export async function callAdvancedTool(name, args, context) {
  args ??= {};
  if (typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  if (args.repo_id !== undefined && (typeof args.repo_id !== "string" || !args.repo_id.trim())) {
    throw new Error("repo_id must be a non-empty string when provided");
  }
  const fleet = callFleetTool(name, args, context);
  if (fleet.handled) return fleet;
  if (name === "find_code") return { handled: true, value: await hybridFindCode(context.db, args) };
  if (name === "record_structured_decision") {
    const repository = resolveRepository(context.db, args.repo_id ?? null);
    await indexDirectory(context.db, repository.root, {
      repoId: repository.repo_id,
      episodeType: "working_tree",
    });
  }
  const handler = ADVANCED_TOOL_CALLS.get(name);
  if (!handler) return { handled: false };
  return { handled: true, value: await handler(context.db, memoryArgs(args), args) };
}
