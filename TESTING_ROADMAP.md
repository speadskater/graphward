# Graphward Testing Roadmap

This is the living inventory of evidence needed to show that Graphward improves coding-agent outcomes accurately, efficiently, and safely. It deliberately distinguishes component correctness from real task effectiveness.

Last reviewed: 2026-07-22
Baseline commit: `4ad6a01`
Current suite: 129 tests, 128 passing, 1 environment-dependent skip, 0 failures
Current deterministic system evaluation: 8 cases in [`benchmarks/system-evaluation.json`](benchmarks/system-evaluation.json)
Current live retrieval evaluation: 3 queries and 4 targets in [`benchmarks/continuous-cup-authorization.json`](benchmarks/continuous-cup-authorization.json)
Current live response-size samples: Continuous Cup and aq-test

## How to maintain this document

Use these states:

- `COVERED`: repeatable evidence exercises the stated risk at the appropriate level.
- `PARTIAL`: a unit/fixture test or narrow experiment exists, but the stated outcome is not yet proven.
- `IN PROGRESS`: an active work item is adding evidence now.
- `UNTRIED`: no direct evidence was found.
- `BLOCKED`: the test has a named prerequisite that is currently unavailable.

Use these priorities:

- `P0`: required to prove Graphward's central accuracy/token-efficiency claim.
- `P1`: high-risk correctness or operational behavior.
- `P2`: important breadth, compatibility, and product quality.
- `P3`: hardening or uncommon edge cases.

An item moves to `COVERED` only when its evidence is linked in the **What we have / definition of done** column. A passing implementation-level test must not be used to mark an agent-outcome item covered.

## Program-improvement rule

The purpose of this roadmap is to improve Graphward, not to maximize test count. Every implemented test must include or clearly imply:

1. **User-visible failure:** the missed finding, wrong result, wasted call/token, stale state, hang, unsafe behavior, or misleading evidence it can expose.
2. **Improvement hypothesis:** which Graphward behavior should change if the test fails.
3. **Measurable signal:** accuracy, completeness, precision, rank, calls, bytes/tokens, latency, determinism, recovery, or safety.
4. **Actionable failure output:** enough diagnostics to identify the responsible retrieval, graph, index, protocol, or product stage.
5. **Before/after evidence:** a legitimate failure should lead to a narrow implementation fix and a demonstrated improvement, not an assertion weakened to match current behavior.

Tests that only mirror implementation details, preserve accidental behavior, or add coverage without a plausible product improvement should not be added. When a proposed test cannot drive an actionable change, leave the roadmap item open and refine the experiment first.

## Active tranche

| Track | Status | Scope | Improvement evidence |
|---|---|---|---|
| Retrieval robustness | COMPLETE | Negative/no-answer behavior, query perturbations, ambiguity, decoys, filters, pagination | Fixed typo ranking from rank 4 to rank 1 and removed a graph-promotion cursor duplicate across more than 101 results |
| Watcher integration | COMPLETE | Real add/edit/delete/rename events, debounce, ignores, lifecycle | Fixed a queued reindex that ran after watcher stop/close and caused stale work |
| MCP robustness | COMPLETE | Malformed/partial input, JSON-RPC errors, notifications, concurrency, shutdown | Fixed three protocol defects, including indexing head-of-line blocking later pings |
| Roadmap integration | COMPLETE | Maintain this matrix, integrate files, run full verification | 129-test suite, deterministic system/live retrieval budgets, response-size checks, and Graphward preflight/review completed |

