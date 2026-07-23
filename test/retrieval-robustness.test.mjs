import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { createHybridSearchIndex } from "../src/semantic-search.mjs";
import { callTool } from "../src/tools.mjs";

function document(id, name, bodyText, overrides = {}) {
  return {
    id,
    name,
    qualified_name: overrides.qualified_name ?? name,
    kind: overrides.kind ?? "Function",
    file_path: overrides.file_path ?? `src/${id}.mjs`,
    signature: overrides.signature ?? `function ${name}()`,
    body_text: bodyText,
    start_line: overrides.start_line ?? 1,
    ...overrides,
  };
}

test("no-relevant queries expose the absence of lexical, exact, and concept evidence", async () => {
  const index = await createHybridSearchIndex([
    document("billing", "settleInvoice", "persist the paid invoice record"),
    document("profile", "formatProfile", "render account profile data"),
    document("security", "authorizeRequest", "check whether an actor may access a resource"),
  ]);

  const results = await index.search("quasarzibble nebulaquonk", { limit: 3 });

  // The current search contract returns bounded best-effort candidates rather than
  // claiming that it can prove there is no match. Its evidence fields must remain
  // honest so callers can distinguish that case from a supported result.
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.scores.exact === 0));
  assert.ok(results.every((result) => result.scores.lexical === 0));
  assert.ok(results.every((result) => result.scores.concept === 0));
  assert.ok(results.every((result) => result.scores.external === 0));
  assert.ok(results.every((result) => result.scores.fuzzy_identifier === 0));
});

test("misspellings, conversational noise, and paraphrases retain the relevant target", async () => {
  const target = document(
    "target",
    "authorizeTransferRequest",
    "verify that the current account owner has permission before moving ownership",
    { qualified_name: "OwnershipPolicy.authorizeTransferRequest" },
  );
  const index = await createHybridSearchIndex([
    target,
    document("receipt", "renderTransferReceipt", "format a transfer receipt for display"),
    document("archive", "archiveTransferRecord", "persist an old transfer record"),
    document("notify", "sendOwnershipNotification", "email an ownership change notification"),
  ]);

  const typo = await index.search("athorize tranfer reqest", { limit: 3 });
  assert.equal(typo[0].id, target.id);
  assert.ok(typo[0].scores.contributions.fuzzy_identifier > 0);

  const noisy = await index.search(
    "hey, could you please find the place that checks whether an account owner is allowed before ownership moves? thanks",
    { limit: 3 },
  );
  assert.equal(noisy[0].id, target.id);

  const paraphrase = await index.search("guard reassignment so only the current principal may proceed", { limit: 3 });
  assert.equal(paraphrase[0].id, target.id);
});

test("duplicate symbol names remain disambiguatable with combined path and kind filters", async () => {
  const index = await createHybridSearchIndex([
    document("admin-method", "handleRequest", "authorize an administrator", {
      qualified_name: "AdminController.handleRequest",
      kind: "Method",
      file_path: "src/admin/controller.mjs",
    }),
    document("public-function", "handleRequest", "render the public landing page", {
      kind: "Function",
      file_path: "src/public/handler.mjs",
    }),
    document("admin-class", "handleRequest", "admin request container", {
      kind: "Class",
      file_path: "src/admin/model.mjs",
    }),
  ]);

  const ambiguous = await index.search("handleRequest", { limit: 10 });
  assert.deepEqual(new Set(ambiguous.map((result) => result.id)), new Set([
    "admin-method", "public-function", "admin-class",
  ]));

  const disambiguated = await index.search("handleRequest", {
    filePath: "admin",
    kind: "method",
    limit: 10,
  });
  assert.deepEqual(disambiguated.map((result) => result.id), ["admin-method"]);
});

test("coherent production evidence resists a test-only keyword-stuffing decoy", async () => {
  const index = await createHybridSearchIndex([
    document(
      "implementation",
      "rotateSigningKey",
      "replace the cryptographic signing secret and invalidate the previous key",
      { file_path: "src/security/keys.mjs" },
    ),
    document(
      "decoy",
      "key-rotation-search.test.mjs",
      "replace cryptographic signing secret key replace cryptographic signing secret key",
      {
        qualified_name: "<module:test/key-rotation-search.test.mjs>",
        kind: "Module",
        file_path: "test/key-rotation-search.test.mjs",
      },
    ),
    document("unrelated", "loadEncryptionConfig", "read cipher configuration", {
      file_path: "src/security/config.mjs",
    }),
  ]);

  const results = await index.search("replace cryptographic signing secret key", { limit: 3 });
  assert.equal(results[0].id, "implementation");
  assert.ok(results.findIndex((result) => result.id === "decoy") > 0);
  assert.equal(results[0].scores.contributions.production, 0.12);
  assert.equal(results.find((result) => result.id === "decoy").scores.contributions.test_penalty, -0.25);
});

