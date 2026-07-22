const RETAINED_EVENTS = 50_000;
const PRUNE_INTERVAL = 256;
const MAX_REFERENCED_FILES = 250;
const TOKEN_BYTES_ESTIMATE = 4;
const PERIODS = new Map([
  ["24h", 24 * 60 * 60 * 1_000],
  ["7d", 7 * 24 * 60 * 60 * 1_000],
  ["30d", 30 * 24 * 60 * 60 * 1_000],
  ["90d", 90 * 24 * 60 * 60 * 1_000],
  ["all", null],
]);

function byteLength(value, pretty = false) {
  try {
    return Buffer.byteLength(JSON.stringify(value, null, pretty ? 2 : 0), "utf8");
  } catch {
    return 0;
  }
}

function estimatedTokens(bytes) {
  return Math.ceil(Math.max(0, Number(bytes) || 0) / TOKEN_BYTES_ESTIMATE);
}

function normalizedSurface(value) {
  return value === "mcp" || value === "dashboard" ? value : "internal";
}

function normalizeFilePath(value) {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) return null;
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function collectFilePaths(value) {
  const found = new Set();
  const seen = new WeakSet();
  const pending = [{ value, depth: 0 }];
  let inspected = 0;
  while (pending.length && found.size < MAX_REFERENCED_FILES && inspected < 20_000) {
    const current = pending.pop();
    inspected += 1;
    if (!current || current.depth > 12 || !current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(current.value)) {
      if ((key === "file_path" || key.endsWith("_file_path")) && typeof item === "string") {
        const normalized = normalizeFilePath(item);
        if (normalized) found.add(normalized);
      } else if (item && typeof item === "object") {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return [...found];
}

function resolvedRepoId(db, args, output, context) {
  const requested = args?.repo_id
    ?? (Array.isArray(args?.repo_ids) && args.repo_ids.length === 1 ? args.repo_ids[0] : null)
    ?? output?.repo_id
    ?? context?.defaultRepoId
    ?? null;
  if (typeof requested === "string" && requested) {
    return db.prepare("SELECT repo_id FROM repositories WHERE repo_id = ?").get(requested)?.repo_id ?? null;
  }
  const rows = db.prepare("SELECT repo_id FROM repositories ORDER BY indexed_at DESC, id DESC LIMIT 2").all();
  return rows.length === 1 ? rows[0].repo_id : null;
}

function referencedFileEvidence(db, repoId, output) {
  if (!repoId || !output) return { count: 0, bytes: 0 };
  const paths = collectFilePaths(output);
  if (!paths.length) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (let offset = 0; offset < paths.length; offset += 150) {
    const chunk = paths.slice(offset, offset + 150);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT f.size
      FROM files f
      JOIN repositories r ON r.id = f.repo_id
      WHERE r.repo_id = ? AND f.path IN (${placeholders})
    `).all(repoId, ...chunk);
    count += rows.length;
    bytes += rows.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
  }
  return { count, bytes };
}

function maybePrune(db, insertedId) {
  if (!insertedId || insertedId % PRUNE_INTERVAL !== 0) return;
  db.prepare(`
    DELETE FROM tool_usage_events
    WHERE id NOT IN (
      SELECT id FROM tool_usage_events ORDER BY id DESC LIMIT ?
    )
  `).run(RETAINED_EVENTS);
}

export function recordToolUsage(db, {
  toolName,
  args,
  output = null,
  context = {},
  durationMs = 0,
  success = true,
  error = null,
}) {
  const surface = normalizedSurface(context.surface);
  const repoId = resolvedRepoId(db, args, output, context);
  const requestBytes = byteLength(args);
  const responseValue = success ? output : { error: error?.message ?? "Tool call failed" };
  const responseBytes = byteLength(responseValue, surface === "mcp");
  const outputTokens = estimatedTokens(responseBytes);
  const evidence = surface === "mcp" ? referencedFileEvidence(db, repoId, output) : { count: 0, bytes: 0 };
  const baselineTokens = estimatedTokens(evidence.bytes);
  const contextTokensAvoided = evidence.bytes > 0 ? Math.max(0, baselineTokens - outputTokens) : 0;
  const result = db.prepare(`
    INSERT INTO tool_usage_events(
      repo_id, tool_name, surface, called_at, duration_ms, success,
      request_bytes, response_bytes, estimated_output_tokens,
      referenced_file_count, baseline_file_bytes, estimated_context_tokens_avoided
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repoId,
    String(toolName ?? "unknown").slice(0, 200),
    surface,
    new Date().toISOString(),
    Math.max(0, Math.round(Number(durationMs) || 0)),
    success ? 1 : 0,
    requestBytes,
    responseBytes,
    outputTokens,
    evidence.count,
    evidence.bytes,
    contextTokensAvoided,
  );
  maybePrune(db, Number(result.lastInsertRowid));
}

function periodFilter(period) {
  if (!PERIODS.has(period)) throw new Error("period must be 24h, 7d, 30d, 90d, or all");
  const duration = PERIODS.get(period);
  return duration == null ? null : new Date(Date.now() - duration).toISOString();
}

function numberRow(row) {
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]));
}

function usageRepoIds(repoId, repoIds) {
  if (repoIds == null) return repoId ? [String(repoId)] : [];
  if (!Array.isArray(repoIds) || !repoIds.length || repoIds.length > 100) {
    throw new Error("repoIds must contain between 1 and 100 repository identifiers");
  }
  const normalized = [...new Set(repoIds.map((value) => String(value).trim()).filter(Boolean))];
  if (!normalized.length) throw new Error("repoIds must contain at least one repository identifier");
  return normalized;
}

function usageByRepository(db, where, values, scopedRepoIds) {
  const rows = db.prepare(`
    SELECT
      repo_id,
      COUNT(*) AS calls,
      COALESCE(SUM(success), 0) AS successful_calls,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
      COALESCE(ROUND(AVG(duration_ms), 1), 0) AS average_duration_ms,
      COALESCE(SUM(estimated_output_tokens), 0) AS estimated_mcp_output_tokens,
      COALESCE(SUM(CASE WHEN baseline_file_bytes > 0 THEN 1 ELSE 0 END), 0) AS modeled_mcp_calls,
      COALESCE(SUM(estimated_context_tokens_avoided), 0) AS modeled_context_tokens_avoided
    FROM tool_usage_events
    ${where}
    GROUP BY repo_id
    ORDER BY calls DESC, repo_id ASC
  `).all(...values).map(numberRow);
  const usage = new Map(rows.map((row) => [row.repo_id, row]));
  const metadataRepoIds = scopedRepoIds.length
    ? scopedRepoIds
    : db.prepare("SELECT repo_id FROM repositories ORDER BY is_linked_worktree, name, repo_id").all().map((row) => row.repo_id);
  const metadata = metadataRepoIds.length
    ? db.prepare(`
        SELECT repo_id, name, root, branch, worktree_id, is_linked_worktree
        FROM repositories
        WHERE repo_id IN (${metadataRepoIds.map(() => "?").join(", ")})
      `).all(...metadataRepoIds)
    : [];
  return metadata.map((repository) => {
    const metrics = usage.get(repository.repo_id) ?? {
      calls: 0,
      successful_calls: 0,
      failed_calls: 0,
      average_duration_ms: 0,
      estimated_mcp_output_tokens: 0,
      modeled_mcp_calls: 0,
      modeled_context_tokens_avoided: 0,
    };
    return {
      ...repository,
      is_linked_worktree: Boolean(repository.is_linked_worktree),
      ...metrics,
      success_rate: metrics.calls ? metrics.successful_calls / metrics.calls : 0,
    };
  }).sort((left, right) => Number(left.is_linked_worktree) - Number(right.is_linked_worktree)
    || String(left.branch ?? "").localeCompare(String(right.branch ?? ""))
    || left.repo_id.localeCompare(right.repo_id));
}

export function getUsageStats(db, { repoId = null, repoIds = null, period = "30d" } = {}) {
  const since = periodFilter(period);
  const clauses = ["surface = 'mcp'"];
  const values = [];
  const scopedRepoIds = usageRepoIds(repoId, repoIds);
  if (scopedRepoIds.length) {
    clauses.push(`repo_id IN (${scopedRepoIds.map(() => "?").join(", ")})`);
    values.push(...scopedRepoIds);
  }
  if (since) {
    clauses.push("called_at >= ?");
    values.push(since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totals = numberRow(db.prepare(`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(success), 0) AS successful_calls,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN 1 ELSE 0 END), 0) AS mcp_calls,
      COALESCE(SUM(CASE WHEN surface = 'dashboard' THEN 1 ELSE 0 END), 0) AS dashboard_calls,
      COALESCE(SUM(CASE WHEN surface = 'internal' THEN 1 ELSE 0 END), 0) AS internal_calls,
      COALESCE(ROUND(AVG(duration_ms), 1), 0) AS average_duration_ms,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_output_tokens ELSE 0 END), 0) AS estimated_mcp_output_tokens,
      COALESCE(SUM(CASE WHEN surface = 'mcp' AND baseline_file_bytes > 0 THEN estimated_output_tokens ELSE 0 END), 0) AS modeled_mcp_output_tokens,
      COALESCE(SUM(CASE WHEN surface = 'mcp' AND baseline_file_bytes > 0 THEN 1 ELSE 0 END), 0) AS modeled_mcp_calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN baseline_file_bytes ELSE 0 END), 0) AS modeled_baseline_file_bytes,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_context_tokens_avoided ELSE 0 END), 0) AS modeled_context_tokens_avoided,
      MIN(called_at) AS first_call_at,
      MAX(called_at) AS last_call_at
    FROM tool_usage_events
    ${where}
  `).get(...values));
  totals.success_rate = totals.calls ? totals.successful_calls / totals.calls : 0;
  totals.model_coverage = totals.mcp_calls ? totals.modeled_mcp_calls / totals.mcp_calls : 0;
  const modeledTotal = totals.modeled_mcp_output_tokens + totals.modeled_context_tokens_avoided;
  totals.modeled_context_reduction = modeledTotal ? totals.modeled_context_tokens_avoided / modeledTotal : 0;

  const byTool = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) AS calls,
      COALESCE(SUM(success), 0) AS successful_calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN 1 ELSE 0 END), 0) AS mcp_calls,
      COALESCE(ROUND(AVG(duration_ms), 1), 0) AS average_duration_ms,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_output_tokens ELSE 0 END), 0) AS estimated_mcp_output_tokens,
      COALESCE(SUM(CASE WHEN surface = 'mcp' AND baseline_file_bytes > 0 THEN 1 ELSE 0 END), 0) AS modeled_mcp_calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_context_tokens_avoided ELSE 0 END), 0) AS modeled_context_tokens_avoided
    FROM tool_usage_events
    ${where}
    GROUP BY tool_name
    ORDER BY calls DESC, tool_name ASC
    LIMIT 50
  `).all(...values).map((row) => {
    const item = numberRow(row);
    item.success_rate = item.calls ? item.successful_calls / item.calls : 0;
    return item;
  });

  const bySurface = db.prepare(`
    SELECT
      surface,
      COUNT(*) AS calls,
      COALESCE(SUM(success), 0) AS successful_calls,
      COALESCE(ROUND(AVG(duration_ms), 1), 0) AS average_duration_ms,
      COALESCE(SUM(estimated_output_tokens), 0) AS estimated_output_tokens
    FROM tool_usage_events
    ${where}
    GROUP BY surface
    ORDER BY calls DESC, surface ASC
  `).all(...values).map(numberRow);

  const daily = db.prepare(`
    SELECT
      SUBSTR(called_at, 1, 10) AS day,
      COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN 1 ELSE 0 END), 0) AS mcp_calls,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_output_tokens ELSE 0 END), 0) AS estimated_mcp_output_tokens,
      COALESCE(SUM(CASE WHEN surface = 'mcp' THEN estimated_context_tokens_avoided ELSE 0 END), 0) AS modeled_context_tokens_avoided
    FROM tool_usage_events
    ${where}
    GROUP BY SUBSTR(called_at, 1, 10)
    ORDER BY day ASC
    LIMIT 180
  `).all(...values).map(numberRow);

  const byRepository = usageByRepository(db, where, values, scopedRepoIds);

  const fullFileModel = "Full-file-equivalent compression applies only to MCP answers containing indexed file-path evidence. It compares the unique referenced files' full indexed byte sizes with the serialized Graphward answer. This deliberately broad baseline is not estimated context savings and does not model grep, bounded reads, caching, or a counterfactual agent run.";
  return {
    repo_id: scopedRepoIds.length === 1 ? scopedRepoIds[0] : null,
    repo_ids: scopedRepoIds,
    scope: scopedRepoIds.length > 1 ? "project" : scopedRepoIds.length === 1 ? "repository" : "database",
    period,
    since,
    generated_at: new Date().toISOString(),
    totals,
    by_tool: byTool,
    by_surface: bySurface,
    by_repository: byRepository,
    daily,
    retention_limit: RETAINED_EVENTS,
    methodology: {
      measured: "MCP tool-call counts, success, duration, and serialized byte sizes are measured locally for calls made after usage accounting was enabled. Dashboard and internal traffic are excluded.",
      token_estimate: `Token figures use a transparent ${TOKEN_BYTES_ESTIMATE}-UTF-8-bytes-per-token heuristic; they are not tokenizer output or billing data.`,
      full_file_model: fullFileModel,
      savings_model: fullFileModel,
      privacy: "The ledger stores no prompts, arguments, source, or responses—only bounded MCP usage metadata—and never leaves this database.",
    },
  };
}