## A. Agent effectiveness and measurement

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| AE-001 | P0 | PARTIAL | Repeated randomized blind with/without trials | Small prior comparisons exist. Done: repeated counterbalanced tasks with identical prompts and hidden condition assignment. |
| AE-002 | P0 | UNTRIED | Final task correctness | Retrieval targets are scored, not completed answers. Done: independent task-level oracle grades final outputs. |
| AE-003 | P0 | UNTRIED | Finding completeness | Continuous Cup exposed missed findings. Done: labeled audits score every required finding and omission. |
| AE-004 | P0 | UNTRIED | Hallucination and unsupported claims | Done: every reported claim is classified supported, contradicted, or CannotProve. |
| AE-005 | P0 | UNTRIED | Real tokenizer measurement | Current estimates use UTF-8 bytes divided by four. Done: model-specific tokenizer counts every exchanged payload. |
| AE-006 | P0 | UNTRIED | Actual model/billing tokens | Usage telemetry is MCP-output-only. Done: provider usage records include prompt, cached, and completion tokens. |
| AE-007 | P0 | UNTRIED | Total task cost | Done: include system/tool schemas, prompts, retries, Graphward calls, shell reads, and final answer. |
| AE-008 | P1 | UNTRIED | Wall-clock completion time | Per-call latency exists. Done: task start-to-accepted-answer latency with timeouts and failures. |
| AE-009 | P0 | PARTIAL | Tool-call savings across task types | Three-call retrieval and response benchmarks exist. Done: compare full task call totals across a diverse suite. |
| AE-010 | P0 | UNTRIED | Fallback discovery use | Done: count `rg`, file reads, shell searches, and non-Graphward discovery bytes per condition. |
| AE-011 | P1 | UNTRIED | Result utilization | Done: trace which returned evidence appears in reasoning, edits, verification, or final claims. |
| AE-012 | P1 | UNTRIED | Multi-turn tasks | Done: tasks require retained evidence and follow-up changes over multiple turns. |
| AE-013 | P1 | UNTRIED | Long-horizon implementation | Done: agents diagnose, edit, test, and explain nontrivial changes rather than only retrieve. |
| AE-014 | P1 | UNTRIED | Context-window pressure | Done: repeat tasks with large prior histories and measure eviction/re-reading behavior. |
| AE-015 | P0 | UNTRIED | Statistical confidence | Done: preregister repetitions and report variance, confidence intervals, and effect sizes. |
| AE-016 | P0 | UNTRIED | Agent/model/order counterbalancing | Done: rotate agents, models, task order, and conditions to isolate Graphward's effect. |
| AE-017 | P1 | UNTRIED | Human usefulness grading | Done: blinded reviewers score correctness, clarity, actionability, and evidence quality. |
| AE-018 | P2 | UNTRIED | Inter-rater agreement | Done: report agreement and adjudicate disagreements in subjective labels. |
| AE-019 | P0 | UNTRIED | Holdout repositories | Existing repos informed tuning. Done: lock a never-tuned multi-domain holdout set. |
| AE-020 | P0 | UNTRIED | Feature ablations | Done: compare lexical, semantic, graph promotion, compaction, and dedupe components independently. |

