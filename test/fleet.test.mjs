import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool, TOOL_DEFINITIONS } from "../src/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");

async function fleetFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-fleet-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  await indexDirectory(db, root, { repoId: "fleet" });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { context: { db, defaultRoot: root } };
}

test("coordinates local agent intents, conflicts, leases, episodes, and escalations", async (t) => {
  const { context } = await fleetFixture(t);
  const target = "symbol:src/auth.js:authorize:Function";

  const alpha = await callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-alpha", agent_name: "Alpha",
    product: "codex", kind: "modify", summary: "Tighten authorization checks", targets: [target],
  }, context);
  assert.equal(alpha.conflict_class, "A");
  assert.equal(alpha.local_only, true);

  const beta = await callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-beta", agent_name: "Beta",
    kind: "refactor", summary: "Extract the authorization policy", targets: [target],
  }, context);
  assert.equal(beta.conflict_class, "B");
  assert.equal(beta.active_conflicts[0].agent_id, "agent-alpha");

  const alphaLease = await callTool("fleet_acquire_lease", {
    repo_id: "fleet", branch: "main", agent_id: "agent-alpha", targets: [target], priority: 10,
  }, context);
  assert.equal(alphaLease.granted, true);
  const betaLease = await callTool("fleet_acquire_lease", {
    repo_id: "fleet", branch: "main", agent_id: "agent-beta", targets: [target], priority: 5,
  }, context);
  assert.equal(betaLease.granted, false);
  assert.equal(betaLease.blockers[0].agent_id, "agent-alpha");

  const gamma = await callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-gamma", agent_name: "Gamma",
    kind: "delete", summary: "Remove the old authorization entry point", targets: [target],
  }, context);
  assert.equal(gamma.conflict_class, "C");
  const episode = await callTool("fleet_record_episode", {
    repo_id: "fleet", intent_id: gamma.intent_id, agent_id: "agent-gamma",
  }, context);
  assert.equal(episode.conflict_class, "C");
  assert.ok(episode.escalation_id);

  const graph = await callTool("fleet_get_graph", { repo_id: "fleet", branch: "main", limit: 100 }, context);
  assert.equal(graph.local_only, true);
  assert.equal(graph.summary.active_agents, 2);
  assert.equal(graph.summary.active_intents, 2);
  assert.equal(graph.summary.overlaps, 1);
  assert.equal(graph.summary.active_leases, 1);
  assert.equal(graph.summary.pending_decisions, 1);
  assert.ok(graph.graph.nodes.some((node) => node.id === "agent:agent-alpha"));
  assert.ok(graph.graph.nodes.some((node) => node.id === `target:${target}`));
  assert.ok(graph.graph.edges.some((edge) => edge.kind === "conflict" && edge.conflict_class === "B"));

  const pending = await callTool("fleet_list_escalations", { repo_id: "fleet", branch: "main" }, context);
  assert.equal(pending.escalations[0].escalation_id, episode.escalation_id);
  const resolved = await callTool("fleet_resolve_escalation", {
    repo_id: "fleet", escalation_id: episode.escalation_id, actor_id: "human-owner",
    directive: "defer", winner_agent_id: "agent-alpha", resolution: "Keep the public entry point until callers migrate.",
  }, context);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.winner_agent_id, "agent-alpha");

  await callTool("fleet_release_lease", { repo_id: "fleet", lease_id: alphaLease.lease_id, agent_id: "agent-alpha" }, context);
  await callTool("fleet_cancel_intent", { repo_id: "fleet", intent_id: beta.intent_id, agent_id: "agent-beta" }, context);
  const status = await callTool("fleet_status", { repo_id: "fleet", branch: "main" }, context);
  assert.equal(status.active_agents, 1);
  assert.equal(status.active_intents, 1);
  assert.equal(status.active_leases, 0);
});

test("exposes bounded Fleet MCP contracts and rejects unsafe ownership or scope inputs", async (t) => {
  const { context } = await fleetFixture(t);
  const names = new Set(TOOL_DEFINITIONS.map((definition) => definition.name));
  for (const name of [
    "fleet_publish_intent", "fleet_status", "fleet_get_graph", "fleet_cancel_intent", "fleet_record_episode",
    "fleet_acquire_lease", "fleet_release_lease", "fleet_list_escalations", "fleet_resolve_escalation",
  ]) assert.equal(names.has(name), true, `${name} should be exposed over MCP`);

  await assert.rejects(callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-alpha", kind: "modify", summary: "No scope", targets: [],
  }, context), /non-empty array/);
  await assert.rejects(callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-alpha", kind: "modify", summary: "Too broad",
    targets: Array.from({ length: 201 }, (_, index) => `symbol:${index}`),
  }, context), /at most 200/);

  const intent = await callTool("fleet_publish_intent", {
    repo_id: "fleet", branch: "main", agent_id: "agent-alpha", kind: "modify", summary: "Owned work", targets: ["file:src/auth.js"],
  }, context);
  await assert.rejects(callTool("fleet_cancel_intent", {
    repo_id: "fleet", intent_id: intent.intent_id, agent_id: "agent-beta",
  }, context), /owning agent/);
});
