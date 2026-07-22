import { createHash } from "node:crypto";
import { methodsCompatible, normalizeApiPath, normalizeHttpMethod } from "./api-utils.mjs";
import { getApiTopology } from "./queries.mjs";

const PROTOCOLS = new Set(["http", "graphql", "grpc", "websocket", "queue"]);
const DIRECTIONS = new Set(["inbound", "outbound"]);
const LINK_ROLES = new Set(["provider", "consumer", "both"]);
const GRAPHQL_TYPES = new Set(["query", "mutation", "subscription", "ANY"]);
const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 5_000;
const DEFAULT_RELATIONSHIP_LIMIT = 10_000;
const MAX_RELATIONSHIP_LIMIT = 50_000;
const DEFAULT_MAX_CANDIDATES = 50;
const MAX_CANDIDATES = 200;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_EVIDENCE_DEPTH = 20;
const MAX_EVIDENCE_NODES = 10_000;

const SERVICE_TOPOLOGY_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_services (
  id INTEGER PRIMARY KEY,
  service_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('configured', 'inferred')),
  confidence REAL NOT NULL,
  base_urls_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_service_repository_links (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES local_services(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('provider', 'consumer', 'both')),
  source TEXT NOT NULL CHECK(source IN ('configured', 'inferred')),
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, repo_id, role)
);
CREATE INDEX IF NOT EXISTS local_service_repo_links_repo_idx
  ON local_service_repository_links(repo_id, role, service_id);

CREATE TABLE IF NOT EXISTS local_service_operations (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES local_services(id) ON DELETE SET NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('http', 'graphql', 'grpc', 'websocket', 'queue')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  operation_key TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  file_path TEXT,
  line INTEGER,
  source_stable_key TEXT,
  confidence REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'configured' CHECK(source IN ('configured')),
  evidence_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS local_service_operations_lookup_idx
  ON local_service_operations(repo_id, protocol, direction, operation_key);
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compareCodePoints(leftValue, rightValue) {
  const left = [...String(leftValue)];
  const right = [...String(rightValue)];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareCodePoints).filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function confidenceValue(value, fallback = 1) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("confidence must be between 0 and 1");
  return number;
}

