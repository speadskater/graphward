import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractJavaScriptRelationships } from "../src/javascript-relationships.mjs";
import { parseSource } from "../src/languages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("extracts exports, heritage, type references, and member resolution hints", async () => {
  const fixturePath = path.join(here, "fixtures", "js-relationships", "relationships.ts");
  const content = await readFile(fixturePath, "utf8");
  const result = extractJavaScriptRelationships(content, "relationships.ts");

  assert.equal(result.ok, true);
  assert.equal(result.parser.mode, "babel");
  assert.deepEqual(
    result.exports.map(({ kind, exportedName, localName, importedName, source, isTypeOnly }) => ({
      kind,
      exportedName,
      localName,
      importedName,
      source,
      isTypeOnly,
    })),
    [
      { kind: "local", exportedName: "localValue", localName: "localValue", importedName: null, source: null, isTypeOnly: false },
      { kind: "alias", exportedName: "publicValue", localName: "internalValue", importedName: null, source: null, isTypeOnly: false },
      { kind: "re-export", exportedName: "renamedRemote", localName: null, importedName: "remoteValue", source: "./remote.js", isTypeOnly: false },
      { kind: "re-export", exportedName: "RemoteShape", localName: null, importedName: "RemoteShape", source: "./remote.js", isTypeOnly: true },
      { kind: "export-all", exportedName: "*", localName: null, importedName: "*", source: "./everything.js", isTypeOnly: false },
      { kind: "re-export-namespace", exportedName: "helpers", localName: null, importedName: "*", source: "./helpers.js", isTypeOnly: false },
      { kind: "local", exportedName: "Runnable", localName: "Runnable", importedName: null, source: null, isTypeOnly: true },
      { kind: "local", exportedName: "Runner", localName: "Runner", importedName: null, source: null, isTypeOnly: false },
      { kind: "default", exportedName: "default", localName: "Runner", importedName: null, source: null, isTypeOnly: false },
    ],
  );

  assert.deepEqual(
    result.heritage.map(({ relation, subjectName, targetName }) => ({ relation, subjectName, targetName })),
    [
      { relation: "interface-extends", subjectName: "Runnable", targetName: "Parent" },
      { relation: "interface-extends", subjectName: "Runnable", targetName: "contracts.Named" },
      { relation: "extends", subjectName: "Runner", targetName: "BaseRunner" },
      { relation: "implements", subjectName: "Runner", targetName: "Runnable" },
      { relation: "implements", subjectName: "Runner", targetName: "contracts.Disposable" },
    ],
  );
  assert.ok(result.typeReferences.some((item) => item.targetName === "Promise" && item.ownerName === "Runnable"));
  assert.ok(result.typeReferences.some((item) => item.targetName === "Result"));
  assert.ok(result.typeReferences.some((item) => item.targetName === "Readonly" && item.ownerName === "Box"));
  assert.ok(result.memberHints.some((item) => item.kind === "call" && item.expression === "this.worker.run" && item.ownerName === "Runner.run"));
  assert.ok(result.memberHints.some((item) => item.kind === "call" && item.expression === "super" && item.ownerName === "Runner.constructor"));

  for (const group of [result.exports, result.heritage, result.typeReferences, result.memberHints]) {
    for (const record of group) {
      assert.ok(record.span.start.line >= 1);
      assert.ok(record.span.end.index >= record.span.start.index);
    }
  }
});

