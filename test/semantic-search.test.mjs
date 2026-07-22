import assert from "node:assert/strict";
import test from "node:test";
import {
  createHybridSearchIndex,
  createLocalFeatureEmbedding,
  documentKey,
  tokenizeCodeText,
} from "../src/semantic-search.mjs";

const DOCUMENTS = [
  {
    id: 1,
    name: "authorizeRequest",
    qualified_name: "SecurityPolicy.authorizeRequest",
    kind: "Method",
    file_path: "src/security/policy.ts",
    signature: "authorizeRequest(actor, resource)",
    body_text: "return policy.can(actor, resource);",
    start_line: 12,
  },
  {
    id: 2,
    name: "parseCommaSeparatedRows",
    qualified_name: "parseCommaSeparatedRows",
    kind: "Function",
    file_path: "src/import/csv.ts",
    signature: "parseCommaSeparatedRows(input)",
    body_text: "return input.split('\\n').map(splitColumns);",
    start_line: 4,
  },
  {
    id: 3,
    name: "writeInvoiceRecord",
    qualified_name: "InvoiceRepository.writeInvoiceRecord",
    kind: "Method",
    file_path: "src/billing/invoice-repository.ts",
    signature: "writeInvoiceRecord(invoice)",
    body_text: "return sql.insert(invoiceTable, invoice);",
    start_line: 30,
  },
  {
    id: 4,
    name: "formatProfilePayload",
    qualified_name: "formatProfilePayload",
    kind: "Function",
    file_path: "src/profile/format.ts",
    signature: "formatProfilePayload(raw)",
    body_text: "return normalize(raw);",
    start_line: 8,
  },
];

test("tokenization understands code identifiers and local embeddings are deterministic", () => {
  assert.deepEqual(tokenizeCodeText("HTTPClient_authorizeRequests.ts"), ["http", "client", "authorize", "request", "ts"]);
  assert.deepEqual(tokenizeCodeText("ÜberHTTPClient"), ["über", "http", "client"]);
  const first = createLocalFeatureEmbedding("check user permission", { dimensions: 128 });
  const second = createLocalFeatureEmbedding("check user permission", { dimensions: 128 });
  assert.deepEqual([...first], [...second]);
  assert.ok(Math.abs([...first].reduce((sum, value) => sum + value * value, 0) - 1) < 1e-5);
});

test("natural-language concepts retrieve code with no exact query-term overlap", async () => {
  const index = await createHybridSearchIndex(DOCUMENTS, { dimensions: 256 });

  const authorization = await index.search("check whether a user has permission", { limit: 2 });
  assert.equal(authorization[0].name, "authorizeRequest");
  assert.equal(authorization[0].scores.lexical, 0);
  assert.ok(authorization[0].scores.concept > 0);
  assert.ok(authorization[0].scores.contributions.concept <= 0.15);
  assert.equal(authorization[0].conceptExpansion, "heuristic-concepts-v1");

  const persistence = await index.search("persist a customer billing document", { limit: 2 });
  assert.equal(persistence[0].name, "writeInvoiceRecord");

  const transformation = await index.search("transform account data for display", { limit: 2 });
  assert.equal(transformation[0].name, "formatProfilePayload");
});

test("exact identifiers remain dominant and results are deduplicated", async () => {
  const duplicate = { ...DOCUMENTS[0], body_text: "" };
  const index = await createHybridSearchIndex([...DOCUMENTS, duplicate]);
  assert.equal(index.documents.length, DOCUMENTS.length);

  const results = await index.search("authorizeRequest", {
    limit: 4,
    lexicalResults: [DOCUMENTS[2], DOCUMENTS[2], DOCUMENTS[1]],
  });
  assert.equal(results[0].name, "authorizeRequest");
  assert.equal(results[0].scores.exact, 1);
  assert.equal(new Set(results.map((item) => item.id)).size, results.length);
  assert.ok(results.find((item) => item.id === 3).scores.external > 0);

  const stableDuplicates = await createHybridSearchIndex([
    { ...DOCUMENTS[0], id: 20, stable_key: "security#authorizeRequest", body_text: "" },
    { ...DOCUMENTS[0], id: 21, stable_key: "security#authorizeRequest" },
  ]);
  assert.equal(stableDuplicates.documents.length, 1);
  assert.equal(stableDuplicates.documents[0].id, 21);
  assert.equal(documentKey({ id: 999, stable_key: "security#authorizeRequest" }), "stable:security#authorizeRequest");
});

test("exact scoring preserves spelling rather than conflating stems", async () => {
  const index = await createHybridSearchIndex([
    { id: "singular", name: "user", qualified_name: "user", kind: "Function", file_path: "user.ts" },
    { id: "plural", name: "users", qualified_name: "users", kind: "Function", file_path: "users.ts" },
    { id: "stop-word", name: "do", qualified_name: "do", kind: "Function", file_path: "do.ts" },
  ]);
  const plural = await index.search("users", { limit: 3 });
  assert.equal(plural[0].id, "plural");
  assert.equal(plural[0].scores.exact, 1);
  assert.notEqual(plural.find((item) => item.id === "singular").scores.exact, 1);
  const stopWord = await index.search("do", { limit: 1 });
  assert.equal(stopWord[0].id, "stop-word");
  assert.equal(stopWord[0].scores.exact, 1);
});