test("offset pagination is deterministic, exhaustive, and contains no duplicate documents", async () => {
  const documents = Array.from({ length: 17 }, (_, index) => document(
    `page-${String(index).padStart(2, "0")}`,
    `reconcileLedgerPage${String(index).padStart(2, "0")}`,
    "reconcile a pagination ledger entry",
  ));
  const searchIndex = await createHybridSearchIndex(documents);
  const allAtOnce = await searchIndex.search("reconcile pagination ledger", { limit: 50 });
  const paged = [];

  for (let offset = 0; offset < allAtOnce.length; offset += 4) {
    const page = await searchIndex.search("reconcile pagination ledger", { limit: 4, offset });
    paged.push(...page);
  }

  assert.deepEqual(paged.map((result) => result.id), allAtOnce.map((result) => result.id));
  assert.equal(new Set(paged.map((result) => result.id)).size, paged.length);
});

async function collectFindCodePages(context, query, limit) {
  const results = [];
  const seen = new Set();
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
    const page = await callTool("find_code", {
      repo_id: "retrieval-pagination",
      query,
      limit,
      cursor,
      response_detail: "full",
    }, context);
    assert.equal(page.page.cursor, cursor);
    assert.ok(page.results.length <= limit);
    for (const result of page.results) {
      assert.equal(seen.has(result.stable_key), false, `duplicate result ${result.stable_key} at cursor ${cursor}`);
      seen.add(result.stable_key);
      results.push(result);
    }
    if (!page.page.has_more) {
      assert.equal(page.page.next_cursor, null);
      return results;
    }
    assert.equal(page.page.next_cursor, cursor + page.results.length);
    cursor = page.page.next_cursor;
  }
  assert.fail("pagination did not terminate within 30 pages");
}

test("find_code cursors remain stable and duplicate-free when graph promotion crosses its ranking window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-retrieval-pagination-"));
  const sourceDirectory = path.join(root, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const functions = Array.from({ length: 110 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return `export function reconcileLedgerPage${suffix}() { return "reconcile pagination ledger"; }`;
  });
  await writeFile(path.join(sourceDirectory, "pages.mjs"), `${functions.join("\n")}\n`);
  const db = openDatabase(path.join(root, ".graphward", "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId: "retrieval-pagination" });
  const context = { db, defaultRoot: root };
  const query = "reconcile pagination ledger";

  const rawFirst = await callTool("find_code", {
    repo_id: "retrieval-pagination", query, limit: 100, response_detail: "full",
  }, context);
  const rawTail = await callTool("find_code", {
    repo_id: "retrieval-pagination", query, limit: 100, cursor: 100, response_detail: "full",
  }, context);
  const expectedKeys = [...rawFirst.results, ...rawTail.results].map((result) => result.stable_key);
  assert.ok(expectedKeys.length > 101, "fixture must exercise the graph reranking boundary");

  const source = rawFirst.results[0];
  const target = rawTail.results[0];
  const repository = db.prepare("SELECT id FROM repositories WHERE repo_id = ?").get("retrieval-pagination");
  const sourceRow = db.prepare("SELECT file_id FROM symbols WHERE id = ?").get(source.id);
  const targetRow = db.prepare("SELECT file_id FROM symbols WHERE id = ?").get(target.id);
  db.prepare(`
    INSERT INTO edges(
      repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id,
      kind, label, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, 'calls', 'pagination-boundary-probe', 1, ?)
  `).run(repository.id, source.id, target.id, sourceRow.file_id, targetRow.file_id, new Date(0).toISOString());

  const firstTraversal = await collectFindCodePages(context, query, 10);
  const secondTraversal = await collectFindCodePages(context, query, 10);
  assert.deepEqual(firstTraversal.map((result) => result.stable_key), secondTraversal.map((result) => result.stable_key));
  assert.deepEqual(new Set(firstTraversal.map((result) => result.stable_key)), new Set(expectedKeys));
  assert.equal(firstTraversal.length, expectedKeys.length);
});
