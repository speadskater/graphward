import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { parseSource } from "../src/languages.mjs";
import { detectPythonExecutable, parsePythonSource } from "../src/python-parser.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(testDirectory, "fixtures", "python-ast");
const parserPath = path.resolve(testDirectory, "..", "src", "python-parser.mjs");
const pythonRuntime = detectPythonExecutable();

function fixture(name) {
  return readFileSync(path.join(fixtureDirectory, name), "utf8");
}

test("detects a compatible Python runtime without a shell", { skip: !pythonRuntime }, () => {
  assert.match(pythonRuntime.version, /^3\./);
  assert.equal(Array.isArray(pythonRuntime.args), true);
  assert.equal(typeof pythonRuntime.command, "string");
});

test("extracts nested definitions, ownership, decorators, bases, and explicit exports", { skip: !pythonRuntime }, () => {
  const source = fixture("comprehensive.py");
  const parsed = parsePythonSource(source, "app/comprehensive.py");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.parser.mode, "python-ast");
  assert.deepEqual(parsed.parser.diagnostics, []);

  const definitions = new Map(parsed.definitions.map((item) => [item.qualifiedName, item]));
  assert.deepEqual([...definitions.keys()], [
    "Service",
    "Service.build",
    "Service.build.prepare",
    "Service.Nested",
    "Service.Nested.run",
    "top_level",
    "top_level.inner",
    "_private",
  ]);

  const service = definitions.get("Service");
  assert.equal(service.kind, "Class");
  assert.equal(service.exported, true);
  assert.deepEqual(service.decorators, ['registry.register("service")']);
  assert.deepEqual(service.bases, ["BaseService", "mixins.LoggingMixin"]);
  assert.equal(service.ownerInternalId, null);
  assert.equal(service.startIndex + 1, 13);
  assert.ok(service.endIndex > service.startIndex);
  assert.ok(service.nodeEnd > service.nodeStart);

  const build = definitions.get("Service.build");
  assert.equal(build.kind, "Method");
  assert.equal(build.isAsync, true);
  assert.equal(build.exported, false);
  assert.equal(build.ownerInternalId, service.internalId);
  assert.equal(build.ownerQualifiedName, "Service");
  assert.deepEqual(build.lexicalPath, ["Service", "build"]);
  assert.deepEqual(build.decorators, ["classmethod"]);

  const prepare = definitions.get("Service.build.prepare");
  assert.equal(prepare.kind, "Function");
  assert.equal(prepare.isAsync, true);
  assert.equal(prepare.ownerInternalId, build.internalId);

  const nested = definitions.get("Service.Nested");
  const nestedRun = definitions.get("Service.Nested.run");
  assert.equal(nested.ownerInternalId, service.internalId);
  assert.equal(nestedRun.ownerInternalId, nested.internalId);
  assert.equal(nestedRun.kind, "Method");

  assert.equal(definitions.get("top_level").exported, true);
  assert.equal(definitions.get("top_level.inner").exported, false);
  assert.equal(definitions.get("_private").exported, false);

  const repeated = parsePythonSource(source, "app/comprehensive.py");
  assert.deepEqual(repeated.definitions, parsed.definitions);
  assert.deepEqual(repeated.calls, parsed.calls);
});

test("emits aliased absolute and relative import bindings", { skip: !pythonRuntime }, () => {
  const parsed = parsePythonSource(fixture("comprehensive.py"), "app/comprehensive.py");
  const imports = new Map(parsed.imports.map((item) => [item.specifier, item]));

  assert.deepEqual(imports.get("os").bindings, [
    { kind: "namespace", local: "os", imported: "*" },
  ]);
  assert.deepEqual(imports.get("pkg.client").bindings, [
    { kind: "namespace", local: "pc", imported: "*" },
  ]);
  assert.deepEqual(imports.get(".services").bindings, [
    { kind: "named", local: "ApiClient", imported: "Client" },
    { kind: "named", local: "helper", imported: "helper" },
  ]);
  assert.equal(imports.get(".services").relativeLevel, 1);
  assert.equal(imports.get(".services").module, "services");
  assert.deepEqual(imports.get("..").bindings, [
    { kind: "named", local: "shared_alias", imported: "shared" },
  ]);
  assert.equal(imports.get("..").relativeLevel, 2);
});

test("attributes calls to their nearest owner and records member and await syntax", { skip: !pythonRuntime }, () => {
  const parsed = parsePythonSource(fixture("comprehensive.py"), "app/comprehensive.py");
  const byName = (name) => parsed.calls.filter((item) => item.calleeName === name);

  const decorator = byName("register")[0];
  assert.equal(decorator.qualifier, "registry");
  assert.equal(decorator.ownerInternalId, null);

  const transform = byName("transform")[0];
  assert.equal(transform.ownerQualifiedName, "Service.build.prepare");
  assert.equal(transform.syntax, "call");

  const initialize = byName("initialize")[0];
  assert.equal(initialize.qualifier, "instance");
  assert.equal(initialize.ownerQualifiedName, "Service.build");
  assert.equal(initialize.awaited, true);

  const execute = byName("execute")[0];
  assert.equal(execute.qualifier, "self.worker");
  assert.equal(execute.ownerQualifiedName, "Service.Nested.run");

  const importedConstructor = byName("Client")[0];
  assert.equal(importedConstructor.qualifier, "pc");
  assert.equal(importedConstructor.ownerQualifiedName, "top_level");

  const serviceBuild = byName("build")[0];
  assert.equal(serviceBuild.qualifier, "service");
  assert.equal(serviceBuild.awaited, true);
  assert.equal(Number.isInteger(serviceBuild.callLine), true);
});

test("reports syntax errors as structured diagnostics instead of throwing", { skip: !pythonRuntime }, () => {
  const parsed = parsePythonSource(fixture("invalid.py"), "app/invalid.py");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.parser.mode, "python-ast-error");
  assert.equal(parsed.error.code, "PYTHON_SYNTAX_ERROR");
  assert.equal(parsed.error.reason_code, "python-syntax-error");
  assert.equal(parsed.error.line, 1);
  assert.equal(parsed.parser.diagnostics.length, 1);
});

test("falls back safely when an invalid Python definition covers the whole file", { skip: !pythonRuntime }, () => {
  const parsed = parseSource(fixture("invalid.py"), "python", "app/invalid.py");
  assert.equal(parsed.parser.mode, "heuristic-fallback");
  assert.equal(parsed.parser.diagnostics[0].reason_code, "python-syntax-error");
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "broken"));
});

test("returns an explicit fallback signal when no interpreter is available", () => {
  const moduleUrl = pathToFileURL(parserPath).href;
  const program = `
    import { parsePythonSource } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(parsePythonSource("def okay():\\n    pass\\n", "okay.py")));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      GRAPHWARD_PYTHON: "graphward-python-does-not-exist",
      PATH: "",
      Path: "",
    },
  });

  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.parser.mode, "python-unavailable");
  assert.equal(parsed.error.code, "PYTHON_UNAVAILABLE");
  assert.match(parsed.error.message, /GRAPHWARD_PYTHON/);
});

test("rejects non-string input without spawning Python", () => {
  const parsed = parsePythonSource(Buffer.from("pass"), "buffer.py");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.parser.mode, "python-invalid-input");
  assert.equal(parsed.error.code, "PYTHON_INVALID_INPUT");
});