## B. Retrieval and ranking

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| RT-001 | P0 | PARTIAL | Large independent labeled corpus | Current system/live manifests contain 11 total cases. Done: hundreds of independently labeled queries across domains. |
| RT-002 | P0 | PARTIAL | Precision, nDCG, and MAP | Recall, target recall, and MRR exist. Done: add precision@k, nDCG, MAP, and false-positive rate. |
| RT-003 | P0 | PARTIAL | No-relevant-answer behavior | Negative queries now expose zero exact/lexical/concept/external/fuzzy evidence, but a calibrated no-result threshold remains open. |
| RT-004 | P1 | PARTIAL | Typographical errors | Fuzzy identifier evidence moves a three-token misspelling target from rank 4 to rank 1; a larger labeled set remains. |
| RT-005 | P1 | PARTIAL | Noisy conversational prompts | A diagnostic noise case retains its target; broader prompt families remain. |
| RT-006 | P0 | PARTIAL | Paraphrase and synonym robustness | Deterministic semantic examples pass; systematic paraphrase sets remain. |
| RT-007 | P0 | PARTIAL | Adversarial decoy wording | Production evidence defeats a keyword-stuffed test decoy; more decoy classes remain. |
| RT-008 | P0 | PARTIAL | Ambiguous short queries | Common-name ambiguity and deterministic filtering are tested; live ambiguity scoring remains. |
| RT-009 | P0 | PARTIAL | Duplicate symbol names | Duplicates across path/kind combinations are disambiguated; package/live cases remain. |
| RT-010 | P1 | UNTRIED | Overloads and anonymous targets | Inline route callbacks are parsed. Done: retrieve overloads, overrides, constructors, and anonymous handlers correctly. |
| RT-011 | P1 | UNTRIED | Exact literals | Endpoint constants exist. Done: error strings, logs, SQL, routes, and configuration literals have labeled cases. |
| RT-012 | P1 | UNTRIED | Non-symbol content | Done: Markdown, schemas, migrations, SQL, and configuration are intentionally supported or explicitly excluded. |
| RT-013 | P1 | PARTIAL | Combined filters | Path and kind are tested together with ambiguous names; fuzzy/cursor combinations remain. |
| RT-014 | P1 | COVERED | Pagination stability | Full traversals are deterministic, exhaustive, duplicate-free, and repeatable. |
| RT-015 | P1 | COVERED | Pagination after graph promotion | A greater-than-101-result integration case proves promotion does not duplicate or skip across cursors. |
| RT-016 | P0 | UNTRIED | Graph-promotion precision | Promotion fixed one missed target. Done: negative cases prevent unrelated neighbor promotion. |
| RT-017 | P1 | UNTRIED | Competing related neighbors | Done: multiple callers/callees have deterministic, evidence-backed selection. |
| RT-018 | P1 | PARTIAL | Production/test ranking by intent | Natural behavior prefers production in a fixture. Done: explicit test queries and mixed intent select appropriately. |
| RT-019 | P0 | PARTIAL | Source-span accuracy | Centered literal evidence is checked in three cases. Done: labeled spans across languages and constructs. |
| RT-020 | P0 | UNTRIED | Agent citation correctness | Done: final answers cite the right returned file, symbol, and span. |
| RT-021 | P1 | PARTIAL | Cold/warm search | Cache metadata exists. Done: accuracy and latency are compared after cold build, warm reuse, and invalidation. |
| RT-022 | P1 | PARTIAL | Session-dedupe boundaries | Same-session duplicate suppression is tested. Done: restart, repo switch, concurrent session, and failed-call boundaries. |