function requiredText(value, name, maximum = 2_048) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required and must be a string`);
  const result = value.trim().normalize("NFC");
  if (result.length > maximum || result.includes("\0")) throw new Error(`${name} must be at most ${maximum} characters and contain no NUL`);
  return result;
}

function optionalText(value, name, maximum = 4_096) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, maximum);
}

function normalizeServiceKey(value) {
  const key = requiredText(value, "serviceKey", 200).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(key)) throw new Error("serviceKey may contain lowercase letters, numbers, dot, underscore, colon, and hyphen");
  return key;
}

function normalizedFilePath(value) {
  const raw = requiredText(value, "filePath", 4_096).replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) {
    throw new Error(`Invalid repository-relative filePath: ${value}`);
  }
  const result = raw.replace(/^\.\//, "");
  if (result === ".." || result.startsWith("../") || /\/[.][.]\//.test(`/${result}/`)) {
    throw new Error(`Invalid repository-relative filePath: ${value}`);
  }
  return result;
}

function normalizeEvidence(value, name = "evidence") {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error(`${name} must be a non-empty object`);
  }
  const active = new Set();
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > MAX_EVIDENCE_NODES) throw new Error(`${name} exceeds ${MAX_EVIDENCE_NODES} JSON nodes`);
    if (depth > MAX_EVIDENCE_DEPTH) throw new Error(`${name} exceeds maximum nesting depth ${MAX_EVIDENCE_DEPTH}`);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.includes("\0")) throw new Error(`${name} strings must not contain NUL`);
      return item.normalize("NFC");
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${name} numbers must be finite`);
      return item;
    }
    if (typeof item !== "object") throw new Error(`${name} must contain only JSON-compatible values`);
    if (active.has(item)) throw new Error(`${name} must be acyclic JSON`);
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      result = item.map((entry) => visit(entry, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must contain only plain JSON objects`);
      result = Object.create(null);
      for (const key of Object.keys(item).sort(compareCodePoints)) {
        if (key.length > 500 || key.includes("\0")) throw new Error(`${name} keys must be at most 500 characters and contain no NUL`);
        const normalizedKey = key.normalize("NFC");
        if (Object.prototype.hasOwnProperty.call(result, normalizedKey)) throw new Error(`${name} contains duplicate keys after Unicode normalization`);
        result[normalizedKey] = visit(item[key], depth + 1);
      }
    }
    active.delete(item);
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error(`${name} must serialize to at most ${MAX_EVIDENCE_BYTES} bytes`);
  }
  return normalized;
}

function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeBaseUrl(value) {
  const raw = requiredText(value, "base URL", 2_048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid absolute base URL: ${value}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("base URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("base URL must not contain credentials");
  parsed.search = "";
  parsed.hash = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/";
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

function normalizeBaseUrls(values) {
  if (!Array.isArray(values)) throw new Error("baseUrls must be an array");
  return [...new Set(values.map(normalizeBaseUrl))].sort(compareCodePoints);
}

function absoluteUrl(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value.trim())) return null;
  try {
    const parsed = new URL(value.trim());
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function urlMatchesBase(url, baseUrl) {
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return !prefix || prefix === "/" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

function repositoryByPublicId(db, repoId) {
  const normalized = requiredText(repoId, "repoId", 500);
  const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(normalized);
  if (!row) throw new Error(`Unknown repo_id: ${normalized}`);
  return row;
}

function resolveRepositories(db, repoIds = null) {
  if (repoIds == null) return db.prepare("SELECT * FROM repositories ORDER BY repo_id").all();
  const values = Array.isArray(repoIds) ? repoIds : [repoIds];
  if (!values.length || values.length > 100) throw new Error("repoIds must contain between 1 and 100 repository ids");
  const unique = [...new Set(values.map((value) => requiredText(value, "repoId", 500)))].sort(compareCodePoints);
  return unique.map((repoId) => repositoryByPublicId(db, repoId));
}

function serviceByKey(db, serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  const row = db.prepare("SELECT * FROM local_services WHERE service_key = ?").get(key);
  if (!row) throw new Error(`Unknown serviceKey: ${key}`);
  return row;
}

function roleCapabilities(role) {
  if (role === "both") return new Set(["provider", "consumer"]);
  return new Set([role]);
}

function roleFromCapabilities(capabilities) {
  if (capabilities.has("provider") && capabilities.has("consumer")) return "both";
  if (capabilities.has("provider")) return "provider";
  if (capabilities.has("consumer")) return "consumer";
  return null;
}

function canonicalLinkEvidence(rows, role, evidence) {
  const roleEvidence = {};
  for (const row of rows) {
    const existing = parseJson(row.evidence_json, {});
    if (existing.kind === "canonical_repository_service_link" && existing.role_evidence && typeof existing.role_evidence === "object") {
      for (const capability of ["provider", "consumer"]) {
        if (existing.role_evidence[capability]) roleEvidence[capability] = existing.role_evidence[capability];
      }
      continue;
    }
    for (const capability of roleCapabilities(row.role)) roleEvidence[capability] = existing;
  }
  for (const capability of roleCapabilities(role)) roleEvidence[capability] = evidence;
  return canonicalize({ kind: "canonical_repository_service_link", role_evidence: roleEvidence });
}

function publicService(row) {
  return {
    id: row.id,
    service_key: row.service_key,
    name: row.name,
    source: row.source,
    confidence: Number(row.confidence),
    base_urls: parseJson(row.base_urls_json, []),
    evidence: parseJson(row.evidence_json, {}),
  };
}

function publicRepository(row) {
  return { repo_id: row.repo_id, name: row.name, root: row.root, indexed_at: row.indexed_at, head_commit: row.head_commit };
}

export function ensureServiceTopologySchema(db) {
  db.exec(SERVICE_TOPOLOGY_SCHEMA);
  return { ok: true, schema: "service-topology-v1" };
}

export function upsertServiceIdentity(db, {
  serviceKey,
  name,
  baseUrls = [],
  confidence = 1,
  evidence,
} = {}) {
  ensureServiceTopologySchema(db);
  const key = normalizeServiceKey(serviceKey);
  const normalizedName = requiredText(name ?? serviceKey, "name", 500);
  const urls = normalizeBaseUrls(baseUrls);
  const normalizedEvidence = normalizeEvidence(evidence);
  const normalizedConfidence = confidenceValue(confidence);
  const existing = db.prepare("SELECT * FROM local_services WHERE service_key = ?").get(key);
  const now = new Date().toISOString();
  if (existing) {
    const changed = existing.name !== normalizedName
      || existing.source !== "configured"
      || Number(existing.confidence) !== normalizedConfidence
      || existing.base_urls_json !== canonicalJson(urls)
      || existing.evidence_json !== canonicalJson(normalizedEvidence);
    if (changed) {
      db.prepare(`
        UPDATE local_services SET name = ?, source = 'configured', confidence = ?, base_urls_json = ?, evidence_json = ?, updated_at = ?
        WHERE id = ?
      `).run(normalizedName, normalizedConfidence, canonicalJson(urls), canonicalJson(normalizedEvidence), now, existing.id);
    }
    return { ok: true, created: false, changed, service: publicService(db.prepare("SELECT * FROM local_services WHERE id = ?").get(existing.id)) };
  }
  const result = db.prepare(`
    INSERT INTO local_services(service_key, name, source, confidence, base_urls_json, evidence_json, created_at, updated_at)
    VALUES (?, ?, 'configured', ?, ?, ?, ?, ?)
  `).run(key, normalizedName, normalizedConfidence, canonicalJson(urls), canonicalJson(normalizedEvidence), now, now);
  return { ok: true, created: true, changed: true, service: publicService(db.prepare("SELECT * FROM local_services WHERE id = ?").get(Number(result.lastInsertRowid))) };
}

export function linkRepositoryService(db, {
  repoId,
  serviceKey,
  role,
  confidence = 1,
  evidence,
} = {}) {
  ensureServiceTopologySchema(db);
  const repository = repositoryByPublicId(db, repoId);
  const service = serviceByKey(db, serviceKey);
  const normalizedRole = String(role ?? "").toLowerCase();
  if (!LINK_ROLES.has(normalizedRole)) throw new Error("role must be provider, consumer, or both");
  const normalizedEvidence = normalizeEvidence(evidence);
  const normalizedConfidence = confidenceValue(confidence);
  const existing = db.prepare(`
    SELECT * FROM local_service_repository_links WHERE service_id = ? AND repo_id = ? ORDER BY id
  `).all(service.id, repository.id);
  const capabilities = new Set(existing.flatMap((row) => [...roleCapabilities(row.role)]));
  for (const capability of roleCapabilities(normalizedRole)) capabilities.add(capability);
  const canonicalRole = roleFromCapabilities(capabilities);
  const canonicalEvidence = canonicalLinkEvidence(existing, normalizedRole, normalizedEvidence);
  const canonicalConfidence = existing.length
    ? Math.min(normalizedConfidence, ...existing.map((row) => Number(row.confidence)))
    : normalizedConfidence;
  const canonicalCreatedAt = existing.map((row) => row.created_at).sort(compareCodePoints)[0];
  const now = new Date().toISOString();
  const unchanged = existing.length === 1
    && existing[0].role === canonicalRole
    && existing[0].source === "configured"
    && Number(existing[0].confidence) === canonicalConfidence
    && existing[0].evidence_json === canonicalJson(canonicalEvidence);
  if (!unchanged) {
    transaction(db, () => {
      db.prepare("DELETE FROM local_service_repository_links WHERE service_id = ? AND repo_id = ?").run(service.id, repository.id);
      db.prepare(`
        INSERT INTO local_service_repository_links(service_id, repo_id, role, source, confidence, evidence_json, created_at, updated_at)
        VALUES (?, ?, ?, 'configured', ?, ?, ?, ?)
      `).run(service.id, repository.id, canonicalRole, canonicalConfidence, canonicalJson(canonicalEvidence), canonicalCreatedAt ?? now, now);
    });
  }
  return {
    ok: true,
    created: existing.length === 0,
    changed: !unchanged,
    repo_id: repository.repo_id,
    service_key: service.service_key,
    role: canonicalRole,
  };
}

export function unlinkRepositoryService(db, {
  repoId,
  serviceKey,
  role = null,
  pruneOrphanService = false,
} = {}) {
  ensureServiceTopologySchema(db);
  const repository = repositoryByPublicId(db, repoId);
  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  const normalizedRole = role == null ? null : String(role).toLowerCase();
  if (normalizedRole != null && !LINK_ROLES.has(normalizedRole)) throw new Error("role must be provider, consumer, both, or null");
  const service = db.prepare("SELECT * FROM local_services WHERE service_key = ?").get(normalizedServiceKey);
  if (!service) {
    return { ok: true, deleted: 0, removed_operations: 0, pruned_service: false, repo_id: repository.repo_id, service_key: normalizedServiceKey, role: normalizedRole };
  }
  const existing = db.prepare(`
    SELECT * FROM local_service_repository_links WHERE service_id = ? AND repo_id = ? ORDER BY id
  `).all(service.id, repository.id);
  const existingCapabilities = new Set(existing.flatMap((row) => [...roleCapabilities(row.role)]));
  const removedCapabilities = normalizedRole == null ? new Set(["provider", "consumer"]) : roleCapabilities(normalizedRole);
  const remainingCapabilities = new Set([...existingCapabilities].filter((capability) => !removedCapabilities.has(capability)));
  const changed = [...removedCapabilities].some((capability) => existingCapabilities.has(capability));
  const operationDirections = [...removedCapabilities].map((capability) => capability === "provider" ? "inbound" : "outbound");
  let removedOperations = 0;
  transaction(db, () => {
    if (changed) {
      db.prepare("DELETE FROM local_service_repository_links WHERE service_id = ? AND repo_id = ?").run(service.id, repository.id);
      const remainingRole = roleFromCapabilities(remainingCapabilities);
      if (remainingRole) {
        const source = existing.some((row) => row.source === "configured") ? "configured" : "inferred";
        const confidence = Math.min(...existing.map((row) => Number(row.confidence)));
        const createdAt = existing.map((row) => row.created_at).sort(compareCodePoints)[0];
        const roleEvidence = {};
        for (const row of existing) {
          const parsed = parseJson(row.evidence_json, {});
          const entries = parsed.kind === "canonical_repository_service_link" && parsed.role_evidence
            ? parsed.role_evidence
            : Object.fromEntries([...roleCapabilities(row.role)].map((capability) => [capability, parsed]));
          for (const capability of remainingCapabilities) {
            if (entries[capability]) roleEvidence[capability] = entries[capability];
          }
        }
        const nextEvidence = canonicalize({ kind: "canonical_repository_service_link", role_evidence: roleEvidence });
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO local_service_repository_links(service_id, repo_id, role, source, confidence, evidence_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(service.id, repository.id, remainingRole, source, confidence, canonicalJson(nextEvidence), createdAt, now);
      }
    }
    if (operationDirections.length) {
      const placeholders = operationDirections.map(() => "?").join(",");
      removedOperations = Number(db.prepare(`
        DELETE FROM local_service_operations
        WHERE service_id = ? AND repo_id = ? AND direction IN (${placeholders})
      `).run(service.id, repository.id, ...operationDirections).changes);
    }
  });
  let pruned = false;
  if (pruneOrphanService) {
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM local_service_repository_links WHERE service_id = ?").get(service.id).count;
    if (!remaining) {
      transaction(db, () => {
        removedOperations += Number(db.prepare("DELETE FROM local_service_operations WHERE service_id = ?").run(service.id).changes);
        db.prepare("DELETE FROM local_services WHERE id = ?").run(service.id);
      });
      pruned = true;
    }
  }
  return { ok: true, deleted: changed ? 1 : 0, removed_operations: removedOperations, pruned_service: pruned, repo_id: repository.repo_id, service_key: service.service_key, role: normalizedRole };
}

function inferredBaseUrls(db, repository) {
  const values = db.prepare(`
    SELECT raw_path FROM api_operations WHERE repo_id = ? AND kind = 'route' ORDER BY id
  `).all(repository.id).map((row) => absoluteUrl(row.raw_path)).filter(Boolean).map((url) => url.origin);
  return [...new Set(values)].sort(compareCodePoints);
}

export function refreshServiceIdentities(db, { repoIds = null } = {}) {
  ensureServiceTopologySchema(db);
  const repositories = resolveRepositories(db, repoIds);
  const now = new Date().toISOString();
  const results = [];
  transaction(db, () => {
    for (const repository of repositories) {
      const configuredProvider = db.prepare(`
        SELECT 1 FROM local_service_repository_links
        WHERE repo_id = ? AND source = 'configured' AND role IN ('provider', 'both') LIMIT 1
      `).get(repository.id);
      const slug = repository.repo_id.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
      const inferredKey = `repo:${slug}:${createHash("sha256").update(repository.repo_id).digest("hex").slice(0, 8)}`;
      if (configuredProvider) {
        const stale = db.prepare("SELECT id FROM local_services WHERE service_key = ? AND source = 'inferred'").get(inferredKey);
        if (stale) {
          db.prepare(`
            DELETE FROM local_services
            WHERE id = ? AND source = 'inferred'
              AND NOT EXISTS (
                SELECT 1 FROM local_service_repository_links
                WHERE service_id = local_services.id AND source = 'configured'
              )
          `).run(stale.id);
        }
        results.push({ repo_id: repository.repo_id, inferred: false, reason: "configured_provider_link" });
        continue;
      }
      const urls = inferredBaseUrls(db, repository);
      const evidence = { kind: "repository_identity", repo_id: repository.repo_id, repository_name: repository.name, base_url_evidence: urls.length ? "absolute_static_route" : "none" };
      let service = db.prepare("SELECT * FROM local_services WHERE service_key = ?").get(inferredKey);
      if (!service) {
        const inserted = db.prepare(`
          INSERT INTO local_services(service_key, name, source, confidence, base_urls_json, evidence_json, created_at, updated_at)
          VALUES (?, ?, 'inferred', ?, ?, ?, ?, ?)
        `).run(inferredKey, repository.name, urls.length ? 0.7 : 0.5, canonicalJson(urls), canonicalJson(evidence), now, now);
        service = db.prepare("SELECT * FROM local_services WHERE id = ?").get(Number(inserted.lastInsertRowid));
      } else {
        const nextConfidence = urls.length ? 0.7 : 0.5;
        const changed = service.name !== repository.name
          || Number(service.confidence) !== nextConfidence
          || service.base_urls_json !== canonicalJson(urls)
          || service.evidence_json !== canonicalJson(evidence);
        if (changed) {
          db.prepare(`
            UPDATE local_services SET name = ?, confidence = ?, base_urls_json = ?, evidence_json = ?, updated_at = ? WHERE id = ?
          `).run(repository.name, nextConfidence, canonicalJson(urls), canonicalJson(evidence), now, service.id);
          service = db.prepare("SELECT * FROM local_services WHERE id = ?").get(service.id);
        }
      }
      const linkEvidence = { kind: "inferred_repository_provider", repo_id: repository.repo_id };
      const link = db.prepare(`
        SELECT * FROM local_service_repository_links WHERE service_id = ? AND repo_id = ? AND role = 'provider'
      `).get(service.id, repository.id);
      if (!link) {
        db.prepare(`
          INSERT INTO local_service_repository_links(service_id, repo_id, role, source, confidence, evidence_json, created_at, updated_at)
          VALUES (?, ?, 'provider', 'inferred', ?, ?, ?, ?)
        `).run(service.id, repository.id, Number(service.confidence), canonicalJson(linkEvidence), now, now);
      } else {
        const nextEvidence = canonicalJson(linkEvidence);
        if (link.source !== "inferred" || Number(link.confidence) !== Number(service.confidence) || link.evidence_json !== nextEvidence) {
          db.prepare(`
            UPDATE local_service_repository_links
            SET source = 'inferred', confidence = ?, evidence_json = ?, updated_at = ?
            WHERE id = ?
          `).run(Number(service.confidence), nextEvidence, now, link.id);
        }
      }
      results.push({ repo_id: repository.repo_id, inferred: true, service_key: service.service_key, base_urls: urls });
    }
    db.prepare(`
      DELETE FROM local_services
      WHERE source = 'inferred'
        AND NOT EXISTS (
          SELECT 1 FROM local_service_repository_links links WHERE links.service_id = local_services.id
        )
    `).run();
  });
  return {
    ok: true,
    repositories: results.sort((left, right) => compareCodePoints(left.repo_id, right.repo_id)),
    methodology: "A repository receives one inferred provider identity only when it has no configured provider/both link. Refresh upserts stable keys and removes only superseded inferred identities.",
  };
}

function operationKey(protocol, operation) {
  if (protocol === "http") return `${operation.method} ${operation.path}`;
  if (protocol === "graphql") return `${operation.operation_type}:${operation.operation_name}`;
  if (protocol === "grpc") return `${operation.service}/${operation.rpc_method}`;
  if (protocol === "websocket") return operation.channel;
  return `${operation.broker ?? ""}:${operation.topic}`;
}

function normalizeConfiguredOperation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("each operation must be an object");
  const protocol = String(raw.protocol ?? "").toLowerCase();
  if (!PROTOCOLS.has(protocol)) throw new Error(`Unsupported protocol: ${raw.protocol}`);
  const direction = String(raw.direction ?? "").toLowerCase();
  if (!DIRECTIONS.has(direction)) throw new Error("operation direction must be inbound or outbound");
  let operation;
  if (protocol === "http") {
    const path = normalizeApiPath(requiredText(raw.path, "HTTP path", 4_096));
    if (!path) throw new Error("HTTP path could not be normalized");
    const suppliedMethod = raw.method == null ? "ANY" : String(raw.method).toUpperCase();
    const method = normalizeHttpMethod(raw.method, "ANY");
    if (method === "ANY" && suppliedMethod !== "ANY") throw new Error(`Unsupported configured HTTP method: ${raw.method}`);
    const rawPath = requiredText(raw.raw_path ?? raw.rawPath ?? raw.path, "HTTP raw path", 4_096);
    operation = { method, path, raw_path: rawPath };
  } else if (protocol === "graphql") {
    const operationName = requiredText(raw.operationName ?? raw.operation_name, "GraphQL operationName", 500);
    if (!/^[_\p{L}][_\p{L}\p{N}]*$/u.test(operationName)) throw new Error("GraphQL operationName must be a static GraphQL name");
    const operationType = String(raw.operationType ?? raw.operation_type ?? "ANY").toLowerCase();
    const normalizedType = operationType === "any" ? "ANY" : operationType;
    if (!GRAPHQL_TYPES.has(normalizedType)) throw new Error("GraphQL operationType must be query, mutation, subscription, or ANY");
    operation = { operation_name: operationName, operation_type: normalizedType };
  } else if (protocol === "grpc") {
    const service = requiredText(raw.service ?? raw.serviceName ?? raw.service_name, "gRPC service", 500);
    const rpcMethod = requiredText(raw.rpcMethod ?? raw.rpc_method ?? raw.method, "gRPC rpcMethod", 500);
    if (!/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(service) || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(rpcMethod)) {
      throw new Error("gRPC service and method must be static identifiers");
    }
    operation = { service, rpc_method: rpcMethod, signature: `${service}/${rpcMethod}` };
  } else if (protocol === "websocket") {
    operation = { channel: requiredText(raw.channel, "WebSocket channel", 2_048) };
  } else {
    operation = {
      topic: requiredText(raw.topic, "queue topic", 2_048),
      broker: optionalText(raw.broker, "queue broker", 500),
    };
  }
  return { protocol, direction, operation, operation_key: operationKey(protocol, operation) };
}

export function recordServiceOperations(db, {
  repoId,
  serviceKey = null,
  operations,
  evidence = null,
  replace = false,
} = {}) {
  ensureServiceTopologySchema(db);
  const repository = repositoryByPublicId(db, repoId);
  if (!Array.isArray(operations) || !operations.length || operations.length > 5_000) throw new Error("operations must contain between 1 and 5000 rows");
  const service = serviceKey == null ? null : serviceByKey(db, serviceKey);
  const normalized = operations.map((raw) => {
    const value = normalizeConfiguredOperation(raw);
    const operationEvidence = normalizeEvidence(raw.evidence ?? evidence, "operation evidence");
    const confidence = confidenceValue(raw.confidence, 1);
    const filePath = raw.filePath ?? raw.file_path;
    const line = raw.line == null ? null : boundedInteger(raw.line, null, 1, 100_000_000, "operation line");
    const sourceStableKey = optionalText(raw.sourceStableKey ?? raw.source_stable_key, "sourceStableKey", 4_096);
    const identity = {
      service_id: service?.id ?? null,
      protocol: value.protocol,
      direction: value.direction,
      operation_key: value.operation_key,
      file_path: filePath == null ? null : normalizedFilePath(filePath),
      line,
      source_stable_key: sourceStableKey,
    };
    return { ...identity, operation: value.operation, confidence, evidence: operationEvidence, fingerprint: fingerprint(identity) };
  });
  if (service) {
    const roles = new Set(db.prepare(`
      SELECT role FROM local_service_repository_links WHERE service_id = ? AND repo_id = ?
    `).all(service.id, repository.id).map((row) => row.role));
    for (const operation of normalized) {
      const accepted = operation.direction === "inbound"
        ? roles.has("provider") || roles.has("both")
        : roles.has("consumer") || roles.has("both");
      if (!accepted) throw new Error(`Repository ${repository.repo_id} lacks a ${operation.direction === "inbound" ? "provider" : "consumer"} link to service ${service.service_key}`);
    }
  }
  if (new Set(normalized.map((item) => item.fingerprint)).size !== normalized.length) throw new Error("operations contains duplicate identities");
  const now = new Date().toISOString();
  transaction(db, () => {
    if (replace) {
      if (service) db.prepare("DELETE FROM local_service_operations WHERE repo_id = ? AND source = 'configured' AND service_id = ?").run(repository.id, service.id);
      else db.prepare("DELETE FROM local_service_operations WHERE repo_id = ? AND source = 'configured' AND service_id IS NULL").run(repository.id);
    }
    const insert = db.prepare(`
      INSERT INTO local_service_operations(
        repo_id, service_id, protocol, direction, operation_key, operation_json, file_path, line,
        source_stable_key, confidence, source, evidence_json, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?)
      ON CONFLICT(repo_id, fingerprint) DO UPDATE SET
        operation_json = excluded.operation_json,
        confidence = excluded.confidence,
        evidence_json = excluded.evidence_json,
        updated_at = CASE
          WHEN local_service_operations.operation_json <> excluded.operation_json
            OR local_service_operations.confidence <> excluded.confidence
            OR local_service_operations.evidence_json <> excluded.evidence_json
          THEN excluded.updated_at ELSE local_service_operations.updated_at END
    `);
    for (const item of normalized) {
      insert.run(
        repository.id, item.service_id, item.protocol, item.direction, item.operation_key,
        canonicalJson(item.operation), item.file_path, item.line, item.source_stable_key,
        item.confidence, canonicalJson(item.evidence), item.fingerprint, now, now,
      );
    }
  });
  return { ok: true, repo_id: repository.repo_id, service_key: service?.service_key ?? null, recorded: normalized.length, replaced: Boolean(replace) };
}

function publicLink(row) {
  return {
    id: row.id,
    repo_id: row.public_repo_id,
    service_id: row.service_id,
    service_key: row.service_key,
    role: row.role,
    source: row.source,
    confidence: Number(row.confidence),
    evidence: parseJson(row.evidence_json, {}),
  };
}

function loadServiceState(db, repositories) {
  if (!repositories.length) {
    return { services: new Map(), links: [], linksByRepo: new Map(), providerLinksByRepo: new Map(), providerLinksByService: new Map() };
  }
  const repoRowIds = new Set(repositories.map((repository) => repository.id));
  const placeholders = repositories.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT l.*, r.repo_id AS public_repo_id, s.service_key, s.name AS service_name,
      s.source AS service_source, s.confidence AS service_confidence,
      s.base_urls_json, s.evidence_json AS service_evidence_json
    FROM local_service_repository_links l
    JOIN repositories r ON r.id = l.repo_id
    JOIN local_services s ON s.id = l.service_id
    WHERE l.repo_id IN (${placeholders})
    ORDER BY r.repo_id, s.service_key, l.role
  `).all(...repoRowIds);
  const services = new Map();
  const linksByRepo = new Map();
  const providerLinksByRepo = new Map();
  const providerLinksByService = new Map();
  for (const row of rows) {
    services.set(row.service_id, {
      id: row.service_id,
      service_key: row.service_key,
      name: row.service_name,
      source: row.service_source,
      confidence: Number(row.service_confidence),
      base_urls: parseJson(row.base_urls_json, []),
      evidence: parseJson(row.service_evidence_json, {}),
    });
    const link = publicLink(row);
    const repoLinks = linksByRepo.get(row.repo_id) ?? [];
    repoLinks.push(link);
    linksByRepo.set(row.repo_id, repoLinks);
    if (new Set(["provider", "both"]).has(row.role)) {
      const providers = providerLinksByRepo.get(row.repo_id) ?? [];
      providers.push(link);
      providerLinksByRepo.set(row.repo_id, providers);
      const serviceProviders = providerLinksByService.get(row.service_id) ?? [];
      serviceProviders.push(link);
      providerLinksByService.set(row.service_id, serviceProviders);
    }
  }
  return { services, links: rows.map(publicLink), linksByRepo, providerLinksByRepo, providerLinksByService };
}