test("links endpoint constants, registry members, builders, and aliases to concrete HTTP methods", () => {
  const content = `
const endpoints = Object.freeze({
  users: "/api/users",
  user: (id) => \`/api/users/\${id}\`,
  nested: { audit: "/api/audit" },
});
const usersUrl = endpoints.users;
const { audit: auditUrl } = endpoints.nested;

axios.get(usersUrl);
fetch(endpoints.user(userId), { method: "PATCH" });
httpClient.post(auditUrl);
apiClient.delete(endpoints.user(userId));
axios({ method: "put", url: endpoints.users });
httpClient.request({ method: "HEAD", url: endpoints.nested.audit });
`;
  const result = extractJavaScriptRelationships(content, "endpoints.ts");

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.endpointValues.definitions.map(({ kind, symbolPath, valueTemplate, sourceExpression }) => ({
      kind,
      symbolPath,
      valueTemplate,
      sourceExpression,
    })),
    [
      { kind: "registry-member", symbolPath: "endpoints.users", valueTemplate: "/api/users", sourceExpression: null },
      { kind: "builder", symbolPath: "endpoints.user", valueTemplate: "/api/users/${}", sourceExpression: null },
      { kind: "registry-member", symbolPath: "endpoints.nested.audit", valueTemplate: "/api/audit", sourceExpression: null },
      { kind: "alias", symbolPath: "usersUrl", valueTemplate: "/api/users", sourceExpression: "endpoints.users" },
      { kind: "alias", symbolPath: "auditUrl", valueTemplate: "/api/audit", sourceExpression: "endpoints.nested.audit" },
    ],
  );

  assert.deepEqual(
    result.endpointValues.usages.map(({ method, valueExpression, resolvedDefinition, valueTemplate }) => ({
      method,
      valueExpression,
      resolvedDefinition,
      valueTemplate,
    })),
    [
      { method: "GET", valueExpression: "usersUrl", resolvedDefinition: "usersUrl", valueTemplate: "/api/users" },
      { method: "PATCH", valueExpression: "endpoints.user", resolvedDefinition: "endpoints.user", valueTemplate: "/api/users/${}" },
      { method: "POST", valueExpression: "auditUrl", resolvedDefinition: "auditUrl", valueTemplate: "/api/audit" },
      { method: "DELETE", valueExpression: "endpoints.user", resolvedDefinition: "endpoints.user", valueTemplate: "/api/users/${}" },
      { method: "PUT", valueExpression: "endpoints.users", resolvedDefinition: "endpoints.users", valueTemplate: "/api/users" },
      { method: "HEAD", valueExpression: "endpoints.nested.audit", resolvedDefinition: "endpoints.nested.audit", valueTemplate: "/api/audit" },
    ],
  );
  assert.ok(result.endpointValues.usages.every((item) => item.confidence === 0.99));
  assert.ok(result.endpointValues.usages.every((item) => item.valueSpan.start.line >= 1));
});

test("extracts CommonJS named/default exports and reports syntax failures without throwing", () => {
  const commonJs = extractJavaScriptRelationships(`
const first = 1;
const second = 2;
module.exports = { first, renamed: second };
exports.extra = first;
`, "common.cjs");
  assert.equal(commonJs.ok, true);
  assert.deepEqual(
    commonJs.exports.map(({ kind, exportedName, localName }) => ({ kind, exportedName, localName })),
    [
      { kind: "commonjs-default", exportedName: "default", localName: null },
      { kind: "commonjs-named", exportedName: "first", localName: "first" },
      { kind: "commonjs-named", exportedName: "renamed", localName: "second" },
      { kind: "commonjs-named", exportedName: "extra", localName: "first" },
    ],
  );

  const invalid = extractJavaScriptRelationships("function broken( {", "broken.js");
  assert.equal(invalid.ok, false);
  assert.equal(typeof invalid.error.message, "string");
});

test("falls back safely when malformed JavaScript is entirely covered by heuristic symbols", () => {
  const result = parseSource("function broken( {", "javascript", "broken.js");
  assert.equal(result.parser.mode, "heuristic-fallback");
  assert.equal(result.symbols[0].name, "broken");
  assert.ok(Array.isArray(result.calls));
});

test("indexes anonymous HTTP route callbacks as bounded handler symbols", () => {
  const result = parseSource(`
const router = require('express').Router();
router.post('/competitions/:id/transfer-owner', optionalAuth, asyncHandler(async (req, res) => {
  const accountStaff = await loadAccountStaff(req.user.id);
  await transferOwnership(req.params.id, accountStaff);
  res.json({ ok: true });
}));
`, "javascript", "server/routes/competitions.js");
  const route = result.symbols.find((symbol) => symbol.kind === "RouteHandler");
  assert.equal(route.name, "POST /competitions/:id/transfer-owner");
  assert.equal(route.qualifiedName, "<route:POST:/competitions/{}/transfer-owner>");
  assert.match(route.bodyText, /loadAccountStaff/);
  assert.ok(result.calls.some((call) => call.sourceStableKey === route.stableKey && call.calleeName === "transferOwnership"));
  assert.equal(result.apiOperations[0].sourceStableKey, route.stableKey);
});
