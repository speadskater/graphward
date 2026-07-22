import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { getArchitecture, getCodeGraph, getRepoMap } from "../src/graph-analysis.mjs";
import { getCochangeContext } from "../src/history.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import {
  findCode,
  findSymbol,
  getApiTopology,
  getChangesSince,
  getImpact,
  getIndexDiagnostics,
  getRepositoryStats,
  getSourceWindow,
  getSymbolContext,
  getTimeline,
  recallDecisions,
  recordDecision,
} from "../src/queries.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-test-"));
  await cp(fixture, root, { recursive: true });
  return root;
}

test("indexes symbols, calls, imports, and full-text bodies", async (t) => {
  const root = await makeWorkspace();
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const worktree = path.join(root, ".claude", "worktrees", "duplicate", "src");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "duplicate.js"), "export function shouldNotBeIndexed() {}\n");
  const arbitraryHidden = path.join(root, ".hidden-source", "nested");
  await mkdir(arbitraryHidden, { recursive: true });
  await writeFile(path.join(arbitraryHidden, "hidden.js"), "export function hiddenSourceIsIgnored() {}\n");
  const gitRefs = path.join(root, ".git", "refs", "heads");
  await mkdir(gitRefs, { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitRefs, "main"), "1234567890abcdef1234567890abcdef12345678\n");

  const indexed = await indexDirectory(db, root, { repoId: "sample" });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.files, 11);
  assert.ok(indexed.symbols >= 16);

  const stats = getRepositoryStats(db, "sample");
  assert.equal(stats.files, 11);
  assert.equal(stats.head_commit, "1234567890abcdef1234567890abcdef12345678");
  assert.ok(stats.edges >= 4);
  assert.equal(stats.api_operations, 4);

  const add = findSymbol(db, { repoId: "sample", name: "add", fuzzy: false });
  assert.equal(add[0].name, "add");
  assert.equal(add[0].file_path, "src/math.js");

  const multiplyContext = getSymbolContext(db, { repoId: "sample", symbol: "multiply" });
  assert.ok(multiplyContext.callees.some((symbol) => symbol.name === "add"));
  assert.ok(multiplyContext.callers.some((symbol) => symbol.name === "handleRequest"));
  assert.ok(multiplyContext.imports.length === 0);

  const handleContext = getSymbolContext(db, { repoId: "sample", symbol: "handleRequest" });
  assert.ok(handleContext.imports.some((item) => item.target_file === "src/math.js"));

  const controllerContext = getSymbolContext(db, { repoId: "sample", symbol: "Controller.run" });
  assert.ok(controllerContext.callees.filter((symbol) => symbol.name === "authorize").length >= 1);
  assert.ok(controllerContext.callees.filter((symbol) => symbol.name === "authorize").every((symbol) => symbol.file_path === "src/auth.js"));
  assert.ok(controllerContext.callees.filter((symbol) => symbol.name === "authorize").every((symbol) => symbol.confidence >= 0.9));

  const commonContext = getSymbolContext(db, { repoId: "sample", symbol: "commonCaller" });
  assert.ok(commonContext.callees.some((symbol) => symbol.name === "authorize" && symbol.file_path === "src/auth.js" && symbol.confidence >= 0.9));

  const diagnostics = getIndexDiagnostics(db, { repoId: "sample" });
  assert.equal(diagnostics.parse_error_files.length, 0);
  assert.ok(diagnostics.parser_modes.some((mode) => mode.parser_mode === "babel" && mode.files === 10));
  assert.equal(diagnostics.calls.by_status.some((status) => status.resolution_status === "missing-source"), false);

  const search = findCode(db, { repoId: "sample", query: "formatResponse" });
  assert.ok(search.some((symbol) => symbol.name === "handleRequest"));

  const impact = getImpact(db, { repoId: "sample", target: "add", direction: "upstream", depth: 5 });
  assert.ok(impact.results.some((symbol) => symbol.name === "multiply"));
  assert.ok(impact.results.some((symbol) => symbol.name === "handleRequest"));

  const moduleImpact = getImpact(db, { repoId: "sample", target: "handleRequest", direction: "upstream", depth: 2 });
  assert.ok(moduleImpact.results.some((symbol) => symbol.kind === "Module" && symbol.file_path === "src/entry.js"));

  const topology = getApiTopology(db, { repoId: "sample" });
  assert.equal(topology.counts.routes, 1);
  assert.equal(topology.counts.mounts, 1);
  assert.equal(topology.counts.clients, 2);
  assert.equal(topology.counts.linked, 2);
  assert.equal(topology.links[0].path, "/users/{}");
  assert.ok(topology.clients.some((client) => client.framework === "endpoint-registry" && client.method === "ANY"));

  const architecture = getArchitecture(db, { repoId: "sample" });
  assert.ok(architecture.central_symbols.length > 0);
  assert.ok(architecture.packages.some((item) => item.name === "src"));
  const codeGraph = getCodeGraph(db, { repoId: "sample", maxNodes: 500, maxEdges: 1_000 });
  assert.equal(codeGraph.repo_id, "sample");
  assert.equal(codeGraph.counts.shown_nodes, codeGraph.nodes.length);
  assert.equal(codeGraph.counts.shown_edges, codeGraph.edges.length);
  assert.ok(codeGraph.clusters.some((cluster) => cluster.path === "src"));
  assert.ok(codeGraph.nodes.every((node) => codeGraph.clusters.some((cluster) => cluster.id === node.cluster_id)));
  const codeGraphNodeIds = new Set(codeGraph.nodes.map((node) => node.id));
  assert.ok(codeGraph.edges.every((edge) => codeGraphNodeIds.has(edge.source) && codeGraphNodeIds.has(edge.target)));
  const repoMap = getRepoMap(db, { repoId: "sample", focus: "arithmetic add", tokenBudget: 500 });
  assert.match(repoMap.map, /src\/math\.js/);
  assert.ok(repoMap.estimated_tokens <= 500);

  const window = getSourceWindow(db, { repoId: "sample", filePath: "src/math.js", startLine: 1, endLine: 3 });
  assert.match(window.content, /export function add/);
  assert.throws(
    () => getSourceWindow(db, { repoId: "sample", filePath: "../outside.js" }),
    /escapes the repository root/,
  );
  assert.throws(
    () => getSourceWindow(db, { repoId: "sample", filePath: "README.md" }),
    /not an indexed source file/,
  );

  const rebuilt = await indexDirectory(db, root, { repoId: "sample", force: true });
  assert.equal(rebuilt.full_reparse, true);
  assert.equal(rebuilt.files, 11);
  assert.equal(getIndexDiagnostics(db, { repoId: "sample" }).parse_error_files.length, 0);
  const unchanged = await indexDirectory(db, root, { repoId: "sample" });
  assert.equal(unchanged.files_changed, 0);
  assert.equal(unchanged.files_parsed, 0);
});