## C. Languages, parsing, indexing, and repository state

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| LP-001 | P1 | PARTIAL | Live Python retrieval | Python AST fixtures cover definitions/imports/calls. Done: labeled retrieval and impact on a real Python repo. |
| LP-002 | P1 | PARTIAL | Live TypeScript/TSX/JSX retrieval | AST and selector fixtures exist. Done: labeled real application coverage. |
| LP-003 | P2 | UNTRIED | Go and Rust heuristics | Parsers exist without dedicated tests. Done: syntax/relationship/retrieval fixtures and honest confidence. |
| LP-004 | P2 | UNTRIED | Java/C#/Kotlin/Swift/C/C++/PHP/Ruby | Heuristic parsers exist without dedicated suites. Done: per-language fixture and live smoke tests. |
| LP-005 | P1 | UNTRIED | Retrieval quality by language | Done: publish per-language recall, precision, rank, and parse coverage. |
| LP-006 | P1 | UNTRIED | Cross-language relationships | Done: explicit mixed-language service/generated-client cases with bounded confidence. |
| LP-007 | P1 | UNTRIED | Mixed-language monorepos | Done: package boundaries and language balance do not distort rankings. |
| LP-008 | P1 | UNTRIED | Framework matrix | Express-like routes are strongest. Done: representative JS/Python/Java/Ruby framework fixtures/live repos. |
| LP-009 | P2 | UNTRIED | Dynamic constructs | Done: reflection, DI, decorators, runtime registration, and metaprogramming report limitations honestly. |
| LP-010 | P1 | UNTRIED | Configured import aliases | Done: compiler/bundler alias resolution is tested or explicitly marked unresolved. |
| LP-011 | P2 | UNTRIED | Conditional/lazy/circular/re-export chains | Barrel exports have fixture coverage. Done: harder module graphs retain deterministic resolution. |
| LP-012 | P0 | UNTRIED | Relationship-edge precision | Done: labeled false-positive/false-negative corpus for resolved and unresolved edges. |
| LP-013 | P1 | UNTRIED | Partial parser failure | Whole-file fallback is tested. Done: mixed valid/invalid regions preserve valid evidence and diagnostics. |
| LP-014 | P1 | COVERED | Watcher add/edit/delete/rename | Real filesystem events update symbols and paths with bounded graph-observable polling. |
| LP-015 | P1 | COVERED | Watcher rapid edits/debounce | Burst edits converge in one reindex to final content; stop/close cancel queued work. |
| LP-016 | P1 | UNTRIED | Query during indexing | Done: snapshot semantics are explicit and responses never mix generations. |
| LP-017 | P1 | UNTRIED | Concurrent same-repo indexing | Done: requests coalesce or serialize without corruption/duplicate episodes. |
| LP-018 | P1 | UNTRIED | Concurrent multi-repo indexing | Done: repositories remain isolated under parallel indexing. |
| LP-019 | P1 | PARTIAL | Dirty main checkout plus worktrees | Identity/isolation units exist. Done: simultaneous watched changes on main and linked worktrees. |
| LP-020 | P1 | UNTRIED | Branch switching while watched | Done: checkout changes refresh identity/snapshot without stale mixed evidence. |
| LP-021 | P2 | UNTRIED | Dynamic worktree lifecycle | Done: creation/removal while running updates project grouping and watchers. |
| LP-022 | P2 | UNTRIED | Submodules/nested Git repos | Done: ownership and indexing scope are explicit and safe. |
| LP-023 | P1 | UNTRIED | Symlinks and junctions | Hostile relative paths are tested. Done: links cannot escape root or duplicate identities. |
| LP-024 | P2 | UNTRIED | Case-only renames/collisions | Cross-platform path fixes exist. Done: Windows/macOS case behavior has integration coverage. |
| LP-025 | P2 | UNTRIED | Unicode/reserved/long paths | Unicode identifiers are tested. Done: filesystem edge paths are indexed or rejected clearly. |
| LP-026 | P1 | UNTRIED | Generated/vendor/minified/binary/huge files | Body budgets exist. Done: exclusion/resource behavior is tested and reported. |
| LP-027 | P2 | UNTRIED | Ignore rules | Ignored directories exist. Done: nested ignore and `.gitignore` semantics are explicit and tested. |
| LP-028 | P2 | UNTRIED | Repository relocation/deletion | Done: stale entries and watchers fail safely and can be cleaned up. |
| LP-029 | P1 | PARTIAL | Live stale-snapshot behavior | Direct snapshot drift test exists. Done: active agent calls during edits surface consistent warnings/results. |

