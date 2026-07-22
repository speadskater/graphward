import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/constants.mjs";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool, TOOL_DEFINITIONS } from "../src/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");

test("integrates search, memory, topology, and quality analysis through MCP dispatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-advanced-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId: "advanced" });
  const context = { db, defaultRoot: root };

  const firstSearch = await callTool("find_code", {
    repo_id: "advanced",
    query: "check whether someone has permission to access a route",
    limit: 10,
  }, context);
  assert.equal(firstSearch.mode, "hybrid-local");
  assert.equal(firstSearch.index.cache_hit, false);
  assert.ok(firstSearch.results.length > 0);
  assert.ok(firstSearch.results.every((result) => result.embedding_provider_trust === "built-in-no-io"));

  const secondSearch = await callTool("find_code", { repo_id: "advanced", query: "authorize", limit: 5 }, context);
  assert.equal(secondSearch.index.cache_hit, true);
  assert.equal(secondSearch.results[0].name, "authorize");
  assert.ok(secondSearch.results[0].literal_matches.some((match) => match.line > 0 && match.column > 0));
  assert.match(secondSearch.results[0].source_context.content, /authorize/);
  assert.equal(secondSearch.index_snapshot.stale, false);
  const firstPage = await callTool("find_code", { repo_id: "advanced", query: "function", limit: 1 }, context);
  assert.equal(firstPage.results.length, 1);
  assert.equal(firstPage.page.has_more, true);
  const nextPage = await callTool("find_code", {
    repo_id: "advanced", query: "function", limit: 1, cursor: firstPage.page.next_cursor,
  }, context);
  assert.equal(nextPage.results.length, 1);
  assert.notEqual(nextPage.results[0].stable_key, firstPage.results[0].stable_key);

  await appendFile(path.join(root, "src", "math.js"), "\nexport function subtract(left, right) { return left - right; }\n");
  await indexDirectory(db, root, { repoId: "advanced" });
  const refreshedSearch = await callTool("find_code", { repo_id: "advanced", query: "subtract", limit: 5 }, context);
  assert.equal(refreshedSearch.index.cache_hit, false);
  assert.equal(refreshedSearch.results[0].name, "subtract");
  const refreshedRepeat = await callTool("find_code", { repo_id: "advanced", query: "subtract", limit: 5 }, context);
  assert.equal(refreshedRepeat.index.cache_hit, true);

  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-advanced-other-"));
  await cp(fixture, otherRoot, { recursive: true });
  await appendFile(path.join(otherRoot, "src", "math.js"), "\nexport function otherRepositoryOnly() { return 1; }\n");
  await indexDirectory(db, otherRoot, { repoId: "advanced-other" });
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const otherSearch = await callTool("find_code", {
    repo_id: "advanced-other", query: "otherRepositoryOnly", limit: 5,
  }, context);
  assert.equal(otherSearch.results[0].name, "otherRepositoryOnly");
  const isolatedSearch = await callTool("find_code", {
    repo_id: "advanced", query: "otherRepositoryOnly", limit: 5,
  }, context);
  assert.ok(isolatedSearch.results.every((result) => result.name !== "otherRepositoryOnly"));
  await assert.rejects(callTool("find_code", { query: "authorize" }, context), /repo_id is required/);
  await assert.rejects(callTool("find_code", { repo_id: "", query: "authorize" }, context), /non-empty string/);

  const recorded = await callTool("record_structured_decision", {
    repo_id: "advanced",
    title: "Authorization stays server-side",
    rationale: "Route access must be decided from server-owned roles.",
    kind: "convention",
    symbols: ["authorize"],
    conventions: ["Keep authorization checks in server middleware."],
    provenance: [{ source_type: "human", recorded_by: "test", evidence: { approved: true } }],
  }, context);
  assert.equal(recorded.decision.kind, "convention");

  const recalled = await callTool("recall_decision", { repo_id: "advanced", query: "authorization server roles" }, context);
  assert.equal(recalled.verdict, "Evidence");
  assert.equal(recalled.decisions[0].id, recorded.decision.id);

  const unverified = await callTool("verify_intent", { repo_id: "advanced", decision_id: recorded.decision.id }, context);
  assert.equal(unverified.verdict, "CannotProve");
  const verified = await callTool("verify_intent", {
    repo_id: "advanced",
    decision_id: recorded.decision.id,
    record: { verdict: "held", evidence: { test: "authorization middleware suite" } },
  }, context);
  assert.equal(verified.verdict, "Held");

  const contracts = await callTool("governing_contracts", { repo_id: "advanced", symbol: "authorize" }, context);
  assert.equal(contracts.verdict, "Evidence");
  assert.ok(contracts.contracts.some((contract) => contract.kind === "convention"));

  await callTool("create_worktree_overlay", {
    repo_id: "advanced", name: "feature-auth", base_reference: "HEAD", base_head: "abc123",
  }, context);
  await callTool("create_worktree_overlay", {
    repo_id: "advanced", name: "review-auth", base_reference: "HEAD", base_head: "abc123",
  }, context);
  await callTool("record_worktree_changes", {
    repo_id: "advanced",
    name: "feature-auth",
    changes: [{
      stable_key: "src/new-auth.js:checkRole:Function",
      change_type: "added",
      file_path: "src/new-auth.js",
      overlay: { stable_key: "src/new-auth.js:checkRole:Function", name: "checkRole", file_path: "src/new-auth.js" },
    }],
  }, context);
  const plan = await callTool("plan_worktree_merge", {
    repo_id: "advanced", source_name: "feature-auth", target_name: "review-auth",
  }, context);
  assert.equal(plan.verdict, "clean");
  assert.equal(plan.summary.apply_source, 1);
  const applied = await callTool("apply_worktree_merge", {
    repo_id: "advanced", source_name: "feature-auth", target_name: "review-auth",
  }, context);
  assert.equal(applied.applied, true);
  assert.equal(applied.target_after.counts.added, 1);

  const episode = await callTool("record_temporal_episode", {
    repo_id: "advanced",
    episode_key: "external:test:1",
    type: "external",
    changes: [{
      entity_type: "symbol",
      change_type: "added",
      stable_key: "src/new-auth.js:checkRole:Function",
      file_path: "src/new-auth.js",
      after: {
        stable_key: "src/new-auth.js:checkRole:Function", name: "checkRole",
        file_path: "src/new-auth.js", body_hash: "check-role-v1",
      },
    }],
  }, context);
  assert.equal(episode.inserted, true);
  const changes = await callTool("get_temporal_changes_since", { repo_id: "advanced", since: 0 }, context);
  assert.equal(changes.episodes.length, 1);
  const timeline = await callTool("get_temporal_timeline", {
    repo_id: "advanced", entity_type: "symbol", stable_key: "src/new-auth.js:checkRole:Function",
  }, context);
  assert.equal(timeline.events.length, 1);
  const replay = await callTool("get_episode_replay", { repo_id: "advanced", episode_id: episode.episode.id }, context);
  assert.ok(replay.entities.some((entity) => entity.stable_key === "src/new-auth.js:checkRole:Function"));
  assert.equal(replay.entities.find((entity) => entity.stable_key === "src/new-auth.js:checkRole:Function").content_hash, "check-role-v1");
  const evolution = await callTool("get_evolution", { repo_id: "advanced", from: 0, mode: "compound" }, context);
  assert.equal(evolution.totals.episodes, 1);
  assert.equal(evolution.top_touched_symbols[0].stable_key, "src/new-auth.js:checkRole:Function");
  const continuedEvolution = await callTool("get_evolution", {
    repo_id: "advanced", cursor: changes.cursor, mode: "summary",
  }, context);
  assert.equal(continuedEvolution.totals.episodes, 0);
  await assert.rejects(callTool("get_evolution", {
    repo_id: "advanced", cursor: changes.cursor, from: 0,
  }, context), /either cursor or from/);

  await callTool("upsert_service_identity", {
    service_key: "advanced-api", name: "Advanced API", base_urls: ["https://advanced.test/api"], evidence: { source: "test" },
  }, context);
  await callTool("link_repository_service", {
    repo_id: "advanced", service_key: "advanced-api", role: "both", evidence: { source: "test" },
  }, context);
  await callTool("record_service_operations", {
    repo_id: "advanced", service_key: "advanced-api",
    operations: [
      { protocol: "http", direction: "inbound", method: "GET", path: "/health", file_path: "src/server.js" },
      { protocol: "http", direction: "outbound", method: "GET", path: "https://advanced.test/api/health", file_path: "src/service.js" },
    ], evidence: { source: "test" },
  }, context);
  const services = await callTool("list_service_identities", { repo_ids: ["advanced"] }, context);
  assert.ok(services.services.some((service) => service.service_key === "advanced-api"));
  const diagram = await callTool("get_service_diagram", { repo_ids: ["advanced"], limit: 100 }, context);
  assert.ok(diagram.nodes.some((node) => node.id === "service:advanced-api"));

  const complexity = await callTool("calculate_cyclomatic_complexity", {
    repo_id: "advanced", limit: 25, include_unavailable: true,
  }, context);
  assert.equal(complexity.repo_id, "advanced");
  assert.ok(Array.isArray(complexity.findings));
  assert.ok(complexity.findings.some((finding) => finding.qualified_name === "authorize"));
  const deadCode = await callTool("find_dead_code", { repo_id: "advanced", limit: 25 }, context);
  assert.equal(deadCode.repo_id, "advanced");
  assert.ok(Array.isArray(deadCode.findings));
  const bridges = await callTool("find_bridge_symbols", {
    repo_id: "advanced", entity_type: "both", limit: 25,
  }, context);
  assert.equal(bridges.repo_id, "advanced");
  assert.ok(Array.isArray(bridges.findings));
  const defaultBridges = await callTool("find_bridge_symbols", { repo_id: "advanced", limit: 25 }, context);
  assert.equal(defaultBridges.repo_id, "advanced");
  assert.ok(Array.isArray(defaultBridges.findings));
  const style = await callTool("get_style_fingerprint", { repo_id: "advanced", max_symbols: 100 }, context);
  assert.equal(style.repo_id, "advanced");
  assert.ok(Array.isArray(style.findings));

  const processRefresh = await callTool("refresh_processes", {
    repo_id: "advanced", max_processes: 25, min_confidence: 0,
  }, context);
  assert.equal(processRefresh.repo_id, "advanced");
  const processes = await callTool("list_processes", { repo_id: "advanced", limit: 25 }, context);
  assert.equal(processes.repo_id, "advanced");
  assert.ok(Array.isArray(processes.processes));
  if (processes.processes.length) {
    const processFlow = await callTool("get_process_flow", {
      repo_id: "advanced", process_key: processes.processes[0].process_key,
    }, context);
    assert.ok(processFlow.steps.length > 0);
  }
  const briefing = await callTool("get_codebase_briefing", {
    repo_id: "advanced", process_limit: 25, hotspot_limit: 10,
  }, context);
  assert.equal(briefing.repo_id, "advanced");
  assert.equal(briefing.sections.repository_stats.status, "available");

  const review = await callTool("review_change", {
    repo_id: "advanced",
    changes: [{ file_path: "src/auth.js", start_line: 1, end_line: 3 }],
    include_cochange: false,
    max_findings: 25,
  }, context);
  assert.equal(review.repo_id, "advanced");
  assert.equal(review.local_only, true);
  assert.equal(review.source_mutated, false);
  assert.ok(Array.isArray(review.findings));

  const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.equal(names.size, TOOL_DEFINITIONS.length);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === "find_code").length, 1);
  assert.ok(TOOL_DEFINITIONS.every((tool) => (
    tool.inputSchema?.type === "object" && tool.inputSchema.additionalProperties === false
  )));
  const timelineDefinition = TOOL_DEFINITIONS.find((tool) => tool.name === "get_temporal_timeline");
  assert.equal(Object.hasOwn(timelineDefinition.inputSchema.properties, "cursor"), false);
  const evolutionDefinition = TOOL_DEFINITIONS.find((tool) => tool.name === "get_evolution");
  assert.ok(Array.isArray(evolutionDefinition.inputSchema.properties.cursor.anyOf));
  const unlinkDefinition = TOOL_DEFINITIONS.find((tool) => tool.name === "unlink_repository_service");
  assert.equal(unlinkDefinition.annotations.destructiveHint, true);
  for (const name of ["get_cross_repository_topology", "get_service_diagram", "get_service_callers"]) {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    assert.notEqual(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.idempotentHint, true);
    assert.equal(definition.annotations.openWorldHint, false);
  }
  for (const name of ["get_service_diagram", "get_service_callers"]) {
    const protocol = TOOL_DEFINITIONS.find((tool) => tool.name === name).inputSchema.properties.protocol;
    assert.deepEqual(protocol.enum, ["http", "graphql", "grpc", "websocket", "queue", null]);
  }
  for (const name of [
    "recall_decision", "verify_intent", "governing_contracts", "list_worktrees", "get_evolution",
    "get_episode_replay", "get_service_diagram", "calculate_cyclomatic_complexity", "find_hotspots",
    "find_dead_code", "find_bridge_symbols", "get_style_fingerprint", "refresh_processes", "list_processes",
    "get_process_flow", "get_process_membership", "get_codebase_briefing", "get_daily_briefing", "review_change",
  ]) assert.ok(names.has(name));
});

test("CLI recognizes --version as a flag", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), VERSION);
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /graphward dashboard/);
  assert.match(help.stdout, /loopback dashboard/i);
});