test("computes bounded git co-change context", async (t) => {
  const root = await makeWorkspace();
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init");
  git("config", "user.email", "graphward@example.invalid");
  git("config", "user.name", "Graphward Tests");
  git("add", ".");
  git("commit", "-m", "initial fixture");
  const mathPath = path.join(root, "src", "math.js");
  const servicePath = path.join(root, "src", "service.js");
  await writeFile(mathPath, `${await readFile(mathPath, "utf8")}\n// coupled change\n`);
  await writeFile(servicePath, `${await readFile(servicePath, "utf8")}\n// coupled change\n`);
  git("add", "src/math.js", "src/service.js");
  git("commit", "-m", "change math and service together");

  await indexDirectory(db, root, { repoId: "sample-git" });
  const context = getCochangeContext(db, { repoId: "sample-git", target: "add", since: "1970-01-01", minCochanges: 2 });
  assert.equal(context.target_file, "src/math.js");
  assert.ok(context.results.some((item) => item.file_path === "src/service.js" && item.cochanges === 2));
});

test("reports dirty snapshot drift and refuses to retarget a repo id to another checkout", async (t) => {
  const root = await makeWorkspace();
  const otherRoot = await makeWorkspace();
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init");
  git("config", "user.email", "graphward@example.invalid");
  git("config", "user.name", "Graphward Tests");
  git("add", ".");
  git("commit", "-m", "snapshot fixture");

  const indexed = await indexDirectory(db, root, { repoId: "snapshot-checkout" });
  assert.equal(indexed.index_snapshot.stale, false);
  assert.equal(indexed.index_snapshot.dirty, false);
  const clean = getRepositoryStats(db, "snapshot-checkout");
  assert.equal(clean.index_snapshot.stale, false);

  await writeFile(path.join(root, "src", "new-uncommitted.js"), "export const UNCOMMITTED_SYMBOL = 1;\n");
  const stale = getRepositoryStats(db, "snapshot-checkout");
  assert.equal(stale.index_snapshot.stale, true);
  assert.match(stale.index_snapshot.warning, /Refresh before trusting/);
  const refreshed = await indexDirectory(db, root, { repoId: "snapshot-checkout", episodeType: "working_tree" });
  assert.equal(refreshed.index_snapshot.dirty, true);
  assert.ok(findSymbol(db, { repoId: "snapshot-checkout", name: "UNCOMMITTED_SYMBOL", fuzzy: false }).length > 0);

  await assert.rejects(
    indexDirectory(db, otherRoot, { repoId: "snapshot-checkout" }),
    /already belongs to a different checkout/,
  );
});