test("empty queries fail clearly and Unicode identifiers remain searchable", async () => {
  const documents = [
    ...DOCUMENTS,
    {
      id: 5,
      name: "calcularPuntuación",
      qualified_name: "resultados.calcularPuntuación",
      kind: "Function",
      file_path: "src/resultados/puntuación.ts",
      signature: "calcularPuntuación(entrada)",
      body_text: "return normalizar(entrada);",
      start_line: 7,
    },
  ];
  const index = await createHybridSearchIndex(documents);
  await assert.rejects(index.search("   "), /query is required/);
  const results = await index.search("calcular puntuación", { limit: 2 });
  assert.equal(results[0].name, "calcularPuntuación");
  assert.equal(results[0].scores.exact, 1);
});

test("ties are deterministic and building an index does not mutate input rows", async () => {
  const documents = [
    { id: "b", name: "sameWork", qualified_name: "sameWork", kind: "Function", file_path: "b.ts", body_text: "widget" },
    { id: "a", name: "sameWork", qualified_name: "sameWork", kind: "Function", file_path: "a.ts", body_text: "widget" },
  ];
  const original = structuredClone(documents);
  const index = await createHybridSearchIndex(documents);
  assert.deepEqual(documents, original);

  const first = await index.search("widget", { limit: 2 });
  const second = await index.search("widget", { limit: 2 });
  assert.deepEqual(first.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));

  const codePointIndex = await createHybridSearchIndex([
    { id: "é", name: "same", qualified_name: "same", kind: "Function", file_path: "same.ts", body_text: "widget" },
    { id: "z", name: "same", qualified_name: "same", kind: "Function", file_path: "same.ts", body_text: "widget" },
  ]);
  assert.deepEqual((await codePointIndex.search("widget", { limit: 2 })).map((item) => item.id), ["z", "é"]);
});

test("filters use normalized DB field names and fallback keys are stable", async () => {
  const index = await createHybridSearchIndex(DOCUMENTS);
  const results = await index.search("save record", { kind: "method", filePath: "billing", limit: 10 });
  assert.deepEqual(results.map((item) => item.id), [3]);
  assert.equal(
    documentKey({ file_path: "src/a.ts", qualified_name: "work", start_line: 9 }),
    "symbol:src/a.ts:work:9",
  );
});

test("input sizes and resource-sensitive options have hard bounds", async () => {
  await assert.rejects(createHybridSearchIndex({}), /documents must be an array/);
  await assert.rejects(createHybridSearchIndex(DOCUMENTS, { dimensions: 4_097 }), /dimensions/);
  await assert.rejects(createHybridSearchIndex(DOCUMENTS, { bodyLimit: 30_001 }), /bodyLimit/);
  await assert.rejects(createHybridSearchIndex(DOCUMENTS, { maxDocuments: 3 }), /at most 3 rows/);
  const withoutBodies = await createHybridSearchIndex(DOCUMENTS, { bodyLimit: 0 });
  assert.ok(withoutBodies.documents.every((document) => document.bodyText === ""));
  await assert.rejects(withoutBodies.search("x".repeat(4_097)), /query must be at most/);
  const externallyBounded = await createHybridSearchIndex(DOCUMENTS, { maxExternalResults: 1 });
  await assert.rejects(externallyBounded.search("invoice", { lexicalResults: [DOCUMENTS[0], DOCUMENTS[1]] }), /at most 1 rows/);
});

test("pluggable providers require explicit caller trust, determinism, batching, and timeouts", async () => {
  await assert.rejects(
    createHybridSearchIndex(DOCUMENTS, {
      embeddingProvider: {
        id: "remote-provider",
        localOnly: false,
        embedDocuments: async () => [],
        embedQuery: async () => [],
      },
    }),
    /allowCustomProvider: true/,
  );
  await assert.rejects(
    createHybridSearchIndex(DOCUMENTS, {
      allowCustomProvider: true,
      embeddingProvider: {
        id: "remote-provider",
        localOnly: false,
        deterministic: true,
        embedDocuments: async () => [],
        embedQuery: async () => [],
      },
    }),
    /localOnly: true/,
  );

  const batches = [];
  const provider = {
    id: "deterministic-test-local",
    localOnly: true,
    deterministic: true,
    embedDocuments: async (texts) => {
      batches.push(texts.length);
      return texts.map((text) => [text.includes("invoice") ? 1 : 0, 1]);
    },
    embedQuery: async (query) => [query.includes("money") ? 1 : 0, 1],
  };
  const index = await createHybridSearchIndex(DOCUMENTS, {
    embeddingProvider: provider,
    allowCustomProvider: true,
    providerBatchSize: 2,
  });
  assert.deepEqual(batches, [2, 2]);
  const results = await index.search("money", { limit: 1 });
  assert.equal(results[0].name, "writeInvoiceRecord");
  assert.equal(results[0].embeddingProvider, "deterministic-test-local");
  assert.equal(results[0].embeddingProviderTrust, "caller-attested-local");

  await assert.rejects(createHybridSearchIndex(DOCUMENTS.slice(0, 1), {
    allowCustomProvider: true,
    providerTimeoutMs: 5,
    embeddingProvider: {
      id: "stalled-local-provider",
      localOnly: true,
      deterministic: true,
      embedDocuments: async () => new Promise(() => {}),
      embedQuery: async () => [1],
    },
  }), /timed out/);
});
