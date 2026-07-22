import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { getSystemResourcePlan, nodeHeapArgument } from "./system-resources.mjs";

function stateDirectory() {
  if (process.env.GRAPHWARD_STATE_DIR) return path.resolve(process.env.GRAPHWARD_STATE_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "Graphward");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "graphward");
}

function pathsFor(port) {
  const directory = stateDirectory();
  const key = `service-${port}`;
  return {
    directory,
    state: path.join(directory, `${key}.json`),
    log: path.join(directory, `${key}.log`),
    profile: path.join(directory, `${key}.profile.json`),
  };
}

export function getDefaultGraphwardDatabasePath({ port = 7331 } = {}) {
  const numericPort = Math.max(1, Math.min(Number(port) || 7331, 65535));
  const name = numericPort === 7331 ? "index.sqlite" : `index-${numericPort}.sqlite`;
  return path.join(stateDirectory(), name);
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(statePath, value) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, statePath);
}

function stateFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".profile.json"))
    .map((entry) => path.join(directory, entry.name));
}

function runningStateForPort(port) {
  const locations = pathsFor(port);
  const candidates = [locations.state, ...stateFiles(locations.directory).filter((candidate) => candidate !== locations.state)];
  for (const stateFile of candidates) {
    const state = readState(stateFile);
    if (Number(state?.port) !== port || !processRunning(Number(state?.pid))) continue;
    return { state, stateFile, legacy: stateFile !== locations.state };
  }
  return null;
}

function legacyProfilesForPort(port) {
  const locations = pathsFor(port);
  if (!existsSync(locations.directory)) return [];
  return readdirSync(locations.directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".profile.json") && entry.name !== path.basename(locations.profile))
    .map((entry) => readState(path.join(locations.directory, entry.name)))
    .filter((profile) => Number(profile?.port) === port && typeof profile?.database === "string" && existsSync(profile.database))
    .sort((left, right) => Number(Boolean(right.repo_id)) - Number(Boolean(left.repo_id))
      || Date.parse(right.updated_at ?? 0) - Date.parse(left.updated_at ?? 0));
}

function waitForDashboard(child, url, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      child.off("exit", exited);
      child.off("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const exited = (code, signal) => finish(new Error(`Graphward dashboard exited before it was ready (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    const failed = (error) => finish(error);
    const probe = () => {
      if (Date.now() - started >= timeoutMs) {
        finish(new Error(`Graphward dashboard did not become ready within ${timeoutMs}ms`));
        return;
      }
      const request = http.get(url, { timeout: 1_000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) finish();
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => {});
    };
    child.once("exit", exited);
    child.once("error", failed);
    timer = setInterval(probe, 150);
    probe();
  });
}

function dashboardResponding(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

export function buildGraphwardServiceArguments({ cliPath, initialRoot, databasePath, host, port, resourcePlan }) {
  return [
    nodeHeapArgument(resourcePlan),
    path.resolve(cliPath),
    "dashboard",
    "--root", path.resolve(initialRoot),
    "--db", path.resolve(databasePath),
    "--host", host,
    "--port", String(port),
    "--watch-indexed",
  ];
}

export async function startGraphwardService({ cliPath, initialRoot = os.homedir(), databasePath, host = "127.0.0.1", port = 7331 }) {
  const resolvedInitialRoot = path.resolve(initialRoot);
  const resolvedDatabase = path.resolve(databasePath);
  const numericPort = Math.max(1, Math.min(Number(port) || 7331, 65535));
  if (!existsSync(resolvedInitialRoot) || !statSync(resolvedInitialRoot).isDirectory()) {
    throw new Error(`Graphward initial folder does not exist or is not a directory: ${resolvedInitialRoot}`);
  }
  const locations = pathsFor(numericPort);
  mkdirSync(locations.directory, { recursive: true });
  const existing = runningStateForPort(numericPort);
  if (existing) {
    return { ok: true, already_running: true, scope: existing.legacy ? "legacy" : "user", ...existing.state };
  }
  if (existsSync(locations.state)) rmSync(locations.state, { force: true });
  const url = `http://${host}:${numericPort}`;
  if (await dashboardResponding(url)) {
    throw new Error(`Port ${numericPort} is already serving another dashboard. Use --port with a different value.`);
  }
  const resourcePlan = getSystemResourcePlan();
  writeState(locations.profile, {
    database: resolvedDatabase,
    host,
    port: numericPort,
    updated_at: new Date().toISOString(),
  });

  const args = buildGraphwardServiceArguments({
    cliPath,
    initialRoot: resolvedInitialRoot,
    databasePath: resolvedDatabase,
    host,
    port: numericPort,
    resourcePlan,
  });
  const log = openSync(locations.log, "a");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: path.dirname(path.resolve(cliPath)),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  const state = {
    pid: child.pid,
    scope: "user",
    initial_root: resolvedInitialRoot,
    database: resolvedDatabase,
    host,
    port: numericPort,
    url,
    log: locations.log,
    resources: resourcePlan,
    started_at: new Date().toISOString(),
  };
  writeState(locations.state, state);
  try {
    await waitForDashboard(child, state.url);
  } catch (error) {
    rmSync(locations.state, { force: true });
    if (processRunning(child.pid)) process.kill(child.pid, "SIGTERM");
    let logTail = "";
    try {
      logTail = readFileSync(locations.log, "utf8").slice(-4_000).trim();
    } catch {
      logTail = "";
    }
    throw new Error(`${error.message}${logTail ? `\n${logTail}` : ""}`);
  }
  return { ok: true, already_running: false, ready: true, ...state };
}

export function getSavedGraphwardServiceProfile({ port = 7331 } = {}) {
  const numericPort = Math.max(1, Math.min(Number(port) || 7331, 65535));
  const locations = pathsFor(numericPort);
  return readState(locations.profile)
    ?? runningStateForPort(numericPort)?.state
    ?? legacyProfilesForPort(numericPort)[0]
    ?? null;
}

export function getGraphwardServiceStatus({ port = 7331 } = {}) {
  const numericPort = Math.max(1, Math.min(Number(port) || 7331, 65535));
  const locations = pathsFor(numericPort);
  const running = runningStateForPort(numericPort);
  if (running) {
    return {
      ok: true,
      running: true,
      scope: running.legacy ? "legacy" : "user",
      ...running.state,
      state_file: running.stateFile,
    };
  }
  if (existsSync(locations.state)) rmSync(locations.state, { force: true });
  return {
    ok: true,
    running: false,
    scope: "user",
    port: numericPort,
    state_file: locations.state,
    log: locations.log,
  };
}

export function stopGraphwardService({ port = 7331 } = {}) {
  const status = getGraphwardServiceStatus({ port });
  if (!status.running) return { ...status, stopped: false };
  process.kill(Number(status.pid), "SIGTERM");
  rmSync(status.state_file, { force: true });
  return { ...status, running: false, stopped: true, stopped_at: new Date().toISOString() };
}