test("indexes structured Python, barrel exports, type relationships, and endpoint values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-relationships-"));
  const source = path.join(root, "src");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "lib.ts"), "export function target() { return 1; }\n");
  await writeFile(path.join(source, "barrel.ts"), "export { target as publicTarget } from './lib.js';\n");
  await writeFile(path.join(source, "consumer.ts"), "import { publicTarget as runTarget } from './barrel.js';\nexport function caller() { return runTarget(); }\n");
  await writeFile(path.join(source, "types.ts"), "export class Base {}\nexport class Child extends Base {}\nexport interface Box { value: Child }\n");
  await writeFile(path.join(source, "paths.ts"), "export const ENDPOINTS = { login: '/api/login' };\n");
  await writeFile(path.join(source, "api-client.ts"), "import { ENDPOINTS } from './paths.js';\nexport function login() { return apiClient.post(ENDPOINTS.login); }\n");
  await writeFile(path.join(source, "worker.py"), "class Worker:\n    def run(self):\n        return self.finish()\n\n    def finish(self):\n        return True\n");
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  await indexDirectory(db, root, { repoId: "relationships" });
  const diagnostics = getIndexDiagnostics(db, { repoId: "relationships" });
  assert.ok(diagnostics.parser_modes.some((item) => item.parser_mode === "python-ast" && item.files === 1));
  assert.ok(diagnostics.semantic_relationships.some((item) => item.category === "export"));

  const caller = getSymbolContext(db, { repoId: "relationships", symbol: "caller" });
  assert.ok(caller.callees.some((item) => item.name === "target" && item.file_path === "src/lib.ts"));
  const heritage = db.prepare(`
    SELECT e.kind, source.name AS source_name, target.name AS target_name
    FROM edges e
    JOIN symbols source ON source.id = e.source_symbol_id
    JOIN symbols target ON target.id = e.target_symbol_id
    WHERE e.repo_id = (SELECT id FROM repositories WHERE repo_id = 'relationships')
      AND e.kind = 'extends'
  `).all();
  assert.ok(heritage.some((item) => item.source_name === "Child" && item.target_name === "Base"));
  const worker = getSymbolContext(db, { repoId: "relationships", symbol: "Worker.run" });
  assert.ok(worker.callees.some((item) => item.qualified_name === "Worker.finish"));
  const topology = getApiTopology(db, { repoId: "relationships", path: "/api/login", method: "POST" });
  assert.ok(topology.clients.some((item) => item.method === "POST" && item.framework.startsWith("endpoint-value:")));
});

test("records incremental episodes and explicit decisions", async (t) => {
  const root = await makeWorkspace();
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId: "sample" });

  const decision = recordDecision(db, {
    repoId: "sample",
    title: "Keep arithmetic deterministic",
    rationale: "Callers depend on add remaining free of network and clock access.",
    tags: ["arithmetic", "determinism"],
    symbols: ["add"],
  });
  assert.ok(decision.decision_id > 0);
  const recalled = recallDecisions(db, { repoId: "sample", query: "deterministic arithmetic" });
  assert.equal(recalled[0].title, "Keep arithmetic deterministic");
  const context = getSymbolContext(db, { repoId: "sample", symbol: "add" });
  assert.equal(context.governing_decisions[0].title, "Keep arithmetic deterministic");

  const mathPath = path.join(root, "src", "math.js");
  const before = await readFile(mathPath, "utf8");
  await writeFile(mathPath, before.replace("return a + b;", "return a + b + 0;"));
  const refreshed = await indexDirectory(db, root, { repoId: "sample", episodeType: "working_tree" });
  assert.equal(refreshed.files_changed, 1);

  const changes = getChangesSince(db, { repoId: "sample", since: 0 });
  assert.ok(changes.episodes.length >= 2);
  assert.ok(changes.episodes.some((episode) => episode.changes.some((change) => change.change_type === "modified" && change.detail.name === "add")));
  const timeline = getTimeline(db, { repoId: "sample", symbol: "add" });
  assert.ok(timeline.events.some((event) => event.change_type === "modified"));
});
