import { randomUUID } from "node:crypto";
import { withTransaction } from "./db.mjs";
import { resolveRepository } from "./queries.mjs";

const INTENT_KINDS = new Set(["read", "add", "modify", "refactor", "test", "review", "rename", "delete", "signature"]);
const DESTRUCTIVE_KINDS = new Set(["rename", "delete", "signature"]);
const WRITE_KINDS = new Set(["add", "modify", "refactor", "test", "rename", "delete", "signature"]);
const RESOLUTION_DIRECTIVES = new Set(["proceed", "defer", "review"]);

const FLEET_SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_intents (
  intent_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  product TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('read', 'add', 'modify', 'refactor', 'test', 'review', 'rename', 'delete', 'signature')),
  summary TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_intents_scope_idx
  ON fleet_intents(repository_id, branch, status, expires_at);
CREATE INDEX IF NOT EXISTS fleet_intents_agent_idx
  ON fleet_intents(repository_id, branch, agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_episodes (
  episode_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  intent_id TEXT REFERENCES fleet_intents(intent_id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  conflict_class TEXT NOT NULL CHECK(conflict_class IN ('A', 'B', 'C')),
  conflicts_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_episodes_scope_idx
  ON fleet_episodes(repository_id, branch, recorded_at DESC);

CREATE TABLE IF NOT EXISTS fleet_leases (
  lease_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('granted', 'requested', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_leases_scope_idx
  ON fleet_leases(repository_id, branch, status, expires_at);

CREATE TABLE IF NOT EXISTS fleet_escalations (
  escalation_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  episode_id TEXT NOT NULL REFERENCES fleet_episodes(episode_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
  conflict_json TEXT NOT NULL,
  winner_agent_id TEXT,
  directive TEXT CHECK(directive IN ('proceed', 'defer', 'review')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS fleet_escalations_scope_idx
  ON fleet_escalations(repository_id, branch, status, created_at DESC);

CREATE TABLE IF NOT EXISTS fleet_audit (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_audit_scope_idx
  ON fleet_audit(repository_id, branch, recorded_at DESC, id DESC);
`;

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const localWrite = { destructiveHint: false, idempotentHint: false, openWorldHint: false };
const localDestructive = { destructiveHint: true, idempotentHint: true, openWorldHint: false };
const string = (description) => ({ type: "string", description });
const integer = (description, minimum, maximum) => ({ type: "integer", description, minimum, maximum });
const targets = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 200,
  description: "Bounded symbol or file scopes, preferably prefixed with symbol: or file:.",
};

export const FLEET_TOOL_DEFINITIONS = [
  {
    name: "fleet_publish_intent",
    description: "Publish a branch-scoped local agent intent before editing and classify overlaps with live peer intents.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), branch: string("Coordination branch or shared target branch."),
      agent_id: string("Stable agent identifier."), agent_name: string("Optional display name."), product: string("Optional agent product."),
      kind: { type: "string", enum: [...INTENT_KINDS] }, summary: string("Short description of the intended work."),
      targets, ttl_seconds: integer("Intent lifetime before it stops appearing as active.", 30, 3600),
    }, required: ["repo_id", "branch", "agent_id", "kind", "summary", "targets"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "fleet_status",
    description: "Return live local agent, intent, overlap, lease, and escalation counts for a repository and optional branch.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), branch: string("Optional branch filter."),
    }, required: ["repo_id"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "fleet_get_graph",
    description: "Return the bounded local Fleet control-room graph plus decisions, work, safety, and activity sections.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), branch: string("Optional branch filter."),
      limit: integer("Maximum rows per control-room section.", 1, 500),
    }, required: ["repo_id"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "fleet_cancel_intent",
    description: "Cancel one active local intent owned by an agent.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), intent_id: string("Intent identifier."), agent_id: string("Owning agent identifier."),
    }, required: ["repo_id", "intent_id", "agent_id"], additionalProperties: false },
    annotations: localDestructive,
  },
  {
    name: "fleet_record_episode",
    description: "Record completed work from an intent, classify it A/B/C against live peers, and open a Class C escalation when needed.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), intent_id: string("Published intent identifier."),
      agent_id: string("Owning agent identifier."), summary: string("Optional completed-work summary."),
    }, required: ["repo_id", "intent_id", "agent_id"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "fleet_acquire_lease",
    description: "Request a bounded exclusive local lease for destructive edits; overlapping live leases remain requested.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), branch: string("Coordination branch."), agent_id: string("Agent identifier."),
      targets, priority: integer("Lease priority.", 0, 100), ttl_seconds: integer("Lease lifetime.", 30, 3600),
    }, required: ["repo_id", "branch", "agent_id", "targets"], additionalProperties: false },
    annotations: localWrite,
  },
  {
    name: "fleet_release_lease",
    description: "Release a local lease owned by an agent.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), lease_id: string("Lease identifier."), agent_id: string("Owning agent identifier."),
    }, required: ["repo_id", "lease_id", "agent_id"], additionalProperties: false },
    annotations: localDestructive,
  },
  {
    name: "fleet_list_escalations",
    description: "List bounded pending or resolved Class C coordination decisions.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), branch: string("Optional branch filter."),
      status: { type: "string", enum: ["pending", "resolved"] }, limit: integer("Maximum escalations.", 1, 500),
    }, required: ["repo_id"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "fleet_resolve_escalation",
    description: "Record a human resolution for a local Class C escalation.",
    inputSchema: { type: "object", properties: {
      repo_id: string("Repository identifier."), escalation_id: string("Escalation identifier."),
      actor_id: string("Human or supervising agent identifier."), directive: { type: "string", enum: [...RESOLUTION_DIRECTIVES] },
      winner_agent_id: string("Optional winning agent."), resolution: string("Resolution rationale."),
    }, required: ["repo_id", "escalation_id", "actor_id", "directive", "resolution"], additionalProperties: false },
    annotations: localDestructive,
  },
];

function boundedText(value, name, maximum, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  if (/[ -]/.test(normalized)) throw new Error(`${name} contains control characters`);
  return normalized || null;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("targets must be a non-empty array");
  if (value.length > 200) throw new Error("targets must contain at most 200 entries");
  return [...new Set(value.map((target) => boundedText(target, "target", 500)))].sort();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAt(now, ttlSeconds) {
  return new Date(new Date(now).getTime() + ttlSeconds * 1_000).toISOString();
}

function ensureFleetSchema(db) {
  db.exec(FLEET_SCHEMA);
}

function audit(db, repositoryId, branch, actorId, eventType, subjectId, detail, recordedAt) {
  db.prepare(`
    INSERT INTO fleet_audit(repository_id, branch, actor_id, event_type, subject_id, detail_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(repositoryId, branch, actorId, eventType, subjectId, JSON.stringify(detail ?? {}), recordedAt);
}

function activeIntentRows(db, repositoryId, branch, now, excludedAgentId = null, excludedIntentId = null) {
  const rows = db.prepare(`
    SELECT * FROM fleet_intents
    WHERE repository_id = ? AND branch = ? AND status = 'active' AND expires_at > ?
    ORDER BY created_at, intent_id
  `).all(repositoryId, branch, now);
  return rows.filter((row) => row.agent_id !== excludedAgentId && row.intent_id !== excludedIntentId);
}

function intentConflicts(db, repositoryId, branch, targetsValue, now, excludedAgentId = null, excludedIntentId = null) {
  const conflicts = [];
  for (const row of activeIntentRows(db, repositoryId, branch, now, excludedAgentId, excludedIntentId)) {
    const overlappingTargets = intersection(targetsValue, parseJson(row.targets_json, []));
    if (!overlappingTargets.length || !WRITE_KINDS.has(row.kind)) continue;
    conflicts.push({
      intent_id: row.intent_id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      kind: row.kind,
      summary: row.summary,
      overlapping_targets: overlappingTargets,
      expires_at: row.expires_at,
    });
  }
  return conflicts;
}

function conflictClass(kind, conflicts) {
  if (!WRITE_KINDS.has(kind) || !conflicts.length) return "A";
  return DESTRUCTIVE_KINDS.has(kind) || conflicts.some((conflict) => DESTRUCTIVE_KINDS.has(conflict.kind)) ? "C" : "B";
}

function publicIntent(row) {
  return {
    intent_id: row.intent_id,
    branch: row.branch,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    product: row.product,
    kind: row.kind,
    summary: row.summary,
    targets: parseJson(row.targets_json, []),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function publicEpisode(row) {
  return {
    episode_id: row.episode_id,
    intent_id: row.intent_id,
    branch: row.branch,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    kind: row.kind,
    summary: row.summary,
    targets: parseJson(row.targets_json, []),
    conflict_class: row.conflict_class,
    conflicts: parseJson(row.conflicts_json, []),
    recorded_at: row.recorded_at,
  };
}

function publicLease(row) {
  return {
    lease_id: row.lease_id,
    branch: row.branch,
    agent_id: row.agent_id,
    targets: parseJson(row.targets_json, []),
    priority: Number(row.priority),
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function publicEscalation(row) {
  return {
    escalation_id: row.escalation_id,
    episode_id: row.episode_id,
    branch: row.branch,
    status: row.status,
    conflict: parseJson(row.conflict_json, {}),
    winner_agent_id: row.winner_agent_id,
    directive: row.directive,
    resolution: row.resolution,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

export function publishFleetIntent(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const branch = boundedText(args.branch, "branch", 300);
  const agentId = boundedText(args.agentId, "agent_id", 300);
  const agentName = boundedText(args.agentName, "agent_name", 300, { required: false });
  const product = boundedText(args.product, "product", 200, { required: false });
  const kind = boundedText(args.kind, "kind", 30);
  if (!INTENT_KINDS.has(kind)) throw new Error(`Unsupported intent kind: ${kind}`);
  const summary = boundedText(args.summary, "summary", 2_000);
  const targetValues = normalizeTargets(args.targets);
  const ttlSeconds = boundedInteger(args.ttlSeconds, 120, 30, 3_600, "ttl_seconds");
  const now = nowIso();
  const conflicts = intentConflicts(db, repository.id, branch, targetValues, now, agentId);
  const classification = conflictClass(kind, conflicts);
  const intentId = randomUUID();
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO fleet_intents(intent_id, repository_id, branch, agent_id, agent_name, product, kind, summary,
        targets_json, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(intentId, repository.id, branch, agentId, agentName, product, kind, summary,
      JSON.stringify(targetValues), now, now, expiresAt(now, ttlSeconds));
    audit(db, repository.id, branch, agentId, "intent.published", intentId, { kind, targets: targetValues, conflict_class: classification }, now);
    return {
      repo_id: repository.repo_id,
      intent_id: intentId,
      conflict_class: classification,
      active_conflicts: conflicts,
      recommendation: classification === "C" ? "acquire a lease or defer before editing" : classification === "B" ? "coordinate and re-read before editing" : "proceed",
      expires_at: expiresAt(now, ttlSeconds),
      local_only: true,
    };
  });
}

export function cancelFleetIntent(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const intentId = boundedText(args.intentId, "intent_id", 100);
  const agentId = boundedText(args.agentId, "agent_id", 300);
  const row = db.prepare("SELECT * FROM fleet_intents WHERE repository_id = ? AND intent_id = ?").get(repository.id, intentId);
  if (!row) throw new Error(`Fleet intent not found: ${intentId}`);
  if (row.agent_id !== agentId) throw new Error("Only the owning agent can cancel this intent");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare("UPDATE fleet_intents SET status = 'cancelled', updated_at = ? WHERE intent_id = ?").run(now, intentId);
    audit(db, repository.id, row.branch, agentId, "intent.cancelled", intentId, {}, now);
    return { repo_id: repository.repo_id, intent_id: intentId, status: "cancelled", local_only: true };
  });
}

export function recordFleetEpisode(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const intentId = boundedText(args.intentId, "intent_id", 100);
  const agentId = boundedText(args.agentId, "agent_id", 300);
  const intent = db.prepare("SELECT * FROM fleet_intents WHERE repository_id = ? AND intent_id = ?").get(repository.id, intentId);
  if (!intent) throw new Error(`Fleet intent not found: ${intentId}`);
  if (intent.agent_id !== agentId) throw new Error("Only the owning agent can record this intent's episode");
  if (intent.status !== "active") throw new Error(`Fleet intent is already ${intent.status}`);
  const summary = boundedText(args.summary ?? intent.summary, "summary", 2_000);
  const targetValues = parseJson(intent.targets_json, []);
  const now = nowIso();
  const conflicts = intentConflicts(db, repository.id, intent.branch, targetValues, now, agentId, intentId);
  const classification = conflictClass(intent.kind, conflicts);
  const episodeId = randomUUID();
  const escalationId = classification === "C" ? randomUUID() : null;
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO fleet_episodes(episode_id, repository_id, branch, intent_id, agent_id, agent_name, kind, summary,
        targets_json, conflict_class, conflicts_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(episodeId, repository.id, intent.branch, intentId, agentId, intent.agent_name, intent.kind, summary,
      JSON.stringify(targetValues), classification, JSON.stringify(conflicts), now);
    db.prepare("UPDATE fleet_intents SET status = 'completed', updated_at = ? WHERE intent_id = ?").run(now, intentId);
    if (escalationId) {
      db.prepare(`
        INSERT INTO fleet_escalations(escalation_id, repository_id, branch, episode_id, status, conflict_json, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(escalationId, repository.id, intent.branch, episodeId, JSON.stringify({ agent_id: agentId, conflicts, targets: targetValues }), now);
    }
    audit(db, repository.id, intent.branch, agentId, "episode.recorded", episodeId, { conflict_class: classification, escalation_id: escalationId }, now);
    return {
      repo_id: repository.repo_id,
      episode_id: episodeId,
      conflict_class: classification,
      conflicts,
      escalation_id: escalationId,
      replan_hint: classification === "C" ? "defer pending a human resolution" : classification === "B" ? "re-read overlapping targets before continuing" : "safe additive or isolated episode",
      local_only: true,
    };
  });
}

function liveLeaseRows(db, repositoryId, branch, now) {
  return db.prepare(`
    SELECT * FROM fleet_leases
    WHERE repository_id = ? AND branch = ? AND status = 'granted' AND expires_at > ?
    ORDER BY priority DESC, created_at, lease_id
  `).all(repositoryId, branch, now);
}

export function acquireFleetLease(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const branch = boundedText(args.branch, "branch", 300);
  const agentId = boundedText(args.agentId, "agent_id", 300);
  const targetValues = normalizeTargets(args.targets);
  const priority = boundedInteger(args.priority, 0, 0, 100, "priority");
  const ttlSeconds = boundedInteger(args.ttlSeconds, 120, 30, 3_600, "ttl_seconds");
  const now = nowIso();
  const blockers = liveLeaseRows(db, repository.id, branch, now)
    .filter((row) => row.agent_id !== agentId)
    .map((row) => ({ ...publicLease(row), overlapping_targets: intersection(targetValues, parseJson(row.targets_json, [])) }))
    .filter((row) => row.overlapping_targets.length);
  const status = blockers.length ? "requested" : "granted";
  const leaseId = randomUUID();
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO fleet_leases(lease_id, repository_id, branch, agent_id, targets_json, priority, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leaseId, repository.id, branch, agentId, JSON.stringify(targetValues), priority, status, now, now, expiresAt(now, ttlSeconds));
    audit(db, repository.id, branch, agentId, `lease.${status}`, leaseId, { targets: targetValues, blockers: blockers.map((row) => row.lease_id) }, now);
    return { repo_id: repository.repo_id, lease_id: leaseId, status, granted: status === "granted", blockers, expires_at: expiresAt(now, ttlSeconds), local_only: true };
  });
}

export function releaseFleetLease(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const leaseId = boundedText(args.leaseId, "lease_id", 100);
  const agentId = boundedText(args.agentId, "agent_id", 300);
  const row = db.prepare("SELECT * FROM fleet_leases WHERE repository_id = ? AND lease_id = ?").get(repository.id, leaseId);
  if (!row) throw new Error(`Fleet lease not found: ${leaseId}`);
  if (row.agent_id !== agentId) throw new Error("Only the owning agent can release this lease");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare("UPDATE fleet_leases SET status = 'released', updated_at = ? WHERE lease_id = ?").run(now, leaseId);
    audit(db, repository.id, row.branch, agentId, "lease.released", leaseId, {}, now);
    return { repo_id: repository.repo_id, lease_id: leaseId, status: "released", local_only: true };
  });
}

function branchClause(branch, column = "branch") {
  return branch ? { sql: ` AND ${column} = ?`, values: [branch] } : { sql: "", values: [] };
}

export function listFleetEscalations(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const branch = boundedText(args.branch, "branch", 300, { required: false });
  const status = boundedText(args.status ?? "pending", "status", 20);
  if (!new Set(["pending", "resolved"]).has(status)) throw new Error("status must be pending or resolved");
  const limit = boundedInteger(args.limit, 100, 1, 500, "limit");
  const scope = branchClause(branch);
  const rows = db.prepare(`
    SELECT * FROM fleet_escalations WHERE repository_id = ? AND status = ?${scope.sql}
    ORDER BY created_at DESC, escalation_id DESC LIMIT ?
  `).all(repository.id, status, ...scope.values, limit);
  return { repo_id: repository.repo_id, branch, status, escalations: rows.map(publicEscalation), local_only: true };
}

export function resolveFleetEscalation(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const escalationId = boundedText(args.escalationId, "escalation_id", 100);
  const actorId = boundedText(args.actorId, "actor_id", 300);
  const directive = boundedText(args.directive, "directive", 20);
  if (!RESOLUTION_DIRECTIVES.has(directive)) throw new Error(`Unsupported directive: ${directive}`);
  const winnerAgentId = boundedText(args.winnerAgentId, "winner_agent_id", 300, { required: false });
  const resolution = boundedText(args.resolution, "resolution", 4_000);
  const row = db.prepare("SELECT * FROM fleet_escalations WHERE repository_id = ? AND escalation_id = ?").get(repository.id, escalationId);
  if (!row) throw new Error(`Fleet escalation not found: ${escalationId}`);
  if (row.status === "resolved") throw new Error("Fleet escalation is already resolved");
  const now = nowIso();
  return withTransaction(db, () => {
    db.prepare(`
      UPDATE fleet_escalations SET status = 'resolved', winner_agent_id = ?, directive = ?, resolution = ?, resolved_at = ?
      WHERE escalation_id = ?
    `).run(winnerAgentId, directive, resolution, now, escalationId);
    audit(db, repository.id, row.branch, actorId, "escalation.resolved", escalationId, { directive, winner_agent_id: winnerAgentId, resolution }, now);
    return { repo_id: repository.repo_id, escalation_id: escalationId, status: "resolved", directive, winner_agent_id: winnerAgentId, resolution, local_only: true };
  });
}

function branchValues(db, repositoryId) {
  const values = new Set();
  for (const table of ["fleet_intents", "fleet_episodes", "fleet_leases", "fleet_escalations"]) {
    for (const row of db.prepare(`SELECT DISTINCT branch FROM ${table} WHERE repository_id = ? ORDER BY branch`).all(repositoryId)) values.add(row.branch);
  }
  return [...values].sort();
}

function conflictEdges(intents) {
  const edges = [];
  for (let leftIndex = 0; leftIndex < intents.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < intents.length; rightIndex += 1) {
      const left = intents[leftIndex];
      const right = intents[rightIndex];
      if (left.agent_id === right.agent_id) continue;
      const overlappingTargets = intersection(left.targets, right.targets);
      if (!overlappingTargets.length || !WRITE_KINDS.has(left.kind) || !WRITE_KINDS.has(right.kind)) continue;
      const classification = conflictClass(left.kind, [{ kind: right.kind }]);
      edges.push({
        id: `conflict:${left.intent_id}:${right.intent_id}`,
        source: `agent:${left.agent_id}`,
        target: `agent:${right.agent_id}`,
        kind: "conflict",
        conflict_class: classification,
        targets: overlappingTargets,
      });
    }
  }
  return edges;
}

function fleetMap(intents, leases) {
  const agents = new Map();
  const targetNodes = new Map();
  const edges = [];
  const addAgent = (agentId, values) => {
    const current = agents.get(agentId) ?? { id: `agent:${agentId}`, kind: "agent", agent_id: agentId, label: values.agent_name ?? agentId, intents: 0, leases: 0 };
    if (values.agent_name) current.label = values.agent_name;
    agents.set(agentId, current);
    return current;
  };
  const addTarget = (target) => {
    const [prefix, ...rest] = target.split(":");
    const typed = rest.length > 0;
    const node = targetNodes.get(target) ?? {
      id: `target:${target}`,
      kind: "target",
      target_type: typed ? prefix : "scope",
      label: typed ? rest.join(":") : target,
      target,
    };
    targetNodes.set(target, node);
  };
  for (const intent of intents) {
    const agent = addAgent(intent.agent_id, intent);
    agent.intents += 1;
    agent.intent_kind = intent.kind;
    agent.summary = intent.summary;
    agent.expires_at = intent.expires_at;
    for (const target of intent.targets) {
      addTarget(target);
      edges.push({ id: `intent:${intent.intent_id}:${target}`, source: agent.id, target: `target:${target}`, kind: "intent", intent_kind: intent.kind });
    }
  }
  for (const lease of leases) {
    const agent = addAgent(lease.agent_id, lease);
    agent.leases += 1;
    for (const target of lease.targets) {
      addTarget(target);
      edges.push({ id: `lease:${lease.lease_id}:${target}`, source: agent.id, target: `target:${target}`, kind: "lease" });
    }
  }
  const overlaps = conflictEdges(intents);
  edges.push(...overlaps);
  return { nodes: [...agents.values(), ...targetNodes.values()], edges, overlaps };
}

function scopedRows(db, table, repositoryId, branch, order, limit, extra = "") {
  const scope = branchClause(branch);
  return db.prepare(`SELECT * FROM ${table} WHERE repository_id = ?${extra}${scope.sql} ORDER BY ${order} LIMIT ?`)
    .all(repositoryId, ...scope.values, limit);
}

export function getFleetGraph(db, args = {}) {
  ensureFleetSchema(db);
  const repository = resolveRepository(db, args.repoId ?? null);
  const branch = boundedText(args.branch, "branch", 300, { required: false });
  const limit = boundedInteger(args.limit, 200, 1, 500, "limit");
  const now = nowIso();
  const intentScope = branchClause(branch);
  const activeRows = db.prepare(`
    SELECT * FROM fleet_intents WHERE repository_id = ? AND status = 'active' AND expires_at > ?${intentScope.sql}
    ORDER BY created_at DESC, intent_id DESC LIMIT ?
  `).all(repository.id, now, ...intentScope.values, limit);
  const leaseScope = branchClause(branch);
  const leaseRows = db.prepare(`
    SELECT * FROM fleet_leases WHERE repository_id = ? AND status IN ('granted', 'requested') AND expires_at > ?${leaseScope.sql}
    ORDER BY created_at DESC, lease_id DESC LIMIT ?
  `).all(repository.id, now, ...leaseScope.values, limit);
  const episodeRows = scopedRows(db, "fleet_episodes", repository.id, branch, "recorded_at DESC, episode_id DESC", limit);
  const escalationRows = scopedRows(db, "fleet_escalations", repository.id, branch, "created_at DESC, escalation_id DESC", limit);
  const auditRows = scopedRows(db, "fleet_audit", repository.id, branch, "recorded_at DESC, id DESC", limit);
  const intents = activeRows.map(publicIntent);
  const leases = leaseRows.map(publicLease);
  const episodes = episodeRows.map(publicEpisode);
  const escalations = escalationRows.map(publicEscalation);
  const map = fleetMap(intents, leases.filter((lease) => lease.status === "granted"));
  const pending = escalations.filter((entry) => entry.status === "pending");
  const activity = auditRows.map((row) => ({
    id: Number(row.id), branch: row.branch, actor_id: row.actor_id, event_type: row.event_type,
    subject_id: row.subject_id, detail: parseJson(row.detail_json, {}), recorded_at: row.recorded_at,
  }));
  const agentCount = map.nodes.filter((node) => node.kind === "agent").length;
  return {
    repo_id: repository.repo_id,
    branch,
    branches: branchValues(db, repository.id),
    generated_at: now,
    summary: {
      active_agents: agentCount,
      active_intents: intents.length,
      overlaps: map.overlaps.length,
      class_c_overlaps: map.overlaps.filter((edge) => edge.conflict_class === "C").length,
      active_leases: leases.filter((lease) => lease.status === "granted").length,
      pending_decisions: pending.length,
      conflict_density: intents.length ? Number((map.overlaps.length / intents.length).toFixed(3)) : 0,
    },
    graph: { nodes: map.nodes, edges: map.edges },
    decisions: escalations,
    work: { intents, episodes },
    safety: { leases, conflicts: map.overlaps },
    activity,
    limits: { per_section: limit },
    local_only: true,
  };
}

export function getFleetStatus(db, args = {}) {
  const graph = getFleetGraph(db, { ...args, limit: 100 });
  return {
    repo_id: graph.repo_id,
    branch: graph.branch,
    branches: graph.branches,
    ...graph.summary,
    local_only: true,
  };
}

export function callFleetTool(name, args, context) {
  if (!name.startsWith("fleet_")) return { handled: false };
  const values = {
    ...args,
    repoId: args.repo_id ?? null,
    agentId: args.agent_id,
    agentName: args.agent_name ?? null,
    intentId: args.intent_id,
    leaseId: args.lease_id,
    escalationId: args.escalation_id,
    actorId: args.actor_id,
    winnerAgentId: args.winner_agent_id ?? null,
    ttlSeconds: args.ttl_seconds,
  };
  const calls = {
    fleet_publish_intent: publishFleetIntent,
    fleet_status: getFleetStatus,
    fleet_get_graph: getFleetGraph,
    fleet_cancel_intent: cancelFleetIntent,
    fleet_record_episode: recordFleetEpisode,
    fleet_acquire_lease: acquireFleetLease,
    fleet_release_lease: releaseFleetLease,
    fleet_list_escalations: listFleetEscalations,
    fleet_resolve_escalation: resolveFleetEscalation,
  };
  const handler = calls[name];
  if (!handler) return { handled: false };
  return { handled: true, value: handler(context.db, values) };
}
