import process from "node:process";
import { spawnSync } from "node:child_process";

const MINIMUM_PYTHON = [3, 8];
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_BUFFER_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Parsing happens in a short-lived CPython process so Graphward can use the
// standard-library AST without adding a native Node dependency. Source is sent
// on stdin and the filename is a positional argument; neither goes through a
// command shell.
const PYTHON_HELPER = String.raw`
import ast
import json
import sys

source = sys.stdin.read()
filename = sys.argv[1] if len(sys.argv) > 1 else "<unknown>"


def diagnostic(message, code, reason_code, line=None, column=None):
    return {
        "message": str(message),
        "code": code,
        "reason_code": reason_code,
        "line": line,
        "column": column,
    }


try:
    tree = ast.parse(source, filename=filename, type_comments=True)
except SyntaxError as error:
    item = diagnostic(
        error.msg,
        "PYTHON_SYNTAX_ERROR",
        "python-syntax-error",
        error.lineno,
        max(0, error.offset - 1) if error.offset is not None else None,
    )
    print(json.dumps({"ok": False, "error": item}, ensure_ascii=False))
    raise SystemExit(0)
except Exception as error:
    item = diagnostic(error, "PYTHON_AST_ERROR", "python-ast-error")
    print(json.dumps({"ok": False, "error": item}, ensure_ascii=False))
    raise SystemExit(0)


source_lines = source.splitlines(keepends=True)
if not source_lines:
    source_lines = [""]
line_starts = []
cursor = 0
for source_line in source_lines:
    line_starts.append(cursor)
    cursor += len(source_line)


def character_offset(line, byte_column):
    if not line or line < 1 or line > len(source_lines):
        return 0
    text = source_lines[line - 1]
    prefix = text.encode("utf-8")[:max(0, byte_column)].decode("utf-8", errors="ignore")
    return line_starts[line - 1] + len(prefix)


def source_text(node):
    value = ast.get_source_segment(source, node)
    if value is None:
        return None
    return " ".join(value.split())[:500]


def expression_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        owner = expression_name(node.value)
        return (owner + "." + node.attr) if owner else node.attr
    if isinstance(node, ast.Call):
        callee = expression_name(node.func)
        return (callee + "()") if callee else None
    if isinstance(node, ast.Subscript):
        owner = expression_name(node.value)
        return (owner + "[]") if owner else None
    if isinstance(node, ast.Await):
        return expression_name(node.value)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return repr(node.value)
    return None


def literal_string_collection(node):
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None
    values = []
    for element in node.elts:
        if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
            return None
        values.append(element.value)
    return values


def explicit_module_exports(module):
    exports = None
    for statement in module.body:
        value = None
        is_assignment = False
        if isinstance(statement, ast.Assign):
            is_assignment = any(isinstance(target, ast.Name) and target.id == "__all__" for target in statement.targets)
            value = statement.value
        elif isinstance(statement, ast.AnnAssign):
            is_assignment = isinstance(statement.target, ast.Name) and statement.target.id == "__all__"
            value = statement.value
        elif isinstance(statement, ast.AugAssign):
            is_assignment = (
                isinstance(statement.target, ast.Name)
                and statement.target.id == "__all__"
                and isinstance(statement.op, ast.Add)
            )
            value = statement.value
        if not is_assignment:
            continue
        names = literal_string_collection(value)
        if names is None:
            return None
        if isinstance(statement, ast.AugAssign):
            if exports is None:
                return None
            exports.update(names)
        else:
            exports = set(names)
    return exports


class Analyzer(ast.NodeVisitor):
    def __init__(self, module):
        self.definitions = []
        self.imports = []
        self.imports_by_specifier = {}
        self.calls = []
        self.owner_stack = []
        self.await_depth = 0
        self.exports = explicit_module_exports(module)

    def add_import(self, specifier, binding, level=0, module=None):
        if not specifier:
            return
        item = self.imports_by_specifier.get(specifier)
        if item is None:
            item = {
                "specifier": specifier,
                "bindings": [],
                "relativeLevel": level,
                "module": module,
            }
            self.imports_by_specifier[specifier] = item
            self.imports.append(item)
        if binding not in item["bindings"]:
            item["bindings"].append(binding)

    def add_definition(self, node, kind, is_async=False):
        owner = self.owner_stack[-1] if self.owner_stack else None
        lexical_path = list(owner["lexicalPath"]) if owner else []
        lexical_path.append(node.name)
        exported = owner is None and (
            node.name in self.exports if self.exports is not None else not node.name.startswith("_")
        )
        start_line = getattr(node, "lineno", 1)
        end_line = getattr(node, "end_lineno", start_line)
        start_column = getattr(node, "col_offset", 0)
        end_column = getattr(node, "end_col_offset", start_column)
        definition = {
            "internalId": len(self.definitions) + 1,
            "name": node.name,
            "qualifiedName": ".".join(lexical_path),
            "kind": kind,
            "startIndex": max(0, start_line - 1),
            "endIndex": max(0, end_line - 1),
            "nodeStart": character_offset(start_line, start_column),
            "nodeEnd": character_offset(end_line, end_column),
            "startColumn": start_column,
            "endColumn": end_column,
            "exported": exported,
            "public": not node.name.startswith("_"),
            "ownerInternalId": owner["internalId"] if owner else None,
            "ownerQualifiedName": owner["qualifiedName"] if owner else None,
            "ownerKind": owner["kind"] if owner else None,
            "lexicalPath": lexical_path,
            "decorators": [value for value in (source_text(item) for item in node.decorator_list) if value],
            "bases": [],
            "isAsync": is_async,
        }
        if isinstance(node, ast.ClassDef):
            definition["bases"] = [value for value in (source_text(item) for item in node.bases) if value]
        self.definitions.append(definition)
        return definition

    def visit_definition_context(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.visit(node.args)
            if node.returns is not None:
                self.visit(node.returns)
        else:
            for base in node.bases:
                self.visit(base)
            for keyword in node.keywords:
                self.visit(keyword)
        for parameter in getattr(node, "type_params", []):
            self.visit(parameter)

    def visit_function(self, node, is_async):
        owner = self.owner_stack[-1] if self.owner_stack else None
        if owner and owner["kind"] == "Class":
            kind = "Constructor" if node.name in ("__init__", "__new__") else "Method"
        else:
            kind = "Function"
        definition = self.add_definition(node, kind, is_async=is_async)
        self.visit_definition_context(node)
        self.owner_stack.append(definition)
        for statement in node.body:
            self.visit(statement)
        self.owner_stack.pop()

    def visit_FunctionDef(self, node):
        self.visit_function(node, is_async=False)

    def visit_AsyncFunctionDef(self, node):
        self.visit_function(node, is_async=True)

    def visit_ClassDef(self, node):
        definition = self.add_definition(node, "Class")
        self.visit_definition_context(node)
        self.owner_stack.append(definition)
        for statement in node.body:
            self.visit(statement)
        self.owner_stack.pop()

    def visit_Import(self, node):
        for alias in node.names:
            local = alias.asname or alias.name.split(".", 1)[0]
            self.add_import(
                alias.name,
                {"kind": "namespace", "local": local, "imported": "*"},
                module=alias.name,
            )

    def visit_ImportFrom(self, node):
        specifier = ("." * node.level) + (node.module or "")
        for alias in node.names:
            if alias.name == "*":
                binding = {"kind": "wildcard", "local": None, "imported": "*"}
            else:
                binding = {
                    "kind": "named",
                    "local": alias.asname or alias.name,
                    "imported": alias.name,
                }
            self.add_import(specifier, binding, level=node.level, module=node.module)

    def visit_Await(self, node):
        self.await_depth += 1
        self.generic_visit(node)
        self.await_depth -= 1

    def visit_Call(self, node):
        callee_name = None
        qualifier = None
        if isinstance(node.func, ast.Name):
            callee_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            callee_name = node.func.attr
            qualifier = expression_name(node.func.value)
        if callee_name:
            owner = self.owner_stack[-1] if self.owner_stack else None
            self.calls.append({
                "calleeName": callee_name,
                "qualifier": qualifier,
                "ownerInternalId": owner["internalId"] if owner else None,
                "ownerQualifiedName": owner["qualifiedName"] if owner else None,
                "callLine": getattr(node, "lineno", None),
                "syntax": "call",
                "awaited": self.await_depth > 0,
            })
        self.generic_visit(node)


analyzer = Analyzer(tree)
analyzer.visit(tree)
print(json.dumps({
    "ok": True,
    "definitions": analyzer.definitions,
    "imports": analyzer.imports,
    "calls": analyzer.calls,
    "apiOperations": [],
}, ensure_ascii=False, separators=(",", ":")))
`;

