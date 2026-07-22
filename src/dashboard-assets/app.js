const sessionToken = document.querySelector('meta[name="graphward-token"]').content;
const preferredRepo = document.querySelector('meta[name="graphward-default-repo"]').content;
const state = {
  repoId: null,
  view: "overview",
  qualityView: "hotspots",
  overview: null,
  codeGraph: null,
  services: null,
  fleet: null,
  fleetBranch: "",
  usagePeriod: "30d",
  requestVersion: 0,
};

const colors = ["#55d6a5", "#7dd3fc", "#c4b5fd", "#fbbf77", "#fb7185", "#94a3b8"];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : "—";
}

function formatDate(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function percent(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "—";
}

function truncate(value, maximum = 90) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function loading(message = "Reading the local index…") {
  return `<div class="loading-state"><div>${escapeHtml(message)}</div></div>`;
}

function empty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function badge(value, kind = "kind") {
  const normalized = String(value ?? "unknown").toLowerCase().replace(/[^a-z]+/g, "-");
  const semantic = ["critical", "error", "high", "warning", "medium", "low", "info"].includes(normalized) ? normalized : kind;
  return `<span class="badge badge-${semantic}">${escapeHtml(value ?? "unknown")}</span>`;
}

function metric(label, value, note) {
  return `<article class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-note">${escapeHtml(note)}</div></article>`;
}

function progress(value, maximum = 100) {
  const safeMaximum = Math.max(1, Number(maximum) || 1);
  const safeValue = Math.max(0, Math.min(safeMaximum, Number(value) || 0));
  return `<progress class="mini-progress" max="${safeMaximum}" value="${safeValue}">${Math.round((safeValue / safeMaximum) * 100)}%</progress>`;
}

let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("is-error", error);
  element.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("is-visible"), 3800);
}

function report(error, target = null) {
  console.error("[graphward dashboard]", error);
  if (target) target.innerHTML = empty(error.message);
  toast(error.message, true);
}

async function api(path, options = {}) {
  const headers = { "X-Graphward-Token": sessionToken, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Dashboard returned HTTP ${response.status}`);
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Dashboard returned HTTP ${response.status}`);
  return payload.data;
}

function repoQuery(extra = {}) {
  const search = new URLSearchParams({ repo_id: state.repoId, ...extra });
  return search.toString();
}

function setConnection(online, label = online ? "Local index ready" : "Connection error") {
  const element = $("#connection-state");
  element.classList.toggle("is-online", online);
  element.lastChild.textContent = label;
}

function clearRepositoryState() {
  state.overview = null;
  state.codeGraph = null;
  state.services = null;
  state.fleet = null;
  state.fleetBranch = "";
  state.requestVersion += 1;
}

function projectOption(project) {
  const main = project.main_repository;
  const branch = main?.index_snapshot?.branch ?? project.repositories?.[0]?.index_snapshot?.branch ?? "detached";
  const checkout = project.has_main_checkout ? branch : `${branch} (worktree only)`;
  const worktrees = `${formatNumber(project.worktree_count)} worktree${project.worktree_count === 1 ? "" : "s"}`;
  return `<option value="${escapeHtml(project.project_id)}" data-repo-id="${escapeHtml(project.primary_repo_id)}">${escapeHtml(project.name ?? project.project_id)} · ${escapeHtml(checkout)} · ${escapeHtml(worktrees)}</option>`;
}

async function refreshRepositories(preferredId = null) {
  const value = await api("/api/repositories");
  const repositories = value.repositories ?? [];
  const projects = value.projects ?? repositories.map((repository) => ({
    project_id: repository.repo_id,
    primary_repo_id: repository.repo_id,
    main_repo_id: repository.repo_id,
    has_main_checkout: true,
    main_repository: repository,
    name: repository.name,
    root: repository.root,
    repo_ids: [repository.repo_id],
    repositories: [repository],
    worktree_count: 0,
    worktrees: [],
  }));
  const select = $("#repo-select");
  if (!projects.length) {
    select.innerHTML = '<option value="">No projects indexed</option>';
    select.disabled = true;
    state.repoId = null;
    return null;
  }
  select.disabled = false;
  select.innerHTML = projects.map(projectOption).join("");
  const matches = (project, id) => project.project_id === id || project.repo_ids?.includes(id);
  const selected = projects.find((project) => matches(project, preferredId))
    ?? projects.find((project) => matches(project, state.repoId))
    ?? projects.find((project) => matches(project, preferredRepo))
    ?? projects.find((project) => matches(project, value.default_project_id ?? value.default_repo_id))
    ?? projects[0];
  state.repoId = selected.primary_repo_id;
  select.value = selected.project_id;
  return selected;
}

async function chooseAndIndexRepository(event) {
  const button = event.currentTarget;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Choose folder…";
  setConnection(true, "Waiting for folder selection");
  try {
    const selection = await api("/api/repositories/pick", { method: "POST", body: "{}" });
    if (selection.cancelled) {
      setConnection(Boolean(state.repoId), state.repoId ? "Local index ready" : "Choose a folder to begin");
      toast("Folder selection cancelled.");
      return;
    }
    const folderName = selection.path.split(/[\\/]/).filter(Boolean).at(-1) ?? selection.path;
    button.textContent = "Indexing…";
    setConnection(true, `Indexing ${folderName}`);
    const result = await api("/api/repositories/index", {
      method: "POST",
      body: JSON.stringify({ path: selection.path, watch: true }),
    });
    clearRepositoryState();
    await refreshRepositories(result.repository.repo_id);
    setConnection(true, result.watching ? "Indexed and watching" : "Indexed locally");
    setView("overview", { force: true });
    const watchNote = result.watching
      ? " and watching for changes"
      : result.watch_error
        ? `; watcher could not start: ${result.watch_error}`
        : "";
    toast(`Indexed ${folderName}${watchNote}.`);
  } catch (error) {
    setConnection(Boolean(state.repoId), state.repoId ? "Indexing failed" : "Choose a folder to begin");
    report(error, state.repoId ? null : $("#overview-metrics"));
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function setView(view, { force = false } = {}) {
  if (!force && state.view === view && $(`[data-panel="${view}"]`).classList.contains("is-visible")) return;
  if (view !== "fleet") clearTimeout(fleetPollTimer);
  if (view !== "graph") stopCodeGraphAnimation();
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.panel === view));
  $(".sidebar").classList.remove("is-open");
  loadView(view).catch((error) => {
    report(error);
    setConnection(false, "Request failed");
  });
}

async function loadView(view) {
  if (!state.repoId) return;
  setConnection(true, "Reading local index");
  const loaders = {
    overview: loadOverview,
    graph: loadCodeGraph,
    quality: () => loadQuality(state.qualityView),
    processes: loadProcesses,
    services: loadServices,
    fleet: loadFleet,
    timeline: loadTimeline,
    usage: loadUsage,
  };
  if (loaders[view]) await loaders[view]();
  setConnection(true);
}

