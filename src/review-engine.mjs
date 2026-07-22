import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getGoverningContracts } from "./local-memory.mjs";
import { findDeadCodeCandidates, getChurnWeightedHotspots } from "./quality-analysis.mjs";
import { getCodeRelationships, resolveRepository } from "./queries.mjs";
import { changePreflight, inferExecutionFlows, parseUnifiedDiff } from "./workflow-analysis.mjs";

export const REVIEW_ENGINE_LIMITS = Object.freeze({
  max_diff_bytes: 2 * 1024 * 1024,
  max_diff_lines: 50_000,
  max_changed_ranges: 1_000,
  max_changed_files: 100,
  max_changed_symbols: 500,
  max_findings: 500,
  max_rules: 100,
  max_rule_file_bytes: 256 * 1024,
  max_rule_pattern_chars: 512,
  max_rule_message_chars: 2_000,
  max_body_bytes: 8 * 1024 * 1024,
  max_process_flows: 200,
  max_relationships_per_file: 200,
  max_verification_items: 200,
});

const DEFAULT_THRESHOLDS = Object.freeze({
  cyclomatic: 12,
  cognitive: 15,
  complexity_delta: 4,
  hotspot_score: 24,
  cross_module_files: 1,
});
const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };

function clamp(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeRepoPath(value) {
  if (typeof value !== "string" || !value || value.length > 4_096 || /[\0-\x1f\x7f]/.test(value)
    || /^[\\/]/.test(value) || /^[a-z]:[\\/]/i.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return null;
  const portable = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (portable.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function normalizeChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("each changed range must be an object");
  const filePath = normalizeRepoPath(change.file_path ?? change.filePath ?? change.path);
  if (!filePath) throw new Error("changed file paths must be repository-relative and cannot contain traversal");
  const startValue = change.start_line ?? change.startLine ?? change.line ?? null;
  const endValue = change.end_line ?? change.endLine ?? change.line ?? startValue;
  if (startValue == null) return { file_path: filePath, start_line: null, end_line: null, source: change.source ?? "provided" };
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 100_000_000) {
    throw new Error("changed line ranges must be positive ordered integers");
  }
  return { file_path: filePath, start_line: start, end_line: end, source: change.source ?? "provided" };
}

function boundedDiff(diff) {
  if (diff == null) return null;
  if (typeof diff !== "string") throw new Error("diff must be a string");
  if (Buffer.byteLength(diff, "utf8") > REVIEW_ENGINE_LIMITS.max_diff_bytes) {
    throw new Error(`diff exceeds ${REVIEW_ENGINE_LIMITS.max_diff_bytes} bytes`);
  }
  const lines = diff.split(/\r?\n/);
  if (lines.length > REVIEW_ENGINE_LIMITS.max_diff_lines) {
    throw new Error(`diff exceeds ${REVIEW_ENGINE_LIMITS.max_diff_lines} lines`);
  }
  return diff;
}

function mergeRanges(ranges) {
  const byFile = new Map();
  for (const range of ranges) {
    const values = byFile.get(range.file_path) ?? [];
    values.push(range);
    byFile.set(range.file_path, values);
  }
  const merged = [];
  for (const filePath of [...byFile.keys()].sort()) {
    const rangesForFile = byFile.get(filePath);
    if (rangesForFile.some((range) => range.start_line == null)) {
      merged.push({ file_path: filePath, start_line: null, end_line: null, source: [...new Set(rangesForFile.map((item) => item.source))].sort().join("+") });
      continue;
    }
    rangesForFile.sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line);
    for (const range of rangesForFile) {
      const previous = merged.at(-1);
      if (previous?.file_path === filePath && range.start_line <= previous.end_line + 1) {
        previous.end_line = Math.max(previous.end_line, range.end_line);
        previous.source = [...new Set(`${previous.source}+${range.source}`.split("+"))].sort().join("+");
      } else {
        merged.push({ ...range });
      }
    }
  }
  return merged;
}

function diffHeaderPath(value) {
  let candidate = String(value ?? "").trim().split("\t")[0];
  if (candidate === "/dev/null") return null;
  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  candidate = candidate.replaceAll("\\", "/");
  if (/^[ab]\//.test(candidate)) candidate = candidate.slice(2);
  return normalizeRepoPath(candidate);
}

function parseDiffEvidence(diff) {
  const files = new Map();
  if (!diff) return files;
  let oldPath = null;
  let newPath = null;
  let oldLine = null;
  let newLine = null;
  let oldRemaining = null;
  let newRemaining = null;
  const finishHunk = () => {
    if (oldRemaining == null && newRemaining == null) return;
    if (oldRemaining !== 0 || newRemaining !== 0) throw new Error("diff hunk body does not match its declared line counts");
    oldLine = null;
    newLine = null;
    oldRemaining = null;
    newRemaining = null;
  };
  const fileState = () => {
    const filePath = newPath ?? oldPath;
    if (!filePath) return null;
    const current = files.get(filePath) ?? {
      file_path: filePath,
      added_lines: [],
      removed_lines: [],
      deleted: false,
      added: false,
    };
    files.set(filePath, current);
    return current;
  };
  for (const line of diff.split(/\r?\n/)) {
    if (oldRemaining === 0 && newRemaining === 0) finishHunk();
    if (line.startsWith("diff --git ")) {
      finishHunk();
      oldPath = null;
      newPath = null;
      oldLine = null;
      newLine = null;
      continue;
    }
    if (newLine == null && line.startsWith("--- ")) {
      const raw = line.slice(4).trim().split("\t")[0];
      oldPath = diffHeaderPath(raw);
      if (raw !== "/dev/null" && !oldPath) throw new Error("diff contains an invalid or non-repository-relative old path");
      continue;
    }
    if (newLine == null && line.startsWith("+++ ")) {
      const raw = line.slice(4).trim().split("\t")[0];
      newPath = diffHeaderPath(raw);
      if (raw !== "/dev/null" && !newPath) throw new Error("diff contains an invalid or non-repository-relative new path");
      const state = fileState();
      if (state) {
        state.deleted = raw === "/dev/null";
        state.added = oldPath == null;
      }
      continue;
    }
    if (line.startsWith("@@") && !line.startsWith("@@ ")) {
      throw new Error("diff contains an unsupported or malformed unified hunk header");
    }
    if (line.startsWith("@@ ")) {
      finishHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (!match) throw new Error("diff contains a malformed unified hunk header");
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      oldRemaining = match[2] == null ? 1 : Number(match[2]);
      newRemaining = match[4] == null ? 1 : Number(match[4]);
      continue;
    }
    if (oldLine == null || newLine == null) continue;
    if (line === "\\ No newline at end of file") continue;
    const state = fileState();
    if (!state) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (newRemaining <= 0) throw new Error("diff hunk contains more added lines than declared");
      state.added_lines.push({ line: newLine, text: line.slice(1), side: "new" });
      newLine += 1;
      newRemaining -= 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (oldRemaining <= 0) throw new Error("diff hunk contains more removed lines than declared");
      state.removed_lines.push({ line: oldLine, text: line.slice(1), side: "old" });
      oldLine += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(" ")) {
      if (oldRemaining <= 0 || newRemaining <= 0) throw new Error("diff hunk contains more context lines than declared");
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      throw new Error("diff hunk contains an invalid body line");
    }
  }
  finishHunk();
  return files;
}

function scalar(value) {
  const text = value.trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function parseYamlSubset(text) {
  const result = { thresholds: {}, rules: [] };
  let section = null;
  let currentRule = null;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indentation = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (line === "rules:") {
      section = "rules";
      currentRule = null;
      continue;
    }
    if (line === "thresholds:") {
      section = "thresholds";
      currentRule = null;
      continue;
    }
    if (section === "rules" && line.startsWith("- ")) {
      currentRule = {};
      result.rules.push(currentRule);
      const pair = line.slice(2).match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
      if (!pair) throw new Error(`Unsupported YAML rule syntax at line ${index + 1}`);
      currentRule[pair[1]] = scalar(pair[2]);
      continue;
    }
    const pair = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!pair) throw new Error(`Unsupported YAML syntax at line ${index + 1}`);
    if (section === "rules" && currentRule && indentation > 0) currentRule[pair[1]] = scalar(pair[2]);
    else if (section === "thresholds" && indentation > 0) result.thresholds[pair[1]] = scalar(pair[2]);
    else result[pair[1]] = scalar(pair[2]);
  }
  return result;
}

