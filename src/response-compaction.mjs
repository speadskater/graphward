import { createHash } from "node:crypto";

export const COMPACT_FIND_CODE_LIMIT = 5;

const RESPONSE_DETAIL_PROPERTY = {
  type: "string",
  enum: ["compact", "full"],
  description: "MCP response detail. Compact is the default; full includes ranking diagnostics and complete index snapshots.",
};

const SEARCH_RESULT_FIELDS = [
  "stable_key",
  "name",
  "qualified_name",
  "kind",
  "signature",
  "file_path",
  "start_line",
  "end_line",
];

export function withResponseDetail(definition) {
  const schema = definition?.inputSchema;
  if (!schema || schema.type !== "object") return definition;
  return {
    ...definition,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        response_detail: RESPONSE_DETAIL_PROPERTY,
      },
    },
  };
}

function compactSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  return {
    snapshot_id: snapshot.snapshot_id ?? null,
    index_generation: snapshot.index_generation ?? null,
    stale: Boolean(snapshot.stale),
    dirty: Boolean(snapshot.dirty),
    warning: snapshot.warning ?? null,
  };
}

function compactSnapshots(value) {
  if (Array.isArray(value)) return value.map(compactSnapshots);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "index_snapshot" ? compactSnapshot(item) : compactSnapshots(item),
  ]));
}

function compactLiteralMatches(matches) {
  if (!Array.isArray(matches)) return [];
  return matches.slice(0, 3).map((match) => ({
    line: match.line,
    column: match.column,
    end_column: match.end_column,
    exact: Boolean(match.exact),
  }));
}

function compactSourceContext(sourceContext, literalMatches) {
  if (!sourceContext || typeof sourceContext.content !== "string") return sourceContext ?? null;
  const lines = sourceContext.content.split(/\r?\n/);
  const matchedLine = literalMatches[0]?.line ?? sourceContext.start_line;
  const matchedIndex = lines.findIndex((line) => line.startsWith(`${matchedLine}:`));
  const center = matchedIndex >= 0 ? matchedIndex : 0;
  const start = Math.max(0, Math.min(lines.length - 5, center - 2));
  const selected = lines.slice(start, start + 5).map((line) => line.slice(0, 240));
  const lineNumber = (line, fallback) => {
    const match = line?.match(/^(\d+):/);
    return match ? Number(match[1]) : fallback;
  };
  return {
    start_line: lineNumber(selected[0], sourceContext.start_line),
    end_line: lineNumber(selected.at(-1), sourceContext.end_line),
    content: selected.join("\n"),
  };
}

function compactSearchResult(result) {
  const compact = {};
  for (const field of SEARCH_RESULT_FIELDS) {
    if (result[field] !== undefined) compact[field] = result[field];
  }
  compact.literal_matches = compactLiteralMatches(result.literal_matches);
  compact.source_context = compactSourceContext(result.source_context, compact.literal_matches);
  return compact;
}

function compactFindCode(value) {
  const originalResults = Array.isArray(value.results) ? value.results : [];
  const results = originalResults.slice(0, COMPACT_FIND_CODE_LIMIT).map(compactSearchResult);
  const cursor = Math.max(0, Number(value.page?.cursor) || 0);
  const hasMore = Boolean(value.page?.has_more || originalResults.length > results.length);
  return {
    repo_id: value.repo_id ?? null,
    mode: value.mode,
    response_detail: "compact",
    page: {
      cursor,
      next_cursor: hasMore ? cursor + results.length : null,
      has_more: hasMore,
    },
    results,
    ...(value.index_snapshot ? { index_snapshot: value.index_snapshot } : {}),
    ...(value.auto_index ? { auto_index: value.auto_index } : {}),
  };
}

function evidenceHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function evidenceCache(context) {
  if (!(context.responseEvidenceHashes instanceof Set)) context.responseEvidenceHashes = new Set();
  return context.responseEvidenceHashes;
}

function deduplicateEvidence(value, cache) {
  if (Array.isArray(value)) return value.map((item) => deduplicateEvidence(item, cache));
  if (!value || typeof value !== "object") return value;

  const result = {};
  const evidenceContent = typeof value.content === "string"
    && Number.isInteger(value.start_line)
    && Number.isInteger(value.end_line);
  for (const [key, item] of Object.entries(value)) {
    if (key === "content" && evidenceContent) {
      const hash = evidenceHash(item);
      if (cache.has(hash)) {
        result.content_ref = `sha256:${hash}`;
        result.content_omitted = "duplicate evidence from this MCP session";
      } else {
        if (cache.size >= 4_096) cache.clear();
        cache.add(hash);
        result.content = item;
      }
      continue;
    }
    result[key] = deduplicateEvidence(item, cache);
  }
  return result;
}

export function compactMcpOutput(name, value, args = {}, context = {}) {
  if (args.response_detail === "full" || !value || typeof value !== "object") return value;
  const compacted = name === "find_code" ? compactFindCode(value) : value;
  const snapshotsCompacted = name === "list_indexed_repositories"
    ? compacted
    : compactSnapshots(compacted);
  return deduplicateEvidence(snapshotsCompacted, evidenceCache(context));
}