## D. Graphward subsystem effectiveness

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| FE-001 | P1 | PARTIAL | Architecture-overview usefulness | Fixture structure is asserted. Done: agent architecture answers improve without completeness loss. |
| FE-002 | P1 | PARTIAL | Repository-map usefulness | Token budget is asserted. Done: agent tasks need fewer reads while retaining required modules. |
| FE-003 | P1 | PARTIAL | Large code-graph correctness | Nodes/edges and dashboard API are tested. Done: sampled live ground truth plus scale limits. |
| FE-004 | P1 | PARTIAL | Relationship reasoning beyond calls | Types, exports, routes, selectors exist. Done: system/live cases require each relationship class. |
| FE-005 | P1 | PARTIAL | Downstream/bidirectional impact | Upstream transitive impact is benchmarked. Done: both directions have labeled live changes. |
| FE-006 | P1 | PARTIAL | Impact by edge kind | Several edge kinds are unit-tested. Done: calls/types/selectors/routes/tests are independently scored. |
| FE-007 | P0 | UNTRIED | Rename/delete/signature/behavior impact | Done: change-type corpus identifies exact affected files/tests and false positives. |
| FE-008 | P0 | PARTIAL | Preflight on labeled real diffs | Fixture diff/range tests exist. Done: real PRs have expected risks and verification targets. |
| FE-009 | P1 | PARTIAL | Co-change predictive value | Co-change calculation is tested. Done: prospective holdout commits score precision/recall. |
| FE-010 | P1 | PARTIAL | Complex Git history | First-parent replay/revert fixtures exist. Done: merges, renames, cherry-picks, squashes, and branch histories. |
| FE-011 | P0 | PARTIAL | Decision memory improves later agents | CRUD/scoping/verification tests exist. Done: blinded tasks measure fewer violations/re-discovery calls. |
| FE-012 | P1 | PARTIAL | Contradictory/obsolete decisions | Status and latest observation are tested. Done: live conflicts/supersession produce calibrated guidance. |
| FE-013 | P1 | PARTIAL | Real overlay merges | Merge planning/application units exist. Done: real file edits and Git merge outcomes agree. |
| FE-014 | P0 | PARTIAL | Process memory improves tasks | Inference, refresh, and membership units exist. Done: debugging/retrieval outcomes improve in blinded trials. |
| FE-015 | P1 | UNTRIED | Cyclic/branching/async/retry processes | Done: complex process models preserve order, alternatives, and honest uncertainty. |
| FE-016 | P1 | PARTIAL | Live cross-repository topology | Synthetic multi-repo HTTP fixtures exist. Done: independent services with labeled links/ambiguities. |
| FE-017 | P1 | PARTIAL | Live non-HTTP protocols | Configured/static protocol units exist. Done: real GraphQL/gRPC/WebSocket/queue projects. |
| FE-018 | P1 | PARTIAL | Service identity collision precision | Ambiguous clients are tested. Done: larger collision corpus and honest unresolved results. |
| FE-019 | P0 | PARTIAL | Quality analyzers against labels | Deterministic fixture findings exist. Done: per-analyzer human-labeled precision/recall. |
| FE-020 | P0 | UNTRIED | Quality false-positive/negative corpora | Done: dead code, complexity, hotspots, bridges, and style each have independent ground truth. |
| FE-021 | P0 | PARTIAL | Review on labeled real PRs | Deterministic fixture reviews exist; optional live DB smoke is skipped by default. Done: known-defect PR corpus. |
| FE-022 | P1 | UNTRIED | Security-review accuracy | Done: labeled vulnerable and safe changes measure detection and noise. |
| FE-023 | P1 | PARTIAL | Fleet with simultaneous real agents | Coordination database units exist. Done: concurrent agents publish intents while editing real branches. |
| FE-024 | P1 | UNTRIED | Fleet crash/scope/heartbeat failures | TTL/ownership inputs are tested. Done: killed agents, abandoned leases, and undeclared edits recover safely. |
| FE-025 | P0 | UNTRIED | Fleet conflict reduction | Done: controlled multi-agent tasks measure conflicts, duplicated work, latency, and success. |
| FE-026 | P1 | PARTIAL | Briefing effectiveness | Bounded/missing evidence is tested. Done: agents start tasks faster with equal or better accuracy. |
| FE-027 | P0 | PARTIAL | Usage telemetry vs actual context | MCP bytes/calls are recorded. Done: correlate with provider token/context records and fallback reads. |