function ruleSeverity(value) {
  const severity = String(value ?? "warning").toLowerCase();
  if (!SEVERITIES.has(severity)) throw new Error(`Unsupported review-rule severity: ${value}`);
  return severity;
}

function optionalRuleText(value, label, maximum = REVIEW_ENGINE_LIMITS.max_rule_message_chars) {
  if (value == null) return null;
  if (typeof value !== "string" || !value || value.length > maximum || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a bounded non-empty single-line string`);
  }
  return value;
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`review rule ${index + 1} must be an object`);
  const id = String(rule.id ?? `local-rule-${index + 1}`).trim();
  const contains = String(rule.contains ?? rule.pattern ?? "");
  const message = String(rule.message ?? `Local rule ${id} matched changed code.`);
  if (!id || id.length > 200 || /[\0\r\n]/.test(id)) throw new Error(`review rule ${index + 1} has an invalid id`);
  if (!contains || contains.length > REVIEW_ENGINE_LIMITS.max_rule_pattern_chars || /[\0\r\n]/.test(contains)) {
    throw new Error(`review rule ${id} must have a bounded single-line contains value`);
  }
  if (!message || message.length > REVIEW_ENGINE_LIMITS.max_rule_message_chars || /[\0-\x1f\x7f]/.test(message)) {
    throw new Error(`review rule ${id} has an invalid single-line message`);
  }
  const scope = String(rule.scope ?? "changed").toLowerCase();
  if (!new Set(["changed", "symbol"]).has(scope)) throw new Error(`review rule ${id} scope must be changed or symbol`);
  const confidence = rule.confidence == null ? 0.95 : Number(rule.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`review rule ${id} confidence must be between 0 and 1`);
  const caseSensitive = rule.case_sensitive ?? rule.caseSensitive ?? true;
  if (typeof caseSensitive !== "boolean") throw new Error(`review rule ${id} case_sensitive must be true or false`);
  return {
    id,
    contains,
    message,
    severity: ruleSeverity(rule.severity),
    confidence,
    case_sensitive: caseSensitive,
    file_contains: optionalRuleText(rule.file_contains ?? rule.fileContains, `review rule ${id} file_contains`, 4_096),
    symbol_contains: optionalRuleText(rule.symbol_contains ?? rule.symbolContains, `review rule ${id} symbol_contains`, 4_096),
    scope,
    verification: optionalRuleText(rule.verification, `review rule ${id} verification`),
  };
}

export function parseLocalReviewRules(input) {
  let parsed;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > REVIEW_ENGINE_LIMITS.max_rule_file_bytes) throw new Error("review rules exceed the local configuration byte limit");
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = parseYamlSubset(input);
    }
  } else {
    parsed = input ?? {};
  }
  if (Array.isArray(parsed)) parsed = { rules: parsed };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("review rules must be an object, array, JSON string, or supported YAML subset");
  const rawRules = parsed.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.length > REVIEW_ENGINE_LIMITS.max_rules) {
    throw new Error(`review rules must contain at most ${REVIEW_ENGINE_LIMITS.max_rules} entries`);
  }
  const rawThresholds = parsed.thresholds ?? {};
  if (!rawThresholds || typeof rawThresholds !== "object" || Array.isArray(rawThresholds)) {
    throw new Error("review thresholds must be an object");
  }
  const thresholds = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    if (Object.hasOwn(rawThresholds, key)) thresholds[key] = rawThresholds[key];
    if (parsed[key] != null) thresholds[key] = parsed[key];
    const snake = `${key}_threshold`;
    if (parsed[snake] != null) thresholds[key] = parsed[snake];
  }
  const normalizedRules = rawRules.map(normalizeRule);
  const ids = new Set();
  for (const rule of normalizedRules) {
    if (ids.has(rule.id)) throw new Error(`duplicate review rule id: ${rule.id}`);
    ids.add(rule.id);
  }
  return { thresholds, rules: normalizedRules };
}

function safeRulesPath(repository, relativePath) {
  const normalized = normalizeRepoPath(relativePath);
  if (!normalized) throw new Error("rulesPath must be a repository-relative path");
  const root = realpathSync(repository.root);
  const absolute = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("rulesPath escapes the repository root");
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("rulesPath must identify a regular non-symlink file");
  if (stats.size > REVIEW_ENGINE_LIMITS.max_rule_file_bytes) throw new Error("rulesPath exceeds the local configuration byte limit");
  const real = realpathSync(absolute);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("rulesPath resolves outside the repository root");
  return real;
}

function mergeReviewConfig(repository, { rules = null, rulesText = null, rulesPath = null, thresholds = null } = {}) {
  const configurations = [];
  if (rulesPath != null) configurations.push(parseLocalReviewRules(readFileSync(safeRulesPath(repository, rulesPath), "utf8")));
  if (rulesText != null) configurations.push(parseLocalReviewRules(rulesText));
  if (rules != null) configurations.push(parseLocalReviewRules(rules));
  if (thresholds != null) configurations.push(parseLocalReviewRules({ thresholds }));
  const combined = { thresholds: { ...DEFAULT_THRESHOLDS }, rules: [] };
  for (const configuration of configurations) {
    Object.assign(combined.thresholds, configuration.thresholds);
    combined.rules.push(...configuration.rules);
  }
  if (combined.rules.length > REVIEW_ENGINE_LIMITS.max_rules) throw new Error(`combined review rules exceed ${REVIEW_ENGINE_LIMITS.max_rules}`);
  const ruleIds = new Set();
  for (const rule of combined.rules) {
    if (ruleIds.has(rule.id)) throw new Error(`duplicate review rule id: ${rule.id}`);
    ruleIds.add(rule.id);
  }
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    const value = Number(combined.thresholds[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new Error(`threshold ${key} must be a finite non-negative number`);
    combined.thresholds[key] = value;
  }
  return combined;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableHasColumns(db, name, required) {
  if (!tableExists(db, name)) return false;
  const columns = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name));
  return required.every((column) => columns.has(column));
}

function parseJson(value, fallback = null) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function historicalMetric(db, repositoryId, stableKey) {
  if (!tableHasColumns(db, "temporal_entity_changes", [
    "id", "episode_id", "repo_id", "entity_type", "change_type", "stable_key", "previous_stable_key", "before_json",
  ]) || !tableHasColumns(db, "temporal_episodes", ["id", "repo_id", "sequence", "complete"])) return null;
  const row = db.prepare(`
    SELECT ec.before_json, ec.change_type, ep.sequence
    FROM temporal_entity_changes ec
    JOIN temporal_episodes ep ON ep.id = ec.episode_id AND ep.repo_id = ec.repo_id
    WHERE ec.repo_id = ? AND ec.entity_type = 'symbol'
      AND (ec.stable_key = ? OR ec.previous_stable_key = ?)
      AND ep.complete = 1
    ORDER BY ep.sequence DESC, ec.id DESC LIMIT 1
  `).get(repositoryId, stableKey, stableKey);
  if (!row) return null;
  const snapshot = parseJson(row.before_json, null);
  if (!snapshot) return null;
  const complexity = snapshot.complexity ?? {};
  const cyclomatic = Number(snapshot.cyclomatic_complexity ?? snapshot.cyclomaticComplexity ?? complexity.cyclomatic);
  const cognitive = Number(snapshot.cognitive_complexity ?? snapshot.cognitiveComplexity ?? complexity.cognitive);
  if (!Number.isFinite(cyclomatic) || !Number.isFinite(cognitive) || cyclomatic < 0 || cognitive < 0) return null;
  return { cyclomatic, cognitive, change_type: row.change_type, sequence: row.sequence };
}

function locationForSymbol(symbol) {
  const changed = symbol.changed_ranges?.find((range) => range.start_line != null);
  return {
    file_path: symbol.file_path,
    line: changed?.start_line ?? symbol.start_line ?? 1,
    end_line: changed?.end_line ?? changed?.start_line ?? symbol.start_line ?? 1,
    side: "new",
  };
}

function publicAffectedSymbol(symbol, role = "affected") {
  return {
    stable_key: symbol.stable_key,
    qualified_name: symbol.qualified_name,
    file_path: symbol.file_path,
    line: symbol.start_line,
    depth: symbol.depth ?? 0,
    role,
  };
}

function findingId(finding) {
  const location = finding.location ?? {};
  const identity = [finding.code, location.file_path, location.line, location.side, finding.affected_symbols?.[0]?.stable_key, finding.message].join("\0");
  return `${finding.code}:${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

function normalizedFinding(finding) {
  const severity = ruleSeverity(finding.severity);
  const rawConfidence = Number(finding.confidence);
  const value = {
    code: finding.code,
    category: finding.category,
    severity,
    confidence: Number((Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0).toFixed(2)),
    title: finding.title,
    message: finding.message,
    location: finding.location,
    evidence: finding.evidence ?? [],
    affected_symbols: finding.affected_symbols ?? [],
    affected_processes: finding.affected_processes ?? [],
    verification_checklist: finding.verification_checklist ?? [],
    caveats: finding.caveats ?? [],
  };
  return { id: findingId(value), ...value };
}

function deduplicateFindings(findings, limit) {
  const values = new Map();
  for (const raw of findings.map(normalizedFinding)) {
    const key = [raw.code, raw.location?.file_path, raw.location?.line, raw.location?.side, raw.affected_symbols[0]?.stable_key, raw.message].join("\0");
    const current = values.get(key);
    if (!current || SEVERITY_ORDER[raw.severity] < SEVERITY_ORDER[current.severity]
      || (raw.severity === current.severity && raw.confidence > current.confidence)) values.set(key, raw);
  }
  const sorted = [...values.values()].sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || String(left.location?.file_path ?? "").localeCompare(String(right.location?.file_path ?? ""))
    || Number(left.location?.line ?? 0) - Number(right.location?.line ?? 0)
    || left.code.localeCompare(right.code)
    || left.id.localeCompare(right.id)
  ));
  return { findings: sorted.slice(0, limit), truncated: sorted.length > limit, total: sorted.length };
}

function lineWithinRanges(line, ranges) {
  return ranges.some((range) => range.start_line == null || line >= range.start_line && line <= range.end_line);
}

function bodyRows(db, repositoryId, symbols, maximumBytes) {
  const result = new Map();
  let bytes = 0;
  for (const symbol of symbols) {
    const row = db.prepare("SELECT body_text FROM symbols WHERE repo_id = ? AND id = ?").get(repositoryId, symbol.id);
    if (!row) continue;
    const body = String(row.body_text ?? "");
    const size = Buffer.byteLength(body, "utf8");
    if (bytes + size > maximumBytes) continue;
    bytes += size;
    result.set(symbol.stable_key, body);
  }
  return { bodies: result, bytes };
}

function matchingLines(body, symbol, needle, caseSensitive, maximum = 20) {
  const source = caseSensitive ? body : body.toLowerCase();
  const requested = caseSensitive ? needle : needle.toLowerCase();
  const bodyLines = body.split(/\r?\n/);
  const matches = [];
  let offset = 0;
  while (matches.length < maximum) {
    const found = source.indexOf(requested, offset);
    if (found < 0) break;
    const lineOffset = body.slice(0, found).split(/\r?\n/).length - 1;
    matches.push({ line: Number(symbol.start_line) + lineOffset, excerpt: bodyLines[lineOffset]?.trim().slice(0, 500) ?? "" });
    offset = found + Math.max(1, requested.length);
  }
  return matches;
}

function affectedProcesses(flows, symbols) {
  const keys = new Set(symbols.flatMap((symbol) => [symbol.stable_key, symbol.qualified_name]));
  const processes = [];
  for (const flow of flows?.flows ?? []) {
    if (!flow.path.some((symbol) => keys.has(symbol.stable_key) || keys.has(symbol.qualified_name))) continue;
    processes.push({
      start_kind: flow.start.kind,
      start_evidence: flow.start.evidence,
      path: flow.path.map((symbol) => ({ stable_key: symbol.stable_key, qualified_name: symbol.qualified_name, file_path: symbol.file_path })),
      aggregate_confidence: flow.aggregate_confidence,
      terminal_reason: flow.terminal_reason,
    });
  }
  processes.sort((left, right) => (
    String(left.start_kind).localeCompare(String(right.start_kind))
    || JSON.stringify(left.start_evidence).localeCompare(JSON.stringify(right.start_evidence))
    || left.path.map((item) => item.stable_key).join("\0").localeCompare(right.path.map((item) => item.stable_key).join("\0"))
  ));
  return processes.slice(0, 50);
}

function reviewSummary(findings, preflight, caveats, truncated) {
  const counts = Object.fromEntries([...SEVERITIES].map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
  const verdict = counts.critical || counts.error
    ? "changes_requested"
    : counts.warning
      ? "review_required"
      : "no_blocking_findings";
  const headline = verdict === "changes_requested"
    ? `${counts.critical + counts.error} blocking local review finding${counts.critical + counts.error === 1 ? "" : "s"}.`
    : verdict === "review_required"
      ? `${counts.warning} warning${counts.warning === 1 ? "" : "s"} requires human review.`
      : "No blocking finding was proven within the configured local evidence bounds.";
  const lines = [`Local review: **${verdict.replaceAll("_", " ")}** — ${headline}`];
  for (const finding of findings.slice(0, 20)) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.title} (${finding.location.file_path}:${finding.location.line})`);
  }
  if (findings.length > 20 || truncated) lines.push("- Additional findings were truncated by the configured output bound.");
  if (caveats.length) lines.push(`- CannotProve: ${caveats[0]}`);
  return {
    verdict,
    headline,
    counts,
    risk: preflight.risk,
    changed_symbols: preflight.changed_symbols.length,
    affected_symbols: preflight.blast_radius.affected_symbols,
    markdown: lines.join("\n"),
  };
}

function uniqueVerification(items, limit) {
  const result = [];
  const keys = new Set();
  for (const item of items) {
    const value = typeof item === "string" ? { type: "check", instruction: item } : item;
    const key = JSON.stringify(value);
    if (keys.has(key)) continue;
    keys.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Produce a bounded, deterministic, local-only review of a diff or changed ranges.
 * The function reads the index and optional repository-local rule configuration; it never mutates source or posts results.
 */
export function reviewChange(db, {
  repoId = null,
  diff = null,
  changes = [],
  rules = null,
  rulesText = null,
  rulesPath = null,
  thresholds = null,
  impactDepth = 5,
  includeCochange = true,
  maxChangedSymbols = 100,
  maxFindings = 200,
  maxBodyBytes = 4 * 1024 * 1024,
  maxProcessFlows = 100,
} = {}) {
  const started = performance.now();
  if (repoId != null && (typeof repoId !== "string" || !repoId.trim())) throw new Error("repoId must be a non-empty string when provided");
  const repository = resolveRepository(db, repoId);
  const safeDiff = boundedDiff(diff);
  if (!Array.isArray(changes) || changes.length > REVIEW_ENGINE_LIMITS.max_changed_ranges) {
    throw new Error(`changes must be an array with at most ${REVIEW_ENGINE_LIMITS.max_changed_ranges} entries`);
  }
  const diffEvidence = parseDiffEvidence(safeDiff);
  const parsedRanges = parseUnifiedDiff(safeDiff).map(normalizeChange);
  const providedRanges = changes.map(normalizeChange);
  const changedRanges = mergeRanges([...parsedRanges, ...providedRanges]);
  if (!changedRanges.length) throw new Error("A non-empty diff or changes array is required");
  if (changedRanges.length > REVIEW_ENGINE_LIMITS.max_changed_ranges) throw new Error("merged changed ranges exceed the review bound");
  const changedFiles = [...new Set(changedRanges.map((item) => item.file_path))].sort();
  if (changedFiles.length > REVIEW_ENGINE_LIMITS.max_changed_files) throw new Error("changed files exceed the review bound");
  const config = mergeReviewConfig(repository, { rules, rulesText, rulesPath, thresholds });
  const appliedChangedSymbols = clamp(maxChangedSymbols, 100, 1, REVIEW_ENGINE_LIMITS.max_changed_symbols);
  const appliedFindings = clamp(maxFindings, 200, 1, REVIEW_ENGINE_LIMITS.max_findings);
  const appliedBodyBytes = clamp(maxBodyBytes, 4 * 1024 * 1024, 1_024, REVIEW_ENGINE_LIMITS.max_body_bytes);
  const caveats = [];
  const componentErrors = [];
  const call = (component, callback, fallback) => {
    try {
      return callback();
    } catch (error) {
      componentErrors.push({ component, error: error.message });
      caveats.push(`${component} evidence is CannotProve because local analysis failed: ${error.message}`);
      return fallback;
    }
  };

  const preflight = changePreflight(db, {
    repoId: repository.repo_id,
    changes: changedRanges,
    impactDepth: clamp(impactDepth, 5, 1, 15),
    maxChangedSymbols: appliedChangedSymbols,
    maxVerificationTargets: REVIEW_ENGINE_LIMITS.max_verification_items,
    includeCochange: Boolean(includeCochange),
  });
  if (preflight.input.symbol_mapping_truncated) caveats.push("Changed-symbol mapping was truncated; findings do not cover every mapped symbol.");
  if (preflight.unmapped_changes.length) caveats.push(`${preflight.unmapped_changes.length} changed range(s) could not be mapped to indexed symbols.`);
  if (preflight.blast_radius.errors.length) caveats.push("Some graph impact traversals failed; the reported blast radius is incomplete.");

  const changedSymbolKeys = new Set(preflight.changed_symbols.map((symbol) => symbol.stable_key));
  const perFileBodyBudget = Math.max(1_024, Math.floor(appliedBodyBytes / Math.max(1, changedFiles.length)));
  const hotspotByKey = new Map();
  const deadByKey = new Map();
  const relationships = [];
  for (const filePath of changedFiles) {
    const hotspots = call("quality_hotspots", () => getChurnWeightedHotspots(db, {
      repoId: repository.repo_id,
      filePath,
      limit: appliedChangedSymbols,
      maxSymbols: appliedChangedSymbols,
      maxBodyBytes: perFileBodyBudget,
    }), { findings: [], truncated: false, diagnostics: [], history_source: "none" });
    for (const finding of hotspots.findings) if (changedSymbolKeys.has(finding.stable_key)) hotspotByKey.set(finding.stable_key, finding);
    if (hotspots.truncated) caveats.push(`Quality analysis for ${filePath} was truncated.`);
    for (const diagnostic of hotspots.diagnostics ?? []) caveats.push(`Quality diagnostic for ${filePath}: ${diagnostic.message}`);
    const dead = call("dead_code", () => findDeadCodeCandidates(db, {
      repoId: repository.repo_id,
      filePath,
      limit: appliedChangedSymbols,
      maxSymbols: appliedChangedSymbols,
      maxBodyBytes: perFileBodyBudget,
    }), { findings: [], truncated: false });
    for (const finding of dead.findings) if (changedSymbolKeys.has(finding.stable_key)) deadByKey.set(finding.stable_key, finding);
    if (dead.truncated) caveats.push(`Dead-code evidence for ${filePath} was truncated.`);
    const relationshipResult = call("relationships", () => getCodeRelationships(db, {
      repoId: repository.repo_id,
      filePath,
      limit: REVIEW_ENGINE_LIMITS.max_relationships_per_file,
    }), { results: [], truncated: false });
    relationships.push(...relationshipResult.results);
    if (relationshipResult.truncated) caveats.push(`Relationship evidence for ${filePath} was truncated.`);
  }

  const flowResult = call("execution_flows", () => inferExecutionFlows(db, {
    repoId: repository.repo_id,
    maxDepth: 8,
    maxResults: clamp(maxProcessFlows, 100, 1, REVIEW_ENGINE_LIMITS.max_process_flows),
    maxStarts: 100,
    maxBranching: 12,
    minConfidence: 0.4,
  }), { flows: [], truncated: false });
  const processes = affectedProcesses(flowResult, [...preflight.changed_symbols, ...preflight.blast_radius.results]);
  if (flowResult.truncated) caveats.push("Affected process discovery reached its configured flow bound.");
  if (!processes.length) caveats.push("No affected execution process was proven from the bounded resolved-call flows.");

  const contracts = [];
  for (const symbol of preflight.changed_symbols) {
    const result = call("governing_contracts", () => getGoverningContracts(db, {
      repoId: repository.repo_id,
      symbolStableKey: symbol.stable_key,
      filePath: symbol.file_path,
    }), { verdict: "CannotProve", contracts: [], decisions: [] });
    contracts.push(...result.contracts.map((contract) => ({ ...contract, stable_key: symbol.stable_key })));
  }
  const uniqueContracts = [...new Map(contracts.map((contract) => [`${contract.decision_id}:${contract.kind}:${contract.statement}:${contract.stable_key}`, contract])).values()]
    .sort((left, right) => Number(left.decision_id) - Number(right.decision_id) || String(left.statement).localeCompare(String(right.statement)));

  const bodyResult = bodyRows(db, repository.id, preflight.changed_symbols, appliedBodyBytes);
  if (bodyResult.bodies.size < preflight.changed_symbols.length) caveats.push("Some changed symbol bodies were unavailable or skipped by the body-byte bound.");
  const findings = [];
  const externalAffected = preflight.blast_radius.results.filter((symbol) => !changedFiles.includes(symbol.file_path));
  const externalFiles = [...new Set(externalAffected.map((symbol) => symbol.file_path))].sort();
  const sharedProcesses = processes.slice(0, 20);

  if (externalFiles.length >= config.thresholds.cross_module_files && preflight.changed_symbols.length) {
    const changed = preflight.changed_symbols[0];
    findings.push({
      code: "cross-module-blast-radius",
      category: "architecture",
      severity: externalFiles.length >= 5 ? "error" : "warning",
      confidence: 0.92,
      title: "Change crosses indexed module boundaries",
      message: `${externalAffected.length} upstream symbol(s) in ${externalFiles.length} other file(s) depend on the changed surface.`,
      location: locationForSymbol(changed),
      evidence: [{ type: "bounded_upstream_impact", files: externalFiles, max_depth: preflight.blast_radius.max_depth }],
      affected_symbols: externalAffected.slice(0, 50).map((symbol) => publicAffectedSymbol(symbol, "upstream")),
      affected_processes: sharedProcesses,
      verification_checklist: externalFiles.slice(0, 20).map((filePath) => `Run focused integration checks covering upstream consumers in ${filePath}.`),
      caveats: ["Static resolved-call impact does not model reflection, runtime routing, or unresolved dynamic dispatch."],
    });
  }

  const boundaryRelationships = relationships.filter((relationship) => ["export", "heritage", "endpoint_definition", "endpoint_usage"].includes(relationship.category));
  if (boundaryRelationships.length && preflight.changed_symbols.length) {
    const changed = preflight.changed_symbols[0];
    findings.push({
      code: "cross-module-contract-surface",
      category: "architecture",
      severity: "warning",
      confidence: 0.82,
      title: "Changed file participates in a public or typed boundary",
      message: `${boundaryRelationships.length} indexed export, type, or endpoint relationship(s) overlap the changed file.`,
      location: locationForSymbol(changed),
      evidence: boundaryRelationships.slice(0, 20).map((relationship) => ({
        type: "code_relationship",
        category: relationship.category,
        kind: relationship.kind,
        source: relationship.source_name,
        target: relationship.target_name,
        line: relationship.start_line,
      })),
      affected_symbols: preflight.changed_symbols.map((symbol) => publicAffectedSymbol(symbol, "changed")),
      affected_processes: sharedProcesses,
      verification_checklist: ["Verify exports, consumers, and compatibility contracts at this boundary."],
      caveats: ["Relationship evidence is syntactic and may not prove runtime use."],
    });
  }

  let historicalMetrics = 0;
  for (const symbol of preflight.changed_symbols) {
    const metric = hotspotByKey.get(symbol.stable_key);
    if (metric?.available && (metric.cyclomatic_complexity >= config.thresholds.cyclomatic
      || metric.cognitive_complexity >= config.thresholds.cognitive)) {
      const severe = metric.cyclomatic_complexity >= config.thresholds.cyclomatic * 1.5
        || metric.cognitive_complexity >= config.thresholds.cognitive * 1.5;
      findings.push({
        code: "changed-symbol-complexity",
        category: "complexity",
        severity: severe ? "error" : "warning",
        confidence: metric.confidence,
        title: "Changed symbol exceeds local complexity threshold",
        message: `${symbol.qualified_name} has cyclomatic ${metric.cyclomatic_complexity} and cognitive ${metric.cognitive_complexity} complexity.`,
        location: locationForSymbol(symbol),
        evidence: [{ type: "ast_complexity", ...metric.evidence, thresholds: config.thresholds }],
        affected_symbols: [publicAffectedSymbol(symbol, "changed")],
        affected_processes: processes.filter((process) => process.path.some((item) => item.stable_key === symbol.stable_key)).slice(0, 20),
        verification_checklist: ["Exercise every changed branch, catch path, and boundary condition in focused tests."],
        caveats: metric.caveats,
      });
    }
    if (metric?.hotspot_score >= config.thresholds.hotspot_score && metric.churn_events > 0) {
      findings.push({
        code: "high-churn-complex-symbol",
        category: "temporal-risk",
        severity: "warning",
        confidence: metric.confidence,
        title: "Complex changed symbol also has recent churn",
        message: `${symbol.qualified_name} has hotspot score ${metric.hotspot_score} across ${metric.churn_events} local temporal event(s).`,
        location: locationForSymbol(symbol),
        evidence: [{ type: "complexity_weighted_churn", hotspot_score: metric.hotspot_score, churn_events: metric.churn_events, ...metric.evidence }],
        affected_symbols: [publicAffectedSymbol(symbol, "changed")],
        affected_processes: [],
        verification_checklist: ["Review recent temporal episodes for repeated regressions and add a stable regression test."],
        caveats: metric.caveats,
      });
    }
    const previous = historicalMetric(db, repository.id, symbol.stable_key);
    if (previous && metric?.available) {
      historicalMetrics += 1;
      const cyclomaticDelta = metric.cyclomatic_complexity - previous.cyclomatic;
      const cognitiveDelta = metric.cognitive_complexity - previous.cognitive;
      if (cyclomaticDelta >= config.thresholds.complexity_delta || cognitiveDelta >= config.thresholds.complexity_delta) {
        findings.push({
          code: "complexity-regression",
          category: "complexity",
          severity: Math.max(cyclomaticDelta, cognitiveDelta) >= config.thresholds.complexity_delta * 2 ? "error" : "warning",
          confidence: Math.min(0.95, metric.confidence),
          title: "AST complexity increased from recorded history",
          message: `${symbol.qualified_name} increased by ${cyclomaticDelta} cyclomatic and ${cognitiveDelta} cognitive points versus its recorded prior snapshot.`,
          location: locationForSymbol(symbol),
          evidence: [{ type: "historical_complexity_delta", before: previous, after: { cyclomatic: metric.cyclomatic_complexity, cognitive: metric.cognitive_complexity } }],
          affected_symbols: [publicAffectedSymbol(symbol, "changed")],
          affected_processes: [],
          verification_checklist: ["Refactor or justify the new branches and add tests for each added decision path."],
          caveats: ["The delta is available only because the prior temporal snapshot explicitly stored complexity metrics."],
        });
      }
    }

    const body = bodyResult.bodies.get(symbol.stable_key);
    if (body) {
      const silentCatch = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]{0,2000}?)\}/g;
      for (const match of body.matchAll(silentCatch)) {
        const catchBody = match[1];
        if (/\bthrow\b|Promise\.reject|\b(?:log|logger|report|capture|emit)\s*\(/i.test(catchBody)) continue;
        const before = body.slice(0, match.index);
        const line = Number(symbol.start_line) + before.split(/\r?\n/).length - 1;
        if (!lineWithinRanges(line, symbol.changed_ranges ?? [])) continue;
        findings.push({
          code: "silent-error-handling",
          category: "error-handling",
          severity: "warning",
          confidence: 0.82,
          title: "Changed catch path may suppress failure evidence",
          message: "The changed catch block neither rethrows nor records the failure through an observed logging/reporting call.",
          location: { file_path: symbol.file_path, line, end_line: line, side: "new" },
          evidence: [{ type: "bounded_code_pattern", pattern: "catch-without-throw-or-report", excerpt: catchBody.trim().slice(0, 500) }],
          affected_symbols: [publicAffectedSymbol(symbol, "changed")],
          affected_processes: processes.filter((process) => process.path.some((item) => item.stable_key === symbol.stable_key)).slice(0, 20),
          verification_checklist: ["Assert the failure path is observable and does not silently convert unexpected errors into success."],
          caveats: ["Pattern evidence is conservative code inspection layered on AST complexity; wrapper logging outside the stored symbol may exist."],
        });
      }
      const finallyReturn = /finally\s*\{[\s\S]{0,1000}?\breturn\b/g;
      for (const match of body.matchAll(finallyReturn)) {
        const line = Number(symbol.start_line) + body.slice(0, match.index).split(/\r?\n/).length - 1;
        if (!lineWithinRanges(line, symbol.changed_ranges ?? [])) continue;
        findings.push({
          code: "finally-control-flow-override",
          category: "control-flow",
          severity: "error",
          confidence: 0.9,
          title: "Return in finally can override errors and earlier returns",
          message: "The changed finally block contains a return, which can replace thrown errors or prior return values.",
          location: { file_path: symbol.file_path, line, end_line: line, side: "new" },
          evidence: [{ type: "bounded_code_pattern", pattern: "return-in-finally" }],
          affected_symbols: [publicAffectedSymbol(symbol, "changed")],
          affected_processes: [],
          verification_checklist: ["Remove control-flow overrides from finally and test thrown-error propagation."],
          caveats: [],
        });
      }
    }
  }
  if (preflight.changed_symbols.length && historicalMetrics === 0) {
    caveats.push("Complexity delta is CannotProve because no prior temporal snapshot stored explicit complexity metrics for changed symbols.");
  }

  for (const symbol of preflight.changed_symbols) {
    const dead = deadByKey.get(symbol.stable_key);
    if (!dead) continue;
    const evidence = diffEvidence.get(symbol.file_path);
    const removal = evidence?.removed_lines.find((line) => line.line >= symbol.start_line && line.line <= symbol.end_line);
    findings.push({
      code: removal ? "dead-code-removal-evidence" : "changed-dead-code-candidate",
      category: "dead-code",
      severity: removal ? "info" : "warning",
      confidence: dead.confidence,
      title: removal ? "Removal has conservative dead-code evidence" : "Changed symbol has no observed incoming use",
      message: removal
        ? `${symbol.qualified_name} is being removed and has zero observed incoming graph use after conservative exclusions.`
        : `${symbol.qualified_name} has zero observed incoming graph use; confirm whether editing it is intentional.`,
      location: removal
        ? { file_path: symbol.file_path, line: removal.line, end_line: removal.line, side: "old" }
        : locationForSymbol(symbol),
      evidence: [{ type: "dead_code_candidate", ...dead.evidence }, ...(removal ? [{ type: "removed_line", text: removal.text.slice(0, 500) }] : [])],
      affected_symbols: [publicAffectedSymbol(symbol, removal ? "removed" : "changed")],
      affected_processes: [],
      verification_checklist: [removal ? "Confirm dynamic/reflection consumers are absent before completing deletion." : "Search runtime registries and dynamic consumers before investing in this symbol."],
      caveats: dead.caveats,
    });
  }

  for (const [filePath, evidence] of diffEvidence) {
    if (!evidence.deleted) continue;
    const affected = preflight.blast_radius.results.filter((symbol) => symbol.file_path !== filePath);
    findings.push({
      code: "file-removal-impact",
      category: "removal",
      severity: affected.length ? "error" : "warning",
      confidence: affected.length ? 0.9 : 0.62,
      title: "File deletion requires consumer verification",
      message: affected.length
        ? `${affected.length} bounded upstream symbol(s) remain connected to the deleted file.`
        : "No upstream consumer was proven, but static absence is not proof that runtime loaders do not use the file.",
      location: { file_path: filePath, line: evidence.removed_lines[0]?.line ?? 1, end_line: evidence.removed_lines[0]?.line ?? 1, side: "old" },
      evidence: [{ type: "file_deletion", removed_lines: evidence.removed_lines.length }],
      affected_symbols: affected.slice(0, 50).map((symbol) => publicAffectedSymbol(symbol, "upstream")),
      affected_processes: sharedProcesses,
      verification_checklist: ["Verify imports, runtime loaders, deployment manifests, and generated registries before deleting the file."],
      caveats: ["The local graph cannot prove absence of dynamic loading."],
    });
  }

  for (const contract of uniqueContracts) {
    const symbol = preflight.changed_symbols.find((item) => item.stable_key === contract.stable_key) ?? preflight.changed_symbols[0];
    if (!symbol) continue;
    findings.push({
      code: "governing-contract-review",
      category: "decision-memory",
      severity: contract.severity === "must" ? "warning" : "info",
      confidence: 1,
      title: "Recorded local contract governs this change",
      message: contract.statement,
      location: locationForSymbol(symbol),
      evidence: [{ type: "recorded_contract", decision_id: contract.decision_id, decision_title: contract.decision_title, kind: contract.kind, severity: contract.severity }],
      affected_symbols: [publicAffectedSymbol(symbol, "governed")],
      affected_processes: [],
      verification_checklist: ["Confirm the implementation and tests still satisfy this explicitly recorded contract."],
      caveats: [],
    });
  }

  for (const rule of config.rules) {
    for (const symbol of preflight.changed_symbols) {
      if (rule.file_contains && !symbol.file_path.includes(rule.file_contains)) continue;
      if (rule.symbol_contains && !symbol.qualified_name.includes(rule.symbol_contains)) continue;
      const body = bodyResult.bodies.get(symbol.stable_key);
      if (!body) continue;
      for (const match of matchingLines(body, symbol, rule.contains, rule.case_sensitive)) {
        if (rule.scope === "changed" && !lineWithinRanges(match.line, symbol.changed_ranges ?? [])) continue;
        findings.push({
          code: `local-rule:${rule.id}`,
          category: "local-rule",
          severity: rule.severity,
          confidence: rule.confidence,
          title: `Local rule ${rule.id} matched`,
          message: rule.message,
          location: { file_path: symbol.file_path, line: match.line, end_line: match.line, side: "new" },
          evidence: [{ type: "local_literal_rule", rule_id: rule.id, contains: rule.contains, excerpt: match.excerpt }],
          affected_symbols: [publicAffectedSymbol(symbol, "changed")],
          affected_processes: [],
          verification_checklist: rule.verification ? [rule.verification] : ["Resolve or explicitly justify the local review rule match."],
          caveats: ["Local rules are bounded literal matches, not arbitrary executable plug-ins."],
        });
      }
    }
  }

  const deduplicated = deduplicateFindings(findings, appliedFindings);
  if (deduplicated.truncated) caveats.push("Review findings were truncated by the configured output bound.");
  const verification = uniqueVerification([
    ...preflight.verification_targets,
    ...deduplicated.findings.flatMap((finding) => finding.verification_checklist),
  ], REVIEW_ENGINE_LIMITS.max_verification_items);
  const uniqueCaveats = [...new Set(caveats)].sort();
  const summary = reviewSummary(deduplicated.findings, preflight, uniqueCaveats, deduplicated.truncated);
  return {
    ok: true,
    repo_id: repository.repo_id,
    local_only: true,
    source_mutated: false,
    posting: { github: false, network: false, note: "This engine returns review data only; callers own any external publication." },
    summary,
    findings: deduplicated.findings,
    affected: {
      symbols: preflight.blast_radius.results.map((symbol) => publicAffectedSymbol(symbol, "upstream")),
      processes,
    },
    verification_checklist: verification,
    cannot_prove: uniqueCaveats,
    evidence: {
      preflight,
      relationships: relationships.slice(0, REVIEW_ENGINE_LIMITS.max_relationships_per_file * changedFiles.length),
      governing_contracts: uniqueContracts,
      component_errors: componentErrors,
    },
    input: {
      changed_ranges: changedRanges,
      changed_files: changedFiles,
      diff_supplied: safeDiff != null,
      rules_loaded: config.rules.length,
    },
    bounds: {
      ...REVIEW_ENGINE_LIMITS,
      applied: {
        max_changed_symbols: appliedChangedSymbols,
        max_findings: appliedFindings,
        max_body_bytes: appliedBodyBytes,
        max_process_flows: clamp(maxProcessFlows, 100, 1, REVIEW_ENGINE_LIMITS.max_process_flows),
      },
      truncated: deduplicated.truncated || preflight.input.symbol_mapping_truncated || Boolean(flowResult.truncated),
    },
    performance: {
      elapsed_ms: Number((performance.now() - started).toFixed(2)),
      changed_symbols_analyzed: preflight.changed_symbols.length,
      body_bytes_analyzed: bodyResult.bytes,
      findings_before_deduplication: findings.length,
      findings_after_deduplication: deduplicated.findings.length,
    },
    methodology: "Local composition of changed-line mapping, bounded upstream impact, co-change, AST complexity with temporal churn, conservative dead-code evidence, execution flows, code relationships, explicit decision contracts, and non-executable literal rules.",
    limitations: [
      "Static graphs cannot prove runtime reachability, reflection, dynamic dispatch, generated code, or environment-specific behavior.",
      "Complexity deltas require prior temporal snapshots that explicitly store complexity metrics; compact hash-only snapshots are insufficient.",
      "Rule matching is deliberately literal and non-executable; semantic or data-flow policies require dedicated analyzers.",
      "The review covers the locally indexed repository and configured history horizon only.",
    ],
  };
}

/** Integration hook for callers that want a configured, reusable local reviewer. */
export function createLocalReviewEngine({ db, defaults = {} } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("createLocalReviewEngine requires an open Graphward database");
  return Object.freeze({
    review(options = {}) {
      return reviewChange(db, { ...defaults, ...options });
    },
    limits: REVIEW_ENGINE_LIMITS,
    local_only: true,
  });
}
