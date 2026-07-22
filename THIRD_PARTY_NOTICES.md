# Third-party design notices

Graphward through v0.4 contains independent implementations informed by the following permissively licensed projects. No upstream source file was copied wholesale. The v0.4 Python AST, relationship, dependency-path, execution-flow, and change-preflight modules were implemented against Graphward's own contracts and tests; no additional upstream code was copied.

## Aider

- Project: <https://github.com/Aider-AI/aider>
- Relevant component: PageRank-based repository map and token-budgeted presentation
- License: Apache License 2.0
- Copyright: Aider project contributors

## codebase-memory-mcp

- Project: <https://github.com/DeusData/codebase-memory-mcp>
- Relevant components: bounded Git co-change analysis and normalized HTTP route rendezvous
- License: MIT
- Copyright: 2025 DeusData

## Feature references not used as source

- GitNexus (<https://github.com/abhigyanpatwari/GitNexus>), PolyForm Noncommercial 1.0.0: compared for feature coverage only; no source reused.
- Zoekt (<https://github.com/sourcegraph/zoekt>), Apache-2.0: evaluated for search architecture; no source reused.
- code2flow (<https://github.com/scottrogowski/code2flow>), MIT: evaluated for call-graph behavior; no source reused.

Algorithms and public interface ideas were re-expressed against Graphward's own SQLite schema, parser output, tests, and MCP API. If future work copies or modifies a substantial upstream source portion, add the complete required license and file-level modification notices before distribution.