## E. Protocol, product, and operational robustness

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| OP-001 | P1 | COVERED | MCP malformed/partial/multiple frames | Malformed JSON/envelopes, empty batches, split/final lines, notifications, errors, and recovery are tested. |
| OP-002 | P1 | PARTIAL | MCP cancellation/disconnect | Notification silence and graceful EOF draining are tested; cancellation of expensive work remains. |
| OP-003 | P1 | PARTIAL | Concurrent MCP clients | Per-line concurrency prevents indexing from blocking ping; multi-process clients/session isolation remain. |
| OP-004 | P1 | UNTRIED | Restart with active calls | Done: clients get explicit failure and restart leaves valid state. |
| OP-005 | P1 | PARTIAL | Real start/status/stop success | Failure and legacy-stop paths exist. Done: installed CLI service lifecycle succeeds in a disposable state directory. |
| OP-006 | P1 | UNTRIED | Watcher restoration after restart | Done: indexed checkouts are rewatched after daemon restart/reboot simulation. |
| OP-007 | P1 | UNTRIED | Abrupt termination cleanup | Done: orphaned PID/state/port files are detected and recovered. |
| OP-008 | P1 | PARTIAL | Install produced npm tarball | CI runs `npm pack --dry-run`. Done: install tarball in a clean prefix and execute CLI/MCP smoke. |
| OP-009 | P1 | UNTRIED | Upgrade/downgrade/uninstall/migration | Done: supported transitions preserve data or fail with actionable rollback guidance. |
| OP-010 | P1 | PARTIAL | Actual Codex/Claude integration | Adapter commands are mocked/unit-tested. Done: fresh client profiles connect and call a tool. |
| OP-011 | P2 | PARTIAL | Existing client-config conflicts | Customized skill conflicts are tested. Done: malformed/duplicate MCP registrations recover safely. |
| OP-012 | P1 | UNTRIED | macOS and Apple Silicon | CI covers Windows/Linux on Node 22.18/24. Done: macOS x64/arm64 jobs. |
| OP-013 | P2 | PARTIAL | Cross-platform filesystem behavior | Windows/Linux CI exists. Done: platform-specific integration suite for watching, paths, signals, and lifecycle. |
| OP-014 | P2 | UNTRIED | Dashboard visual/a11y/responsive | Loopback API/assets are tested. Done: browser rendering, keyboard, screen-reader, and viewport checks. |
| OP-015 | P2 | UNTRIED | Browser compatibility | Done: current Chromium, Firefox, and WebKit smoke coverage. |
| OP-016 | P2 | UNTRIED | Long-running dashboard/large graph | Done: repeated updates and maximum graph sizes stay usable without leaks. |
| OP-017 | P0 | UNTRIED | Very large repository scaling | A 50k-symbol cap exists. Done: representative large repos measure accuracy and truncation behavior. |
| OP-018 | P0 | PARTIAL | Performance regression gates | Parse/MCP scripts exist without CI baselines. Done: index/query/CPU/memory/DB-size budgets block regressions. |
| OP-019 | P1 | UNTRIED | Soak and leak testing | Done: long-running watcher/MCP/dashboard workloads have bounded memory and DB growth. |
| OP-020 | P1 | UNTRIED | Permission/disk-full/locked/corrupt DB failures | Done: safe errors, rollback, and recovery for each storage failure. |
| OP-021 | P1 | PARTIAL | Interrupted migration/index recovery | Schema idempotence/rollback units exist. Done: process interruption at transaction boundaries recovers. |
| OP-022 | P0 | PARTIAL | Cross-run ranking reproducibility | Tie determinism is unit-tested. Done: same corpus matches across order, Node versions, OSes, and repeats. |

## F. Security and test-quality techniques

