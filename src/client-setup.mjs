import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_CLIENTS = ["codex", "claude"];
const CLIENT_ALIASES = new Map([
  ["claude-code", "claude"],
  ["claude_code", "claude"],
]);
const LEGACY_SERVER_NAME = "localtrace";
const COMMAND_TIMEOUT_MS = 30_000;
const BUNDLED_SKILL_PATH = fileURLToPath(new URL("../skills/graphward-first/SKILL.md", import.meta.url));

function boundedOutput(value) {
  const text = String(value ?? "").trim();
  return text.length > 4_096 ? `${text.slice(0, 4_093)}...` : text;
}

function normalizedClient(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CLIENT_ALIASES.get(normalized) ?? normalized;
}

function expandSetupTarget(value) {
  const client = normalizedClient(value);
  if (!client) return [];
  if (client === "all") return [...SUPPORTED_CLIENTS];
  if (!SUPPORTED_CLIENTS.includes(client)) {
    throw new Error(`Unsupported setup target: ${value}. Supported targets: ${SUPPORTED_CLIENTS.join(", ")}`);
  }
  return [client];
}

export function parseSetupTargets(value = null) {
  if (value == null || value === "") return { clients: [...SUPPORTED_CLIENTS], explicit: false };
  const requested = Array.isArray(value) ? value : String(value).split(",");
  const clients = [...new Set(requested.flatMap(expandSetupTarget))];
  if (clients.length === 0) throw new Error("setup requires at least one target");
  return { clients, explicit: true };
}

export function buildClientCommands(client, { nodePath, cliPath }) {
  if (!nodePath || !cliPath) throw new Error("nodePath and cliPath are required");
  const server = [nodePath, cliPath, "serve", "--watch"];
  if (client === "codex") {
    return {
      executable: "codex",
      inspect: ["mcp", "get", "graphward"],
      remove: ["mcp", "remove", "graphward"],
      add: ["mcp", "add", "graphward", "--", ...server],
      legacy: {
        inspect: ["mcp", "get", LEGACY_SERVER_NAME],
        remove: ["mcp", "remove", LEGACY_SERVER_NAME],
      },
      scope: "user",
    };
  }
  if (client === "claude") {
    return {
      executable: "claude",
      inspect: ["mcp", "get", "graphward"],
      remove: ["mcp", "remove", "--scope", "user", "graphward"],
      add: ["mcp", "add", "--scope", "user", "--transport", "stdio", "graphward", "--", ...server],
      legacy: {
        inspect: ["mcp", "get", LEGACY_SERVER_NAME],
        remove: ["mcp", "remove", "--scope", "user", LEGACY_SERVER_NAME],
      },
      scope: "user",
    };
  }
  throw new Error(`Unsupported setup target: ${client}`);
}

export function defaultMcpProjectRoot({
  environment = process.env,
  currentDirectory = process.cwd(),
} = {}) {
  const claudeProject = String(environment.CLAUDE_PROJECT_DIR ?? "").trim();
  return claudeProject && path.isAbsolute(claudeProject) ? claudeProject : currentDirectory;
}

export function getClientSkillPath(client, {
  homeDirectory = os.homedir(),
  environment = process.env,
} = {}) {
  if (client === "codex") {
    return path.join(homeDirectory, ".agents", "skills", "graphward-first", "SKILL.md");
  }
  if (client === "claude") {
    const configuredRoot = String(environment.CLAUDE_CONFIG_DIR ?? "").trim();
    const claudeRoot = configuredRoot ? path.resolve(configuredRoot) : path.join(homeDirectory, ".claude");
    return path.join(claudeRoot, "skills", "graphward-first", "SKILL.md");
  }
  throw new Error(`Unsupported setup target: ${client}`);
}

