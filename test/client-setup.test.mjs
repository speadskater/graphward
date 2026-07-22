import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClientCommands,
  defaultMcpProjectRoot,
  getClientSkillPath,
  installClientSkill,
  parseSetupTargets,
  setupClients,
} from "../src/client-setup.mjs";

const runtime = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\Program Files\\Graphward\\src\\cli.mjs",
};

function skillFixture({ existing = "bundled skill" } = {}) {
  const sourceSkillPath = "C:\\package\\skills\\graphward-first\\SKILL.md";
  const writes = [];
  return {
    homeDirectory: "C:\\Users\\tester",
    environment: {},
    sourceSkillPath,
    read: async (filePath) => {
      if (filePath === sourceSkillPath) return "bundled skill";
      if (existing != null) return existing;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    write: async (filePath, contents) => writes.push({ filePath, contents }),
    makeDirectory: async () => {},
    writes,
  };
}

test("setup target parsing supports aliases, lists, and all", () => {
  assert.deepEqual(parseSetupTargets(), { clients: ["codex", "claude"], explicit: false });
  assert.deepEqual(parseSetupTargets("claude-code,codex,claude"), { clients: ["claude", "codex"], explicit: true });
  assert.deepEqual(parseSetupTargets("all"), { clients: ["codex", "claude"], explicit: true });
  assert.throws(() => parseSetupTargets("cursor"), /Unsupported setup target/);
});

test("client adapters build official user-scoped stdio registration commands", () => {
  const codex = buildClientCommands("codex", runtime);
  assert.deepEqual(codex.add, [
    "mcp", "add", "graphward", "--",
    runtime.nodePath, runtime.cliPath, "serve", "--watch",
  ]);

  const claude = buildClientCommands("claude", runtime);
  assert.deepEqual(claude.add, [
    "mcp", "add", "--scope", "user", "--transport", "stdio", "graphward", "--",
    runtime.nodePath, runtime.cliPath, "serve", "--watch",
  ]);
});

test("Claude's stable project root overrides the MCP process working directory", () => {
  assert.equal(defaultMcpProjectRoot({
    environment: { CLAUDE_PROJECT_DIR: "C:\\work\\project" },
    currentDirectory: "C:\\Users\\example",
  }), "C:\\work\\project");
  assert.equal(defaultMcpProjectRoot({
    environment: { CLAUDE_PROJECT_DIR: "relative-project" },
    currentDirectory: "C:\\Users\\example",
  }), "C:\\Users\\example");
});

test("client skill paths use each agent's user-level discovery directory", () => {
  assert.equal(
    getClientSkillPath("codex", { homeDirectory: "C:\\Users\\tester", environment: {} }),
    "C:\\Users\\tester\\.agents\\skills\\graphward-first\\SKILL.md",
  );
  assert.equal(
    getClientSkillPath("claude", {
      homeDirectory: "C:\\Users\\tester",
      environment: { CLAUDE_CONFIG_DIR: "D:\\ClaudeConfig" },
    }),
    "D:\\ClaudeConfig\\skills\\graphward-first\\SKILL.md",
  );
});

test("skill installation is idempotent and protects user-customized copies", async () => {
  const missing = skillFixture({ existing: null });
  const installed = await installClientSkill("codex", missing);
  assert.equal(installed.status, "installed");
  assert.equal(missing.writes.length, 1);

  const identical = skillFixture();
  assert.equal((await installClientSkill("claude", identical)).status, "already_installed");
  assert.equal(identical.writes.length, 0);

  const customized = skillFixture({ existing: "user customization" });
  assert.equal((await installClientSkill("codex", customized)).status, "conflict");
  assert.equal(customized.writes.length, 0);
  assert.equal((await installClientSkill("codex", { ...customized, force: true })).status, "updated");
  assert.equal(customized.writes.length, 1);
});

test("default setup configures detected clients and skips missing clients", async () => {
  const calls = [];
  const result = await setupClients({
    ...runtime,
    ...skillFixture(),
    resolveExecutable: async (name) => name === "codex" ? "C:\\Tools\\codex.exe" : null,
    execute: async (executable, args, options = {}) => {
      calls.push({ executable, args, options });
      if (args[1] === "get") return { ok: false, code: 1, stdout: "", stderr: "not found" };
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.detected, 1);
  assert.equal(result.configured, 1);
  assert.equal(result.results[0].status, "configured");
  assert.equal(result.results[1].status, "skipped");
  assert.deepEqual(calls.map((item) => item.args.slice(0, 3)), [
    ["mcp", "get", "graphward"],
    ["mcp", "add", "graphward"],
  ]);
});

test("setup is idempotent unless force is requested", async () => {
  const ordinaryCalls = [];
  const ordinary = await setupClients({
    ...runtime,
    ...skillFixture(),
    targets: "codex",
    resolveExecutable: async () => "codex",
    execute: async (_executable, args) => {
      ordinaryCalls.push(args);
      return { ok: true, code: 0, stdout: "configured", stderr: "" };
    },
  });
  assert.equal(ordinary.results[0].status, "already_configured");
  assert.equal(ordinaryCalls.length, 1);

  const forcedCalls = [];
  const forced = await setupClients({
    ...runtime,
    ...skillFixture(),
    targets: "claude",
    force: true,
    resolveExecutable: async () => "claude",
    execute: async (_executable, args) => {
      forcedCalls.push(args);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(forced.results[0].status, "updated");
  assert.deepEqual(forcedCalls.map((args) => args.slice(0, 2)), [
    ["mcp", "get"],
    ["mcp", "remove"],
    ["mcp", "add"],
  ]);
});

test("explicit missing clients fail while dry runs expose the exact plan", async () => {
  const noneDetected = await setupClients({
    ...runtime,
    ...skillFixture(),
    resolveExecutable: async () => null,
  });
  assert.equal(noneDetected.ok, false);
  assert.match(noneDetected.message, /No supported coding-agent clients/);

  const missing = await setupClients({
    ...runtime,
    ...skillFixture(),
    targets: "claude",
    resolveExecutable: async () => null,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.results[0].status, "error");

  const planned = await setupClients({
    ...runtime,
    ...skillFixture(),
    targets: "codex,claude",
    dryRun: true,
    resolveExecutable: async (name) => name === "codex" ? "C:\\Tools\\codex.exe" : null,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.configured, 0);
  assert.equal(planned.planned, 2);
  assert.deepEqual(planned.results.map((item) => item.status), ["planned", "planned"]);
  assert.equal(planned.results[1].available, false);
  assert.deepEqual(planned.results[0].command.slice(-4), [runtime.nodePath, runtime.cliPath, "serve", "--watch"]);
});
