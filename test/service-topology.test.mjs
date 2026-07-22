import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import {
  ensureServiceTopologySchema,
  getCrossRepositoryTopology,
  getServiceCallers,
  getServiceDiagram,
  linkRepositoryService,
  listServiceIdentities,
  recordServiceOperations,
  refreshServiceIdentities,
  unlinkRepositoryService,
  upsertServiceIdentity,
} from "../src/service-topology.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "service-topology");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-service-topology-test-"));
  const db = openDatabase(path.join(root, "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const repositories = [
    ["server-a", "users-server-a"],
    ["server-b", "users-server-b"],
    ["client", "users-client"],
    ["ambiguous-client", "ambiguous-client"],
  ];
  for (const [directory, repoId] of repositories) {
    await indexDirectory(db, path.join(fixtureRoot, directory), { repoId });
  }
  ensureServiceTopologySchema(db);
  return { db };
}

function configureUsersService(db) {
  const created = upsertServiceIdentity(db, {
    serviceKey: "users",
    name: "Users Service",
    baseUrls: ["http://users.local/"],
    evidence: { kind: "configured_service", source: "local test configuration" },
  });
  assert.equal(created.service.service_key, "users");
  linkRepositoryService(db, {
    repoId: "users-server-a",
    serviceKey: "users",
    role: "provider",
    evidence: { kind: "configured_provider", source: "local test configuration" },
  });
  linkRepositoryService(db, {
    repoId: "users-client",
    serviceKey: "users",
    role: "consumer",
    evidence: { kind: "configured_consumer", source: "local test configuration" },
  });
}

test("refreshes configured and inferred service identities idempotently and unlinks deterministically", async (t) => {
  const { db } = await workspace(t);
  configureUsersService(db);
  const first = refreshServiceIdentities(db);
  const second = refreshServiceIdentities(db);
  assert.deepEqual(second, first);
  const identities = listServiceIdentities(db, {});
  assert.ok(identities.services.some((service) => service.service_key === "users" && service.source === "configured"));
  assert.ok(identities.services.some((service) => service.service_key.startsWith("repo:users-server-b:") && service.source === "inferred"));
  assert.equal(identities.links.filter((link) => link.repo_id === "users-server-a" && link.role === "provider").length, 1);

  const merged = linkRepositoryService(db, {
    repoId: "users-client",
    serviceKey: "users",
    role: "provider",
    evidence: { kind: "configured_provider", source: "canonical-role test" },
  });
  assert.equal(merged.role, "both");
  const canonicalLinks = listServiceIdentities(db, {}).links.filter((link) => link.repo_id === "users-client" && link.service_key === "users");
  assert.equal(canonicalLinks.length, 1);
  assert.equal(canonicalLinks[0].role, "both");
  assert.deepEqual(Object.keys(canonicalLinks[0].evidence.role_evidence), ["consumer", "provider"]);

  const downgraded = unlinkRepositoryService(db, { repoId: "users-client", serviceKey: "users", role: "provider" });
  assert.equal(downgraded.deleted, 1);
  assert.equal(listServiceIdentities(db, {}).links.find((link) => link.repo_id === "users-client" && link.service_key === "users").role, "consumer");
  const removed = unlinkRepositoryService(db, { repoId: "users-client", serviceKey: "users", role: "consumer" });
  const repeated = unlinkRepositoryService(db, { repoId: "users-client", serviceKey: "users", role: "consumer" });
  assert.equal(removed.deleted, 1);
  assert.equal(repeated.deleted, 0);
  const refreshed = refreshServiceIdentities(db, { repoIds: ["users-client"] });
  assert.equal(refreshed.repositories[0].inferred, true);

  const orphan = db.prepare("SELECT id FROM local_services WHERE service_key LIKE 'repo:users-server-b:%'").get();
  db.prepare("DELETE FROM local_service_repository_links WHERE service_id = ?").run(orphan.id);
  refreshServiceIdentities(db, { repoIds: ["users-server-a"] });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_services WHERE id = ?").get(orphan.id).count, 0);
});