function drawDonut(canvas, rows) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const radius = Math.min(width, height) * 0.42;
  const total = rows.reduce((sum, row) => sum + Number(row.files ?? 0), 0) || 1;
  let angle = -Math.PI / 2;
  rows.forEach((row, index) => {
    const next = angle + (Number(row.files ?? 0) / total) * Math.PI * 2;
    context.beginPath();
    context.arc(width / 2, height / 2, radius, angle, next);
    context.strokeStyle = colors[index % colors.length];
    context.lineWidth = 17;
    context.stroke();
    angle = next;
  });
  context.fillStyle = "#f0f4ef";
  context.font = "700 22px Segoe UI";
  context.textAlign = "center";
  context.fillText(formatNumber(total), width / 2, height / 2 + 2);
  context.fillStyle = "#697572";
  context.font = "9px Segoe UI";
  context.fillText("FILES", width / 2, height / 2 + 18);
}

function fitCanvas(canvas) {
  const rectangle = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rectangle.width * ratio));
  canvas.height = Math.max(1, Math.round(rectangle.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rectangle.width, height: rectangle.height };
}

function shortLabel(value, maximum = 22) {
  const text = String(value ?? "unknown");
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function architecturePackageNodes(packages, width, height) {
  const rows = packages.slice(0, 7);
  const columns = Math.ceil(rows.length / 2);
  return rows.map((item, index) => ({
    ...item,
    x: 72 + (index % 2) * Math.max(80, width - 144),
    y: 48 + Math.floor(index / 2) * Math.max(58, (height - 96) / Math.max(1, columns)),
  }));
}

function architectureSymbolNodes(symbols, width, height) {
  const rows = symbols.slice(0, 12);
  const centerX = width / 2;
  const centerY = height / 2;
  const orbitX = Math.max(80, width * 0.28);
  const orbitY = Math.max(68, height * 0.34);
  return rows.map((item, index) => {
    const angle = (index / Math.max(1, rows.length)) * Math.PI * 2 - Math.PI / 2;
    return { ...item, x: centerX + Math.cos(angle) * orbitX, y: centerY + Math.sin(angle) * orbitY };
  });
}

function drawArchitectureLinks(context, packages, symbols) {
  context.lineWidth = 1;
  for (const symbol of symbols) {
    const packageName = String(symbol.file_path ?? "").split("/")[0] || ".";
    const target = packages.find((item) => item.name === packageName) ?? packages[0];
    if (!target) continue;
    context.beginPath();
    context.moveTo(symbol.x, symbol.y);
    context.lineTo(target.x, target.y);
    context.strokeStyle = "rgba(85, 214, 165, 0.16)";
    context.stroke();
  }
}

function drawPackageNodes(context, nodes, width) {
  for (const node of nodes) {
    const alignLeft = node.x < width / 2;
    context.beginPath();
    context.arc(node.x, node.y, 9, 0, Math.PI * 2);
    context.fillStyle = "#c4b5fd";
    context.fill();
    context.fillStyle = "#94a09d";
    context.font = "10px Segoe UI";
    context.textAlign = alignLeft ? "left" : "right";
    context.fillText(shortLabel(node.name, 17), node.x + (alignLeft ? 14 : -14), node.y + 4);
  }
}

function drawCentralNodes(context, nodes, width) {
  for (const node of nodes) {
    const alignLeft = node.x < width / 2;
    const rank = Number(node.score ?? node.pagerank ?? 0);
    const radius = 4 + Math.min(7, Math.sqrt(Math.max(0, rank) * 400));
    context.beginPath();
    context.arc(node.x, node.y, radius, 0, Math.PI * 2);
    context.fillStyle = "#55d6a5";
    context.fill();
    context.fillStyle = "#d5dfdb";
    context.font = "10px Segoe UI";
    context.textAlign = alignLeft ? "right" : "left";
    context.fillText(shortLabel(node.name, 19), node.x + (alignLeft ? -10 : 10), node.y + 3);
  }
}

function drawArchitecture(architecture) {
  const canvas = $("#architecture-canvas");
  if (!canvas) return;
  const { context, width, height } = fitCanvas(canvas);
  context.clearRect(0, 0, width, height);
  const packages = architecturePackageNodes(architecture.packages ?? [], width, height);
  const symbols = architectureSymbolNodes(architecture.central_symbols ?? [], width, height);
  drawArchitectureLinks(context, packages, symbols);
  drawPackageNodes(context, packages, width);
  drawCentralNodes(context, symbols, width);
}

function renderLanguages(rows) {
  const values = (rows ?? []).slice(0, 6);
  $("#language-chart").innerHTML = `
    <canvas class="donut-canvas" id="language-donut" aria-label="Language distribution"></canvas>
    <div class="legend-list">${values.map((row, index) => `
      <div class="legend-row"><i class="legend-dot legend-dot-${index % colors.length}"></i><span>${escapeHtml(row.language)}</span><strong>${formatNumber(row.files)}</strong></div>
    `).join("")}</div>`;
  requestAnimationFrame(() => drawDonut($("#language-donut"), values));
}

function statusRow(title, note, status, label) {
  return `<div class="stack-item"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(note)}</small></div><span class="status-pill status-${status}">${escapeHtml(label)}</span></div>`;
}

function hotspotTable(findings) {
  if (!findings?.length) return empty("No bounded hotspot findings are available.");
  const maximum = Math.max(...findings.map((item) => Number(item.hotspot_score ?? item.score ?? 0)), 1);
  return `<table class="data-table"><thead><tr><th>Symbol</th><th>Pressure</th><th>Complexity</th><th>Churn</th><th>Confidence</th></tr></thead><tbody>${findings.slice(0, 12).map((item) => {
    const score = Number(item.hotspot_score ?? item.score ?? 0);
    return `<tr><td><strong>${escapeHtml(item.qualified_name ?? item.name)}</strong><div class="path">${escapeHtml(item.file_path)}</div></td><td>${progress(score, maximum)}<div class="path">${score.toFixed(1)}</div></td><td>${formatNumber(item.cyclomatic_complexity ?? item.complexity ?? 0)} / ${formatNumber(item.cognitive_complexity ?? 0)}</td><td>${formatNumber(item.churn_events ?? 0)}</td><td>${percent(item.confidence)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderOverviewMetrics(stats, briefing) {
  const processSection = briefing.sections?.processes;
  const processValue = processSection?.value;
  const processCount = processValue?.processes?.length ?? processValue?.length ?? 0;
  const indexedDate = stats.indexed_at ? new Date(stats.indexed_at).toLocaleDateString() : "—";
  const snapshot = stats.head_commit ? String(stats.head_commit).slice(0, 10) : "working snapshot";
  $("#overview-metrics").innerHTML = [
    metric("Files", formatNumber(stats.files), `${stats.languages?.length ?? 0} languages`),
    metric("Symbols", formatNumber(stats.symbols), `${formatNumber(stats.semantic_relationships)} semantic relations`),
    metric("Graph edges", formatNumber(stats.edges), `${formatNumber(stats.api_operations)} API operations`),
    metric("Processes", formatNumber(processCount), processSection?.status ?? "missing evidence"),
    metric("Last indexed", indexedDate, snapshot),
  ].join("");
}

function diagnosticResolutionRow(label, values, noun) {
  const rate = values?.resolution_rate ?? 0;
  const note = `${formatNumber(values?.resolved)} of ${formatNumber(values?.total)} ${noun}`;
  return statusRow(label, note, rate >= 0.5 ? "good" : "warn", percent(rate));
}

function temporalEvidenceRow(temporal) {
  const note = temporal?.reason ?? temporal?.source ?? "No history ingested";
  const state = temporal?.status === "available" ? "good" : "warn";
  return statusRow("Temporal coverage", note, state, temporal?.status ?? "Missing");
}

function renderEvidenceHealth(diagnostics, briefing) {
  const parseErrors = diagnostics.parse_error_files?.length ?? 0;
  const temporal = briefing.sections?.temporal_history;
  const parseNote = parseErrors ? `${parseErrors} diagnostic file(s)` : "No parser diagnostics in sample";
  const parseState = parseErrors ? "warn" : "good";
  $("#evidence-health").innerHTML = [
    statusRow("Structured parsing", parseNote, parseState, parseErrors ? "Review" : "Healthy"),
    diagnosticResolutionRow("Call resolution", diagnostics.calls, "calls"),
    diagnosticResolutionRow("Import resolution", diagnostics.imports, "imports"),
    temporalEvidenceRow(temporal),
  ].join("");
}

function renderOverviewHotspots(briefing) {
  const value = briefing.sections?.hotspots?.value;
  const hotspots = value?.findings ?? value ?? [];
  $("#overview-hotspots").innerHTML = hotspotTable(Array.isArray(hotspots) ? hotspots : []);
}

async function loadOverview() {
  const version = ++state.requestVersion;
  $("#overview-metrics").innerHTML = loading();
  $("#evidence-health").innerHTML = loading();
  $("#overview-hotspots").innerHTML = loading("Calculating current pressure…");
  const value = await api(`/api/overview?${repoQuery()}`);
  if (version !== state.requestVersion) return;
  state.overview = value;
  const { stats, diagnostics, architecture, briefing } = value;
  renderOverviewMetrics(stats, briefing);
  $("#architecture-meta").textContent = `${architecture.communities?.length ?? 0} communities · ${architecture.packages?.length ?? 0} packages`;
  renderLanguages(stats.languages ?? architecture.languages ?? []);
  renderEvidenceHealth(diagnostics, briefing);
  renderOverviewHotspots(briefing);
  requestAnimationFrame(() => drawArchitecture(architecture));
}

let codeGraphRenderer = null;

function stopCodeGraphAnimation() {
  codeGraphRenderer?.stop();
}

function renderCodeGraphSummary(value) {
  const counts = value.counts ?? {};
  const bounded = value.bounds?.truncated ? " · bounded" : " · complete";
  $("#code-graph-summary").innerHTML = [
    `<span>${formatNumber(counts.shown_nodes)} / ${formatNumber(counts.indexed_nodes)} symbols</span>`,
    `<span>${formatNumber(counts.shown_edges)} / ${formatNumber(counts.indexed_edges)} edges</span>`,
    `<span>${formatNumber(counts.clusters)} communities${bounded}</span>`,
  ].join("");
}

function renderCodeGraphDetail(node) {
  const detail = $("#code-graph-detail");
  if (!node) {
    detail.classList.remove("is-visible");
    detail.innerHTML = empty("Select a point to inspect its symbol and graph neighborhood.");
    return;
  }
  detail.classList.add("is-visible");
  detail.innerHTML = `
    <div class="graph-symbol-header"><div><h2>${escapeHtml(node.qualified_name ?? node.name)}</h2><p class="graph-symbol-path">${escapeHtml(node.file_path)}:${formatNumber(node.start_line)} · ${escapeHtml(node.cluster?.path ?? node.cluster_id)}</p></div><button id="graph-close-detail" type="button" aria-label="Close symbol detail">Close</button></div>
    <div class="badge-row">${badge(node.kind)}${node.exported ? badge("exported", "info") : ""}${node.test ? badge("test", "info") : ""}</div>
    <div class="graph-symbol-stats"><div><span>Callers</span><strong>${formatNumber(node.incoming)}</strong></div><div><span>Dependencies</span><strong>${formatNumber(node.outgoing)}</strong></div><div><span>Lines</span><strong>${formatNumber(Math.max(1, Number(node.end_line) - Number(node.start_line) + 1))}</strong></div></div>
    <div class="graph-symbol-actions"><button class="button button-primary" id="graph-open-symbol" type="button">Open in Explorer</button></div>`;
  $("#graph-close-detail").addEventListener("click", () => codeGraphRenderer?.clearSelection());
  $("#graph-open-symbol").addEventListener("click", () => openCodeGraphSymbol(node));
}

function openCodeGraphSymbol(node) {
  if (!node) return;
  setView("explorer");
  loadSymbol(node).catch((error) => report(error, $("#symbol-detail")));
}

function ensureCodeGraphRenderer() {
  if (codeGraphRenderer) return codeGraphRenderer;
  const Constructor = window.GraphwardCodeGraph?.CodeGraphRenderer;
  if (!Constructor) throw new Error("The local code-graph renderer did not load.");
  codeGraphRenderer = new Constructor($("#code-graph-canvas"), $("#code-graph-tooltip"), {
    onSelect: renderCodeGraphDetail,
    onOpen: openCodeGraphSymbol,
  });
  return codeGraphRenderer;
}

function applyCodeGraphOptions() {
  codeGraphRenderer?.setOptions({
    showCalls: $("#graph-calls").checked,
    showImports: $("#graph-imports").checked,
    showTests: $("#graph-tests").checked,
    colorMode: $("#graph-color-mode").value,
  });
}

async function loadCodeGraph() {
  const version = ++state.requestVersion;
  const loadingElement = $("#code-graph-loading");
  loadingElement.textContent = "Projecting local graph…";
  loadingElement.hidden = false;
  renderCodeGraphDetail(null);
  const maxNodes = Number($("#graph-density").value) || 8_000;
  const maxEdges = Math.min(40_000, Math.max(100, maxNodes * 4));
  let value;
  try {
    value = await api(`/api/code-graph?${repoQuery({ max_nodes: maxNodes, max_edges: maxEdges })}`);
  } catch (error) {
    loadingElement.textContent = error.message;
    throw error;
  }
  if (version !== state.requestVersion || state.view !== "graph") return;
  state.codeGraph = value;
  renderCodeGraphSummary(value);
  const renderer = ensureCodeGraphRenderer();
  renderer.setData(value);
  applyCodeGraphOptions();
  loadingElement.hidden = true;
}

function renderSearchResults(result) {
  const rows = result.results ?? [];
  if (!rows.length) {
    $("#search-results").innerHTML = empty("No indexed symbols matched this search.");
    return;
  }
  $("#search-results").innerHTML = rows.map((item, index) => `
    <button class="result-item" data-result-index="${index}">
      <div class="result-title"><strong>${escapeHtml(item.qualified_name ?? item.name)}</strong><span class="result-score">${Number(item.score ?? 0).toFixed(3)}</span></div>
      <div class="result-path">${escapeHtml(item.file_path)} · ${escapeHtml(item.kind)}</div>
    </button>`).join("");
  $$("[data-result-index]", $("#search-results")).forEach((button) => button.addEventListener("click", () => {
    $$("[data-result-index]", $("#search-results")).forEach((item) => item.classList.toggle("is-active", item === button));
    loadSymbol(rows[Number(button.dataset.resultIndex)]).catch((error) => report(error));
  }));
}

function relationChips(items, emptyLabel) {
  if (!items?.length) return `<span class="path">${escapeHtml(emptyLabel)}</span>`;
  return `<div class="chip-list">${items.slice(0, 30).map((item) => `<span class="chip">${escapeHtml(item.qualified_name ?? item.name ?? item.target_name ?? item.source_name ?? item.kind)}</span>`).join("")}</div>`;
}

function renderSource(source) {
  if (!source?.content) return empty("Source text is unavailable for this indexed span.");
  return `<div class="code-window">${source.content.split(/\r?\n/).map((line) => {
    const match = /^(\d+):\s?(.*)$/.exec(line);
    return `<div class="code-line"><span>${escapeHtml(match?.[1] ?? "")}</span><code>${escapeHtml(match?.[2] ?? line)}</code></div>`;
  }).join("")}</div>`;
}

async function loadSymbol(item) {
  $("#symbol-detail").innerHTML = loading("Tracing relationships and impact…");
  const value = await api(`/api/symbol?${repoQuery({ symbol: item.name, file_path: item.file_path })}`);
  const symbol = value.context.symbol;
  const affected = value.impact.results ?? value.impact.affected ?? [];
  const relationships = value.relationships.results ?? [];
  $("#symbol-detail").innerHTML = `
    <div class="symbol-header"><div><h2>${escapeHtml(symbol.qualified_name)}</h2><p class="path">${escapeHtml(symbol.file_path)}:${formatNumber(symbol.start_line)}</p></div><div class="badge-row">${badge(symbol.kind)}${badge(value.impact.risk ?? "low", value.impact.risk ?? "low")}${symbol.exported ? badge("exported", "info") : ""}</div></div>
    <div class="detail-grid">
      <div class="detail-card"><span>Callers</span><strong>${formatNumber(value.context.callers?.length)}</strong></div>
      <div class="detail-card"><span>Callees</span><strong>${formatNumber(value.context.callees?.length)}</strong></div>
      <div class="detail-card"><span>Blast radius</span><strong>${formatNumber(affected.length)}</strong></div>
    </div>
    <h3 class="section-title">Signature</h3><div class="chip">${escapeHtml(symbol.signature)}</div>
    <h3 class="section-title">Callers</h3>${relationChips(value.context.callers, "No observed callers")}
    <h3 class="section-title">Callees</h3>${relationChips(value.context.callees, "No observed callees")}
    <h3 class="section-title">Semantic relationships</h3>${relationChips(relationships, "No explicit semantic relationships")}
    <h3 class="section-title">Source window</h3>${renderSource(value.source)}
  `;
}

function qualityTable(view, result) {
  const findings = result.findings ?? [];
  if (view === "style") {
    if (!findings.length) return empty("No empirical style evidence is available.");
    return `<table class="data-table"><thead><tr><th>Dimension</th><th>Preferred</th><th>Evidence</th><th>Confidence</th></tr></thead><tbody>${findings.map((item) => `<tr><td><strong>${escapeHtml(item.dimension)}</strong></td><td>${escapeHtml(item.preferred)}</td><td>${formatNumber(item.evidence?.total)}</td><td>${percent(item.confidence)}</td></tr>`).join("")}</tbody></table>`;
  }
  if (!findings.length) return empty("No findings within the current bounded analysis.");
  if (view === "hotspots") return hotspotTable(findings);
  if (view === "complexity") return `<table class="data-table"><thead><tr><th>Symbol</th><th>Cyclomatic</th><th>Cognitive</th><th>Parser</th><th>Confidence</th></tr></thead><tbody>${findings.map((item) => `<tr><td><strong>${escapeHtml(item.qualified_name)}</strong><div class="path">${escapeHtml(item.file_path)}</div></td><td>${formatNumber(item.cyclomatic_complexity)}</td><td>${formatNumber(item.cognitive_complexity)}</td><td>${escapeHtml(item.evidence?.parser ?? "unavailable")}</td><td>${percent(item.confidence)}</td></tr>`).join("")}</tbody></table>`;
  if (view === "dead") return `<table class="data-table"><thead><tr><th>Candidate</th><th>Observed incoming</th><th>Confidence</th><th>Caveat</th></tr></thead><tbody>${findings.map((item) => `<tr><td><strong>${escapeHtml(item.qualified_name)}</strong><div class="path">${escapeHtml(item.file_path)}</div></td><td>${formatNumber(item.evidence?.incoming_relationships)}</td><td>${percent(item.confidence)}</td><td>${escapeHtml(truncate(item.caveats?.[0] ?? "Static absence is not runtime proof", 130))}</td></tr>`).join("")}</tbody></table>`;
  return `<table class="data-table"><thead><tr><th>Bridge</th><th>Type</th><th>Classification</th><th>Degree</th><th>Confidence</th></tr></thead><tbody>${findings.map((item) => `<tr><td><strong>${escapeHtml(item.qualified_name ?? item.name ?? item.file_path)}</strong><div class="path">${escapeHtml(item.file_path)}</div></td><td>${escapeHtml(item.entity_type)}</td><td>${escapeHtml(item.classification)}</td><td>${formatNumber(item.evidence?.degree)}</td><td>${percent(item.confidence)}</td></tr>`).join("")}</tbody></table>`;
}

async function loadQuality(view) {
  state.qualityView = view;
  $$("[data-quality]").forEach((button) => button.classList.toggle("is-active", button.dataset.quality === view));
  $("#quality-content").innerHTML = loading(`Running bounded ${view} analysis…`);
  const value = await api(`/api/quality?${repoQuery({ view })}`);
  $("#quality-content").innerHTML = qualityTable(view, value.result);
}

function processLabel(process) {
  return process.name ?? process.process_key ?? "Unnamed process";
}

async function loadProcesses() {
  $("#process-list").innerHTML = loading("Reading process memory…");
  const value = await api(`/api/processes?${repoQuery()}`);
  if (!value.processes?.length) {
    $("#process-list").innerHTML = empty("No active process models. Refresh to infer bounded static flows.");
    return;
  }
  $("#process-list").innerHTML = value.processes.map((process, index) => `
    <button class="result-item" data-process-index="${index}"><div class="result-title"><strong>${escapeHtml(processLabel(process))}</strong>${badge(process.source)}</div><div class="result-path">${formatNumber(process.step_count)} steps · ${percent(process.aggregate_confidence)}</div></button>
  `).join("");
  $$("[data-process-index]", $("#process-list")).forEach((button) => button.addEventListener("click", () => {
    $$("[data-process-index]", $("#process-list")).forEach((item) => item.classList.toggle("is-active", item === button));
    loadProcess(value.processes[Number(button.dataset.processIndex)]).catch((error) => report(error));
  }));
}

async function loadProcess(process) {
  $("#process-detail").innerHTML = loading("Loading resolved static path…");
  const value = await api(`/api/process?${repoQuery({ process_key: process.process_key })}`);
  $("#process-detail").innerHTML = `
    <div class="process-summary"><div class="badge-row">${badge(value.process.source)}${badge(value.process.start?.kind ?? "configured")}</div><h3>${escapeHtml(processLabel(value.process))}</h3><p>${escapeHtml(value.methodology)}</p></div>
    <div class="flow-track">${value.steps.map((step, index) => `<div class="flow-step" data-step="${index + 1}"><strong>${escapeHtml(step.qualified_name ?? step.name)}</strong><small>${escapeHtml(step.file_path)}:${formatNumber(step.start_line)} · edge ${step.incoming_edge_confidence == null ? "start" : percent(step.incoming_edge_confidence)}</small></div>`).join("")}</div>
  `;
}

function positionServiceNodes(nodes, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = Math.max(80, width * 0.39);
  const radiusY = Math.max(80, height * 0.37);
  return new Map(nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return [node.id, { ...node, x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY }];
  }));
}

function drawServiceEdges(context, positioned, edges) {
  for (const edge of edges) {
    const source = positioned.get(edge.source ?? edge.source_id ?? edge.from);
    const target = positioned.get(edge.target ?? edge.target_id ?? edge.to);
    if (!source || !target) continue;
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.strokeStyle = "rgba(125, 211, 252, 0.22)";
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawServiceNodes(context, positioned, centerX) {
  for (const node of positioned.values()) {
    const isService = String(node.id ?? "").startsWith("service:") || node.type === "service";
    context.beginPath();
    context.arc(node.x, node.y, isService ? 9 : 6, 0, Math.PI * 2);
    context.fillStyle = isService ? "#55d6a5" : "#c4b5fd";
    context.fill();
    context.fillStyle = "#d5dfdb";
    context.font = "10px Segoe UI";
    context.textAlign = node.x < centerX ? "right" : "left";
    context.fillText(shortLabel(node.label ?? node.name ?? node.id, 24), node.x + (node.x < centerX ? -12 : 12), node.y + 3);
  }
}

function drawServiceGraph(value) {
  const canvas = $("#service-canvas");
  if (!canvas) return;
  const { context, width, height } = fitCanvas(canvas);
  const nodes = (value.nodes ?? []).slice(0, 120);
  const edges = (value.edges ?? []).slice(0, 500);
  context.clearRect(0, 0, width, height);
  if (!nodes.length) return;
  const positioned = positionServiceNodes(nodes, width, height);
  drawServiceEdges(context, positioned, edges);
  drawServiceNodes(context, positioned, width / 2);
}

async function loadServices() {
  $("#service-summary").innerHTML = loading("Refreshing local inferred service identities…");
  const value = await api(`/api/services?${repoQuery()}`);
  state.services = value;
  $("#service-summary").innerHTML = `<span><strong>${formatNumber(value.nodes?.length)}</strong> nodes</span><span><strong>${formatNumber(value.edges?.length)}</strong> edges</span><span>Static evidence only · local identity cache refreshed</span>`;
  requestAnimationFrame(() => drawServiceGraph(value));
}

function positionFleetRing(nodes, width, height, scale, angleOffset = -Math.PI / 2) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = Math.max(60, width * scale);
  const radiusY = Math.max(55, height * scale);
  return nodes.map((node, index) => {
    const angle = nodes.length === 1 ? angleOffset : (index / nodes.length) * Math.PI * 2 + angleOffset;
    return [node.id, { ...node, x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY }];
  });
}

function positionFleetNodes(nodes, width, height) {
  const agents = nodes.filter((node) => node.kind === "agent");
  const targets = nodes.filter((node) => node.kind !== "agent");
  return new Map([
    ...positionFleetRing(agents, width, height, agents.length === 1 ? 0 : 0.17),
    ...positionFleetRing(targets, width, height, 0.4, Math.PI / 2),
  ]);
}

function fleetEdgeStyle(kind) {
  if (kind === "conflict") return { dash: [6, 5], color: "rgba(251, 113, 133, 0.9)", width: 2.2 };
  if (kind === "lease") return { dash: [], color: "rgba(251, 191, 119, 0.72)", width: 1.8 };
  return { dash: [], color: "rgba(125, 211, 252, 0.25)", width: 1 };
}

function drawFleetConflictLabel(context, edge, source, target) {
  if (edge.kind !== "conflict") return;
  context.fillStyle = "#fb7185";
  context.font = "700 9px Segoe UI";
  context.textAlign = "center";
  context.fillText(`Class ${edge.conflict_class}`, (source.x + target.x) / 2, (source.y + target.y) / 2 - 5);
}

function drawFleetEdge(context, edge, source, target) {
  const style = fleetEdgeStyle(edge.kind);
  context.beginPath();
  context.moveTo(source.x, source.y);
  context.lineTo(target.x, target.y);
  context.setLineDash(style.dash);
  context.strokeStyle = style.color;
  context.lineWidth = style.width;
  context.stroke();
  context.setLineDash([]);
  drawFleetConflictLabel(context, edge, source, target);
}

function drawFleetEdges(context, positioned, edges) {
  for (const edge of edges) {
    const source = positioned.get(edge.source);
    const target = positioned.get(edge.target);
    if (source && target) drawFleetEdge(context, edge, source, target);
  }
}

function fleetNodeStyle(node) {
  if (node.kind === "agent") return { radius: 12, color: "#55d6a5", text: "#f0f4ef", font: "600 11px Segoe UI", offset: 18, labelLength: 28 };
  const color = node.target_type === "file" ? "#7dd3fc" : "#c4b5fd";
  return { radius: 6, color, text: "#9aa6a3", font: "10px Segoe UI", offset: 10, labelLength: 22 };
}

function drawFleetNode(context, node, centerX) {
  const style = fleetNodeStyle(node);
  context.beginPath();
  context.arc(node.x, node.y, style.radius, 0, Math.PI * 2);
  context.fillStyle = style.color;
  context.fill();
  if (node.kind === "agent") {
    context.strokeStyle = "rgba(167, 243, 208, 0.25)";
    context.lineWidth = 7;
    context.stroke();
  }
  const left = node.x < centerX;
  context.fillStyle = style.text;
  context.font = style.font;
  context.textAlign = left ? "right" : "left";
  context.fillText(shortLabel(node.label, style.labelLength), node.x + (left ? -style.offset : style.offset), node.y + 3);
}

function drawFleetNodes(context, positioned, centerX) {
  for (const node of positioned.values()) drawFleetNode(context, node, centerX);
}

function drawFleetGraph(value) {
  const canvas = $("#fleet-canvas");
  if (!canvas) return;
  const { context, width, height } = fitCanvas(canvas);
  const nodes = (value.graph?.nodes ?? []).slice(0, 300);
  const edges = (value.graph?.edges ?? []).slice(0, 1_000);
  context.clearRect(0, 0, width, height);
  if (!nodes.length) {
    context.fillStyle = "#697572";
    context.font = "12px Segoe UI";
    context.textAlign = "center";
    context.fillText("No live intents. Agents appear after fleet_publish_intent.", width / 2, height / 2);
    return;
  }
  const positioned = positionFleetNodes(nodes, width, height);
  drawFleetEdges(context, positioned, edges);
  drawFleetNodes(context, positioned, width / 2);
}

function fleetTargets(values) {
  const targets = (values ?? []).slice(0, 8);
  if (!targets.length) return "";
  return `<div class="fleet-item-targets">${targets.map((target) => `<span title="${escapeHtml(target)}">${escapeHtml(target)}</span>`).join("")}</div>`;
}

function renderFleetMetrics(summary) {
  $("#fleet-metrics").innerHTML = [
    metric("Live agents", formatNumber(summary.active_agents), "TTL-backed presence"),
    metric("Active intents", formatNumber(summary.active_intents), "Branch-scoped work"),
    metric("Overlaps", formatNumber(summary.overlaps), `${formatNumber(summary.class_c_overlaps)} destructive`),
    metric("Leases", formatNumber(summary.active_leases), "Exclusive local claims"),
    metric("Decisions", formatNumber(summary.pending_decisions), "Needs human judgment"),
    metric("Conflict density", Number(summary.conflict_density ?? 0).toFixed(2), "Overlaps per intent"),
  ].join("");
}

function renderFleetDecisions(decisions) {
  const target = $("#fleet-decisions");
  if (!decisions.length) {
    target.innerHTML = empty("No Class C escalations in this scope.");
    return;
  }
  target.innerHTML = decisions.map((decision) => `
    <article class="fleet-item"><header><strong>${escapeHtml(decision.resolution ?? `Escalation ${decision.escalation_id}`)}</strong>${badge(decision.status, decision.status === "pending" ? "warning" : "low")}</header><p>${escapeHtml(decision.directive ? `Directive: ${decision.directive}` : "Waiting for a human directive.")}</p><small>${escapeHtml(decision.branch)} Â· ${formatDate(decision.created_at)}</small></article>
  `).join("");
}

function renderFleetIntent(intent) {
  return `<article class="fleet-item"><header><strong>${escapeHtml(intent.agent_name ?? intent.agent_id)} Â· ${escapeHtml(intent.summary)}</strong>${badge(intent.kind)}</header>${fleetTargets(intent.targets)}<small>${escapeHtml(intent.branch)} Â· expires ${formatDate(intent.expires_at)}</small></article>`;
}

function renderFleetEpisode(episode) {
  return `<article class="fleet-item"><header><strong>${escapeHtml(episode.agent_name ?? episode.agent_id)} Â· ${escapeHtml(episode.summary)}</strong>${badge(`Class ${episode.conflict_class}`, episode.conflict_class === "C" ? "error" : episode.conflict_class === "B" ? "warning" : "low")}</header>${fleetTargets(episode.targets)}<small>Episode Â· ${formatDate(episode.recorded_at)}</small></article>`;
}

function renderFleetWork(work) {
  const rows = [...(work.intents ?? []).map(renderFleetIntent), ...(work.episodes ?? []).slice(0, 20).map(renderFleetEpisode)];
  $("#fleet-work").innerHTML = rows.length ? rows.join("") : empty("No active intents or recorded episodes in this scope.");
}

function renderFleetSafety(safety) {
  const leases = (safety.leases ?? []).map((lease) => `<article class="fleet-item"><header><strong>${escapeHtml(lease.agent_id)} lease</strong>${badge(lease.status, lease.status === "granted" ? "low" : "warning")}</header>${fleetTargets(lease.targets)}<small>Priority ${formatNumber(lease.priority)} Â· expires ${formatDate(lease.expires_at)}</small></article>`);
  const conflicts = (safety.conflicts ?? []).map((conflict) => `<article class="fleet-item"><header><strong>${escapeHtml(conflict.source.replace(/^agent:/, ""))} â†” ${escapeHtml(conflict.target.replace(/^agent:/, ""))}</strong>${badge(`Class ${conflict.conflict_class}`, conflict.conflict_class === "C" ? "error" : "warning")}</header>${fleetTargets(conflict.targets)}<small>Live touched-scope overlap</small></article>`);
  const rows = [...conflicts, ...leases];
  $("#fleet-safety").innerHTML = rows.length ? rows.join("") : empty("No live conflicts or leases in this scope.");
}

function renderFleetActivity(activity) {
  const rows = activity.map((entry) => `<article class="fleet-item"><header><strong>${escapeHtml(entry.actor_id)}</strong>${badge(entry.event_type)}</header><p>${escapeHtml(entry.subject_id ?? "Repository coordination event")}</p><small>${escapeHtml(entry.branch)} Â· ${formatDate(entry.recorded_at)}</small></article>`);
  $("#fleet-activity").innerHTML = rows.length ? rows.join("") : empty("No local Fleet activity has been recorded yet.");
}

function updateFleetBranches(branches) {
  const select = $("#fleet-branch");
  const previous = state.fleetBranch;
  select.innerHTML = `<option value="">All branches</option>${branches.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`).join("")}`;
  state.fleetBranch = branches.includes(previous) ? previous : "";
  select.value = state.fleetBranch;
}

let fleetPollTimer;
function scheduleFleetPoll() {
  clearTimeout(fleetPollTimer);
  if (state.view !== "fleet") return;
  fleetPollTimer = setTimeout(() => loadFleet({ quiet: true }).catch((error) => report(error)), 5_000);
}

async function loadFleet({ quiet = false } = {}) {
  if (!quiet) {
    $("#fleet-metrics").innerHTML = loading("Reading local coordination stateâ€¦");
    $("#fleet-work").innerHTML = loading("Reading live intentsâ€¦");
  }
  const extra = state.fleetBranch ? { branch: state.fleetBranch } : {};
  const value = await api(`/api/fleet?${repoQuery(extra)}`);
  state.fleet = value;
  updateFleetBranches(value.branches ?? []);
  renderFleetMetrics(value.summary ?? {});
  renderFleetDecisions(value.decisions ?? []);
  renderFleetWork(value.work ?? {});
  renderFleetSafety(value.safety ?? {});
  renderFleetActivity(value.activity ?? []);
  $("#fleet-generated").textContent = `${value.branch ?? "all branches"} Â· ${formatDate(value.generated_at)}`;
  requestAnimationFrame(() => drawFleetGraph(value));
  scheduleFleetPoll();
}

function temporalEpisodes(value) {
  const evolution = value.evolution ?? {};
  return evolution.episodes ?? evolution.recent_episodes ?? evolution.events ?? evolution.changes ?? [];
}

async function loadTimeline() {
  $("#timeline-metrics").innerHTML = loading();
  $("#timeline-list").innerHTML = loading("Reading explicit temporal episodes…");
  const value = await api(`/api/timeline?${repoQuery()}`);
  const stats = value.stats;
  $("#timeline-metrics").innerHTML = [
    metric("Episodes", formatNumber(stats.episodes), stats.first_reference_time ? `Since ${new Date(stats.first_reference_time).toLocaleDateString()}` : "No explicit history"),
    metric("Entity changes", formatNumber(stats.changes), "Recorded deltas"),
    metric("Versions", formatNumber(stats.versions), `${formatNumber(stats.open_versions)} currently open`),
    metric("Latest evidence", stats.last_reference_time ? new Date(stats.last_reference_time).toLocaleDateString() : "—", "Bounded first-parent memory"),
  ].join("");
  const episodes = temporalEpisodes(value);
  $("#timeline-list").innerHTML = episodes.length ? episodes.slice(0, 120).map((episode) => `
    <article class="timeline-entry"><time>${escapeHtml(formatDate(episode.reference_time ?? episode.created_at ?? episode.timestamp))}</time><h3>${escapeHtml(episode.message ?? episode.summary ?? episode.episode_key ?? episode.type ?? "Repository episode")}</h3><p>${escapeHtml(`${episode.type ?? "episode"} · ${formatNumber(episode.change_count ?? episode.changes?.length ?? 0)} changes`)}</p></article>
  `).join("") : empty("No explicit temporal history has been ingested for this repository.");
}

function renderDecisions(value) {
  const decisions = value.decisions ?? [];
  if (!decisions.length) {
    $("#decision-results").innerHTML = empty(`Decision memory returned ${value.verdict ?? "CannotProve"}.`);
    return;
  }
  $("#decision-results").innerHTML = decisions.map((decision) => `
    <article class="decision-card"><header><div><h3>${escapeHtml(decision.title)}</h3><div class="decision-meta"><span>${escapeHtml(decision.kind ?? "choice")}</span><span>${escapeHtml(decision.status)}</span><span>${formatNumber(decision.provenance?.length)} evidence records</span></div></div>${badge(decision.status ?? "active", decision.status === "active" ? "low" : "warning")}</header><p>${escapeHtml(decision.rationale)}</p></article>
  `).join("");
}

function renderReview(value) {
  const summary = value.summary ?? {};
  const findings = value.findings ?? [];
  $("#review-results").innerHTML = `
    <div class="review-summary"><div class="badge-row">${badge(summary.verdict ?? "complete", summary.verdict === "changes_requested" ? "error" : "low")}${badge(summary.risk ?? "unknown", summary.risk ?? "info")}</div><h2>${escapeHtml(summary.headline ?? "Local review complete")}</h2><p>${formatNumber(summary.changed_symbols)} changed symbols · ${formatNumber(summary.affected_symbols)} affected symbols · ${findings.length} findings</p></div>
    <div class="finding-list">${findings.length ? findings.map((finding) => `<article class="finding-card"><header><h3>${escapeHtml(finding.title)}</h3>${badge(finding.severity, finding.severity)}</header><p>${escapeHtml(finding.message)}</p><div class="finding-location">${escapeHtml(finding.location?.file_path)}:${formatNumber(finding.location?.line)} · confidence ${percent(finding.confidence)}</div></article>`).join("") : empty("No bounded findings for this diff.")}</div>
  `;
}

function usageToolTable(rows) {
  if (!rows.length) return empty("No Graphward tool calls have been recorded in this window.");
  return `<table class="data-table"><thead><tr><th>Tool</th><th>Calls</th><th>MCP</th><th>Success</th><th>Average</th><th>Estimated output</th><th>Vs full files</th></tr></thead><tbody>${rows.map((item) => `
    <tr><td><strong>${escapeHtml(item.tool_name)}</strong><div class="path">${formatNumber(item.modeled_mcp_calls)} calls with a full-file baseline</div></td><td>${formatNumber(item.calls)}</td><td>${formatNumber(item.mcp_calls)}</td><td>${percent(item.success_rate)}</td><td>${formatNumber(item.average_duration_ms)} ms</td><td>≈${formatNumber(item.estimated_mcp_output_tokens)} tokens</td><td>≈${formatNumber(item.modeled_context_tokens_avoided)} tokens</td></tr>
  `).join("")}</tbody></table>`;
}

function usageRepositoryTable(rows) {
  if (!rows.length) return empty("No indexed checkouts belong to this project.");
  return `<table class="data-table"><thead><tr><th>Checkout</th><th>Branch</th><th>Calls</th><th>Success</th><th>Estimated output</th><th>Vs full files</th></tr></thead><tbody>${rows.map((item) => `
    <tr><td><strong>${item.is_linked_worktree ? "Worktree" : "Main"}</strong><div class="path">${escapeHtml(item.root)}</div></td><td>${escapeHtml(item.branch ?? "detached")}</td><td>${formatNumber(item.calls)}</td><td>${percent(item.success_rate)}</td><td>≈${formatNumber(item.estimated_mcp_output_tokens)} tokens</td><td>≈${formatNumber(item.modeled_context_tokens_avoided)} tokens</td></tr>
  `).join("")}</tbody></table>`;
}

function renderUsage(value) {
  const totals = value.totals ?? {};
  const periodLabel = value.period === "all" ? "All retained events" : `Last ${value.period}`;
  $("#usage-metrics").innerHTML = [
    metric("MCP calls", formatNumber(totals.calls), periodLabel),
    metric("Full-file baselines", formatNumber(totals.modeled_mcp_calls), `${percent(totals.model_coverage)} of calls cite measurable indexed files`),
    metric("Successful", percent(totals.success_rate), `${formatNumber(totals.failed_calls)} failed calls`),
    metric("Estimated MCP output", `≈${formatNumber(totals.estimated_mcp_output_tokens)}`, "Tokens · four-byte heuristic"),
    metric("Full-file-equivalent compression", `≈${formatNumber(totals.modeled_context_tokens_avoided)}`, `${percent(totals.modeled_context_reduction)} smaller than referenced full files · not estimated savings`),
  ].join("");
  $("#usage-tools").innerHTML = usageToolTable(value.by_tool ?? []);
  $("#usage-repositories").innerHTML = usageRepositoryTable(value.by_repository ?? []);
  const methodology = value.methodology ?? {};
  $("#usage-methodology").innerHTML = [
    ["Measured", methodology.measured],
    ["Token estimate", methodology.token_estimate],
    ["Full-file baseline", methodology.full_file_model ?? methodology.savings_model],
    ["Privacy", methodology.privacy],
  ].map(([title, description]) => `<div class="methodology-item"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`).join("");
  const projectLabel = value.project ? `${value.project.name} · main + ${formatNumber(value.project.worktree_count)} worktree${value.project.worktree_count === 1 ? "" : "s"}` : "";
  $("#usage-generated").textContent = `${projectLabel}${projectLabel ? " · " : ""}${periodLabel} · ${formatDate(value.generated_at)}`;
}

async function loadUsage() {
  $("#usage-metrics").innerHTML = loading("Reading the local usage ledger…");
  $("#usage-tools").innerHTML = loading("Aggregating tool calls…");
  $("#usage-repositories").innerHTML = loading("Aggregating checkout activity…");
  const value = await api(`/api/usage?${repoQuery({ period: state.usagePeriod })}`);
  renderUsage(value);
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.jump)));
  $("#mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));
  $("#reload-view").addEventListener("click", () => setView(state.view, { force: true }));
  $("#choose-repository").addEventListener("click", chooseAndIndexRepository);
  $("#usage-period").addEventListener("change", (event) => {
    state.usagePeriod = event.target.value;
    if (state.view === "usage") loadUsage().catch((error) => report(error));
  });
  $("#repo-select").addEventListener("change", (event) => {
    state.repoId = event.target.selectedOptions[0]?.dataset.repoId ?? event.target.value;
    clearRepositoryState();
    setView(state.view, { force: true });
  });
  $("#graph-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("#graph-search-input").value.trim();
    if (!query || !codeGraphRenderer) return;
    const node = codeGraphRenderer.focus(query);
    if (!node) {
      toast("No rendered symbol or file matched that search.", true);
      return;
    }
    if (node.test) $("#graph-tests").checked = true;
    renderCodeGraphDetail(node);
  });
  $("#graph-density").addEventListener("change", () => {
    if (state.view === "graph") loadCodeGraph().catch((error) => report(error));
  });
  for (const selector of ["#graph-calls", "#graph-imports", "#graph-tests", "#graph-color-mode"]) {
    $(selector).addEventListener("change", applyCodeGraphOptions);
  }
  $("#graph-reset").addEventListener("click", () => codeGraphRenderer?.resetCamera());
  $("#code-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("#code-search-input").value.trim();
    if (!query) return;
    $("#search-results").innerHTML = loading("Building or querying the local hybrid index…");
    $("#symbol-detail").innerHTML = empty("Select a result after search completes.");
    try {
      renderSearchResults(await api(`/api/search?${repoQuery({ q: query })}`));
    } catch (error) {
      report(error, $("#search-results"));
    }
  });
  $$("[data-quality]").forEach((button) => button.addEventListener("click", () => loadQuality(button.dataset.quality).catch((error) => report(error))));
  $("#refresh-processes").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Refreshing…";
    try {
      const result = await api("/api/processes/refresh", { method: "POST", body: JSON.stringify({ repo_id: state.repoId }) });
      toast(`Process memory refreshed: ${result.counts?.candidates ?? 0} candidates${result.truncated ? " (bounded)" : ""}.`);
      await loadProcesses();
    } catch (error) {
      report(error);
    }
    button.disabled = false;
    button.textContent = "Refresh inferred processes";
  });
  $("#refresh-fleet").addEventListener("click", () => loadFleet().catch((error) => report(error)));
  $("#fleet-branch").addEventListener("change", (event) => {
    state.fleetBranch = event.target.value;
    loadFleet().catch((error) => report(error));
  });
  $("#decision-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("#decision-search-input").value.trim();
    if (!query) return;
    $("#decision-results").innerHTML = loading("Recalling explicit local rationale…");
    try {
      renderDecisions(await api(`/api/decisions?${repoQuery({ q: query })}`));
    } catch (error) {
      report(error, $("#decision-results"));
    }
  });
  $("#review-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const diff = $("#review-diff").value;
    if (!diff.trim()) {
      toast("Paste a unified diff before running review.", true);
      return;
    }
    const button = $("#review-form button[type='submit']");
    button.disabled = true;
    button.textContent = "Reviewing locally…";
    $("#review-results").innerHTML = loading("Composing graph, quality, history, and process evidence…");
    try {
      const value = await api("/api/review", {
        method: "POST",
        body: JSON.stringify({ repo_id: state.repoId, diff, include_cochange: $("#review-cochange").checked }),
      });
      renderReview(value);
    } catch (error) {
      report(error, $("#review-results"));
    }
    button.disabled = false;
    button.textContent = "Run local review";
  });
  window.addEventListener("resize", () => {
    if (state.view === "overview" && state.overview) drawArchitecture(state.overview.architecture);
    if (state.view === "services" && state.services) drawServiceGraph(state.services);
    if (state.view === "fleet" && state.fleet) drawFleetGraph(state.fleet);
    if (state.view === "graph" && state.codeGraph) codeGraphRenderer?.start();
    if (state.view === "overview" && state.overview) drawDonut($("#language-donut"), state.overview.stats.languages ?? []);
  });
}

async function initialize() {
  bindEvents();
  try {
    const selected = await refreshRepositories();
    if (!selected) {
      setConnection(true, "Choose a folder to begin");
      $("#overview-metrics").innerHTML = empty("Choose a folder to build your first local index.");
      return;
    }
    setConnection(true);
    await loadOverview();
  } catch (error) {
    setConnection(false);
    report(error, $("#overview-metrics"));
  }
}

initialize();