export async function installClientSkill(client, {
  sourceSkillPath = BUNDLED_SKILL_PATH,
  homeDirectory = os.homedir(),
  environment = process.env,
  dryRun = false,
  force = false,
  read = readFile,
  write = writeFile,
  makeDirectory = mkdir,
} = {}) {
  const destination = getClientSkillPath(client, { homeDirectory, environment });
  if (dryRun) return { path: destination, status: "planned" };

  try {
    const bundled = await read(sourceSkillPath, "utf8");
    let existing = null;
    try {
      existing = await read(destination, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing === bundled) return { path: destination, status: "already_installed" };
    if (existing != null && !force) {
      return {
        path: destination,
        status: "conflict",
        message: "An existing graphward-first skill differs; use --force to replace it",
      };
    }
    await makeDirectory(path.dirname(destination), { recursive: true });
    await write(destination, bundled, "utf8");
    return { path: destination, status: existing == null ? "installed" : "updated" };
  } catch (error) {
    return { path: destination, status: "error", message: boundedOutput(error?.message) };
  }
}

async function executeFile(executable, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
    });
    return { ok: true, code: 0, stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr) };
  } catch (error) {
    const result = {
      ok: false,
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: boundedOutput(error?.stdout),
      stderr: boundedOutput(error?.stderr || error?.message),
    };
    if (!allowFailure) {
      const detail = result.stderr || result.stdout || `exit code ${result.code}`;
      throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`);
    }
    return result;
  }
}

export async function findClientExecutable(name, {
  platform = process.platform,
  execute = executeFile,
} = {}) {
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = await execute(locator, [name], { allowFailure: true });
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? null;
}

function setupPlan(client, commands, executable, skillPath, available = true) {
  return {
    client,
    executable,
    available,
    scope: commands.scope,
    command: [executable, ...commands.add],
    skill_path: skillPath,
  };
}

function unavailableResult(client, commands, skillPath, { dryRun, explicit }) {
  if (dryRun) {
    return {
      ...setupPlan(client, commands, commands.executable, skillPath, false),
      status: "planned",
      message: `${commands.executable} is not currently available on PATH`,
      mcp: { status: "planned", command: [commands.executable, ...commands.add] },
      skill: { path: skillPath, status: "planned" },
    };
  }
  return {
    client,
    available: false,
    status: explicit ? "error" : "skipped",
    scope: commands.scope,
    message: `${commands.executable} was not found on PATH`,
    skill_path: skillPath,
    mcp: { status: "skipped" },
    skill: { path: skillPath, status: "skipped" },
  };
}

async function configureClient(plan, commands, { force, execute }) {
  const existing = await execute(plan.executable, commands.inspect, { allowFailure: true });
  const legacy = await execute(plan.executable, commands.legacy.inspect, { allowFailure: true });
  if (existing.ok && !force) {
    if (legacy.ok) {
      try {
        await execute(plan.executable, commands.legacy.remove);
        return {
          ...plan,
          status: "updated",
          message: "Removed the legacy Localtrace registration; Graphward was already registered",
        };
      } catch (error) {
        return { ...plan, status: "error", message: boundedOutput(error.message) };
      }
    }
    return {
      ...plan,
      status: "already_configured",
      message: "Graphward is already registered; use --force to replace it",
    };
  }

  try {
    if (existing.ok) await execute(plan.executable, commands.remove);
    await execute(plan.executable, commands.add);
    if (legacy.ok) await execute(plan.executable, commands.legacy.remove);
    return {
      ...plan,
      status: existing.ok || legacy.ok ? "updated" : "configured",
      ...(legacy.ok ? { message: "Migrated the legacy Localtrace registration to Graphward" } : {}),
    };
  } catch (error) {
    return { ...plan, status: "error", message: boundedOutput(error.message) };
  }
}

function combinedClientResult(plan, mcp, skill) {
  const resourceStatuses = [mcp.status, skill.status];
  const failed = resourceStatuses.some((status) => ["error", "conflict"].includes(status));
  const changed = resourceStatuses.some((status) => ["configured", "installed"].includes(status));
  const updated = resourceStatuses.includes("updated");
  const status = failed ? "error" : updated ? "updated" : changed ? "configured" : "already_configured";
  const messages = [mcp.message, skill.message].filter(Boolean);
  return {
    ...plan,
    status,
    ...(messages.length > 0 ? { message: messages.join("; ") } : {}),
    mcp: { status: mcp.status, ...(mcp.message ? { message: mcp.message } : {}) },
    skill,
  };
}

async function setupClient(client, {
  nodePath,
  cliPath,
  dryRun,
  force,
  explicit,
  resolveExecutable,
  execute,
  skillOptions,
}) {
  const commands = buildClientCommands(client, { nodePath, cliPath });
  const skillPath = getClientSkillPath(client, skillOptions);
  const executable = await resolveExecutable(commands.executable);
  if (!executable) return unavailableResult(client, commands, skillPath, { dryRun, explicit });
  const plan = setupPlan(client, commands, executable, skillPath);
  const skill = await installClientSkill(client, { ...skillOptions, dryRun, force });
  if (dryRun) {
    return {
      ...plan,
      status: "planned",
      mcp: { status: "planned", command: plan.command },
      skill,
    };
  }
  const mcp = await configureClient(plan, commands, { force, execute });
  return combinedClientResult(plan, mcp, skill);
}

function setupSummary(selection, results, { dryRun, force }) {
  const failed = results.filter((item) => item.status === "error").length;
  const detected = results.filter((item) => item.status !== "skipped" && item.available !== false).length;
  const noneDetected = !dryRun && detected === 0;
  return {
    ok: failed === 0 && !noneDetected,
    dry_run: Boolean(dryRun),
    force: Boolean(force),
    clients: selection.clients,
    detected,
    configured: results.filter((item) => ["configured", "updated", "already_configured"].includes(item.status)).length,
    planned: results.filter((item) => item.status === "planned").length,
    failed,
    ...(noneDetected ? { message: "No supported coding-agent clients were found on PATH" } : {}),
    results,
  };
}

export async function setupClients({
  targets = null,
  nodePath = process.execPath,
  cliPath,
  dryRun = false,
  force = false,
  resolveExecutable = findClientExecutable,
  execute = executeFile,
  homeDirectory = os.homedir(),
  environment = process.env,
  sourceSkillPath = BUNDLED_SKILL_PATH,
  read = readFile,
  write = writeFile,
  makeDirectory = mkdir,
} = {}) {
  if (!cliPath) throw new Error("cliPath is required");
  const selection = parseSetupTargets(targets);
  const results = [];

  for (const client of selection.clients) {
    results.push(await setupClient(client, {
      nodePath,
      cliPath,
      dryRun,
      force,
      explicit: selection.explicit,
      resolveExecutable,
      execute,
      skillOptions: { homeDirectory, environment, sourceSkillPath, read, write, makeDirectory },
    }));
  }
  return setupSummary(selection, results, { dryRun, force });
}