function configuredOperations(db, repositories) {
  if (!repositories.length) return [];
  const byRowId = new Map(repositories.map((repository) => [repository.id, repository]));
  const placeholders = repositories.map(() => "?").join(",");
  return db.prepare(`
    SELECT o.*, r.repo_id AS public_repo_id, s.service_key
    FROM local_service_operations o
    JOIN repositories r ON r.id = o.repo_id
    LEFT JOIN local_services s ON s.id = o.service_id
    WHERE o.repo_id IN (${placeholders})
    ORDER BY r.repo_id, o.protocol, o.direction, o.operation_key, o.id
  `).all(...byRowId.keys()).map((row) => ({
    id: `configured:${row.id}`,
    repo_row_id: row.repo_id,
    repo_id: row.public_repo_id,
    service_id: row.service_id,
    service_key: row.service_key,
    protocol: row.protocol,
    direction: row.direction,
    operation_key: row.operation_key,
    operation: parseJson(row.operation_json, {}),
    file_path: row.file_path,
    line: row.line,
    source_stable_key: row.source_stable_key,
    confidence: Number(row.confidence),
    evidence: [{ source: "configured", details: parseJson(row.evidence_json, {}) }],
  }));
}

function apiOperations(db, repositories) {
  const values = [];
  let truncated = false;
  for (const repository of repositories) {
    const topology = getApiTopology(db, { repoId: repository.repo_id, limit: 5_000 });
    truncated ||= topology.truncated;
    for (const route of topology.routes) {
      values.push({
        id: `api:inbound:${repository.repo_id}:${route.instance_id ?? route.id}:${route.method}:${route.path}`,
        repo_row_id: repository.id,
        repo_id: repository.repo_id,
        service_id: null,
        service_key: null,
        protocol: "http",
        direction: "inbound",
        operation_key: `${route.method} ${route.path}`,
        operation: { method: route.method, path: route.path, raw_path: route.raw_path },
        file_path: route.file_path,
        line: route.line,
        source_stable_key: route.source?.stable_key ?? null,
        confidence: Number(route.confidence),
        evidence: [{ source: "api_operation", operation_id: route.id, kind: "route", framework: route.framework, handler_name: route.handler_name, composed_path: route.path }],
      });
    }
    for (const client of topology.clients) {
      values.push({
        id: `api:outbound:${repository.repo_id}:${client.id}:${client.method}:${client.path}`,
        repo_row_id: repository.id,
        repo_id: repository.repo_id,
        service_id: null,
        service_key: null,
        protocol: "http",
        direction: "outbound",
        operation_key: `${client.method} ${client.path}`,
        operation: { method: client.method, path: client.path, raw_path: client.raw_path },
        file_path: client.file_path,
        line: client.line,
        source_stable_key: client.source?.stable_key ?? null,
        confidence: Number(client.confidence),
        evidence: [{ source: "api_operation", operation_id: client.id, kind: "client", framework: client.framework, raw_path: client.raw_path }],
      });
    }
  }
  return { operations: values, truncated };
}

