import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "sample");
const cli = path.resolve(here, "..", "src", "cli.mjs");

test("serves tools over stdio JSON-RPC", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-mcp-"));
  await cp(fixture, root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const child = spawn(process.execPath, [cli, "serve", "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, GRAPHWARD_STATE_DIR: path.join(root, ".graphward-state") },
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "graphward-test", version: "1" },
  });
  assert.equal(initialized.result.serverInfo.name, "graphward");
  assert.match(initialized.result.instructions, /indexes a missing current project/i);

  const listed = await request("tools/list");
  const toolNames = listed.result.tools.map((tool) => tool.name);
  assert.equal(new Set(toolNames).size, toolNames.length);
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_impact"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_index_diagnostics"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "record_decision"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_architecture"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_code_graph"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_repo_map"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_api_topology"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_cochange_context"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_dependency_path"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_execution_flows"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "change_preflight"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_code_relationships"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_evolution"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "record_temporal_episode"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "get_usage_stats"));
  assert.equal(toolNames.filter((name) => name === "find_code").length, 1);

  const repositories = await request("tools/call", {
    name: "list_indexed_repositories",
    arguments: {},
  });
  assert.equal(repositories.result.isError, false);
  assert.equal(repositories.result.structuredContent.repositories.length, 1);
  assert.equal(repositories.result.structuredContent.auto_index.performed, true);
  assert.equal(path.resolve(repositories.result.structuredContent.auto_index.root), path.resolve(root));

  const found = await request("tools/call", {
    name: "find_symbol",
    arguments: { name: "multiply", fuzzy: false },
  });
  assert.equal(found.result.isError, false);
  assert.equal(found.result.structuredContent.results[0].name, "multiply");

  const foundCode = await request("tools/call", {
    name: "find_code",
    arguments: { query: "authorize", limit: 5 },
  });
  assert.equal(foundCode.result.isError, false);
  assert.equal(foundCode.result.structuredContent.mode, "hybrid-local");
  assert.equal(foundCode.result.structuredContent.response_detail, "compact");
  assert.equal(foundCode.result.structuredContent.results[0].name, "authorize");
  assert.ok(foundCode.result.structuredContent.results.every((result) => (
    result.embedding_provider_trust === undefined && result.scores === undefined
  )));

  const recordedTemporal = await request("tools/call", {
    name: "record_temporal_episode",
    arguments: {
      episode_key: "mcp:test:snake-case",
      type: "external",
      changes: [{
        entity_type: "file",
        change_type: "added",
        stable_key: "src/mcp-added.js",
        file_path: "src/mcp-added.js",
        after: { stable_key: "src/mcp-added.js", path: "src/mcp-added.js", content_hash: "mcp" },
      }],
    },
  });
  assert.equal(recordedTemporal.result.isError, false);
  assert.equal(recordedTemporal.result.structuredContent.inserted, true);
  const replayedTemporal = await request("tools/call", {
    name: "get_episode_replay",
    arguments: { episode_id: recordedTemporal.result.structuredContent.episode.id },
  });
  assert.equal(replayedTemporal.result.isError, false);
  assert.equal(replayedTemporal.result.structuredContent.entities[0].content_hash, "mcp");

  const dependencyPath = await request("tools/call", {
    name: "get_dependency_path",
    arguments: { source: "handleRequest", target: "add", max_depth: 5 },
  });
  assert.equal(dependencyPath.result.isError, false);
  assert.equal(dependencyPath.result.structuredContent.found, true);

  const flows = await request("tools/call", {
    name: "get_execution_flows",
    arguments: { max_depth: 3, max_results: 10 },
  });
  assert.equal(flows.result.isError, false);
  assert.ok(flows.result.structuredContent.flow_count > 0);

  const preflight = await request("tools/call", {
    name: "change_preflight",
    arguments: {
      changes: [{ file_path: "src/math.js", start_line: 1, end_line: 2 }],
      include_cochange: false,
    },
  });
  assert.equal(preflight.result.isError, false);
  assert.ok(preflight.result.structuredContent.changed_symbols.some((item) => item.name === "add"));

  const relationships = await request("tools/call", {
    name: "get_code_relationships",
    arguments: { file_path: "src/math.js", category: "export" },
  });
  assert.equal(relationships.result.isError, false);
  assert.ok(relationships.result.structuredContent.results.some((item) => item.source_name === "add"));

  const usage = await request("tools/call", {
    name: "get_usage_stats",
    arguments: { period: "30d" },
  });
  assert.equal(usage.result.isError, false);
  assert.ok(usage.result.structuredContent.totals.mcp_calls >= 7);
  assert.ok(usage.result.structuredContent.by_tool.some((item) => item.tool_name === "find_code"));
  assert.match(usage.result.structuredContent.methodology.token_estimate, /not tokenizer output or billing data/i);

  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`MCP process exited ${code}`)));
    child.once("error", reject);
  });
});