test("matches HTTP clients across repositories with base URL evidence and reports ambiguity honestly", async (t) => {
  const { db } = await workspace(t);
  configureUsersService(db);
  const topology = getCrossRepositoryTopology(db, { protocol: "http", limit: 100 });
  const absolute = topology.matches.find((match) => match.caller.file_path === "src/client.js"
    && match.caller.operation.raw_path.includes("users.local/users"));
  assert.ok(absolute);
  assert.equal(absolute.status, "resolved");
  assert.equal(absolute.source_repo_id, "users-client");
  assert.equal(absolute.target_repo_id, "users-server-a");
  assert.equal(absolute.target_service.service_key, "users");
  assert.equal(absolute.confidence_evidence.identity_kind, "configured_or_inferred_base_url");
  assert.ok(absolute.evidence.some((item) => item.source === "service_identity"));
  assert.ok(topology.unresolved.some((item) => item.caller.operation.path === "/missing/{}" && item.reason === "no_static_target"));

  const ambiguous = topology.ambiguous_matches.find((group) => group.caller.repo_id === "ambiguous-client");
  assert.ok(ambiguous);
  assert.equal(ambiguous.candidate_count, 2);
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.target_repo_id).sort(), ["users-server-a", "users-server-b"]);

  const isolated = getCrossRepositoryTopology(db, {
    repoIds: ["users-client", "users-server-a"],
    protocol: "http",
    limit: 100,
  });
  assert.ok(isolated.matches.every((match) => new Set(["users-client", "users-server-a"]).has(match.source_repo_id)
    && new Set(["users-client", "users-server-a"]).has(match.target_repo_id)));
  assert.equal(isolated.repositories.length, 2);
});

test("rendezvous GraphQL, gRPC, WebSocket, and queue operations only from explicit evidence", async (t) => {
  const { db } = await workspace(t);
  configureUsersService(db);
  const inbound = [
    { protocol: "graphql", direction: "inbound", operationName: "GetUser", operationType: "query", filePath: "src/server.js", line: 3 },
    { protocol: "grpc", direction: "inbound", service: "users.v1.Users", rpcMethod: "GetUser", filePath: "src/server.js", line: 3 },
    { protocol: "websocket", direction: "inbound", channel: "users/updates", filePath: "src/server.js", line: 3 },
    { protocol: "queue", direction: "inbound", topic: "user.created", broker: "events", filePath: "src/server.js", line: 3 },
  ].map((operation) => ({ ...operation, evidence: { kind: "configured_static_contract", source: `${operation.protocol} schema` } }));
  const outbound = inbound.map((operation) => {
    const result = {
      ...operation,
      direction: "outbound",
      filePath: "src/client.js",
      evidence: { kind: "configured_static_client", source: `${operation.protocol} client declaration` },
    };
    if (operation.protocol === "queue") delete result.broker;
    return result;
  });
  recordServiceOperations(db, { repoId: "users-server-a", serviceKey: "users", operations: inbound });
  recordServiceOperations(db, { repoId: "users-client", serviceKey: "users", operations: outbound });

  const topology = getCrossRepositoryTopology(db, { limit: 100 });
  for (const protocol of ["graphql", "grpc", "websocket", "queue"]) {
    const match = topology.matches.find((item) => item.protocol === protocol);
    assert.ok(match, `missing ${protocol} match`);
    assert.equal(match.status, "resolved");
    assert.equal(match.target_service.service_key, "users");
    assert.ok(match.evidence.every((item) => item.source === "configured" || item.source === "service_identity"));
  }
  const queue = topology.matches.find((item) => item.protocol === "queue");
  assert.equal(queue.confidence_evidence.broker_penalty, 0.85);
  assert.equal(queue.confidence, 0.85);
  assert.match(topology.methodology, /omitted queue brokers are explicit wildcards/);
  assert.match(topology.methodology, /not observed runtime traffic/);

  recordServiceOperations(db, {
    repoId: "users-client", serviceKey: "users",
    operations: [
      {
        protocol: "queue", direction: "outbound", topic: "user.created", broker: "other-events",
        evidence: { kind: "configured_static_client", source: "broker mismatch" },
      },
      {
        protocol: "graphql", direction: "outbound", operationName: "GetUser", operationType: "ANY",
        evidence: { kind: "configured_static_client", source: "GraphQL wildcard" },
      },
    ],
  });
  const wildcardTopology = getCrossRepositoryTopology(db, { limit: 100 });
  assert.equal(wildcardTopology.matches.some((match) => match.protocol === "queue"
    && match.caller.operation.broker === "other-events"), false);
  assert.ok(wildcardTopology.unresolved.some((item) => item.caller.protocol === "queue"
    && item.caller.operation.broker === "other-events" && item.reason === "no_static_target"));
  const graphqlWildcard = wildcardTopology.matches.find((match) => match.protocol === "graphql"
    && match.caller.operation.operation_type === "ANY");
  assert.ok(graphqlWildcard);
  assert.equal(graphqlWildcard.confidence_evidence.graphql_type_penalty, 0.85);
  const diagram = getServiceDiagram(db, { limit: 100 });
  assert.ok(diagram.nodes.some((node) => node.id === "service:users"));
  assert.ok(diagram.edges.some((edge) => edge.kind === "repository_service" && edge.role === "provider"));
  assert.ok(diagram.edges.some((edge) => edge.kind === "call" && edge.protocol === "grpc"));

  const callers = getServiceCallers(db, { repoId: "users-server-a", direction: "inbound", limit: 100 });
  assert.ok(callers.inbound.some((call) => call.protocol === "graphql"));
  assert.equal(callers.outbound.length, 0);
});

