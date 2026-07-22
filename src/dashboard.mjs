import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseDirectory } from "./folder-picker.mjs";
import { resolveRealPath, samePath } from "./path-utils.mjs";
import { groupIndexedProjects, resolveIndexedProject } from "./projects.mjs";
import { callTool } from "./tools.mjs";
import { getUsageStats } from "./usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsRoot = path.join(here, "dashboard-assets");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const API_BODY_LIMIT = 2_250_000;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function boundedText(value, name, maximum, { required = true } = {}) {
  if (value == null || value === "") {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim().normalize("NFC");
  if (!normalized && required) throw new Error(`${name} is required`);
  if (normalized.length > maximum || normalized.includes("\0")) throw new Error(`${name} exceeds its local dashboard bound`);
  return normalized || null;
}

function boundedRawText(value, name, maximum) {
  if (typeof value !== "string" || !value.length) throw new Error(`${name} is required`);
  if (value.length > maximum || value.includes("\0")) throw new Error(`${name} exceeds its local dashboard bound`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function publicError(error) {
  return error instanceof Error ? error.message : "Local dashboard request failed";
}

function htmlAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isAllowedHost(header) {
  return typeof header === "string"
    && /^(?:127[.]0[.]0[.]1|localhost|\[::1\])(?::\d{1,5})?$/i.test(header);
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), JSON_HEADERS);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > API_BODY_LIMIT) throw new Error(`request body exceeds ${API_BODY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value;
}

function queryValue(url, name, maximum = 4_096, options = {}) {
  return boundedText(url.searchParams.get(name), name, maximum, options);
}

function repoArgs(url) {
  return { repo_id: queryValue(url, "repo_id", 300) };
}

async function loadAssets(sessionToken, defaultRepoId) {
  const [indexTemplate, styles, graphApplication, application] = await Promise.all([
    readFile(path.join(assetsRoot, "index.html"), "utf8"),
    readFile(path.join(assetsRoot, "styles.css"), "utf8"),
    readFile(path.join(assetsRoot, "code-graph.js"), "utf8"),
    readFile(path.join(assetsRoot, "app.js"), "utf8"),
  ]);
  return {
    "/": {
      type: "text/html; charset=utf-8",
      body: indexTemplate
        .replace("%%GRAPHWARD_SESSION_TOKEN%%", htmlAttribute(sessionToken))
        .replace("%%GRAPHWARD_DEFAULT_REPO%%", htmlAttribute(defaultRepoId ?? "")),
    },
    "/index.html": null,
    "/styles.css": { type: "text/css; charset=utf-8", body: styles },
    "/code-graph.js": { type: "text/javascript; charset=utf-8", body: graphApplication },
    "/app.js": { type: "text/javascript; charset=utf-8", body: application },
  };
}

async function getRepositories(_request, _url, context) {
  const result = await callTool("list_indexed_repositories", {}, context);
  const projects = groupIndexedProjects(context.db, result.repositories);
  const defaultProject = projects.find((project) => project.repo_ids.includes(context.defaultRepoId)) ?? projects[0] ?? null;
  return {
    ...result,
    default_project_id: defaultProject?.project_id ?? null,
    default_repo_id: defaultProject?.primary_repo_id ?? context.defaultRepoId,
    projects,
  };
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function validatedDirectory(value) {
  const requested = boundedText(value, "path", 4_096);
  if (!path.isAbsolute(requested)) throw new Error("path must be absolute");
  const resolved = resolveRealPath(await realpath(requested));
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("path must identify a directory");
  return resolved;
}

async function pickRepositoryFolder(_request, _url, context) {
  if (context.pickingFolder) throw statusError("a folder picker is already open", 409);
  context.pickingFolder = true;
  try {
    const selected = await context.pickDirectory({ initialPath: context.defaultRoot });
    if (!selected) return { cancelled: true, path: null };
    return { cancelled: false, path: await validatedDirectory(selected) };
  } finally {
    context.pickingFolder = false;
  }
}

function existingRepositoryId(db, root) {
  const repositories = db.prepare("SELECT repo_id, root FROM repositories ORDER BY indexed_at DESC, id DESC").all();
  return repositories.find((repository) => samePath(repository.root, root))?.repo_id ?? null;
}

async function indexRepository(request, _url, context) {
  if (context.indexingRepository) throw statusError("a repository index is already running", 409);
  context.indexingRepository = true;
  try {
    const body = await readJson(request);
    if (body.force != null && typeof body.force !== "boolean") throw new Error("force must be a boolean");
    if (body.watch != null && typeof body.watch !== "boolean") throw new Error("watch must be a boolean");
    const root = await validatedDirectory(body.path);
    const repoId = existingRepositoryId(context.db, root);
    const indexArgs = {
      path: root,
      force: body.force === true,
    };
    if (repoId) indexArgs.repo_id = repoId;
    const repository = await callTool("index_directory", indexArgs, context);
    let watching = null;
    let watchError = null;
    if (body.watch !== false && context.watchManager) {
      try {
        watching = await callTool("watch_directory", {
          path: root,
          repo_id: repository.repo_id,
          initial_index: false,
        }, context);
      } catch (error) {
        watchError = publicError(error);
      }
    }
    context.defaultRepoId = repository.repo_id;
    return {
      repository,
      watching,
      watch_error: watchError,
      watch_available: Boolean(context.watchManager),
    };
  } finally {
    context.indexingRepository = false;
  }
}

async function getOverview(_request, url, context) {
  const args = repoArgs(url);
  const stats = await callTool("get_repository_stats", args, context);
  const diagnostics = await callTool("get_index_diagnostics", { ...args, limit: 12 }, context);
  const architecture = await callTool("get_architecture", { ...args, max_communities: 10, max_symbols: 24 }, context);
  const briefing = await callTool("get_codebase_briefing", {
    ...args, process_limit: 12, decision_limit: 12, hotspot_limit: 8,
    community_limit: 8, central_symbol_limit: 16,
  }, context);
  return { stats, diagnostics, architecture, briefing };
}

function getCodeGraph(_request, url, context) {
  const kinds = (url.searchParams.get("edge_kinds") ?? "calls,imports")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  if (!kinds.length || kinds.some((kind) => kind !== "calls" && kind !== "imports")) {
    throw new Error("edge_kinds must contain calls, imports, or both");
  }
  return callTool("get_code_graph", {
    ...repoArgs(url),
    focus: queryValue(url, "focus", 2_000, { required: false }),
    max_nodes: boundedInteger(url.searchParams.get("max_nodes"), 8_000, 50, 12_000, "max_nodes"),
    max_edges: boundedInteger(url.searchParams.get("max_edges"), 24_000, 100, 40_000, "max_edges"),
    include_tests: url.searchParams.get("include_tests") !== "false",
    edge_kinds: kinds,
  }, context);
}

function searchCode(_request, url, context) {
  return callTool("find_code", {
    ...repoArgs(url), query: queryValue(url, "q", 2_000),
    limit: boundedInteger(url.searchParams.get("limit"), 30, 1, 60, "limit"),
  }, context);
}

async function getSymbol(_request, url, context) {
  const args = repoArgs(url);
  const symbol = queryValue(url, "symbol", 4_096);
  const filePath = queryValue(url, "file_path", 4_096, { required: false });
  const contextResult = await callTool("get_symbol_context", { ...args, symbol, file_path: filePath }, context);
  const selected = contextResult.symbol;
  const impact = await callTool("get_impact", {
    ...args, target: selected.name, file_path: selected.file_path, direction: "both", depth: 4,
  }, context);
  const relationships = await callTool("get_code_relationships", {
    ...args, symbol: selected.name, file_path: selected.file_path, limit: 160,
  }, context);
  const startLine = Math.max(1, Number(selected.start_line) - 8);
  const endLine = Math.min(Number(selected.end_line) + 8, startLine + 399);
  const source = await callTool("get_source_window", {
    ...args, file_path: selected.file_path, start_line: startLine, end_line: endLine,
  }, context);
  return { context: contextResult, impact, relationships, source };
}

async function getQuality(_request, url, context) {
  const args = repoArgs(url);
  const view = queryValue(url, "view", 30, { required: false }) ?? "hotspots";
  const calls = {
    hotspots: ["find_hotspots", { ...args, limit: 80, max_symbols: 5_000 }],
    complexity: ["calculate_cyclomatic_complexity", { ...args, limit: 80, max_symbols: 5_000 }],
    dead: ["find_dead_code", { ...args, limit: 80, max_symbols: 8_000 }],
    bridges: ["find_bridge_symbols", { ...args, limit: 80 }],
    style: ["get_style_fingerprint", { ...args, max_symbols: 5_000 }],
  };
  if (!calls[view]) throw new Error("view must be hotspots, complexity, dead, bridges, or style");
  const [tool, toolArgs] = calls[view];
  return { view, result: await callTool(tool, toolArgs, context) };
}

function getProcesses(_request, url, context) {
  return callTool("list_processes", { ...repoArgs(url), active: true, limit: 250 }, context);
}

function getProcess(_request, url, context) {
  return callTool("get_process_flow", {
    ...repoArgs(url), process_key: queryValue(url, "process_key", 300),
  }, context);
}

async function refreshProcesses(request, _url, context) {
  const body = await readJson(request);
  return callTool("refresh_processes", {
    repo_id: boundedText(body.repo_id, "repo_id", 300), max_processes: 250,
    min_confidence: 0.5, max_depth: 8,
  }, context);
}

function getServices(_request, url, context) {
  const args = repoArgs(url);
  return callTool("get_service_diagram", { repo_ids: [args.repo_id], limit: 1_000 }, context);
}

function getFleet(_request, url, context) {
  return callTool("fleet_get_graph", {
    ...repoArgs(url),
    branch: queryValue(url, "branch", 300, { required: false }),
    limit: 300,
  }, context);
}

async function getTimeline(_request, url, context) {
  const args = repoArgs(url);
  const stats = await callTool("get_temporal_stats", args, context);
  const evolution = await callTool("get_evolution", { ...args, from: 0, mode: "recent", limit: 120 }, context);
  return { stats, evolution };
}

function getDecisions(_request, url, context) {
  return callTool("recall_decision", {
    ...repoArgs(url), query: queryValue(url, "q", 2_000), limit: 50,
  }, context);
}

async function getUsage(_request, url, context) {
  const period = queryValue(url, "period", 10, { required: false }) ?? "30d";
  if (!new Set(["24h", "7d", "30d", "90d", "all"]).has(period)) {
    throw new Error("period must be 24h, 7d, 30d, 90d, or all");
  }
  const selected = repoArgs(url);
  const project = resolveIndexedProject(context.db, selected.repo_id);
  const usage = getUsageStats(context.db, { repoIds: project.repo_ids, period });
  return {
    ...usage,
    project: {
      project_id: project.project_id,
      name: project.name,
      root: project.root,
      main_repo_id: project.main_repo_id,
      worktree_count: project.worktree_count,
      repo_ids: project.repo_ids,
    },
  };
}

async function reviewChanges(request, _url, context) {
  const body = await readJson(request);
  const repoId = boundedText(body.repo_id, "repo_id", 300);
  const diff = body.diff == null || body.diff === "" ? null : boundedRawText(body.diff, "diff", 2_100_000);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!diff && !changes.length) throw new Error("diff or changes is required");
  return callTool("review_change", {
    repo_id: repoId, diff, changes, include_cochange: body.include_cochange !== false,
    max_changed_symbols: 200, max_findings: 200, max_body_bytes: 8_388_608, max_process_flows: 150,
  }, context);
}

const API_ROUTES = new Map([
  ["GET /api/repositories", getRepositories],
  ["POST /api/repositories/pick", pickRepositoryFolder],
  ["POST /api/repositories/index", indexRepository],
  ["GET /api/overview", getOverview],
  ["GET /api/code-graph", getCodeGraph],
  ["GET /api/search", searchCode],
  ["GET /api/symbol", getSymbol],
  ["GET /api/quality", getQuality],
  ["GET /api/processes", getProcesses],
  ["GET /api/process", getProcess],
  ["POST /api/processes/refresh", refreshProcesses],
  ["GET /api/services", getServices],
  ["GET /api/fleet", getFleet],
  ["GET /api/timeline", getTimeline],
  ["GET /api/decisions", getDecisions],
  ["GET /api/usage", getUsage],
  ["POST /api/review", reviewChanges],
]);

function apiResponse(request, url, context) {
  const handler = API_ROUTES.get(`${request.method} ${url.pathname}`);
  if (handler) return handler(request, url, context);
  const error = new Error(`Unknown dashboard endpoint: ${request.method} ${url.pathname}`);
  error.statusCode = 404;
  throw error;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isAllowedHost(parsed.host) && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

export async function startDashboard({
  db,
  defaultRoot,
  defaultRepoId = null,
  watchManager = null,
  pickDirectory = chooseDirectory,
  host = "127.0.0.1",
  port = 7331,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("dashboard requires an open Graphward database");
  if (!LOOPBACK_HOSTS.has(String(host).toLowerCase())) throw new Error("dashboard host must be loopback-only (127.0.0.1, ::1, or localhost)");
  const listenHost = host === "localhost" ? "127.0.0.1" : host;
  const listenPort = boundedInteger(port, 7331, 0, 65_535, "port");
  const sessionToken = randomBytes(32).toString("base64url");
  const assets = await loadAssets(sessionToken, defaultRepoId);
  assets["/index.html"] = assets["/"];
  if (typeof pickDirectory !== "function") throw new Error("dashboard folder picker must be a function");
  const context = {
    db,
    defaultRoot,
    defaultRepoId,
    watchManager,
    pickDirectory,
    surface: "dashboard",
    pickingFolder: false,
    indexingRepository: false,
  };

  const server = createServer((request, response) => {
    const run = async () => {
      if (!isAllowedHost(request.headers.host)) {
        sendJson(response, 421, { error: "dashboard accepts only loopback Host headers" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        if (!tokenMatches(request.headers["x-graphward-token"], sessionToken)) {
          sendJson(response, 403, { error: "invalid local dashboard session" });
          return;
        }
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendJson(response, 403, { error: "dashboard write-style requests require the same loopback origin" });
          return;
        }
        const value = await apiResponse(request, url, context);
        sendJson(response, 200, { ok: true, data: value });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      const asset = assets[url.pathname];
      if (!asset) {
        send(response, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
        return;
      }
      send(response, 200, request.method === "HEAD" ? "" : asset.body, {
        "Content-Type": asset.type,
        "Cache-Control": "no-cache",
      });
    };
    run().catch((error) => {
      console.error(`[graphward dashboard] request failed: ${publicError(error)}`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, error.statusCode ?? 400, { error: publicError(error) });
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(listenPort, listenHost, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  const urlHost = listenHost === "::1" ? "[::1]" : listenHost;
  return {
    host: listenHost,
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
