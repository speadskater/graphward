import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { recordDecision } from "../src/queries.mjs";
import {
  changePreflight,
  findDependencyPath,
  inferExecutionFlows,
  parseUnifiedDiff,
} from "../src/workflow-analysis.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "workflow-analysis");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-workflow-test-"));
  await cp(fixture, root, { recursive: true });
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, db };
}

function runGit(root, ...args) {
  const result = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test("finds the highest-confidence shortest call path with edge evidence", async (t) => {
  const { root, db } = await workspace(t);
  await indexDirectory(db, root, { repoId: "workflow-path" });

  const result = findDependencyPath(db, {
    repoId: "workflow-path",
    source: "handleOrder",
    target: "addFee",
    maxDepth: 5,
  });
  assert.equal(result.found, true);
  assert.equal(result.hops, 2);
  assert.deepEqual(result.path.map((symbol) => symbol.name), ["handleOrder", "calculateTotal", "addFee"]);
  assert.equal(result.edges.length, 2);
  assert.ok(result.edges.every((edge) => edge.kind === "calls" && edge.confidence > 0));
  assert.ok(result.aggregate_confidence > 0 && result.aggregate_confidence <= 1);

  const reverse = findDependencyPath(db, {
    repoId: "workflow-path",
    source: "addFee",
    target: "handleOrder",
    maxDepth: 5,
  });
  assert.equal(reverse.found, false);
  assert.deepEqual(reverse.path, []);
});

test("infers bounded flows from composed API routes and entry points", async (t) => {
  const { root, db } = await workspace(t);
  await indexDirectory(db, root, { repoId: "workflow-flows" });

  const result = inferExecutionFlows(db, {
    repoId: "workflow-flows",
    maxDepth: 5,
    maxResults: 20,
    minConfidence: 0,
  });
  const routeStart = result.starts.find((start) => start.kind === "api_route");
  assert.ok(routeStart);
  assert.equal(routeStart.evidence.method, "GET");
  assert.equal(routeStart.evidence.path, "/orders/{}");
  assert.equal(routeStart.symbol.name, "handleOrder");
  assert.ok(result.starts.some((start) => start.kind === "entry_point" && start.symbol.name === "bootstrap"));
  assert.ok(result.flows.some((flow) =>
    flow.start.kind === "api_route"
    && flow.path.map((symbol) => symbol.name).join(" -> ") === "handleOrder -> calculateTotal -> addFee",
  ));
  assert.ok(result.flow_count <= 20);
});

test("parses diff ranges and builds a risk-rated change preflight", async (t) => {
  const { root, db } = await workspace(t);
  runGit(root, "init");
  runGit(root, "config", "user.email", "graphward@example.invalid");
  runGit(root, "config", "user.name", "Graphward Tests");
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "initial workflow fixture");
  await appendFile(path.join(root, "src", "service.js"), "\n// service history\n");
  await appendFile(path.join(root, "src", "math.js"), "\n// math history\n");
  runGit(root, "add", "src/service.js", "src/math.js");
  runGit(root, "commit", "-m", "change service and math together");

  await indexDirectory(db, root, { repoId: "workflow-preflight" });
  recordDecision(db, {
    repoId: "workflow-preflight",
    title: "Keep order calculations local",
    rationale: "Order calculation must remain deterministic.",
    symbols: ["handleOrder"],
  });
  const diff = [
    "diff --git a/src/service.js b/src/service.js",
    "--- a/src/service.js",
    "+++ b/src/service.js",
    "@@ -2,5 +2,5 @@",
    " ",
    " export function handleOrder(input) {",
    "-  return calculateTotal(input);",
    "+  return calculateTotal(Number(input));",
    " }",
    " ",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [{
    file_path: "src/service.js",
    start_line: 4,
    end_line: 4,
    source: "diff",
  }]);

  const result = changePreflight(db, {
    repoId: "workflow-preflight",
    diff,
    impactDepth: 5,
    cochangeSince: "1970-01-01",
    minCochanges: 2,
  });
  assert.equal(result.changed_symbols.some((symbol) => symbol.name === "handleOrder"), true);
  assert.ok(result.blast_radius.results.some((symbol) => symbol.name === "bootstrap"));
  assert.ok(result.cochange.partners.some((partner) => partner.file_path === "src/math.js" && partner.cochanges >= 2));
  assert.equal(result.governing_decisions[0].title, "Keep order calculations local");
  assert.ok(["medium", "high", "critical"].includes(result.risk));
  assert.ok(result.verification_targets.some((target) => target.type === "changed_symbol" && target.symbol === "handleOrder"));
  assert.ok(result.verification_targets.some((target) => target.type === "cochange_file" && target.file_path === "src/math.js"));
});

test("accepts explicit changed file and line sets when Git history is unavailable", async (t) => {
  const { root, db } = await workspace(t);
  await indexDirectory(db, root, { repoId: "workflow-explicit" });
  const result = changePreflight(db, {
    repoId: "workflow-explicit",
    changes: [{ file_path: "src/math.js", lines: [1, 2] }],
    includeCochange: true,
  });
  assert.ok(result.changed_symbols.some((symbol) => symbol.name === "addFee"));
  assert.ok(result.blast_radius.affected_symbols >= 2);
  assert.equal(result.cochange.files_analyzed, 0);
  assert.equal(result.cochange.errors.length, 1);
});

test("uses exact current working-tree diff lines instead of caller-supplied whole-file ranges", async (t) => {
  const { root, db } = await workspace(t);
  runGit(root, "init");
  runGit(root, "config", "user.email", "graphward@example.invalid");
  runGit(root, "config", "user.name", "Graphward Tests");
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "working-tree preflight fixture");
  const servicePath = path.join(root, "src", "service.js");
  const source = await readFile(servicePath, "utf8");
  await writeFile(servicePath, source.replace("calculateTotal(input)", "calculateTotal(Number(input))"));
  await indexDirectory(db, root, { repoId: "workflow-live-diff", episodeType: "working_tree" });

  const result = changePreflight(db, {
    repoId: "workflow-live-diff",
    changes: [{ file_path: "src/service.js" }],
    includeCochange: false,
  });
  assert.equal(result.input.source, "working_tree");
  assert.equal(result.input.changed_ranges.length, 1);
  assert.notEqual(result.input.changed_ranges[0].start_line, null);
  assert.equal(result.input.changed_ranges[0].start_line, result.input.changed_ranges[0].end_line);
  assert.ok(result.changed_symbols.some((symbol) => symbol.name === "handleOrder"));
});