test("recovers non-HTTP protocols only from relationships explicitly marked static", async (t) => {
  const { db } = await workspace(t);
  const serverRepo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'users-server-a'").get();
  const clientRepo = db.prepare("SELECT id FROM repositories WHERE repo_id = 'users-client'").get();
  const serverFile = db.prepare("SELECT id FROM files WHERE repo_id = ? AND path = 'src/server.js'").get(serverRepo.id);
  const clientFile = db.prepare("SELECT id FROM files WHERE repo_id = ? AND path = 'src/client.js'").get(clientRepo.id);
  const insert = db.prepare(`
    INSERT INTO code_relationships(
      repo_id, file_id, category, kind, source_stable_key, source_name, target_name,
      specifier, start_line, end_line, confidence, details_json
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
  `);
  insert.run(serverRepo.id, serverFile.id, "graphql", "handler", "schema", "ListUsers", 7, 7, 0.9,
    JSON.stringify({ protocol: "graphql", static: true, direction: "inbound", operationName: "ListUsers", operationType: "query" }));
  insert.run(clientRepo.id, clientFile.id, "graphql", "call", "client", "ListUsers", 4, 4, 0.85,
    JSON.stringify({ protocol: "graphql", static: true, direction: "outbound", operationName: "ListUsers", operationType: "query" }));
  insert.run(clientRepo.id, clientFile.id, "queue", "publish", "client", "dynamic.topic", 5, 5, 1,
    JSON.stringify({ protocol: "queue", static: false, direction: "outbound", topic: "dynamic.topic" }));

  const topology = getCrossRepositoryTopology(db, { repoIds: ["users-server-a", "users-client"], limit: 100 });
  const graphql = topology.matches.find((match) => match.operation_key === "query:ListUsers");
  assert.ok(graphql);
  assert.equal(graphql.confidence, 0.75);
  assert.ok(graphql.evidence.every((item) => item.source === "code_relationship"));
  assert.equal(topology.matches.some((match) => match.operation_key.includes("dynamic.topic")), false);
  assert.ok(topology.diagnostics.relationship_evidence.skipped_not_static >= 1);

  const filtered = getCrossRepositoryTopology(db, {
    repoIds: ["users-server-a", "users-client"],
    minConfidence: 0.8,
    limit: 100,
  });
  assert.equal(filtered.matches.some((match) => match.operation_key === "query:ListUsers"), false);
  assert.ok(filtered.unresolved.some((item) => item.caller.operation_key === "query:ListUsers"
    && item.reason === "below_confidence_threshold"));
});

test("validates configured identities, operation roles, and result bounds", async (t) => {
  const { db } = await workspace(t);
  assert.throws(() => upsertServiceIdentity(db, {
    serviceKey: "unsafe",
    name: "Unsafe",
    baseUrls: ["https://token@example.com/api"],
    evidence: { kind: "test" },
  }), /credentials/);
  configureUsersService(db);
  assert.throws(() => recordServiceOperations(db, {
    repoId: "users-client",
    serviceKey: "users",
    operations: [{ protocol: "grpc", direction: "inbound", service: "Users", rpcMethod: "Get", evidence: { kind: "wrong role" } }],
  }), /lacks a provider link/);
  assert.throws(() => getCrossRepositoryTopology(db, { limit: 5_001 }), /limit/);
  assert.throws(() => listServiceIdentities(db, { repoIds: ["users-client"], includeUnlinked: true }), /unrelated service identities/);
  const bounded = getCrossRepositoryTopology(db, { limit: 1 });
  assert.ok(bounded.matches.length <= 1);
  assert.equal(bounded.truncated, true);
});

