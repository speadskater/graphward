---
name: graphward-first
description: Route source-code discovery, architecture exploration, debugging, impact analysis, reviews, and pre-edit checks through the local Graphward MCP graph before manual text search or broad file reading. Use for questions about where code lives, how it works, what calls or depends on a symbol, what a change could break, why code exists, what recently changed, and which files or tests should move together.
---

# Graphward First

Use Graphward as the first evidence source for indexed source-code tasks. Keep source, queries, graph data, and decisions local.

## Establish repository context

1. Call `list_indexed_repositories`.
2. Match the current checkout by its exact root. Do not silently use an index for a different worktree or branch.
3. If the checkout is missing, stale, or wrong, call `index_directory` for the current repository path. Use a stable `repo_id` when more than one repository is indexed.
4. Surface stale-index, dirty-checkout, partial-parse, and confidence warnings. Treat missing evidence as `CannotProve`, not as proof that no relationship exists.

## Route the task

- Locate a definition: `find_symbol`.
- Find behavior, concepts, literals, or error text: `find_code`.
- Understand a symbol: find it first, then call `get_symbol_context`; use `get_source_window` only for the narrowed source span.
- Trace callers, callees, types, selectors, or dependencies: `get_code_relationships`, `get_dependency_path`, or `get_execution_flows`.
- Estimate change risk: `get_impact`, then `get_cochange_context` and `governing_contracts` when relevant.
- Explore a repository: `get_codebase_briefing`, `get_architecture`, or `get_repo_map`.
- Investigate APIs or services: `get_api_topology`, `get_service_callers`, or `get_cross_repository_topology`.
- Check rationale and constraints: `recall_decision`, `governing_contracts`, or `why_is_this_here`.
- Inspect history: `get_evolution`, `get_timeline`, `get_changes_since`, or `get_episode_replay`.
- Assess quality: `find_hotspots`, `find_dead_code`, `calculate_cyclomatic_complexity`, or `get_style_fingerprint`.

Use manual text search or broad file reads only after Graphward has narrowed the relevant files, or when Graphward is unavailable or cannot represent the required evidence. Explain the fallback briefly.

## Before and after edits

Before modifying an existing symbol, identify the exact definition and inspect its context, upstream impact, governing decisions, and likely verification targets. Match the repository's measured style when Graphward has sufficient evidence.

After editing:

1. Refresh the index with `index_directory` unless an active watcher has already captured the change.
2. Call `change_preflight` against the current working tree or exact diff.
3. Run the repository's real tests, lint, type checks, or build; Graphward evidence does not replace execution.
4. Use `review_change` for graph-backed review when the change is broad or risky.
5. Record a decision only for durable architectural rationale, bans, conventions, or contracts, not routine edits.

## Evidence rules

- Prefer stable symbol keys and exact file paths when disambiguating results.
- Distinguish static graph evidence from runtime proof.
- Do not claim zero impact, no callers, dead code, or a held contract when Graphward reports incomplete or low-confidence evidence.
- Preserve user changes and do not use Graphward administration tools to mutate source files.