let cachedRuntime;

function parserDiagnostic(message, code, reasonCode, line = null, column = null) {
  return {
    message: String(message),
    code,
    reason_code: reasonCode,
    line,
    column,
  };
}

function configuredExecutable() {
  const value = process.env.GRAPHWARD_PYTHON?.trim();
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function candidateRuntimes() {
  const configured = configuredExecutable();
  const candidates = [];
  if (configured) candidates.push({ command: configured, args: [], configured: true });
  if (process.platform === "win32") candidates.push({ command: "py", args: ["-3"] });
  candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  const unique = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.command, candidate.args]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function probeRuntime(candidate) {
  const probe = spawnSync(candidate.command, [
    ...candidate.args,
    "-S",
    "-c",
    "import json,sys; print(json.dumps({'version': list(sys.version_info[:3])}))",
  ], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 3_000,
    maxBuffer: 64 * 1024,
  });
  if (probe.error || probe.status !== 0) return null;
  try {
    const value = JSON.parse(probe.stdout.trim());
    const version = Array.isArray(value.version) ? value.version.map(Number) : [];
    if (version.length < 2 || !version.every(Number.isInteger)) return null;
    if (version[0] < MINIMUM_PYTHON[0]
      || (version[0] === MINIMUM_PYTHON[0] && version[1] < MINIMUM_PYTHON[1])) return null;
    return {
      command: candidate.command,
      args: [...candidate.args],
      configured: Boolean(candidate.configured),
      version: version.join("."),
    };
  } catch {
    return null;
  }
}