test("keeps schema setup idempotent, isolates repositories, and rejects hostile configured inputs", async (t) => {
  const { db } = await workspace(t);
  assert.deepEqual(ensureServiceTopologySchema(db), ensureServiceTopologySchema(db));
  configureUsersService(db);
  for (const serviceKey of ["audit", "billing"]) {
    upsertServiceIdentity(db, {
      serviceKey,
      name: `${serviceKey} service`,
      evidence: { kind: "configured_service", service: serviceKey },
    });
    linkRepositoryService(db, {
      repoId: "users-client",
      serviceKey,
      role: "consumer",
      evidence: { kind: "configured_consumer", service: serviceKey },
    });
  }

  const isolated = listServiceIdentities(db, { repoIds: ["users-server-a"], limit: 100 });
  assert.deepEqual(isolated.services.map((service) => service.service_key), ["users"]);
  assert.ok(isolated.links.every((link) => link.repo_id === "users-server-a"));
  assert.throws(() => listServiceIdentities(db, { repoIds: ["users-client' OR 1=1 --"] }), /Unknown repo_id/);

  const capped = listServiceIdentities(db, { repoIds: ["users-client"], limit: 1 });
  assert.equal(capped.services.length, 1);
  assert.equal(capped.links.length, 1);
  assert.ok(capped.counts.services > capped.services.length);
  assert.ok(capped.counts.links > capped.links.length);
  assert.equal(capped.truncated, true);

  const baseOperation = {
    protocol: "http",
    direction: "outbound",
    path: "/safe",
    method: "GET",
    evidence: { kind: "configured_static_client" },
  };
  assert.throws(() => recordServiceOperations(db, {
    repoId: "users-client", serviceKey: "users",
    operations: [{ ...baseOperation, method: "TRACE" }],
  }), /Unsupported configured HTTP method/);
  for (const filePath of ["/absolute.js", "C:\\absolute.js", "../escape.js", "\\\\server\\share.js"]) {
    assert.throws(() => recordServiceOperations(db, {
      repoId: "users-client", serviceKey: "users",
      operations: [{ ...baseOperation, filePath }],
    }), /repository-relative filePath/);
  }
  assert.throws(() => unlinkRepositoryService(db, {
    repoId: "users-client", serviceKey: "does-not-exist", role: "administrator",
  }), /role must be/);
  const cyclicEvidence = { kind: "cyclic" };
  cyclicEvidence.self = cyclicEvidence;
  assert.throws(() => upsertServiceIdentity(db, {
    serviceKey: "cyclic", name: "Cyclic", evidence: cyclicEvidence,
  }), /acyclic JSON/);
  assert.throws(() => upsertServiceIdentity(db, {
    serviceKey: "oversized", name: "Oversized", evidence: { kind: "oversized", body: "x".repeat(70_000) },
  }), /at most 65536 bytes/);
});

test("unlinking and replacement remove only operations owned by the affected scope", async (t) => {
  const { db } = await workspace(t);
  configureUsersService(db);
  recordServiceOperations(db, {
    repoId: "users-server-a", serviceKey: "users",
    operations: [{
      protocol: "queue", direction: "inbound", topic: "user.created", broker: "events",
      evidence: { kind: "configured_static_contract" },
    }],
  });
  recordServiceOperations(db, {
    repoId: "users-client", serviceKey: "users",
    operations: [{
      protocol: "queue", direction: "outbound", topic: "user.created", broker: "events",
      evidence: { kind: "configured_static_client" },
    }],
  });
  recordServiceOperations(db, {
    repoId: "users-client", replace: true,
    operations: [{
      protocol: "websocket", direction: "outbound", channel: "unscoped.old",
      evidence: { kind: "configured_unscoped" },
    }],
  });
  recordServiceOperations(db, {
    repoId: "users-client", replace: true,
    operations: [{
      protocol: "websocket", direction: "outbound", channel: "unscoped.new",
      evidence: { kind: "configured_unscoped" },
    }],
  });
  const users = db.prepare("SELECT id FROM local_services WHERE service_key = 'users'").get();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_service_operations WHERE service_id = ?").get(users.id).count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_service_operations WHERE repo_id = (SELECT id FROM repositories WHERE repo_id = 'users-client') AND service_id IS NULL").get().count, 1);

  const unlinked = unlinkRepositoryService(db, { repoId: "users-client", serviceKey: "users", role: "consumer" });
  assert.equal(unlinked.removed_operations, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_service_operations WHERE service_id = ? AND direction = 'outbound'").get(users.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_service_operations WHERE service_id = ? AND direction = 'inbound'").get(users.id).count, 1);

  upsertServiceIdentity(db, { serviceKey: "temporary", name: "Temporary", evidence: { kind: "temporary" } });
  linkRepositoryService(db, { repoId: "users-client", serviceKey: "temporary", role: "consumer", evidence: { kind: "temporary" } });
  recordServiceOperations(db, {
    repoId: "users-client", serviceKey: "temporary",
    operations: [{ protocol: "websocket", direction: "outbound", channel: "temporary", evidence: { kind: "temporary" } }],
  });
  const pruned = unlinkRepositoryService(db, {
    repoId: "users-client", serviceKey: "temporary", role: "consumer", pruneOrphanService: true,
  });
  assert.equal(pruned.pruned_service, true);
  assert.equal(pruned.removed_operations, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_services WHERE service_key = 'temporary'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_service_operations WHERE operation_key = 'temporary'").get().count, 0);
});