function relationshipDirection(row, details) {
  const explicit = String(details.direction ?? "").toLowerCase();
  if (DIRECTIONS.has(explicit)) return explicit;
  const kind = String(row.kind ?? "").toLowerCase();
  if (/(client|call|publish|producer|send|emit)/.test(kind)) return "outbound";
  if (/(server|handler|route|subscribe|consumer|receive|listen)/.test(kind)) return "inbound";
  return null;
}

function relationshipProtocol(row, details) {
  const raw = String(details.protocol ?? row.category ?? "").toLowerCase().replaceAll("-", "_");
  if (raw === "ws" || raw === "web_socket") return "websocket";
  if (raw === "event" || raw === "event_bus" || raw === "messaging") return "queue";
  return PROTOCOLS.has(raw) ? raw : null;
}

function operationFromRelationship(row) {
  const details = parseJson(row.details_json, {});
  if (details.static !== true) return { operation: null, reason: "not_explicitly_static" };
  const protocol = relationshipProtocol(row, details);
  const direction = relationshipDirection(row, details);
  if (!protocol || protocol === "http" || !direction) return { operation: null, reason: "unsupported_or_direction_unknown" };
  try {
    let raw;
    if (protocol === "graphql") {
      raw = {
        protocol,
        direction,
        operationName: details.operationName ?? details.operation_name ?? row.target_name,
        operationType: details.operationType ?? details.operation_type ?? "ANY",
      };
    } else if (protocol === "grpc") {
      let service = details.service ?? details.serviceName ?? details.service_name;
      let rpcMethod = details.rpcMethod ?? details.rpc_method ?? details.method;
      if ((!service || !rpcMethod) && row.target_name) {
        const separator = row.target_name.includes("/") ? "/" : ".";
        const parts = row.target_name.split(separator);
        rpcMethod ??= parts.pop();
        service ??= parts.join(separator);
      }
      raw = { protocol, direction, service, rpcMethod };
    } else if (protocol === "websocket") {
      raw = { protocol, direction, channel: details.channel ?? row.target_name };
    } else {
      raw = { protocol, direction, topic: details.topic ?? row.target_name, broker: details.broker };
    }
    const normalized = normalizeConfiguredOperation(raw);
    return {
      operation: {
        id: `relationship:${row.id}`,
        repo_row_id: row.repo_id,
        repo_id: row.public_repo_id,
        service_id: null,
        service_key: null,
        protocol: normalized.protocol,
        direction: normalized.direction,
        operation_key: normalized.operation_key,
        operation: normalized.operation,
        file_path: row.file_path,
        line: row.start_line,
        source_stable_key: row.source_stable_key,
        confidence: Number(row.confidence),
        evidence: [{
          source: "code_relationship",
          relationship_id: row.id,
          category: row.category,
          kind: row.kind,
          static: true,
          details,
        }],
      },
    };
  } catch (error) {
    return { operation: null, reason: `invalid_static_evidence:${error.message}` };
  }
}

