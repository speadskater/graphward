import assert from "node:assert/strict";
import { request } from "node:http";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startDashboard } from "../src/dashboard.mjs";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool } from "../src/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");

function hostileHostRequest(url) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const incoming = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: "/",
      method: "GET",
      headers: { Host: "attacker.example" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    incoming.once("error", reject);
    incoming.end();
  });
}

test("serves a loopback-only dashboard with protected local APIs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-dashboard-"));
  const chosenRoot = await mkdtemp(path.join(os.tmpdir(), "graphward-dashboard-chosen-"));
  const resolvedChosenRoot = await realpath(chosenRoot);
  await cp(fixture, root, { recursive: true });
  await cp(fixture, chosenRoot, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  await indexDirectory(db, root, { repoId: "dashboard" });
  const fleetContext = { db, defaultRoot: root };
  await callTool("fleet_publish_intent", {
    repo_id: "dashboard", branch: "main", agent_id: "dashboard-alpha", agent_name: "Alpha",
    kind: "modify", summary: "Update authorization", targets: ["symbol:authorize"],
  }, fleetContext);
  await callTool("fleet_publish_intent", {
    repo_id: "dashboard", branch: "main", agent_id: "dashboard-beta", agent_name: "Beta",
    kind: "refactor", summary: "Extract authorization policy", targets: ["symbol:authorize"],
  }, fleetContext);
  const watched = [];
  const watchManager = {
    async start(watchedPath, options) {
      watched.push({ path: path.resolve(watchedPath), repo_id: options.repoId });
      return { ok: true, path: path.resolve(watchedPath), already_watching: false };
    },
  };
  const dashboard = await startDashboard({
    db,
    defaultRoot: root,
    defaultRepoId: "dashboard",
    watchManager,
    pickDirectory: async () => chosenRoot,
    port: 0,
  });
  t.after(async () => {
    await dashboard.close();
    db.close();
    await rm(root, { recursive: true, force: true });
    await rm(chosenRoot, { recursive: true, force: true });
  });

  const pageResponse = await fetch(dashboard.url);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(pageResponse.headers.get("x-frame-options"), "DENY");
  const page = await pageResponse.text();
  assert.match(page, /Graphward Observatory/);
  assert.match(page, /Interactive program topology/);
  assert.match(page, /Fleet control room/);
  assert.match(page, /Choose folder/);
  assert.match(page, /Indexed project/);
  assert.match(page, /Efficiency ledger/);
  assert.match(page, /Checkout activity/);
  assert.doesNotMatch(page, /%%GRAPHWARD_SESSION_TOKEN%%/);
  const token = /<meta name="graphward-token" content="([^"]+)">/.exec(page)?.[1];
  assert.ok(token);
  const apiHeaders = { "X-Graphward-Token": token };

  const denied = await fetch(`${dashboard.url}/api/repositories`);
  assert.equal(denied.status, 403);

  const repositoriesResponse = await fetch(`${dashboard.url}/api/repositories`, { headers: apiHeaders });
  assert.equal(repositoriesResponse.status, 200);
  const repositories = await repositoriesResponse.json();
  assert.equal(repositories.data.repositories[0].repo_id, "dashboard");
  assert.equal(repositories.data.default_repo_id, "dashboard");
  assert.equal(repositories.data.projects.length, 1);
  assert.equal(repositories.data.projects[0].main_repo_id, "dashboard");

  const wrongPickerOrigin = await fetch(`${dashboard.url}/api/repositories/pick`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: "http://attacker.example" },
    body: "{}",
  });
  assert.equal(wrongPickerOrigin.status, 403);

  const pickerResponse = await fetch(`${dashboard.url}/api/repositories/pick`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: "{}",
  });
  assert.equal(pickerResponse.status, 200);
  const picker = await pickerResponse.json();
  assert.equal(picker.data.cancelled, false);
  assert.equal(picker.data.path, resolvedChosenRoot);

  const relativeIndexResponse = await fetch(`${dashboard.url}/api/repositories/index`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: JSON.stringify({ path: "." }),
  });
  assert.equal(relativeIndexResponse.status, 400);

  const indexResponse = await fetch(`${dashboard.url}/api/repositories/index`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: JSON.stringify({ path: picker.data.path, watch: true }),
  });
  assert.equal(indexResponse.status, 200);
  const indexed = await indexResponse.json();
  assert.equal(indexed.data.repository.root, resolvedChosenRoot);
  assert.ok(indexed.data.repository.symbols > 0);
  assert.equal(indexed.data.watching.ok, true);
  assert.equal(watched.length, 1);
  assert.equal(watched[0].repo_id, indexed.data.repository.repo_id);

  const refreshedRepositories = await (await fetch(`${dashboard.url}/api/repositories`, { headers: apiHeaders })).json();
  assert.equal(refreshedRepositories.data.default_repo_id, indexed.data.repository.repo_id);
  assert.ok(refreshedRepositories.data.repositories.some((repo) => repo.repo_id === indexed.data.repository.repo_id));

  const existingIndexResponse = await fetch(`${dashboard.url}/api/repositories/index`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: JSON.stringify({ path: root, watch: false }),
  });
  const existingIndex = await existingIndexResponse.json();
  assert.equal(existingIndexResponse.status, 200);
  assert.equal(existingIndex.data.repository.repo_id, "dashboard");
  const repositoriesAfterRefresh = await (await fetch(`${dashboard.url}/api/repositories`, { headers: apiHeaders })).json();
  assert.equal(repositoriesAfterRefresh.data.repositories.length, 2);

  const commonDirectory = path.join(root, ".git");
  db.prepare(`UPDATE repositories SET git_common_dir = ?, git_dir = ?, branch = ?, is_linked_worktree = 0 WHERE repo_id = ?`)
    .run(commonDirectory, commonDirectory, "main", "dashboard");
  db.prepare(`UPDATE repositories SET git_common_dir = ?, git_dir = ?, branch = ?, is_linked_worktree = 1 WHERE repo_id = ?`)
    .run(commonDirectory, path.join(commonDirectory, "worktrees", "dashboard-feature"), "feature", indexed.data.repository.repo_id);
  const groupedRepositories = await (await fetch(`${dashboard.url}/api/repositories`, { headers: apiHeaders })).json();
  assert.equal(groupedRepositories.data.projects.length, 1);
  assert.equal(groupedRepositories.data.projects[0].main_repo_id, "dashboard");
  assert.equal(groupedRepositories.data.projects[0].worktree_count, 1);
  assert.deepEqual(groupedRepositories.data.projects[0].repo_ids, ["dashboard", indexed.data.repository.repo_id]);

  const overviewResponse = await fetch(`${dashboard.url}/api/overview?repo_id=dashboard`, { headers: apiHeaders });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.data.stats.repo_id, "dashboard");
  assert.ok(overview.data.stats.symbols > 0);
  assert.ok(Array.isArray(overview.data.architecture.central_symbols));

  const usageResponse = await fetch(`${dashboard.url}/api/usage?repo_id=dashboard&period=30d`, { headers: apiHeaders });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.data.totals.calls, 0);
  assert.equal(usage.data.totals.dashboard_calls, 0);
  assert.match(usage.data.methodology.savings_model, /indexed file-path evidence/i);

  const projectMcpContext = { db, defaultRoot: root, defaultRepoId: "dashboard", surface: "mcp" };
  await callTool("get_repository_stats", { repo_id: "dashboard" }, projectMcpContext);
  await callTool("get_repository_stats", { repo_id: indexed.data.repository.repo_id }, projectMcpContext);
  const projectUsageResponse = await fetch(`${dashboard.url}/api/usage?repo_id=dashboard&period=30d`, { headers: apiHeaders });
  assert.equal(projectUsageResponse.status, 200);
  const projectUsage = await projectUsageResponse.json();
  assert.equal(projectUsage.data.scope, "project");
  assert.equal(projectUsage.data.project.main_repo_id, "dashboard");
  assert.equal(projectUsage.data.project.worktree_count, 1);
  assert.equal(projectUsage.data.totals.calls, 2);
  assert.equal(projectUsage.data.by_repository.length, 2);

  const codeGraphResponse = await fetch(`${dashboard.url}/api/code-graph?repo_id=dashboard&max_nodes=500&max_edges=1000`, { headers: apiHeaders });
  assert.equal(codeGraphResponse.status, 200);
  const codeGraph = await codeGraphResponse.json();
  assert.equal(codeGraph.data.repo_id, "dashboard");
  assert.ok(codeGraph.data.nodes.length > 0);
  assert.ok(codeGraph.data.clusters.length > 0);
  assert.ok(codeGraph.data.edges.every((edge) => codeGraph.data.nodes.some((node) => node.id === edge.source)));

  const searchResponse = await fetch(`${dashboard.url}/api/search?repo_id=dashboard&q=authorize`, { headers: apiHeaders });
  const search = await searchResponse.json();
  assert.equal(search.data.results[0].name, "authorize");
  const selected = search.data.results[0];
  const symbolResponse = await fetch(`${dashboard.url}/api/symbol?repo_id=dashboard&symbol=${encodeURIComponent(selected.name)}&file_path=${encodeURIComponent(selected.file_path)}`, { headers: apiHeaders });
  assert.equal(symbolResponse.status, 200);
  const symbol = await symbolResponse.json();
  assert.equal(symbol.data.context.symbol.name, "authorize");
  assert.match(symbol.data.source.content, /authorize/);

  const qualityResponse = await fetch(`${dashboard.url}/api/quality?repo_id=dashboard&view=hotspots`, { headers: apiHeaders });
  assert.equal(qualityResponse.status, 200);
  const quality = await qualityResponse.json();
  assert.ok(Array.isArray(quality.data.result.findings));

  const wrongOrigin = await fetch(`${dashboard.url}/api/review`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: "http://attacker.example" },
    body: JSON.stringify({ repo_id: "dashboard", changes: [{ file_path: "src/auth.js", start_line: 1, end_line: 2 }] }),
  });
  assert.equal(wrongOrigin.status, 403);

  const processRefreshResponse = await fetch(`${dashboard.url}/api/processes/refresh`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: JSON.stringify({ repo_id: "dashboard" }),
  });
  assert.equal(processRefreshResponse.status, 200);
  const processRefresh = await processRefreshResponse.json();
  assert.equal(processRefresh.data.repo_id, "dashboard");
  const processesResponse = await fetch(`${dashboard.url}/api/processes?repo_id=dashboard`, { headers: apiHeaders });
  assert.equal(processesResponse.status, 200);

  const fleetResponse = await fetch(`${dashboard.url}/api/fleet?repo_id=dashboard&branch=main`, { headers: apiHeaders });
  assert.equal(fleetResponse.status, 200);
  const fleet = await fleetResponse.json();
  assert.equal(fleet.data.local_only, true);
  assert.equal(fleet.data.summary.active_agents, 2);
  assert.equal(fleet.data.summary.overlaps, 1);
  assert.ok(fleet.data.graph.nodes.some((node) => node.id === "agent:dashboard-alpha"));
  assert.ok(fleet.data.graph.edges.some((edge) => edge.kind === "conflict"));

  const reviewResponse = await fetch(`${dashboard.url}/api/review`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json", Origin: dashboard.url },
    body: JSON.stringify({ repo_id: "dashboard", changes: [{ file_path: "src/auth.js", start_line: 1, end_line: 2 }], include_cochange: false }),
  });
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json();
  assert.equal(review.data.local_only, true);
  assert.equal(review.data.source_mutated, false);
  assert.equal(review.data.posting.network, false);

  const hostile = await hostileHostRequest(dashboard.url);
  assert.equal(hostile.status, 421);
  assert.match(hostile.body, /loopback/);

  const application = await (await fetch(`${dashboard.url}/app.js`)).text();
  assert.doesNotMatch(application, /https?:\/\//);
  assert.match(application, /worktree/);
  assert.match(application, /data-repo-id/);
  const graphApplication = await (await fetch(`${dashboard.url}/code-graph.js`)).text();
  assert.match(graphApplication, /CodeGraphRenderer/);
  assert.doesNotMatch(graphApplication, /https?:\/\//);
});

test("refuses non-loopback dashboard binding", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-dashboard-host-"));
  const db = openDatabase(path.join(root, "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    startDashboard({ db, defaultRoot: root, host: "0.0.0.0", port: 0 }),
    /loopback-only/,
  );
});