test("composes configured HTTP base prefixes, preserves method isolation, and scopes service callers", async (t) => {
  const { db } = await workspace(t);
  configureUsersService(db);
  upsertServiceIdentity(db, {
    serviceKey: "users", name: "Users Service", baseUrls: ["http://users.local/api"],
    evidence: { kind: "configured_service", source: "prefix test" },
  });
  recordServiceOperations(db, {
    repoId: "users-server-a", serviceKey: "users",
    operations: [{
      protocol: "http", direction: "inbound", method: "GET", path: "/mounted/users/{id}",
      evidence: { kind: "configured_static_contract" },
    }],
  });
  recordServiceOperations(db, {
    repoId: "users-client", serviceKey: "users",
    operations: [
      {
        protocol: "http", direction: "outbound", method: "GET",
        path: "http://users.local/api/mounted/users/42",
        evidence: { kind: "configured_static_client" },
      },
      {
        protocol: "http", direction: "outbound", method: "POST",
        path: "http://users.local/api/mounted/users/42",
        evidence: { kind: "configured_static_client" },
      },
    ],
  });
  const topology = getCrossRepositoryTopology(db, {
    repoIds: ["users-server-a", "users-client"], protocol: "http", limit: 100,
  });
  const prefixed = topology.matches.find((match) => match.caller.operation.method === "GET"
    && match.target.operation.path === "/mounted/users/{}");
  assert.ok(prefixed);
  assert.deepEqual(prefixed.confidence_evidence.identity, 1);
  assert.deepEqual(prefixed.evidence.at(-1).details.relative_paths, ["/mounted/users/{}"]);
  assert.equal(topology.matches.some((match) => match.caller.operation.method === "POST"
    && match.target.operation.path === "/mounted/users/{}"), false);
  const post = topology.unresolved.find((item) => item.caller.operation.method === "POST"
    && item.caller.operation.path === "/api/mounted/users/{}");
  assert.ok(post);
  assert.equal(post.reason, "no_static_target");
  assert.ok(post.evidence.attempted_rendezvous_keys.includes("http:/mounted/users/{}"));

  const callers = getServiceCallers(db, { serviceKey: "users", direction: "outbound", limit: 100 });
  assert.ok(callers.outbound.some((call) => call.source_repo_id === "users-client" && call.target_service.service_key === "users"));
  assert.ok(callers.outbound.every((call) => call.target_service?.service_key === "users"
    || call.caller.service_key === "users" || call.candidate_services.includes("users")));
});

test("refresh repairs stale inferred link evidence without deleting configured references", async (t) => {
  const { db } = await workspace(t);
  refreshServiceIdentities(db, { repoIds: ["users-server-b"] });
  const service = db.prepare("SELECT * FROM local_services WHERE service_key LIKE 'repo:users-server-b:%'").get();
  const repository = db.prepare("SELECT id FROM repositories WHERE repo_id = 'users-server-b'").get();
  db.prepare("UPDATE local_service_repository_links SET confidence = 0.1, evidence_json = '{\"stale\":true}' WHERE service_id = ? AND repo_id = ?")
    .run(service.id, repository.id);
  refreshServiceIdentities(db, { repoIds: ["users-server-b"] });
  const repaired = db.prepare("SELECT * FROM local_service_repository_links WHERE service_id = ? AND repo_id = ?").get(service.id, repository.id);
  assert.equal(repaired.source, "inferred");
  assert.equal(repaired.confidence, 0.5);
  assert.deepEqual(JSON.parse(repaired.evidence_json), { kind: "inferred_repository_provider", repo_id: "users-server-b" });

  linkRepositoryService(db, {
    repoId: "users-server-b", serviceKey: service.service_key, role: "provider",
    evidence: { kind: "configured_reference", source: "adversarial test" },
  });
  refreshServiceIdentities(db, { repoIds: ["users-server-b"] });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_services WHERE id = ?").get(service.id).count, 1);
  assert.equal(db.prepare("SELECT source FROM local_service_repository_links WHERE service_id = ? AND repo_id = ?").get(service.id, repository.id).source, "configured");
});
