import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { groupIndexedProjects } from "../src/projects.mjs";
import { callTool } from "../src/tools.mjs";
import { getUsageStats } from "../src/usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");

test("records bounded local usage and labels modeled MCP context efficiency", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-usage-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  await indexDirectory(db, root, { repoId: "usage" });
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const mcpContext = { db, defaultRoot: root, defaultRepoId: "usage", surface: "mcp" };
  const dashboardContext = { ...mcpContext, surface: "dashboard" };
  await callTool("find_code", { repo_id: "usage", query: "authorize", limit: 5 }, mcpContext);
  await callTool("get_repository_stats", { repo_id: "usage" }, mcpContext);
  await assert.rejects(callTool("not_a_graphward_tool", {}, mcpContext), /Unknown tool/);
  await callTool("find_symbol", { repo_id: "usage", name: "authorize", fuzzy: false }, dashboardContext);

  const usage = await callTool("get_usage_stats", { repo_id: "usage", period: "30d" }, mcpContext);
  assert.equal(usage.totals.calls, 3);
  assert.equal(usage.totals.mcp_calls, 3);
  assert.equal(usage.totals.dashboard_calls, 0);
  assert.equal(usage.totals.successful_calls, 2);
  assert.equal(usage.totals.failed_calls, 1);
  assert.ok(usage.totals.estimated_mcp_output_tokens > 0);
  assert.ok(usage.totals.modeled_mcp_calls >= 1);
  assert.ok(usage.totals.modeled_baseline_file_bytes > 0);
  assert.ok(usage.by_tool.some((item) => item.tool_name === "find_code" && item.mcp_calls === 1));
  assert.equal(usage.by_surface.some((item) => item.surface === "dashboard"), false);
  assert.match(usage.methodology.token_estimate, /not tokenizer output or billing data/i);
  assert.match(usage.methodology.savings_model, /not a claim about a counterfactual agent run/i);
  assert.match(usage.methodology.privacy, /stores no prompts, arguments, source, or responses/i);

  const columns = db.prepare("PRAGMA table_info(tool_usage_events)").all().map((column) => column.name);
  assert.equal(columns.some((column) => /prompt|argument|source|response_content/i.test(column)), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tool_usage_events").get().count, 4);
});

test("groups linked worktrees into one project usage ledger", async (t) => {
  const mainRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-project-main-"));
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-project-worktree-"));
  await cp(fixture, mainRoot, { recursive: true });
  await cp(fixture, worktreeRoot, { recursive: true });
  const db = openDatabase(path.join(mainRoot, ".graphward", "index.sqlite"));
  await indexDirectory(db, mainRoot, { repoId: "project-main" });
  await indexDirectory(db, worktreeRoot, { repoId: "project-worktree" });
  t.after(async () => {
    db.close();
    await rm(mainRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  const commonDirectory = path.join(mainRoot, ".git");
  db.prepare(`
    UPDATE repositories
    SET git_common_dir = ?, git_dir = ?, branch = ?, is_linked_worktree = ?, worktree_id = ?
    WHERE repo_id = ?
  `).run(commonDirectory, commonDirectory, "main", 0, "main-checkout", "project-main");
  db.prepare(`
    UPDATE repositories
    SET git_common_dir = ?, git_dir = ?, branch = ?, is_linked_worktree = ?, worktree_id = ?
    WHERE repo_id = ?
  `).run(commonDirectory, path.join(commonDirectory, "worktrees", "feature"), "feature", 1, "feature-worktree", "project-worktree");

  const projects = groupIndexedProjects(db);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].main_repo_id, "project-main");
  assert.equal(projects[0].primary_repo_id, "project-main");
  assert.equal(projects[0].worktree_count, 1);
  assert.deepEqual(projects[0].repo_ids, ["project-main", "project-worktree"]);

  await callTool("get_repository_stats", { repo_id: "project-main" }, {
    db, defaultRoot: mainRoot, defaultRepoId: "project-main", surface: "mcp",
  });
  await callTool("find_symbol", { repo_id: "project-worktree", name: "authorize", fuzzy: false }, {
    db, defaultRoot: worktreeRoot, defaultRepoId: "project-worktree", surface: "mcp",
  });

  const aggregate = getUsageStats(db, {
    repoIds: projects[0].repo_ids,
    period: "30d",
  });
  assert.equal(aggregate.scope, "project");
  assert.equal(aggregate.totals.calls, 2);
  assert.equal(aggregate.by_repository.length, 2);
  assert.equal(aggregate.by_repository.find((item) => item.repo_id === "project-main").calls, 1);
  assert.equal(aggregate.by_repository.find((item) => item.repo_id === "project-worktree").calls, 1);
  assert.equal(aggregate.by_repository.find((item) => item.repo_id === "project-worktree").is_linked_worktree, true);

  const mainOnly = getUsageStats(db, {
    repoId: "project-main",
    period: "30d",
  });
  assert.equal(mainOnly.scope, "repository");
  assert.equal(mainOnly.totals.calls, 1);
});