function relationshipOperations(db, repositories, limit) {
  if (!repositories.length) return { operations: [], diagnostics: { scanned: 0, recovered: 0, skipped_not_static: 0, skipped_invalid: 0, truncated: false } };
  const placeholders = repositories.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT cr.*, r.repo_id AS public_repo_id, f.path AS file_path
    FROM code_relationships cr
    JOIN repositories r ON r.id = cr.repo_id
    JOIN files f ON f.id = cr.file_id
    WHERE cr.repo_id IN (${placeholders})
    ORDER BY r.repo_id, cr.id
    LIMIT ?
  `).all(...repositories.map((repository) => repository.id), limit + 1);
  const diagnostics = { scanned: Math.min(rows.length, limit), recovered: 0, skipped_not_static: 0, skipped_invalid: 0, truncated: rows.length > limit };
  const operations = [];
  for (const row of rows.slice(0, limit)) {
    const result = operationFromRelationship(row);
    if (result.operation) {
      operations.push(result.operation);
      diagnostics.recovered += 1;
    } else if (result.reason === "not_explicitly_static") {
      diagnostics.skipped_not_static += 1;
    } else {
      diagnostics.skipped_invalid += 1;
    }
  }
  return { operations, diagnostics };
}

function operationSort(left, right) {
  return compareCodePoints(left.repo_id, right.repo_id)
    || compareCodePoints(left.protocol, right.protocol)
    || compareCodePoints(left.direction, right.direction)
    || compareCodePoints(left.operation_key, right.operation_key)
    || compareCodePoints(left.id, right.id);
}

function rendezvousKey(operation) {
  if (operation.protocol === "http") return `http:${operation.operation.path}`;
  if (operation.protocol === "graphql") return `graphql:${operation.operation.operation_name}`;
  if (operation.protocol === "grpc") return `grpc:${operation.operation.service}/${operation.operation.rpc_method}`;
  if (operation.protocol === "websocket") return `websocket:${operation.operation.channel}`;
  return `queue:${operation.operation.topic}`;
}

function compatibleOperations(outbound, inbound) {
  if (outbound.protocol !== inbound.protocol) return false;
  if (rendezvousKey(outbound) !== rendezvousKey(inbound)) return false;
  if (outbound.protocol === "http") return methodsCompatible(outbound.operation.method, inbound.operation.method);
  if (outbound.protocol === "graphql") {
    return outbound.operation.operation_type === "ANY"
      || inbound.operation.operation_type === "ANY"
      || outbound.operation.operation_type === inbound.operation.operation_type;
  }
  if (outbound.protocol === "queue") {
    return !outbound.operation.broker || !inbound.operation.broker || outbound.operation.broker === inbound.operation.broker;
  }
  return true;
}

function operationSpecificity(outbound, inbound) {
  const methodPenalty = outbound.protocol === "http"
    && (outbound.operation.method === "ANY" || inbound.operation.method === "ANY") ? 0.85 : 1;
  const graphqlTypePenalty = outbound.protocol === "graphql"
    && (outbound.operation.operation_type === "ANY" || inbound.operation.operation_type === "ANY") ? 0.85 : 1;
  const brokerPenalty = outbound.protocol === "queue"
    && (!outbound.operation.broker || !inbound.operation.broker) ? 0.85 : 1;
  return {
    methodPenalty,
    graphqlTypePenalty,
    brokerPenalty,
    combined: methodPenalty * graphqlTypePenalty * brokerPenalty,
  };
}

function relativePathsForServiceUrl(url, services) {
  const relativePaths = [];
  const matchedBaseUrls = [];
  for (const service of services) {
    for (const baseUrl of service?.base_urls ?? []) {
      if (!urlMatchesBase(url, baseUrl)) continue;
      matchedBaseUrls.push(baseUrl);
      const base = new URL(baseUrl);
      const prefix = base.pathname.replace(/\/+$/, "");
      const relative = prefix && prefix !== "/" ? url.pathname.slice(prefix.length) || "/" : url.pathname;
      const normalized = normalizeApiPath(relative);
      if (normalized) relativePaths.push(normalized);
    }
  }
  return {
    relativePaths: [...new Set(relativePaths)].sort(compareCodePoints),
    matchedBaseUrls: [...new Set(matchedBaseUrls)].sort(compareCodePoints),
  };
}

function serviceConstraint(outbound, state) {
  if (outbound.service_id != null) {
    const service = state.services.get(outbound.service_id) ?? null;
    const url = outbound.protocol === "http" ? absoluteUrl(outbound.operation.raw_path) : null;
    const mapped = url && service ? relativePathsForServiceUrl(url, [service]) : { relativePaths: [], matchedBaseUrls: [] };
    return {
      serviceIds: new Set([outbound.service_id]),
      kind: "configured_operation_service",
      confidence: 1,
      evidence: {
        service_key: outbound.service_key,
        ...(url ? {
          absolute_url: `${url.origin}${url.pathname}`,
          matched_base_urls: mapped.matchedBaseUrls,
          relative_paths: mapped.relativePaths,
        } : {}),
      },
      relativePaths: mapped.relativePaths,
    };
  }
  if (outbound.protocol !== "http") return { serviceIds: null, kind: "none", confidence: null, evidence: null, relativePaths: [] };
  const url = absoluteUrl(outbound.operation.raw_path);
  if (!url) return { serviceIds: null, kind: "relative_path", confidence: null, evidence: null, relativePaths: [] };
  const matching = [...state.services.values()].filter((service) => service.base_urls.some((baseUrl) => urlMatchesBase(url, baseUrl)));
  if (!matching.length) {
    return { serviceIds: new Set(), kind: "absolute_base_unmapped", confidence: 0, evidence: { origin: url.origin, pathname: url.pathname }, relativePaths: [] };
  }
  const mapped = relativePathsForServiceUrl(url, matching);
  return {
    serviceIds: new Set(matching.map((service) => service.id)),
    kind: "configured_or_inferred_base_url",
    confidence: Math.min(...matching.map((service) => service.source === "configured" ? 0.98 : 0.75)),
    evidence: {
      url: `${url.origin}${url.pathname}`,
      matching_services: matching.map((service) => service.service_key).sort(compareCodePoints),
      matched_base_urls: mapped.matchedBaseUrls,
      relative_paths: mapped.relativePaths,
    },
    relativePaths: mapped.relativePaths,
  };
}

function targetServiceForCandidate(inbound, constraint, state) {
  const providers = state.providerLinksByRepo.get(inbound.repo_row_id) ?? [];
  if (inbound.service_id != null) {
    if (constraint.serviceIds && !constraint.serviceIds.has(inbound.service_id)) return { accepted: false };
    const service = state.services.get(inbound.service_id);
    return { accepted: true, service: service ?? null, providerLinks: providers.filter((link) => link.service_id === inbound.service_id) };
  }
  const acceptedProviders = constraint.serviceIds == null ? providers : providers.filter((link) => constraint.serviceIds.has(link.service_id));
  if (constraint.serviceIds && !acceptedProviders.length) return { accepted: false };
  const service = acceptedProviders.length === 1 ? state.services.get(acceptedProviders[0].service_id) ?? null : null;
  return { accepted: true, service, providerLinks: acceptedProviders };
}

function publicOperation(operation) {
  return {
    id: operation.id,
    repo_id: operation.repo_id,
    service_key: operation.service_key,
    protocol: operation.protocol,
    direction: operation.direction,
    operation_key: operation.operation_key,
    operation: operation.operation,
    file_path: operation.file_path,
    line: operation.line,
    source_stable_key: operation.source_stable_key,
    confidence: operation.confidence,
    evidence: operation.evidence,
  };
}

function resolutionEvidence(caller, constraint, candidateKeys) {
  return {
    identity_kind: constraint.kind,
    identity: constraint.evidence,
    attempted_rendezvous_keys: [...candidateKeys].sort(compareCodePoints),
    operation: {
      protocol: caller.protocol,
      ...(caller.protocol === "http" ? { method: caller.operation.method, path: caller.operation.path } : {}),
    },
  };
}

export function listServiceIdentities(db, { repoIds = null, includeUnlinked = false, limit = 1_000 } = {}) {
  ensureServiceTopologySchema(db);
  if (includeUnlinked && repoIds != null) {
    throw new Error("includeUnlinked may only be used when repoIds is omitted to avoid leaking unrelated service identities");
  }
  const repositories = resolveRepositories(db, repoIds);
  const state = loadServiceState(db, repositories);
  let services = [...state.services.values()];
  if (includeUnlinked) {
    for (const row of db.prepare("SELECT * FROM local_services ORDER BY service_key").all()) {
      if (!state.services.has(row.id)) services.push(publicService(row));
    }
  }
  services.sort((left, right) => compareCodePoints(left.service_key, right.service_key));
  const capped = boundedInteger(limit, 1_000, 1, 5_000, "limit");
  return {
    repositories: repositories.map(publicRepository),
    services: services.slice(0, capped),
    links: state.links.slice(0, capped),
    truncated: services.length > capped || state.links.length > capped,
    counts: { services: services.length, links: state.links.length },
  };
}

export function getCrossRepositoryTopology(db, {
  repoIds = null,
  protocol = null,
  minConfidence = 0,
  limit = DEFAULT_LIMIT,
  relationshipLimit = DEFAULT_RELATIONSHIP_LIMIT,
  maxCandidatesPerOperation = DEFAULT_MAX_CANDIDATES,
  maxOperations = 20_000,
  refreshIdentities = true,
} = {}) {
  ensureServiceTopologySchema(db);
  const repositories = resolveRepositories(db, repoIds);
  if (repositories.length > 100) throw new Error("At most 100 repositories can be analyzed at once");
  const normalizedProtocol = protocol == null ? null : String(protocol).toLowerCase();
  if (normalizedProtocol != null && !PROTOCOLS.has(normalizedProtocol)) throw new Error(`Unsupported protocol: ${protocol}`);
  const threshold = confidenceValue(minConfidence, 0);
  const resultLimit = boundedInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
  const relationshipCap = boundedInteger(relationshipLimit, DEFAULT_RELATIONSHIP_LIMIT, 1, MAX_RELATIONSHIP_LIMIT, "relationshipLimit");
  const candidateCap = boundedInteger(maxCandidatesPerOperation, DEFAULT_MAX_CANDIDATES, 1, MAX_CANDIDATES, "maxCandidatesPerOperation");
  const operationCap = boundedInteger(maxOperations, 20_000, 1, 50_000, "maxOperations");
  if (refreshIdentities) refreshServiceIdentities(db, { repoIds: repositories.map((repository) => repository.repo_id) });
  const state = loadServiceState(db, repositories);
  const api = apiOperations(db, repositories);
  const relationships = relationshipOperations(db, repositories, relationshipCap);
  let operations = [...api.operations, ...configuredOperations(db, repositories), ...relationships.operations]
    .filter((operation) => normalizedProtocol == null || operation.protocol === normalizedProtocol)
    .sort(operationSort);
  const operationInputTruncated = operations.length > operationCap;
  operations = operations.slice(0, operationCap);
  const inbound = operations.filter((operation) => operation.direction === "inbound");
  const outbound = operations.filter((operation) => operation.direction === "outbound");
  const inboundByKey = new Map();
  for (const operation of inbound) {
    const key = rendezvousKey(operation);
    const values = inboundByKey.get(key) ?? [];
    values.push(operation);
    inboundByKey.set(key, values);
  }
  const matches = [];
  const unresolved = [];
  const ambiguousMatches = [];
  const matchedInbound = new Set();
  let truncated = api.truncated || relationships.diagnostics.truncated || operationInputTruncated;
  for (const caller of outbound) {
    if (matches.length >= resultLimit) {
      truncated = true;
      break;
    }
    const constraint = serviceConstraint(caller, state);
    const candidateKeys = new Set([rendezvousKey(caller)]);
    if (caller.protocol === "http") {
      for (const relativePath of constraint.relativePaths ?? []) candidateKeys.add(`http:${relativePath}`);
    }
    if (constraint.serviceIds?.size === 0) {
      unresolved.push({
        caller: publicOperation(caller),
        reason: constraint.kind,
        evidence: resolutionEvidence(caller, constraint, candidateKeys),
        candidate_count: 0,
        candidates_truncated: false,
        candidates: [],
      });
      continue;
    }
    const rawCandidates = [...candidateKeys]
      .flatMap((key) => inboundByKey.get(key) ?? [])
      .filter((target, index, values) => values.findIndex((candidate) => candidate.id === target.id) === index)
      .filter((target) => target.repo_row_id !== caller.repo_row_id && compatibleOperations({
        ...caller,
        operation: caller.protocol === "http" && candidateKeys.has(`http:${target.operation.path}`)
          ? { ...caller.operation, path: target.operation.path }
          : caller.operation,
      }, target));
    const accepted = [];
    for (const target of rawCandidates) {
      const targetService = targetServiceForCandidate(target, constraint, state);
      if (targetService.accepted) accepted.push({ target, ...targetService });
    }
    if (!accepted.length) {
      unresolved.push({
        caller: publicOperation(caller),
        reason: rawCandidates.length ? "service_identity_mismatch" : "no_static_target",
        evidence: resolutionEvidence(caller, constraint, candidateKeys),
        candidate_count: rawCandidates.length,
        candidates_truncated: rawCandidates.length > candidateCap,
        candidates: rawCandidates.slice(0, candidateCap).map(publicOperation),
      });
      continue;
    }
    const overflow = accepted.length > candidateCap;
    const boundedCandidates = accepted.slice(0, candidateCap);
    const ambiguous = accepted.length > 1;
    const group = [];
    for (const candidate of boundedCandidates) {
      if (matches.length >= resultLimit) {
        truncated = true;
        break;
      }
      const staticConfidence = Math.min(caller.confidence, candidate.target.confidence);
      const identityConfidence = constraint.confidence ?? (ambiguous ? 0.55 : 0.75);
      const specificity = operationSpecificity(caller, candidate.target);
      const confidence = Math.min(staticConfidence, identityConfidence) * specificity.combined;
      if (confidence < threshold) continue;
      const match = {
        status: ambiguous ? "ambiguous" : "resolved",
        protocol: caller.protocol,
        operation_key: caller.operation_key,
        confidence,
        confidence_evidence: {
          caller_static: caller.confidence,
          target_static: candidate.target.confidence,
          identity: identityConfidence,
          identity_kind: constraint.kind,
          method_penalty: specificity.methodPenalty,
          graphql_type_penalty: specificity.graphqlTypePenalty,
          broker_penalty: specificity.brokerPenalty,
          specificity_penalty: specificity.combined,
        },
        source_repo_id: caller.repo_id,
        target_repo_id: candidate.target.repo_id,
        target_service: candidate.service ? { service_key: candidate.service.service_key, name: candidate.service.name } : null,
        candidate_services: candidate.providerLinks.map((link) => link.service_key).sort(compareCodePoints),
        caller: publicOperation(caller),
        target: publicOperation(candidate.target),
        evidence: [...caller.evidence, ...candidate.target.evidence, ...(constraint.evidence ? [{ source: "service_identity", kind: constraint.kind, details: constraint.evidence }] : [])],
      };
      matches.push(match);
      group.push(match);
      matchedInbound.add(candidate.target.id);
    }
    if (!group.length && matches.length < resultLimit) {
      unresolved.push({
        caller: publicOperation(caller),
        reason: "below_confidence_threshold",
        evidence: { ...resolutionEvidence(caller, constraint, candidateKeys), minimum_confidence: threshold },
        candidate_count: accepted.length,
        candidates_truncated: accepted.length > candidateCap,
        candidates: boundedCandidates.map((candidate) => publicOperation(candidate.target)),
      });
      continue;
    }
    if (ambiguous && group.length) {
      ambiguousMatches.push({
        caller: publicOperation(caller),
        candidate_count: accepted.length,
        candidates_truncated: overflow || group.length < boundedCandidates.length,
        candidates: group,
      });
    }
    if (overflow) truncated = true;
  }
  const unmatchedInboundAll = inbound.filter((operation) => !matchedInbound.has(operation.id)).map(publicOperation);
  const unmatchedInbound = unmatchedInboundAll.slice(0, resultLimit);
  unresolved.sort((left, right) => compareCodePoints(left.caller.repo_id, right.caller.repo_id) || compareCodePoints(left.caller.id, right.caller.id));
  const allServices = [...state.services.values()].sort((left, right) => compareCodePoints(left.service_key, right.service_key));
  const allLinks = state.links;
  const identityOutputTruncated = allServices.length > resultLimit || allLinks.length > resultLimit;
  truncated ||= identityOutputTruncated || unresolved.length > resultLimit || unmatchedInboundAll.length > resultLimit;
  return {
    repositories: repositories.map(publicRepository),
    services: allServices.slice(0, resultLimit),
    repository_service_links: allLinks.slice(0, resultLimit),
    counts: {
      operations: operations.length,
      inbound: inbound.length,
      outbound: outbound.length,
      matches: matches.length,
      resolved: matches.filter((match) => match.status === "resolved").length,
      ambiguous_callers: ambiguousMatches.length,
      unresolved: unresolved.length,
      unmatched_inbound: unmatchedInboundAll.length,
      services: allServices.length,
      repository_service_links: allLinks.length,
    },
    matches,
    ambiguous_matches: ambiguousMatches,
    unresolved: unresolved.slice(0, resultLimit),
    unmatched_inbound: unmatchedInbound,
    diagnostics: {
      relationship_evidence: relationships.diagnostics,
      api_operations_truncated: api.truncated,
      operation_input_truncated: operationInputTruncated,
      identity_output_truncated: identityOutputTruncated,
    },
    truncated,
    methodology: "Static rendezvous only: exact normalized HTTP paths, gRPC service/methods, WebSocket channels, and queue topics. HTTP ANY methods, GraphQL ANY types, and omitted queue brokers are explicit wildcards with a confidence penalty; specified values must match exactly. Absolute HTTP URLs require a mapped service base URL. Results are static evidence, not observed runtime traffic.",
  };
}

export function getServiceDiagram(db, options = {}) {
  const topology = getCrossRepositoryTopology(db, options);
  const serviceNodes = new Map(topology.services.map((service) => [service.service_key, {
    id: `service:${service.service_key}`,
    kind: "service",
    label: service.name,
    service_key: service.service_key,
    source: service.source,
    confidence: service.confidence,
  }]));
  for (const link of topology.repository_service_links) {
    if (!serviceNodes.has(link.service_key)) {
      serviceNodes.set(link.service_key, { id: `service:${link.service_key}`, kind: "service", label: link.service_key, service_key: link.service_key });
    }
  }
  for (const match of topology.matches) {
    const service = match.target_service;
    if (service && !serviceNodes.has(service.service_key)) {
      serviceNodes.set(service.service_key, { id: `service:${service.service_key}`, kind: "service", label: service.name, service_key: service.service_key });
    }
  }
  const nodes = [
    ...topology.repositories.map((repository) => ({ id: `repo:${repository.repo_id}`, kind: "repository", label: repository.name, repo_id: repository.repo_id })),
    ...serviceNodes.values(),
  ].sort((left, right) => compareCodePoints(left.id, right.id));
  const edgeMap = new Map();
  for (const link of topology.repository_service_links) {
    const key = `identity|${link.repo_id}|${link.service_key}|${link.role}`;
    edgeMap.set(key, {
      kind: "repository_service",
      source: `repo:${link.repo_id}`,
      target: `service:${link.service_key}`,
      role: link.role,
      status: link.source,
      operations: 0,
      minimum_confidence: link.confidence,
      examples: [],
      evidence: link.evidence,
    });
  }
  for (const match of topology.matches) {
    const targetId = match.target_service ? `service:${match.target_service.service_key}` : `repo:${match.target_repo_id}`;
    const key = `${match.source_repo_id}|${targetId}|${match.protocol}|${match.status}`;
    const edge = edgeMap.get(key) ?? {
      kind: "call",
      source: `repo:${match.source_repo_id}`,
      target: targetId,
      protocol: match.protocol,
      status: match.status,
      operations: 0,
      minimum_confidence: 1,
      examples: [],
    };
    edge.operations += 1;
    edge.minimum_confidence = Math.min(edge.minimum_confidence, match.confidence);
    if (edge.examples.length < 5) edge.examples.push(match.operation_key);
    edgeMap.set(key, edge);
  }
  const edges = [...edgeMap.values()].sort((left, right) => compareCodePoints(`${left.kind}|${left.source}|${left.target}|${left.protocol ?? left.role}|${left.status}`, `${right.kind}|${right.source}|${right.target}|${right.protocol ?? right.role}|${right.status}`));
  return {
    nodes,
    edges,
    unresolved: topology.unresolved,
    ambiguous_matches: topology.ambiguous_matches,
    counts: { nodes: nodes.length, edges: edges.length, ...topology.counts },
    truncated: topology.truncated,
    methodology: topology.methodology,
  };
}

export function getServiceCallers(db, {
  repoId = null,
  serviceKey = null,
  direction = "both",
  protocol = null,
  minConfidence = 0,
  limit = 500,
} = {}) {
  ensureServiceTopologySchema(db);
  if (repoId == null && serviceKey == null) throw new Error("repoId or serviceKey is required");
  const normalizedDirection = String(direction).toLowerCase();
  if (!new Set(["inbound", "outbound", "both"]).has(normalizedDirection)) throw new Error("direction must be inbound, outbound, or both");
  const focalRepository = repoId == null ? null : repositoryByPublicId(db, repoId);
  const focalService = serviceKey == null ? null : serviceByKey(db, serviceKey);
  const capped = boundedInteger(limit, 500, 1, 2_000, "limit");
  const topology = getCrossRepositoryTopology(db, { protocol, minConfidence, limit: Math.min(MAX_LIMIT, capped * 5) });
  const targetsFocalService = (match) => focalService == null
    || match.target_service?.service_key === focalService.service_key
    || match.caller.service_key === focalService.service_key
    || match.target.service_key === focalService.service_key
    || match.candidate_services.includes(focalService.service_key);
  const unresolvedTargetsFocalService = (item) => {
    if (focalService == null) return true;
    const identity = item.evidence?.identity ?? {};
    return item.caller.service_key === focalService.service_key
      || identity.service_key === focalService.service_key
      || identity.matching_services?.includes(focalService.service_key);
  };
  const inbound = normalizedDirection === "outbound" ? [] : topology.matches.filter((match) =>
    (focalRepository == null || match.target_repo_id === focalRepository.repo_id)
    && targetsFocalService(match),
  );
  const outbound = normalizedDirection === "inbound" ? [] : topology.matches.filter((match) =>
    (focalRepository == null || match.source_repo_id === focalRepository.repo_id)
    && targetsFocalService(match),
  );
  const unresolvedOutbound = normalizedDirection === "inbound" ? [] : topology.unresolved.filter((item) =>
    (focalRepository == null || item.caller.repo_id === focalRepository.repo_id)
    && unresolvedTargetsFocalService(item),
  );
  return {
    focal: { repo_id: focalRepository?.repo_id ?? null, service_key: focalService?.service_key ?? null },
    inbound: inbound.slice(0, capped),
    outbound: outbound.slice(0, capped),
    unresolved_outbound: unresolvedOutbound.slice(0, capped),
    counts: { inbound: inbound.length, outbound: outbound.length, unresolved_outbound: unresolvedOutbound.length },
    truncated: inbound.length > capped || outbound.length > capped || unresolvedOutbound.length > capped || topology.truncated,
    methodology: topology.methodology,
  };
}