| ID | Priority | State | Category | What we have / definition of done |
|---|---|---|---|---|
| SQ-001 | P0 | PARTIAL | OS-level no-network proof | Code and dashboard assertions prohibit known fetches. Done: sandbox/proxy test proves zero egress during index/query/review. |
| SQ-002 | P0 | UNTRIED | Source prompt/tool injection | Done: malicious comments/strings cannot redirect agent/tool behavior and are clearly untrusted evidence. |
| SQ-003 | P0 | UNTRIED | Secret leakage | Done: seeded secrets never appear unexpectedly in logs, diagnostics, usage, errors, or broad responses. |
| SQ-004 | P1 | PARTIAL | Dashboard security fuzzing | Token, host, origin, and loopback controls are tested. Done: systematic request/header/path/body fuzzing. |
| SQ-005 | P1 | PARTIAL | Denial-of-service inputs | Several size bounds exist. Done: oversized queries, identifiers, diffs, nesting, and hostile syntax remain bounded. |
| SQ-006 | P1 | UNTRIED | Property-based invariants | Done: generated graphs/episodes/decisions preserve isolation, idempotence, and referential integrity. |
| SQ-007 | P1 | UNTRIED | Fuzz testing | Done: parsers, search, diff, MCP, and configuration fuzzers run with retained regressions. |
| SQ-008 | P1 | UNTRIED | Metamorphic testing | Done: irrelevant renames/order/format changes preserve relevant rankings and graph facts. |
| SQ-009 | P1 | UNTRIED | Mutation testing | Done: score and document surviving mutants; critical retrieval/index/review mutations are killed. |
| SQ-010 | P2 | UNTRIED | Flake detection | Done: repeated, shuffled, stressed runs report and quarantine nondeterminism. |
| SQ-011 | P0 | UNTRIED | Stored benchmark baselines/CI gates | Done: versioned accuracy, bytes/tokens, latency, and memory baselines enforce justified thresholds. |

## P0 execution order

1. Finish the active deterministic retrieval, watcher, and MCP foundations.
2. Build an independently labeled holdout task corpus with negative cases and completeness oracles (`AE-002` through `AE-004`, `AE-019`, `RT-001` through `RT-003`).
3. Build a condition-blind agent runner that records all tools, reads, timings, final answers, and provider usage (`AE-001`, `AE-005` through `AE-010`, `AE-015`, `AE-016`).
4. Run Graphward/no-Graphward and feature-ablation trials (`AE-020`) before tuning on the holdout results.
5. Add relationship and impact precision corpora (`LP-012`, `FE-007`, `FE-008`) because missed or false impact evidence can directly cause incorrect edits.
6. Add real-review and quality ground truth (`FE-019` through `FE-022`).
7. Gate releases on reproducibility, scale, privacy, and stored baselines (`OP-017`, `OP-018`, `OP-022`, `SQ-001` through `SQ-003`, `SQ-011`).

## Evidence log

Append dated entries here whenever status changes. Include the commit, command, environment, result, and affected IDs.

- 2026-07-22 — Created complete baseline inventory at `4ad6a01`.
- 2026-07-22 — Retrieval robustness exposed and fixed typo rank 4 → 1 plus a duplicate at cursor 90; focused retrieval regressions passed 21/21 (`RT-003`–`RT-009`, `RT-013`–`RT-015`).
- 2026-07-22 — Watcher integration exposed and fixed a post-stop queued reindex; watcher tests passed 2/2 and watcher+indexer tests passed 7/7 (`LP-014`, `LP-015`, `LP-027`, `OP-013`).
- 2026-07-22 — MCP protocol baseline passed 3/6; after strict envelopes, notification silence, concurrent dispatch, and EOF draining it passed 6/6, existing+new MCP passed 7/7, and three repeated runs passed 18/18 (`OP-001`–`OP-003`, `OP-013`).
- 2026-07-22 — Graphward review identified the touched MCP dispatcher as a complexity hotspot; dispatch/tool/protocol responsibilities were separated and the file now has no callable at the ≥10 cyclomatic/cognitive reporting threshold.
- 2026-07-22 — Final suite passed 128/129 with the existing optional review-fixture skip and zero failures. The 8-case system evaluation stayed at score 1 within 8 calls and 16,515 bytes.
- 2026-07-22 — Live Continuous Cup retrieval retained 4/4 targets in 3 calls, MRR 0.675, and 12,091 response bytes. Compact-response reduction remained 75.37% on Continuous Cup and 75.92% on aq-test; these remain byte proxies, not real token savings (`AE-005`–`AE-007`, `FE-027`).
