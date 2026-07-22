# Graphward

[![CI](https://github.com/speadskater/graphward/actions/workflows/ci.yml/badge.svg)](https://github.com/speadskater/graphward/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22.18+](https://img.shields.io/badge/Node.js-22.18%2B-43853d.svg)](package.json)

Graphward is private, local-first code intelligence for coding agents and humans. It builds a static graph of your repositories, keeps the evidence in local SQLite, and exposes bounded search, architecture, impact, history, quality, review, and coordination tools through MCP and a loopback-only dashboard.

There is no hosted service, account, telemetry, remote embedding call, or runtime quota. Codex and Claude Code use the same local graph through one explicit setup command.

> **Public alpha:** Graphward has extensive automated coverage, but interfaces and storage formats may still change before 1.0. Do not treat static analysis as runtime proof.

## Why Graphward

- **Evidence before guesswork:** narrow code exploration with definitions, exact source spans, relationships, and confidence.
- **Local by design:** source, queries, graph data, decisions, and Fleet coordination remain on your machine.
- **Repository-aware:** distinguish worktrees, branches, dirty snapshots, cross-repository services, and incomplete evidence.
- **Agent-ready:** install one shared MCP server and workflow for Codex, Claude Code, or both.
- **Human-readable:** inspect the same evidence in the CLI and local visual dashboard.

## Quick start

Graphward requires Node.js 22.18 or newer; Node.js 24 LTS is recommended.

```shell
git clone https://github.com/speadskater/graphward.git
cd graphward
npm install --global .

# Preview, then configure every detected coding agent.
graphward setup --dry-run
graphward setup

# Start the shared local dashboard and database service.
graphward start
```

Open `http://127.0.0.1:7331`, choose a repository folder, and begin exploring. Setup never installs or silently changes a coding-agent client; it only configures clients already present on `PATH`.

## What works

- Babel AST parsing for JavaScript, JSX, TypeScript, and TSX, including CommonJS and ESM imports.
- CPython AST parsing for Python functions, classes, nesting, decorators, imports, ownership, and calls, with an explicit heuristic fallback when Python is unavailable.
- Heuristic extraction for Go, Rust, Java, C#, Kotlin, Swift, C/C++, PHP, and Ruby.
- Automatic exclusion of every dot-prefixed directory plus dependency/build-output directories.
- Incremental indexing using file metadata and SHA-256 content/symbol hashes. Every generation records its checkout root, linked-worktree identity, commit, branch, dirty files, and snapshot fingerprint; MCP results warn when that generation is stale.
- Hybrid local search combining exact identifiers, FTS5/BM25, and deterministic offline semantic features. Results include exact line/column literal evidence, bounded source context, and cursored continuation. Exact names stay ahead of fuzzy matches and no embedding call leaves the process.
- Import-bound call edges for named, aliased, namespace, default, CommonJS, and barrel re-exports.
- Source-spanned export/re-export, inheritance, type-use, constructor, endpoint-value, and DOM-selector relationships. Selector registries, JSX producers, walkthroughs, tests, and browser consumers are linked through semantic contract edges.
- Caller/callee context, confidence scores, and transitive blast-radius analysis.
- Token-budgeted, focus-aware repository maps ranked with weighted PageRank.
- Architecture overviews with packages, entry points, central symbols, and dependency communities.
- An interactive local 3D code graph with deterministic package clouds, community or symbol-kind coloring, resolved call/import edges, test filtering, orbit/zoom navigation, symbol focus, and source-detail handoff.
- Express/Fastify-style route extraction, mount-prefix composition, `fetch`/Axios/client-wrapper detection, Next.js route inference, and endpoint-registry discovery.
- Bounded local Git co-change analysis that filters broad commits and generated/lock assets.
- Parser and resolution diagnostics through CLI and MCP.
- Shortest dependency paths, bounded route/entry execution flows, and exact-line working-tree change preflight with blast radius, decisions, co-change evidence, risk, and verification targets.
- Bounded repository-safe source reads, first-parent Git and working-tree episodes, symbol timelines/evolution/replay, churn, and debounced watching. History ingestion is explicit so normal indexing remains fast.
- Structured local decisions, contracts, bans, provenance, `Held`/`ViolatedAt`/`CannotProve` verification, and isolated worktree overlays with deterministic three-way merge planning.
- Explicit service identities and repository links, bounded cross-repository endpoint/client rendezvous, service callers, and diagram data.
- AST-backed cyclomatic/cognitive complexity, churn-weighted hotspots, conservative dead-code candidates, bridge symbols/files, and empirical style fingerprints.
- Persistent named static process models inferred from routes and entry points, plus codebase and daily briefings that distinguish missing evidence from measured-empty results.
- A bounded local-only review engine that composes diff-to-symbol mapping, blast radius, co-change, complexity/churn, dead-code evidence, process flows, relationships, recorded contracts, and non-executable local rules. It never posts reviews or mutates source.
- Branch-scoped local Fleet coordination with TTL-backed typed intents, A/B/C overlap classification, exclusive leases, completed-work episodes, human escalation records, and an append-only activity trail.
- A responsive local dashboard for architecture, hybrid search, source context, blast radius, quality, process flows, service topology, Fleet coordination, temporal memory, decisions, and diff review. It binds only to loopback and uses no remote assets.
- Stdio MCP transport with no listening socket.

## Development install

- Node.js 22.18 or newer. Node 24 LTS is recommended.
- npm installs the local `@babel/parser` dependency and links the development CLI.

```powershell
cd C:\path\to\graphward
npm ci
npm test
npm link
```

`npm ci` contacts the npm registry during installation. Indexing, querying, watching, and MCP operation make no network requests.

After linking, start Graphward from any directory:

```powershell
graphward start
graphward status
graphward stop
```

`graphward start` returns after the loopback dashboard is ready and leaves one user-scoped Graphward service running in the background. Its identity and default database do not depend on the current directory. Add repository folders with **Choose folder** in the dashboard; every checkout is indexed into the shared database and watched independently, while checkouts sharing a Git common directory are presented as one project with the main checkout and linked worktrees grouped beneath it. Watchers for all indexed checkouts are restored when the service restarts.

Before launch, Graphward checks total and currently available system memory, reserves headroom for the operating system and non-V8 allocations, and gives the background Node process an adaptive heap of up to 32 GiB. Set `GRAPHWARD_MAX_HEAP_MB` to an integer of at least 512 to override that recommendation for a known workload. The selected resource plan is included in `start`, `status`, and `doctor` output. Lifecycle profiles, state, the shared database, and logs are stored under the current user's local application-data directory.

MCP uses that same user database. When an agent calls Graphward from a project that is not indexed yet, the first repository-scoped tool call starts one shared index job, reports progress when the client supports it, waits for indexing to finish, and then returns the originally requested result. No separate manual indexing command is required.

## Set up coding agents

Graphward has one setup command with provider-specific adapters. Each adapter registers the Graphward MCP server and installs the same bundled `graphward-first` workflow in the client's user-level skill directory. With no target, setup detects Codex and Claude Code on `PATH` and configures every client it finds:

```powershell
graphward setup
```

Select one or more clients explicitly when you want deterministic setup or are scripting an install:

```powershell
graphward setup codex
graphward setup claude
graphward setup --only codex,claude
```

Codex is registered in its shared user MCP configuration and receives the skill at `~/.agents/skills/graphward-first/SKILL.md`. Claude Code is registered with `--scope user` and receives the skill at `~/.claude/skills/graphward-first/SKILL.md` (or beneath `CLAUDE_CONFIG_DIR` when set). The same Graphward server and workflow are therefore available across projects. Both adapters register the current Node executable and Graphward CLI by absolute path and enable watching. The MCP process attaches to the project from which the agent launches it; for Claude Code, Graphward uses Claude's stable `CLAUDE_PROJECT_DIR` value.

Setup is idempotent. Existing matching registrations and skills are left unchanged. A customized skill is never overwritten implicitly; use `--force` to replace the registration and bundled skill after moving or upgrading a source checkout. Use `--dry-run` to inspect the exact commands and destinations without changing either client's configuration:

```powershell
graphward setup --only codex,claude --dry-run
graphward setup codex --force
```

Missing clients are skipped during automatic detection and reported as errors when explicitly requested. Setup does not install Codex or Claude Code. Restart the configured client or open a new session after registration, then use `/mcp` or the client's MCP settings to verify that Graphward is connected.

## Use Graphward with any repository

```powershell
$Graphward = "C:\path\to\graphward"
$Repo = "C:\path\to\your\repository"
$Db = Join-Path $env:LOCALAPPDATA "Graphward\index.sqlite"
$RepoId = "example-repo"

Set-Location $Graphward

node .\src\cli.mjs index $Repo --db $Db --repo-id $RepoId
node .\src\cli.mjs diagnostics --db $Db --repo-id $RepoId
node .\src\cli.mjs architecture --db $Db --repo-id $RepoId
node .\src\cli.mjs map "authentication middleware" --tokens 1200 --db $Db --repo-id $RepoId
node .\src\cli.mjs api /api/users --method GET --db $Db --repo-id $RepoId
node .\src\cli.mjs cochange src/auth.mjs --since "1 year ago" --db $Db --repo-id $RepoId
node .\src\cli.mjs search validateToken --db $Db --repo-id $RepoId
node .\src\cli.mjs impact validateToken --db $Db --repo-id $RepoId --direction upstream --depth 3
node .\src\cli.mjs relationships validateToken --db $Db --repo-id $RepoId
node .\src\cli.mjs path validateToken handleRequest --db $Db --repo-id $RepoId
node .\src\cli.mjs flows --route-path /api/users --max-results 20 --db $Db --repo-id $RepoId
node .\src\cli.mjs preflight .\change.diff --db $Db --repo-id $RepoId

# One background dashboard for every repository in the shared database.
graphward start --db $Db
graphward status
graphward stop
```

Index progress is written to stderr as scan/parse, persist, and resolve stages. `--force` performs a full rebuild; index-format upgrades do this automatically.
Graphward does not assume a repository name, directory layout, route, or symbol. Each index remains scoped by repository path and ID inside the shared user database; the daemon itself is not scoped to any repository.

## Local dashboard

```powershell
$Graphward = "C:\path\to\graphward"
$Repo = "C:\path\to\your\repository"
$Db = Join-Path $Repo ".graphward\index.sqlite"
$RepoId = "example-repo"

Set-Location $Graphward
node .\src\cli.mjs dashboard `
  --root $Repo `
  --db $Db `
  --repo-id $RepoId `
  --watch
```

Open `http://127.0.0.1:7331`. Use **Choose folder** to open the operating system's native folder picker, index that checkout into the current local database, start watching it for changes, and switch the dashboard to its project. The project selector uses the main checkout for code views and groups linked worktrees by their shared Git common directory. The CLI `--root`/`--index` flow remains available for automation, and `--port N` chooses another local port.

The dashboard accepts only `127.0.0.1`, `::1`, or `localhost`, rejects hostile Host headers, and protects every JSON request with an in-memory session token. It has no CDN, remote font, analytics, or external script. Review and process-refresh actions can update the local SQLite evidence/cache tables but never repository source.

### Code graph

Open **Code graph** to explore the indexed program itself. Drag to orbit, use the wheel to zoom, search for a symbol or file, click a point to inspect its graph degree and source location, or double-click to open the full symbol context in Explorer. Calls and imports can be toggled independently; tests can be hidden without rebuilding the projection. Community coloring emphasizes directory topology while symbol-kind coloring distinguishes functions, methods, classes, constructors, and modules.

Open **Efficiency** to see how often Graphward is called through MCP, success and latency, approximate MCP output size, and full-file-equivalent compression. The totals aggregate the main checkout and every indexed linked worktree in the selected project, with a per-checkout breakdown below the tool table. Browser-dashboard and internal calls are not recorded. Full-file-equivalent compression is calculated only when an MCP result cites indexed files: Graphward compares the unique files' measured full sizes with the serialized answer. It is deliberately not labeled context saved because a realistic alternative may use `rg`, bounded reads, caching, or other selective discovery instead of reading complete files. Calls without file evidence have no baseline, and the four-bytes-per-token estimate is neither tokenizer output nor billing data. Collection begins when version 0.10 first opens the database and retains at most 50,000 metadata-only events.

The Full index detail level currently returns up to 8,000 symbols and 32,000 edges; Maximum raises the symbol ceiling to 12,000 and the server-side edge ceiling to 40,000. The graph always displays both indexed and rendered counts, plus whether the view was bounded. `get_code_graph` exposes the same evidence through MCP.

### Fleet control room

Open **Fleet** in the dashboard to see live agents connected to their touched symbols and files. Cyan edges are intents, amber edges are exclusive leases, and red dashed edges are active overlaps. The four panels under the graph show Class C decisions, in-flight and completed work, leases and conflict density, and the durable local activity trail.

The graph is evidence-backed rather than simulated: an agent appears after calling `fleet_publish_intent` with its branch, stable agent id, intent kind, summary, and bounded targets such as `symbol:src/auth.js:authorize:Function` or `file:src/auth.js`. Intents expire after 120 seconds by default so abandoned work does not remain falsely active. Agents should record completion with `fleet_record_episode` or release abandoned work with `fleet_cancel_intent`.

## Manual MCP registration

`graphward setup` is the recommended path. If you need to register the server manually, use the client CLI and the absolute paths for your Node executable and this checkout's `src\cli.mjs`.

### Codex

```powershell
$GraphwardCli = "C:\path\to\graphward\src\cli.mjs"
$Repo = "C:\path\to\your\repository"
$Db = Join-Path $Repo ".graphward\index.sqlite"
$RepoId = "example-repo"

codex mcp add graphward -- node $GraphwardCli serve `
  --root $Repo `
  --db $Db `
  --repo-id $RepoId `
  --index `
  --watch

codex mcp get graphward
codex mcp list
```

Restart Codex after registration so new tasks receive the tool catalog. The MCP process writes protocol messages only to stdout and operational diagnostics only to stderr.

### Claude Code

```powershell
$GraphwardCli = "C:\path\to\graphward\src\cli.mjs"

claude mcp add --scope user --transport stdio graphward -- node $GraphwardCli serve --watch
claude mcp get graphward
claude mcp list
```

User scope makes Graphward available in every Claude Code project without committing an `.mcp.json` file. Open a new Claude Code session and run `/mcp` to verify the connection.

The dashboard and MCP server must use the same `--db` and `--repo-id`; Fleet state is shared through that SQLite database.

Useful agent prompts include:

- “Use Graphward `get_index_diagnostics` before trusting this graph.”
- “Use `get_repo_map` with my task as the focus, then inspect the most relevant symbols.”
- “Find the dependency path from `authorize` to `getUserCompetitionRoles`.”
- “Trace bounded execution flows for `/api/competitions`.”
- “Run `change_preflight` on this diff and give me the required verification targets.”
- “Show exports, inheritance, types, and endpoint relationships for this file.”
- “Record this architectural decision locally and link it to these symbols.”
- “Show Graphward usage and full-file-equivalent compression for the last 30 days.”

For Fleet-aware work, tell each agent: `Before editing, call fleet_publish_intent for this branch and these symbols; call fleet_record_episode when finished.`

## MCP tools

- `index_directory`
- `list_indexed_repositories`
- `get_repository_stats`
- `get_usage_stats`
- `get_index_diagnostics`
- `get_architecture`, `get_code_graph`, `get_repo_map`
- `get_api_topology`, `get_cochange_context`
- `find_symbol`, `find_code`, `get_source_window`
- `get_symbol_context`, `get_code_relationships`, `get_impact`
- `get_dependency_path`, `get_execution_flows`, `change_preflight`
- `get_changes_since`, `get_timeline`
- `watch_directory`, `unwatch_directory`, `list_watched_paths`
- `record_decision`, `recall_decisions`
- Structured decisions: `record_structured_decision`, `get_decision`, `get_decision_provenance`, `recall_decision`, `set_decision_status`, `verify_intent`, `governing_contracts`, `why_is_this_here`
- Worktree memory: `create_worktree_overlay`, `record_worktree_changes`, `get_worktree_overlay`, `list_worktrees`, `plan_worktree_merge`, `apply_worktree_merge`, `set_worktree_status`
- Temporal memory: `replay_history`, `capture_working_tree_episode`, `record_temporal_episode`, `get_temporal_changes_since`, `get_temporal_timeline`, `get_evolution`, `get_episode_replay`, `get_temporal_stats`
- Service topology: `upsert_service_identity`, `link_repository_service`, `unlink_repository_service`, `refresh_service_identities`, `record_service_operations`, `list_service_identities`, `get_cross_repository_topology`, `get_service_diagram`, `get_service_callers`
- Quality: `calculate_cyclomatic_complexity`, `find_hotspots`, `find_dead_code`, `find_bridge_symbols`, `get_style_fingerprint`
- Process memory and briefings: `upsert_process_model`, `retire_process_model`, `refresh_processes`, `list_processes`, `get_process_flow`, `get_process_membership`, `list_process_refreshes`, `get_codebase_briefing`, `get_daily_briefing`
- Local review: `review_change`
- Fleet: `fleet_publish_intent`, `fleet_status`, `fleet_get_graph`, `fleet_cancel_intent`, `fleet_record_episode`, `fleet_acquire_lease`, `fleet_release_lease`, `fleet_list_escalations`, `fleet_resolve_escalation`

`replay_history` is intentionally opt-in and bounded. Run it once when symbol-level Git evolution or churn is needed; ordinary `index_directory` and watched refreshes do not silently walk repository history.

Service topology queries refresh inferred service identities in the local database before matching. `get_cross_repository_topology` can set `refresh_identities: false` to query the existing identity snapshot; `get_service_diagram` and `get_service_callers` always use the idempotent local refresh path.

`get_index_diagnostics` reports parser modes/errors, call relationship and occurrence counts, resolution confidence, unresolved/ambiguous samples, local import resolution, and semantic relationship counts. Unresolved calls include built-ins, third-party APIs, callback parameters, and dynamic dispatch, so the resolution percentage is a transparency metric—not a standalone accuracy score.

`get_api_topology` distinguishes direct clients from endpoint-registry entries through `framework` and `confidence`. Registry paths use method `ANY`: they prove a URL is defined, but not that every matching HTTP verb is called.

## Privacy model

Graphward contains no outbound HTTP client, authentication flow, analytics, updater, remote embedding provider, or hosted documentation call. The optional dashboard is a loopback-only HTTP server; MCP remains stdio-only. Its only runtime dependency is a parser loaded from local `node_modules`. You can additionally deny outbound network access to the Node process with an OS firewall rule; core operation does not require access.

## Known limitations

- Python requires a local Python 3.8+ runtime for structured parsing. Spawning CPython per changed file is correctness-first but adds full-index overhead on Python-heavy repositories; a persistent/batched worker is the next performance priority.
- Non-JavaScript/Python languages still use heuristic parsing.
- Member calls on runtime values and third-party package APIs are usually unresolved without project/compiler type information.
- Export, inheritance, and type records are explicit, but override detection and deep generic/type-flow resolution remain incomplete.
- Offline semantic ranking is deterministic feature hashing with code-aware concept hints, not a learned embedding model; it is intentionally explainable and dependency-free.
- API and service topology are static and framework-pattern-based. Dynamically constructed URLs, runtime registration, and deep GraphQL/gRPC/message schema analysis remain incomplete.
- Code Graph projections are bounded to 12,000 rendered symbols and 40,000 rendered edges. Larger repositories preserve explicit indexed-versus-rendered counts and prioritize PageRank-central symbols while reserving representation for every retained package community.
- Temporal memory is bounded first-parent history and must be explicitly ingested. It is not a full Git object database or branch-merging model.
- Execution processes are bounded static resolved-call paths, not observed runtime traces. Graphward rejects evidence that claims otherwise.
- Dead-code results prove only zero observed incoming static use after conservative exclusions; reflection, registries, generated code, and runtime loaders can still exist.
- The review engine returns local structured findings only. It does not execute arbitrary rule code, perform whole-program data-flow proof, or publish to GitHub.
- Multi-agent fleet voting and conflict arbitration are not included; named overlays cover isolated local graph experiments, not concurrent source editing.
- Node currently labels `node:sqlite` experimental and may print a warning to stderr.

## Tests and evaluation

```powershell
corepack npm@11.7.0 test
node .\scripts\benchmark-parse.mjs "C:\path\to\repository"
```

The suite covers AST symbol spans and parser fallbacks, Python ownership/imports/calls, ESM aliases, barrel/CommonJS exports, inheritance/types, endpoint values, confidence, hybrid search, transitive impact, dependency paths, execution flows, diff preflight/review, mount-composed API and service topology, PageRank maps, architecture, Git co-change and temporal replay, forced/no-op refreshes, structured decisions, worktree overlays, Fleet conflicts/leases/escalations, quality analysis, process memory, briefings, end-to-end MCP stdio exchange, and the token-protected loopback dashboard API.

See [FEATURE_AUDIT.md](FEATURE_AUDIT.md) for the GitHub comparison that drove v0.3 and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for design-source attribution.