/**
 * Returns the cached compatible CPython command, or null when none is present.
 * GRAPHWARD_PYTHON may contain an exact executable path (not shell arguments).
 */
export function detectPythonExecutable() {
  if (cachedRuntime !== undefined) return cachedRuntime ? { ...cachedRuntime, args: [...cachedRuntime.args] } : null;
  cachedRuntime = null;
  for (const candidate of candidateRuntimes()) {
    const runtime = probeRuntime(candidate);
    if (runtime) {
      cachedRuntime = runtime;
      break;
    }
    // An explicit invalid override must not disable the safe standard probes.
  }
  return cachedRuntime ? { ...cachedRuntime, args: [...cachedRuntime.args] } : null;
}

function parserFailure(error, mode, runtime = null) {
  return {
    ok: false,
    error,
    parser: {
      mode,
      diagnostics: [error],
      implementation: "cpython-ast",
      runtime,
    },
  };
}

function parserTimeout() {
  const configured = Number.parseInt(process.env.GRAPHWARD_PYTHON_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, configured));
}

function parserBufferSize(content) {
  const estimated = Buffer.byteLength(content, "utf8") * 12 + 256 * 1024;
  return Math.max(MIN_BUFFER_BYTES, Math.min(MAX_BUFFER_BYTES, estimated));
}

/**
 * Parses one Python source file into the structured adapter consumed by
 * languages.parseSource. The function never throws for an interpreter or
 * source failure; callers can use the existing heuristic parser when ok=false.
 */
export function parsePythonSource(content, relativePath = "<unknown>") {
  if (typeof content !== "string") {
    const error = parserDiagnostic(
      "Python source must be a string",
      "PYTHON_INVALID_INPUT",
      "python-invalid-input",
    );
    return parserFailure(error, "python-invalid-input");
  }

  const runtime = detectPythonExecutable();
  if (!runtime) {
    const error = parserDiagnostic(
      "No compatible Python interpreter was found. Install Python 3.8+ or set GRAPHWARD_PYTHON to an exact executable path.",
      "PYTHON_UNAVAILABLE",
      "python-executable-unavailable",
    );
    return parserFailure(error, "python-unavailable");
  }

  const runtimeDetails = {
    executable: runtime.command,
    arguments: runtime.args,
    version: runtime.version,
  };
  const result = spawnSync(runtime.command, [
    ...runtime.args,
    "-S",
    "-c",
    PYTHON_HELPER,
    String(relativePath || "<unknown>"),
  ], {
    input: content,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: parserTimeout(),
    maxBuffer: parserBufferSize(content),
  });

  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    const error = parserDiagnostic(
      timedOut ? `Python AST parsing exceeded ${parserTimeout()}ms` : result.error.message,
      timedOut ? "PYTHON_AST_TIMEOUT" : "PYTHON_PROCESS_ERROR",
      timedOut ? "python-ast-timeout" : "python-process-error",
    );
    return parserFailure(error, "python-ast-error", runtimeDetails);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const error = parserDiagnostic(
      stderr || `Python parser exited with status ${result.status}`,
      "PYTHON_PROCESS_EXIT",
      "python-process-exit",
    );
    return parserFailure(error, "python-ast-error", runtimeDetails);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const diagnostic = parserDiagnostic(
      `Python parser returned invalid JSON: ${error.message}`,
      "PYTHON_PROTOCOL_ERROR",
      "python-protocol-error",
    );
    return parserFailure(diagnostic, "python-ast-error", runtimeDetails);
  }
  if (!parsed?.ok) {
    const error = parsed?.error ?? parserDiagnostic(
      "Python parser failed without a diagnostic",
      "PYTHON_AST_ERROR",
      "python-ast-error",
    );
    return parserFailure(error, "python-ast-error", runtimeDetails);
  }

  return {
    ok: true,
    definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
    imports: Array.isArray(parsed.imports) ? parsed.imports : [],
    calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    apiOperations: Array.isArray(parsed.apiOperations) ? parsed.apiOperations : [],
    parser: {
      mode: "python-ast",
      diagnostics: [],
      implementation: "cpython-ast",
      runtime: runtimeDetails,
    },
  };
}
