# Architecture

Graphward is one local Node process and one SQLite database.

```text
source tree
   |
   +--> Babel AST (JS/TS) --------+
   |        |                     |
   |        +--> exports/types ---+
   |        +--> HTTP values -----+
   |                              |
   +--> CPython AST --------------+--> files, symbols, imports, calls, API operations,
   |                              |    semantic relationships
   +--> heuristic extractors -----+
                                          |
                                 import/export-aware resolver
                                          |
                                          v
                                  SQLite graph + FTS5
                                     |      |       |
                                     |      |       +--> Git log (bounded co-change query)
                                     v      v
                              graph analysis   stdio MCP / CLI / loopback dashboard
                                     |                         |
                                     +--> local Fleet state <--+
```

## Index pipeline

1. Walk supported source files while excluding every dot-prefixed directory and known dependency/build directories.
2. On an incremental run, reuse files whose size and modification time match the stored record. Changed files are read and content-hashed.
3. Parse JavaScript/TypeScript with Babel and Python with CPython's standard-library AST. Other languages use bounded heuristic extractors and are labeled accordingly.
4. Persist symbols, imports, deduplicated call relationships, semantic relationships, API operations, occurrence counts, and parser diagnostics in one transaction.
5. Resolve relative imports, barrel exports, call targets, inheritance/type targets, and endpoint values using same-file ownership plus named, aliased, namespace, default, and CommonJS bindings.
6. Rebuild graph edges only when something changed. A no-op refresh leaves the graph untouched.
7. Update FTS in batches and record an episode only when files or symbols changed.

CLI indexing reports stage timings so performance regressions are observable.

## Data model

- `repositories`: identity, root, current commit, and last index time.
- `files`: language, size/mtime, content hash, and line counts.
- `symbols`: stable keys, exact source spans, signatures, body hashes/text, and module nodes for top-level calls.
- `file_imports`: specifiers plus structured local/imported binding data.
- `symbol_calls`: one row per source/callee/qualifier relationship, occurrence count, first call line, resolution status, target, and confidence.
- `file_diagnostics`: parser mode and recoverable/fallback errors per file.
- `code_relationships`: source-spanned exports/re-exports, inheritance, type references, constructor hints, and endpoint definitions/usages with confidence and raw evidence.
- `api_operations`: statically observed routes, mounts, clients, endpoint-registry paths, methods, source ownership, and confidence.
- `edges`: resolved calls, local file imports, inheritance, and type-reference relationships.
- `episodes` and `episode_changes`: append-only index/change history.
- `decisions` and `decision_links`: explicit rationale and governing-symbol links.
- `temporal_*`: bounded Git/working-tree episodes, entity changes, and validity intervals.
- `local_decision_*` and `local_worktree_*`: structured provenance/contracts and isolated overlays.
- `local_service_*`: explicit and inferred service identities, repository links, and operations.
- `local_process_*`: persistent configured/inferred static process paths and refresh snapshots.
- `fleet_intents`, `fleet_episodes`, `fleet_leases`, `fleet_escalations`, and `fleet_audit`: branch-scoped local agent presence, work, safety, human decisions, and activity.
- `symbols_fts` and `decisions_fts`: local full-text indexes.

Stable symbol keys use `file:qualified-name:kind`, with an occurrence suffix only for ambiguous duplicates in one file. Normal line movement therefore does not change symbol identity.

## Resolution confidence

- `0.99`: same-file/class-qualified target or exact local import path.
- `0.97`: imported binding, namespace member, or CommonJS direct binding.
- `0.70`: unique repository-wide name fallback.

Ambiguous and unresolved calls stay in `symbol_calls` and appear in diagnostics; they are not silently converted into graph edges.

## Query-time analysis

- Repository maps run weighted PageRank over resolved symbol calls, personalize ranks from focus terms, down-rank test helpers unless testing is requested, and stop at an approximate token budget.
- Architecture communities use single-level modularity optimization over weighted file call/import edges. Results are structural groupings, not claimed business-domain truth.
- API topology composes Express-style mount paths through import bindings, canonicalizes parameter syntaxes to `{}`, and links compatible methods and paths. Endpoint registries are confidence `0.75` with method `ANY`; directly observed clients and handlers retain higher confidence.
- Co-change invokes local Git with argument arrays, limits history/commit breadth, ignores generated and lock assets, and scores partners as `cochanges / min(target commits, partner commits)`.
- Dependency paths use bounded breadth-first traversal and prefer higher aggregate confidence at equal depth.
- Execution flows start at statically detected routes and conventional entry points, follow resolved calls only, and stop at configured depth/branch/result bounds.
- Change preflight maps unified-diff ranges to the most-specific symbols, then combines upstream impact, active decisions, local Git co-change, unmapped ranges, and edit breadth into a risk rating and verification list.
- Hybrid search fuses exact identifiers, FTS5/BM25 evidence, and deterministic offline semantic features without a remote embedding request.
- Quality analysis computes bounded AST complexity, temporal hotspots, conservative zero-incoming-use candidates, graph bridges, and empirical style evidence.
- The review engine composes changed-range mapping, graph impact, quality, process, temporal, relationship, and recorded-contract evidence into local structured findings.
- Fleet classifies exact touched-scope overlap between live branch-scoped intents: A for isolated/read-only work, B for concurrent modifications, and C when a destructive rename/delete/signature change overlaps another writer. Intents and leases have bounded TTLs; completed work and resolutions remain in the local audit history.

## Dashboard surface

`src/dashboard.mjs` is an opt-in Node HTTP server that binds only to loopback. It serves three bundled static assets and a narrow allowlisted JSON API backed by the same `callTool` dispatch used by MCP. There is no generic tool-execution endpoint. The Fleet page polls the local `fleet_get_graph` projection every five seconds while visible and renders agent, code-scope, intent, lease, and conflict edges on a bundled canvas.

Every API request requires a random in-memory session token embedded in the same-origin HTML response. Write-style requests additionally require an exact loopback Origin match. Static paths are allowlisted; API bodies, text inputs, query limits, graph sizes, source windows, review diffs, and result counts remain bounded by the dashboard and underlying analysis modules.

## Security boundaries

- Source paths are resolved beneath the repository root and must match an indexed source file before reads.
- Source windows are capped at 200 lines.
- Generated databases under `.graphward/` and every other dot-prefixed directory are excluded from traversal.
- The default MCP transport is process-local stdio; no TCP listener is opened by indexing, querying, or MCP operation.
- Fleet state is stored only in the selected SQLite database. Agent ids, intent summaries, touched scopes, leases, episodes, and resolutions are never published or synchronized externally.
- The optional dashboard accepts only `127.0.0.1`, `::1`, or `localhost`, validates Host headers, sends a strict content-security policy, and requires an unguessable session token for JSON access.
- The runtime has no outbound request implementation, remote asset dependency, telemetry path, or implicit remote fallback.

## Extension path

Parser adapters can replace heuristics language by language without changing the MCP/query/dashboard layers. The next structural priorities are a batched/persistent Python worker, compiler-assisted member/override resolution, broader endpoint/protocol propagation, and more scalable local semantic/vector indexing. Dashboard follow-ups can add saved local layouts and graph filtering without changing the evidence model.
