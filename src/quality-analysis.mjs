import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "@babel/parser";
import { detectPythonExecutable } from "./python-parser.mjs";

const CALLABLE_KINDS = new Set(["Function", "Method", "Constructor"]);
const DEAD_CODE_KINDS = new Set(["Function", "Method", "Constructor", "Class"]);
const SUPPORTED_COMPLEXITY_LANGUAGES = new Set(["javascript", "typescript", "python"]);
const MAX_FINDINGS = 5_000;
const DEFAULT_MAX_ANALYSIS_SYMBOLS = 5_000;
const MAX_ANALYSIS_SYMBOLS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const MAX_SINGLE_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_NODES = 50_000;
const DEFAULT_MAX_GRAPH_EDGES = 100_000;
const MAX_GRAPH_EDGES = 250_000;
const COMPLEXITY_COUNTING_RULES = {
  cyclomatic: {
    baseline_per_callable: 1,
    increments: [
      "if and else-if", "for/for-in/for-of/while/do-while", "catch/except handler",
      "tested switch or match case", "ternary/conditional expression",
      "each &&, ||, or ?? expression", "each Python boolean operand after the first",
      "each Python comprehension generator and filter",
    ],
    exclusions: ["plain else", "try/finally", "nested callable bodies", "class bodies"],
  },
  cognitive: {
    increments: [
      "one plus current nesting for if, loops, catch/except, switch/match, and conditional expressions",
      "one when a logical sequence begins or changes operator, one for else, labeled break/continue, and direct recursion",
      "one plus nesting for Python comprehensions and filters",
    ],
    nesting: "Control-structure bodies increase nesting; else-if chains do not add an extra nesting level.",
    exclusions: ["nested callable bodies", "ordinary sequential statements"],
  },
  recursion_detection: "Bare self-calls plus this.method(...) in JS/TS and self/cls method calls in Python; aliases and class-qualified static recursion are not inferred.",
};
const DEAD_CODE_EXCLUSION_RULES = {
  exported_or_public_api: "Symbol is explicitly exported/public.",
  export_or_type_contract: "Symbol participates in an export, inheritance, implementation, override, or indexed type contract.",
  route_or_handler: "Symbol owns a route or is named as a statically recovered route handler.",
  entry_point_file: "Symbol is in a conventional main/index/app/server/CLI/worker/bin entry-point file.",
  test_or_fixture_file: "Symbol is in a test/spec/fixture path where runner discovery can be implicit.",
  framework_hook_name: "Name matches a framework lifecycle, route verb, test hook, dunder, useX, or onX convention.",
  constructor_or_initializer: "Constructors and language initializers are reached through class construction rather than direct symbol calls.",
  observed_incoming_relationship: "At least one resolved incoming graph relationship exists.",
  dynamic_dispatch_or_unresolved_call: "An unresolved/ambiguous call uses the same callee name.",
  reflection_or_registry_string: "A reflection, dependency-container, or registry body contains the symbol name as a string.",
};
const FRAMEWORK_HOOKS = new Set([
  "main", "handler", "lambda_handler", "middleware", "loader", "action", "render",
  "setup", "mounted", "created", "destroyed", "beforeEach", "afterEach",
  "beforeAll", "afterAll", "setUp", "tearDown", "getServerSideProps",
  "getStaticProps", "getStaticPaths", "generateMetadata", "generateStaticParams",
  "componentDidMount", "componentDidUpdate", "componentWillUnmount",
  "connectedCallback", "disconnectedCallback", "attributeChangedCallback",
  "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD",
]);

const PYTHON_COMPLEXITY_HELPER = String.raw`
import ast
import json
import sys
import textwrap

items = json.load(sys.stdin)


def metric(item):
    source = textwrap.dedent(item.get("body") or "")
    try:
        tree = ast.parse(source, filename=item.get("file_path") or "<quality>", type_comments=True)
    except SyntaxError as error:
        return {
            "ok": False,
            "diagnostic": {
                "message": error.msg,
                "line": error.lineno,
                "column": max(0, error.offset - 1) if error.offset else None,
            },
        }
    callables = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    root = next((node for node in callables if node.name == item.get("name")), callables[0] if callables else None)
    if root is None:
        return {"ok": False, "diagnostic": {"message": "No Python callable was found in the stored symbol body", "line": None, "column": None}}

    cyclomatic = 1
    cognitive = 0
    points = {}

    def add(name, cyclo=0, cognition=0):
        nonlocal cyclomatic, cognitive
        cyclomatic += cyclo
        cognitive += cognition
        points[name] = points.get(name, 0) + 1

    def children(node, nesting):
        for child in ast.iter_child_nodes(node):
            visit(child, nesting)

    match_node = getattr(ast, "Match", ())
    match_as_node = getattr(ast, "MatchAs", ())
    try_star_node = getattr(ast, "TryStar", ())

    def visit(node, nesting=0):
        if node is not root and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            return
        if isinstance(node, ast.If):
            add("if", 1, 1 + nesting)
            visit(node.test, nesting)
            for statement in node.body:
                visit(statement, nesting + 1)
            if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                visit(node.orelse[0], nesting)
            elif node.orelse:
                add("else", 0, 1)
                for statement in node.orelse:
                    visit(statement, nesting + 1)
            return
        if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
            add("loop", 1, 1 + nesting)
            for child in (getattr(node, "target", None), getattr(node, "iter", None), getattr(node, "test", None)):
                if child is not None:
                    visit(child, nesting)
            for statement in node.body:
                visit(statement, nesting + 1)
            if node.orelse:
                add("loop_else", 0, 1)
                for statement in node.orelse:
                    visit(statement, nesting + 1)
            return
        if isinstance(node, (ast.Try, try_star_node) if try_star_node else ast.Try):
            for statement in node.body:
                visit(statement, nesting)
            for handler in node.handlers:
                add("except", 1, 1 + nesting)
                for statement in handler.body:
                    visit(statement, nesting + 1)
            for statement in node.orelse:
                visit(statement, nesting)
            for statement in node.finalbody:
                visit(statement, nesting)
            return
        if isinstance(node, ast.BoolOp):
            amount = max(0, len(node.values) - 1)
            if amount:
                cyclomatic_add = amount
                cognitive_add = 1
                cyclomatic_nonlocal[0] += cyclomatic_add
                cognitive_nonlocal[0] += cognitive_add
                points["boolean_operator"] = points.get("boolean_operator", 0) + amount
            for value in node.values:
                visit(value, nesting)
            return
        if isinstance(node, ast.IfExp):
            add("conditional_expression", 1, 1 + nesting)
            children(node, nesting + 1)
            return
        if match_node and isinstance(node, match_node):
            add("match", 0, 1 + nesting)
            for case in node.cases:
                wildcard = bool(match_as_node) and isinstance(case.pattern, match_as_node) and case.pattern.name is None and case.pattern.pattern is None
                if not wildcard or case.guard is not None:
                    add("match_case", 1, 0)
                if case.guard is not None:
                    visit(case.guard, nesting + 1)
                for statement in case.body:
                    visit(statement, nesting + 1)
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            for generator in node.generators:
                add("comprehension", 1, 1 + nesting)
                visit(generator.target, nesting + 1)
                visit(generator.iter, nesting + 1)
                for condition in generator.ifs:
                    add("comprehension_if", 1, 1 + nesting)
                    visit(condition, nesting + 1)
            if isinstance(node, ast.DictComp):
                visit(node.key, nesting + 1)
                visit(node.value, nesting + 1)
            else:
                visit(node.elt, nesting + 1)
            return
        if isinstance(node, (ast.Break, ast.Continue)):
            add("jump", 0, 1)
            return
        if isinstance(node, ast.Call):
            recursive = isinstance(node.func, ast.Name) and node.func.id == root.name
            recursive = recursive or (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == root.name
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in ("self", "cls")
            )
            if recursive:
                add("recursion", 0, 1)
        children(node, nesting)

    # Python has no nonlocal assignment target for arbitrary arithmetic in the
    # BoolOp branch, so use one-element holders and fold them after traversal.
    cyclomatic_nonlocal = [0]
    cognitive_nonlocal = [0]
    visit(root, 0)
    cyclomatic += cyclomatic_nonlocal[0]
    cognitive += cognitive_nonlocal[0]
    return {
        "ok": True,
        "cyclomatic": cyclomatic,
        "cognitive": cognitive,
        "decision_points": points,
        "parser": "cpython-ast",
    }


print(json.dumps({item["id"]: metric(item) for item in items}, ensure_ascii=False, separators=(",", ":")))
`;

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function resolveRepository(db, repoId = null) {
  if (repoId != null) {
    const row = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(String(repoId));
    if (!row) throw new Error(`Repository not found: ${repoId}`);
    return row;
  }
  const rows = db.prepare("SELECT * FROM repositories ORDER BY id").all();
  if (rows.length !== 1) throw new Error("repoId is required when the database contains zero or multiple repositories");
  return rows[0];
}

function capped(value, fallback = 100, maximum = MAX_FINDINGS) {
  const number = Number(value);
  return Math.max(1, Math.min(maximum, Number.isFinite(number) ? Math.trunc(number) : fallback));
}

function requestedNumber(value, fallback) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? fallback : number;
}

function nonNegativeNumber(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`);
  return number;
}

function analysisCaps({ maxSymbols = DEFAULT_MAX_ANALYSIS_SYMBOLS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return {
    max_symbols: capped(maxSymbols, DEFAULT_MAX_ANALYSIS_SYMBOLS, MAX_ANALYSIS_SYMBOLS),
    max_body_bytes: capped(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES),
    max_single_body_bytes: MAX_SINGLE_BODY_BYTES,
  };
}

function boundBodyRows(rows, caps) {
  const selected = [];
  let bodyBytes = 0;
  let skippedByBytes = 0;
  let skippedOversizedBodies = 0;
  for (const row of rows.slice(0, caps.max_symbols)) {
    const bytes = Buffer.byteLength(row.body_text ?? "", "utf8");
    if (bytes > MAX_SINGLE_BODY_BYTES) {
      skippedByBytes += 1;
      skippedOversizedBodies += 1;
      continue;
    }
    if (bodyBytes + bytes > caps.max_body_bytes) {
      skippedByBytes += 1;
      continue;
    }
    selected.push(row);
    bodyBytes += bytes;
  }
  return {
    rows: selected,
    body_bytes: bodyBytes,
    skipped_by_symbol_limit: Math.max(0, Number(rows[0]?.total_rows ?? rows.length) - caps.max_symbols),
    skipped_by_body_limit: skippedByBytes,
    skipped_by_individual_body_limit: skippedOversizedBodies,
    truncated: rows.length > caps.max_symbols || skippedByBytes > 0,
  };
}

function symbolRows(db, repository, {
  filePath = null, language = null, kinds = CALLABLE_KINDS, maximum = 100_000,
  stratifyByLanguage = false, supportedOnly = false,
} = {}) {
  const clauses = ["s.repo_id = ?"];
  const params = [repository.id];
  if (filePath) {
    clauses.push("(f.path = ? OR f.path LIKE ?)");
    const normalized = String(filePath).replaceAll("\\", "/").replace(/\/$/, "");
    params.push(normalized, `${normalized}/%`);
  }
  if (language) {
    clauses.push("f.language = ?");
    params.push(language);
  } else if (supportedOnly) {
    clauses.push(`f.language IN (${[...SUPPORTED_COMPLEXITY_LANGUAGES].map(() => "?").join(",")})`);
    params.push(...SUPPORTED_COMPLEXITY_LANGUAGES);
  }
  if (kinds?.size) {
    clauses.push(`s.kind IN (${[...kinds].map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  const languageRank = stratifyByLanguage
    ? ", ROW_NUMBER() OVER (PARTITION BY f.language ORDER BY f.path, s.start_line, s.id) AS language_rank"
    : "";
  const ordering = stratifyByLanguage ? "language_rank, f.language, f.path, s.start_line, s.id" : "f.path, s.start_line, s.id";
  return db.prepare(`
    SELECT s.*, f.path AS file_path, f.language,
      fd.parser_mode, fd.diagnostic_count, COUNT(*) OVER() AS total_rows${languageRank}
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    LEFT JOIN file_diagnostics fd ON fd.file_id = f.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY ${ordering}
    LIMIT ?
  `).all(...params, maximum);
}

function babelPlugins(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const plugins = ["jsx", "decorators-legacy", "importAttributes", "explicitResourceManagement"];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  return plugins;
}

function astChildren(node) {
  const result = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) result.push(...value.filter((item) => item && typeof item.type === "string"));
    else if (value && typeof value.type === "string") result.push(value);
  }
  return result;
}

function jsCallableName(node, parent = null) {
  if (node?.id?.name) return node.id.name;
  if (node?.key?.name) return node.key.name;
  if (typeof node?.key?.value === "string") return node.key.value;
  if (parent?.type === "VariableDeclarator" && parent.id?.name) return parent.id.name;
  if (["ObjectProperty", "ClassProperty", "ClassPrivateProperty"].includes(parent?.type)) {
    if (parent.key?.name) return parent.key.name;
    if (typeof parent.key?.value === "string") return parent.key.value;
  }
  return null;
}

function findJsCallable(ast, expectedName) {
  let first = null;
  const visit = (node, parent = null) => {
    if (!node || first?.exact) return;
    if ([
      "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
      "ClassMethod", "ClassPrivateMethod", "ObjectMethod",
    ].includes(node.type)) {
      const candidate = { node, name: jsCallableName(node, parent), exact: jsCallableName(node, parent) === expectedName };
      if (candidate.exact) {
        first = candidate;
        return;
      }
      if (!first) first = candidate;
    }
    for (const child of astChildren(node)) visit(child, node);
  };
  visit(ast.program ?? ast);
  return first;
}

function jsMetric(symbol) {
  const method = ["Method", "Constructor"].includes(symbol.kind);
  const sources = method
    ? [
      { context: "class-member", source: `class __GraphwardQuality__ extends Object {\n${symbol.body_text}\n}` },
      { context: "object-member", source: `const __GraphwardQuality__ = {\n${symbol.body_text}\n};` },
      { context: "array-element", source: `const __GraphwardQuality__ = [\n${symbol.body_text}\n];` },
      { context: "expression-suffix", source: `const __GraphwardQualityResult__ = __GraphwardQuality__\n${symbol.body_text}\n;` },
      { context: "conditional-consequent", source: `const __GraphwardQuality__ = __GraphwardQualityCondition__\n${symbol.body_text}\n: null;` },
      { context: "conditional-alternate", source: `const __GraphwardQuality__ = __GraphwardQualityCondition__ ? null\n${symbol.body_text}\n;` },
      { context: "callback-conditional-consequent", source: `__GraphwardQualityCallback__(__GraphwardQualityCondition__\n${symbol.body_text}` },
      { context: "callback-conditional-alternate", source: `__GraphwardQualityCallback__(__GraphwardQualityCondition__ ? null\n${symbol.body_text}` },
      { context: "raw", source: symbol.body_text },
    ]
    : [{ context: "raw", source: symbol.body_text }];
  let callable = null;
  let parserContext = null;
  const parserAttempts = [];
  for (const attempt of sources) {
    try {
      const ast = parse(attempt.source, {
        sourceType: "unambiguous",
        errorRecovery: false,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        plugins: babelPlugins(symbol.file_path),
      });
      callable = findJsCallable(ast, symbol.name);
      if (callable) {
        parserContext = attempt.context;
        break;
      }
      parserAttempts.push({ context: attempt.context, message: "No callable found", line: null, column: null });
    } catch (error) {
      parserAttempts.push({
        context: attempt.context,
        message: String(error?.message ?? error),
        line: error?.loc?.line ?? null,
        column: error?.loc?.column ?? null,
      });
    }
  }
  if (!callable) {
    return {
      ok: false,
      diagnostic: {
        message: "Stored JavaScript callable body could not be parsed in any supported callable-fragment context",
        attempts: parserAttempts,
      },
    };
  }
  const root = callable.node;
  const points = {};
  let cyclomatic = 1;
  let cognitive = 0;
  const add = (name, cyclo = 0, cognition = 0, occurrences = 1) => {
    cyclomatic += cyclo;
    cognitive += cognition;
    points[name] = (points[name] ?? 0) + occurrences;
  };
  const visitChildren = (node, nesting) => {
    for (const child of astChildren(node)) visit(child, nesting, null);
  };
  const visit = (node, nesting = 0, logicalParentOperator = null) => {
    if (!node) return;
    if (node !== root && [
      "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
      "ClassMethod", "ClassPrivateMethod", "ObjectMethod", "ClassDeclaration", "ClassExpression",
    ].includes(node.type)) return;
    if (node.type === "IfStatement") {
      add("if", 1, 1 + nesting);
      visit(node.test, nesting);
      visit(node.consequent, nesting + 1);
      if (node.alternate?.type === "IfStatement") visit(node.alternate, nesting);
      else if (node.alternate) {
        add("else", 0, 1);
        visit(node.alternate, nesting + 1);
      }
      return;
    }
    if (["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(node.type)) {
      add("loop", 1, 1 + nesting);
      for (const child of [node.init, node.left, node.right, node.test, node.update]) visit(child, nesting);
      visit(node.body, nesting + 1);
      return;
    }
    if (node.type === "SwitchStatement") {
      add("switch", 0, 1 + nesting);
      visit(node.discriminant, nesting);
      for (const item of node.cases) {
        if (item.test) {
          add("switch_case", 1, 0);
          visit(item.test, nesting + 1);
        }
        for (const statement of item.consequent) visit(statement, nesting + 1);
      }
      return;
    }
    if (node.type === "CatchClause") {
      add("catch", 1, 1 + nesting);
      visit(node.param, nesting);
      visit(node.body, nesting + 1);
      return;
    }
    if (node.type === "ConditionalExpression") {
      add("conditional_expression", 1, 1 + nesting);
      visitChildren(node, nesting + 1);
      return;
    }
    if (node.type === "LogicalExpression" && ["&&", "||", "??"].includes(node.operator)) {
      add(`logical_${node.operator}`, 1, logicalParentOperator === node.operator ? 0 : 1);
      for (const child of astChildren(node)) visit(child, nesting, node.operator);
      return;
    }
    if (["BreakStatement", "ContinueStatement"].includes(node.type) && node.label) add("labeled_jump", 0, 1);
    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const recursive = node.callee?.type === "Identifier" && node.callee.name === symbol.name;
      const recursiveMember = ["MemberExpression", "OptionalMemberExpression"].includes(node.callee?.type)
        && node.callee.object?.type === "ThisExpression"
        && (node.callee.property?.name === symbol.name || node.callee.property?.value === symbol.name);
      if (recursive || recursiveMember) add("recursion", 0, 1);
    }
    visitChildren(node, nesting);
  };
  visit(root, 0);
  return { ok: true, cyclomatic, cognitive, decision_points: points, parser: "babel-ast", parser_context: parserContext };
}

function pythonMetrics(symbols) {
  if (!symbols.length) return { metrics: new Map(), diagnostics: [] };
  const runtime = detectPythonExecutable();
  if (!runtime) {
    return {
      metrics: new Map(),
      diagnostics: [{ code: "PYTHON_UNAVAILABLE", message: "Python complexity requires Python 3.8+", level: "warning" }],
    };
  }
  const input = symbols.map((symbol) => ({
    id: String(symbol.id), name: symbol.name, kind: symbol.kind,
    file_path: symbol.file_path, body: symbol.body_text,
  }));
  const maxBuffer = Math.max(1024 * 1024, Buffer.byteLength(JSON.stringify(input), "utf8") * 3);
  const result = spawnSync(runtime.command, [
    ...runtime.args, "-S", "-c", PYTHON_COMPLEXITY_HELPER,
  ], {
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    return {
      metrics: new Map(),
      diagnostics: [{
        code: result.error?.code === "ETIMEDOUT" ? "PYTHON_COMPLEXITY_TIMEOUT" : "PYTHON_COMPLEXITY_FAILED",
        message: result.error?.message ?? result.stderr?.trim() ?? `Python exited with status ${result.status}`,
        level: "warning",
      }],
    };
  }
  try {
    return { metrics: new Map(Object.entries(JSON.parse(result.stdout))), diagnostics: [] };
  } catch (error) {
    return {
      metrics: new Map(),
      diagnostics: [{ code: "PYTHON_COMPLEXITY_PROTOCOL", message: error.message, level: "warning" }],
    };
  }
}

function complexityFinding(symbol, metric) {
  const lineCount = Math.max(1, Number(symbol.end_line) - Number(symbol.start_line) + 1);
  if (!metric?.ok) {
    return {
      symbol: symbol.name,
      qualified_name: symbol.qualified_name,
      stable_key: symbol.stable_key,
      kind: symbol.kind,
      file_path: symbol.file_path,
      language: symbol.language,
      available: false,
      cyclomatic_complexity: null,
      cognitive_complexity: null,
      evidence: { parser: symbol.parser_mode ?? "unknown", diagnostic: metric?.diagnostic ?? null, lines: lineCount },
      confidence: 0,
      caveats: ["The stored symbol body could not be parsed, so no complexity score was estimated."],
    };
  }
  return {
    symbol: symbol.name,
    qualified_name: symbol.qualified_name,
    stable_key: symbol.stable_key,
    kind: symbol.kind,
    file_path: symbol.file_path,
    language: symbol.language,
    available: true,
    cyclomatic_complexity: metric.cyclomatic,
    cognitive_complexity: metric.cognitive,
    lines: lineCount,
    density: Number(((metric.cyclomatic + metric.cognitive) / lineCount).toFixed(3)),
    evidence: {
      parser: metric.parser,
      parser_context: metric.parser_context ?? "raw",
      decision_points: metric.decision_points,
      indexed_parser_mode: symbol.parser_mode ?? null,
      lines: lineCount,
    },
    confidence: symbol.diagnostic_count ? 0.9 : 0.97,
    caveats: [
      "Cyclomatic counting follows common branch/operator rules; cognitive complexity is a transparent Sonar-style approximation.",
      "Nested callable bodies are scored separately and excluded from their parent callable.",
      "Direct recursion recognizes bare self-calls and this/self/cls member calls; aliased or class-qualified recursion may be missed.",
    ],
  };
}

function computeComplexities(rows) {
  const python = rows.filter((row) => row.language === "python");
  const pythonResult = pythonMetrics(python);
  const findings = [];
  let parseFailures = 0;
  let unsupported = 0;
  for (const row of rows) {
    let metric;
    if (row.language === "python") metric = pythonResult.metrics.get(String(row.id));
    else if (row.language === "javascript" || row.language === "typescript") metric = jsMetric(row);
    else {
      unsupported += 1;
      continue;
    }
    const finding = complexityFinding(row, metric);
    if (!finding.available) parseFailures += 1;
    findings.push(finding);
  }
  return { findings, diagnostics: pythonResult.diagnostics, parseFailures, unsupported };
}

/** AST-backed JS/TS and Python callable complexity. */
export function analyzeComplexity(db, {
  repoId = null, filePath = null, language = null,
  minimumCyclomatic = 1, minimumCognitive = 0, includeUnavailable = false, limit = 100,
  maxSymbols = DEFAULT_MAX_ANALYSIS_SYMBOLS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const analysisLimits = analysisCaps({ maxSymbols, maxBodyBytes });
  const boundedRows = boundBodyRows(symbolRows(db, repository, {
    filePath, language, maximum: analysisLimits.max_symbols + 1,
  }), analysisLimits);
  const rows = boundedRows.rows;
  const computed = computeComplexities(rows);
  const appliedLimit = capped(limit);
  const cyclomaticThreshold = nonNegativeNumber(minimumCyclomatic, 1, "minimumCyclomatic");
  const cognitiveThreshold = nonNegativeNumber(minimumCognitive, 0, "minimumCognitive");
  const supportedRows = rows.filter((row) => SUPPORTED_COMPLEXITY_LANGUAGES.has(row.language)).length;
  const findings = computed.findings
    .filter((finding) => includeUnavailable && !finding.available
      || finding.available
        && finding.cyclomatic_complexity >= cyclomaticThreshold
        && finding.cognitive_complexity >= cognitiveThreshold)
    .sort((a, b) => (
      Number(b.available) - Number(a.available)
      || (b.cognitive_complexity ?? -1) - (a.cognitive_complexity ?? -1)
      || (b.cyclomatic_complexity ?? -1) - (a.cyclomatic_complexity ?? -1)
      || a.stable_key.localeCompare(b.stable_key)
    ));
  return {
    repo_id: repository.repo_id,
    findings: findings.slice(0, appliedLimit),
    coverage: {
      callable_symbols: rows.length,
      supported_symbols: supportedRows,
      unsupported_symbols: computed.unsupported,
      parse_failures: computed.parseFailures,
      supported_languages: [...SUPPORTED_COMPLEXITY_LANGUAGES],
      body_bytes_analyzed: boundedRows.body_bytes,
      symbols_skipped_by_limit: boundedRows.skipped_by_symbol_limit,
      symbols_skipped_by_body_limit: boundedRows.skipped_by_body_limit,
      symbols_skipped_by_individual_body_limit: boundedRows.skipped_by_individual_body_limit,
    },
    truncated: findings.length > appliedLimit || boundedRows.truncated,
    limits: {
      findings: { requested: requestedNumber(limit, 100), applied: appliedLimit, maximum: MAX_FINDINGS },
      analysis: { ...analysisLimits, maximum_symbols: MAX_ANALYSIS_SYMBOLS, maximum_body_bytes: MAX_BODY_BYTES },
    },
    diagnostics: computed.diagnostics,
    methodology: "Babel AST for JS/TS and one batched CPython ast process for Python. Nested callables are excluded from parent scores.",
    counting_rules: COMPLEXITY_COUNTING_RULES,
  };
}

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  add(value) {
    if (value && !this.parent.has(value)) this.parent.set(value, value);
  }

  find(value) {
    this.add(value);
    const parent = this.parent.get(value);
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value);
  }

  union(left, right) {
    if (!left || !right) return;
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(b, a);
  }
}

function churnByStableKey(db, repository) {
  let source = "none";
  let rows = [];
  let confidence = 0.45;
  const diagnostics = { invalid_timestamps: 0, unknown_change_types: 0 };
  const withValidTimestamps = (values) => values.filter((row) => {
    if (Number.isFinite(Date.parse(row.reference_time))) return true;
    diagnostics.invalid_timestamps += 1;
    return false;
  });
  if (tableExists(db, "temporal_entity_changes") && tableExists(db, "temporal_episodes")) {
    rows = withValidTimestamps(db.prepare(`
      SELECT ec.stable_key, ec.previous_stable_key, ec.change_type, ep.reference_time
      FROM temporal_entity_changes ec
      JOIN temporal_episodes ep ON ep.id = ec.episode_id
      WHERE ec.repo_id = ? AND ec.entity_type = 'symbol'
      ORDER BY ep.sequence, ec.id
    `).all(repository.id));
    if (rows.length) {
      source = "temporal";
      confidence = 0.94;
    }
  }
  if (!rows.length && tableExists(db, "episode_changes") && tableExists(db, "episodes")) {
    rows = withValidTimestamps(db.prepare(`
      SELECT ec.stable_key, NULL AS previous_stable_key, ec.change_type, ep.reference_time
      FROM episode_changes ec
      JOIN episodes ep ON ep.id = ec.episode_id
      WHERE ep.repo_id = ? AND ec.entity_type = 'symbol'
      ORDER BY ep.reference_time, ep.id, ec.id
    `).all(repository.id));
    if (rows.length) {
      source = "legacy";
      confidence = 0.78;
    }
  }
  const dsu = new DisjointSet();
  for (const row of rows) {
    dsu.add(row.stable_key);
    if (row.previous_stable_key) dsu.union(row.stable_key, row.previous_stable_key);
  }
  const referenceMs = rows.reduce((maximum, row) => Math.max(maximum, Date.parse(row.reference_time)), 0)
    || Date.parse(repository.indexed_at) || 0;
  const components = new Map();
  for (const row of rows) {
    const root = dsu.find(row.stable_key);
    const item = components.get(root) ?? { events: 0, weighted: 0, lastChanged: null, types: {} };
    const eventMs = Date.parse(row.reference_time);
    const ageDays = Math.max(0, (referenceMs - eventMs) / 86_400_000);
    const recency = 0.5 ** (ageDays / 90);
    const typeWeight = row.change_type === "modified" ? 1 : row.change_type === "renamed" ? 0.75 : 0.5;
    if (!new Set(["added", "modified", "removed", "renamed"]).has(row.change_type)) diagnostics.unknown_change_types += 1;
    item.events += 1;
    item.weighted += typeWeight * recency;
    item.types[row.change_type] = (item.types[row.change_type] ?? 0) + 1;
    if (!item.lastChanged || eventMs > Date.parse(item.lastChanged)) item.lastChanged = new Date(eventMs).toISOString();
    components.set(root, item);
  }
  const result = new Map();
  for (const key of dsu.parent.keys()) result.set(key, components.get(dsu.find(key)) ?? { events: 0, weighted: 0, lastChanged: null, types: {} });
  return { byKey: result, source, confidence, referenceTime: new Date(referenceMs).toISOString(), diagnostics };
}

/** Complexity multiplied by recency-decayed symbol churn. */
export function getChurnWeightedHotspots(db, {
  repoId = null, filePath = null, language = null, minimumScore = 0, limit = 50,
  maxSymbols = DEFAULT_MAX_ANALYSIS_SYMBOLS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const analysisLimits = analysisCaps({ maxSymbols, maxBodyBytes });
  const boundedRows = boundBodyRows(symbolRows(db, repository, {
    filePath, language, maximum: analysisLimits.max_symbols + 1,
  }), analysisLimits);
  const rows = boundedRows.rows;
  const computed = computeComplexities(rows);
  const churn = churnByStableKey(db, repository);
  const appliedLimit = capped(limit);
  const scoreThreshold = nonNegativeNumber(minimumScore, 0, "minimumScore");
  const findings = computed.findings.filter((item) => item.available).map((complexity) => {
    const history = churn.byKey.get(complexity.stable_key) ?? { events: 0, weighted: 0, lastChanged: null, types: {} };
    const structural = complexity.cyclomatic_complexity + complexity.cognitive_complexity;
    const score = structural * Math.log2(2 + history.weighted);
    return {
      ...complexity,
      hotspot_score: Number(score.toFixed(3)),
      churn_events: history.events,
      weighted_churn: Number(history.weighted.toFixed(3)),
      last_changed: history.lastChanged,
      evidence: {
        ...complexity.evidence,
        history_source: churn.source,
        event_types: history.types,
        churn_reference_time: churn.referenceTime,
        formula: "(cyclomatic + cognitive) * log2(2 + 90-day-half-life weighted churn)",
        history_diagnostics: churn.diagnostics,
      },
      confidence: Number(Math.min(complexity.confidence, churn.confidence).toFixed(2)),
      caveats: [
        ...complexity.caveats,
        churn.source === "none"
          ? "No temporal or legacy symbol episodes were available; ranking is complexity-only."
          : "Churn covers only the locally ingested history horizon.",
      ],
    };
  }).filter((item) => item.hotspot_score >= scoreThreshold)
    .sort((a, b) => b.hotspot_score - a.hotspot_score || b.cognitive_complexity - a.cognitive_complexity || a.stable_key.localeCompare(b.stable_key));
  return {
    repo_id: repository.repo_id,
    findings: findings.slice(0, appliedLimit),
    history_source: churn.source,
    history_diagnostics: churn.diagnostics,
    truncated: findings.length > appliedLimit || boundedRows.truncated,
    limits: {
      findings: { requested: requestedNumber(limit, 50), applied: appliedLimit, maximum: MAX_FINDINGS },
      analysis: {
        ...analysisLimits,
        body_bytes_analyzed: boundedRows.body_bytes,
        symbols_skipped_by_limit: boundedRows.skipped_by_symbol_limit,
        symbols_skipped_by_body_limit: boundedRows.skipped_by_body_limit,
        symbols_skipped_by_individual_body_limit: boundedRows.skipped_by_individual_body_limit,
      },
    },
    diagnostics: computed.diagnostics,
    methodology: "AST complexity weighted by recency-decayed temporal churn; temporal lineage is joined across explicit rename events.",
    counting_rules: COMPLEXITY_COUNTING_RULES,
  };
}

export const getQualityHotspots = getChurnWeightedHotspots;

function isTestPath(filePath) {
  return /(^|\/)(?:test|tests|__tests__|spec|specs|fixture|fixtures)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(filePath);
}

function isEntryPath(filePath) {
  return /(^|\/)(?:index|main|app|server|cli|entry|worker)\.[^.]+$/i.test(filePath)
    || /(^|\/)bin\//i.test(filePath);
}

function isFrameworkHook(name) {
  return FRAMEWORK_HOOKS.has(name)
    || /^__.*__$/.test(name)
    || /^(?:test|pytest)_/.test(name)
    || /^(?:use[A-Z]|on[A-Z])/.test(name);
}

function reflectionNames(rows) {
  const evidence = new Map();
  const marker = /\b(?:getattr|setattr|hasattr|Reflect\.(?:get|set|apply)|getOwnProperty|registry|container\.(?:get|resolve)|inject|lookup)\b/;
  const strings = /["']([A-Za-z_$][\w$]{2,})["']/g;
  for (const row of rows) {
    if (!marker.test(row.body_text)) continue;
    for (const match of row.body_text.matchAll(strings)) {
      const values = evidence.get(match[1]) ?? [];
      if (values.length < 5) values.push({ stable_key: row.stable_key, file_path: row.file_path });
      evidence.set(match[1], values);
    }
  }
  return evidence;
}

/** Conservative zero-incoming-use candidates with explicit uncertainty exclusions. */
export function findDeadCodeCandidates(db, {
  repoId = null, filePath = null, language = null, limit = 100,
  maxSymbols = DEFAULT_MAX_ANALYSIS_SYMBOLS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const analysisLimits = analysisCaps({ maxSymbols, maxBodyBytes });
  const rawCandidates = symbolRows(db, repository, {
    filePath, language, kinds: DEAD_CODE_KINDS, maximum: analysisLimits.max_symbols + 1,
  });
  const candidates = rawCandidates.slice(0, analysisLimits.max_symbols);
  const boundedBodies = boundBodyRows(symbolRows(db, repository, {
    kinds: null, maximum: analysisLimits.max_symbols + 1,
  }), analysisLimits);
  const allBodies = boundedBodies.rows;
  const incoming = new Map(db.prepare(`
    SELECT target_symbol_id, COUNT(*) AS count, GROUP_CONCAT(DISTINCT kind) AS kinds
    FROM edges WHERE repo_id = ? AND target_symbol_id IS NOT NULL
    GROUP BY target_symbol_id
  `).all(repository.id).map((row) => [Number(row.target_symbol_id), { count: Number(row.count), kinds: row.kinds?.split(",") ?? [] }]));
  const unresolved = new Map(db.prepare(`
    SELECT callee_name, COUNT(*) AS count, GROUP_CONCAT(DISTINCT resolution_status) AS statuses
    FROM symbol_calls
    WHERE repo_id = ? AND resolution_status != 'resolved'
    GROUP BY callee_name
  `).all(repository.id).map((row) => [row.callee_name, { count: Number(row.count), statuses: row.statuses?.split(",") ?? [] }]));
  const routeSources = new Set();
  const routeHandlers = new Set();
  for (const row of db.prepare("SELECT source_stable_key, handler_name FROM api_operations WHERE repo_id = ? AND kind = 'route'").all(repository.id)) {
    if (row.source_stable_key) routeSources.add(row.source_stable_key);
    if (row.handler_name) {
      routeHandlers.add(row.handler_name);
      const leaf = String(row.handler_name).match(/(?:^|[.#:])([A-Za-z_$][\w$]*)$/)?.[1];
      if (leaf) routeHandlers.add(leaf);
    }
  }
  const contractSources = new Set();
  const contractNames = new Set();
  for (const row of db.prepare(`
    SELECT source_stable_key, source_name, target_name, kind, category
    FROM code_relationships
    WHERE repo_id = ? AND (category IN ('export', 'heritage', 'type') OR kind IN ('exports', 're_exports', 'extends', 'implements', 'overrides'))
  `).all(repository.id)) {
    if (row.source_stable_key) contractSources.add(row.source_stable_key);
    if (row.source_name) contractNames.add(row.source_name);
    if (row.target_name) contractNames.add(row.target_name);
  }
  const reflected = reflectionNames(allBodies);
  const exclusionSummary = {};
  const excluded = (reason) => {
    exclusionSummary[reason] = (exclusionSummary[reason] ?? 0) + 1;
  };
  const findings = [];
  for (const symbol of candidates) {
    let reason = null;
    let reasonEvidence = null;
    if (symbol.exported) reason = "exported_or_public_api";
    else if (contractSources.has(symbol.stable_key) || contractNames.has(symbol.name)) reason = "export_or_type_contract";
    else if (routeSources.has(symbol.stable_key) || routeHandlers.has(symbol.name) || routeHandlers.has(symbol.qualified_name)) reason = "route_or_handler";
    else if (isEntryPath(symbol.file_path)) reason = "entry_point_file";
    else if (isTestPath(symbol.file_path)) reason = "test_or_fixture_file";
    else if (symbol.kind === "Constructor" || new Set(["constructor", "__init__", "__new__"]).has(symbol.name)) reason = "constructor_or_initializer";
    else if (isFrameworkHook(symbol.name)) reason = "framework_hook_name";
    else if (incoming.has(Number(symbol.id))) {
      reason = "observed_incoming_relationship";
      reasonEvidence = incoming.get(Number(symbol.id));
    } else if (unresolved.has(symbol.name)) {
      reason = "dynamic_dispatch_or_unresolved_call";
      reasonEvidence = unresolved.get(symbol.name);
    } else if (reflected.has(symbol.name)) {
      reason = "reflection_or_registry_string";
      reasonEvidence = reflected.get(symbol.name);
    }
    if (reason) {
      excluded(reason);
      continue;
    }
    const privateLike = symbol.name.startsWith("_") || symbol.name.startsWith("#");
    let confidence = privateLike ? 0.9 : symbol.kind === "Function" ? 0.8 : symbol.kind === "Class" ? 0.64 : 0.56;
    if (![/^babel/, /^python-ast/].some((pattern) => pattern.test(symbol.parser_mode ?? ""))) confidence -= 0.12;
    const caveats = ["No incoming use was observed in the indexed static graph; this is not proof of runtime unreachability."];
    if (boundedBodies.truncated) {
      confidence -= 0.15;
      caveats.push("Reflection and registry scanning was bounded, so an unscanned dynamic reference may exist.");
    }
    if (["Method", "Constructor"].includes(symbol.kind)) caveats.push("Instance dispatch, dependency injection, or framework construction may be unresolved.");
    if (symbol.language !== "javascript" && symbol.language !== "typescript" && symbol.language !== "python") {
      caveats.push(`Dead-code confidence is lower because ${symbol.language} indexing is heuristic.`);
    }
    findings.push({
      symbol: symbol.name,
      qualified_name: symbol.qualified_name,
      stable_key: symbol.stable_key,
      kind: symbol.kind,
      file_path: symbol.file_path,
      language: symbol.language,
      evidence: {
        incoming_relationships: 0,
        unresolved_same_name_calls: 0,
        exported: false,
        route_handler: false,
        entry_point: false,
        test_path: false,
        framework_hook: false,
        reflection_or_registry_reference: false,
        reflection_scan_complete: !boundedBodies.truncated,
        indexed_parser_mode: symbol.parser_mode ?? null,
      },
      confidence: Number(Math.max(0.2, confidence).toFixed(2)),
      caveats,
    });
  }
  findings.sort((a, b) => b.confidence - a.confidence || a.file_path.localeCompare(b.file_path) || a.qualified_name.localeCompare(b.qualified_name));
  const appliedLimit = capped(limit);
  return {
    repo_id: repository.repo_id,
    classification: "candidates_not_proof",
    findings: findings.slice(0, appliedLimit),
    examined_symbols: candidates.length,
    exclusion_summary: exclusionSummary,
    exclusion_rules: DEAD_CODE_EXCLUSION_RULES,
    truncated: findings.length > appliedLimit || rawCandidates.length > candidates.length || boundedBodies.truncated,
    limits: {
      findings: { requested: requestedNumber(limit, 100), applied: appliedLimit, maximum: MAX_FINDINGS },
      analysis: {
        ...analysisLimits,
        reflection_body_bytes_analyzed: boundedBodies.body_bytes,
        reflection_symbols_skipped_by_body_limit: boundedBodies.skipped_by_body_limit,
        reflection_symbols_skipped_by_individual_body_limit: boundedBodies.skipped_by_individual_body_limit,
      },
    },
    methodology: "Candidates require zero observed incoming graph use after conservative API, entry-point, test, hook, type-contract, unresolved-call, and reflection exclusions.",
  };
}

function articulation(adjacency) {
  const discovery = new Map();
  const low = new Map();
  const parent = new Map();
  const result = new Map();
  let time = 0;
  for (const root of adjacency.keys()) {
    if (discovery.has(root)) continue;
    discovery.set(root, ++time);
    low.set(root, time);
    const stack = [{ node: root, neighbors: [...(adjacency.get(root) ?? [])], index: 0, children: 0, separatingChildren: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      if (frame.index < frame.neighbors.length) {
        const neighbor = frame.neighbors[frame.index];
        frame.index += 1;
        if (!discovery.has(neighbor)) {
          parent.set(neighbor, frame.node);
          frame.children += 1;
          discovery.set(neighbor, ++time);
          low.set(neighbor, time);
          stack.push({ node: neighbor, neighbors: [...(adjacency.get(neighbor) ?? [])], index: 0, children: 0, separatingChildren: 0 });
        } else if (neighbor !== parent.get(frame.node)) {
          low.set(frame.node, Math.min(low.get(frame.node), discovery.get(neighbor)));
        }
        continue;
      }
      stack.pop();
      const parentNode = parent.get(frame.node);
      if (parentNode != null) {
        low.set(parentNode, Math.min(low.get(parentNode), low.get(frame.node)));
        const parentFrame = stack.at(-1);
        if (low.get(frame.node) >= discovery.get(parentNode) && parentFrame?.node === parentNode) {
          parentFrame.separatingChildren += 1;
        }
      }
      const isRoot = parentNode == null;
      const isArticulation = isRoot ? frame.children > 1 : frame.separatingChildren > 0;
      if (isArticulation) result.set(frame.node, isRoot ? frame.children : frame.separatingChildren + 1);
    }
  }
  return result;
}

function addUndirected(adjacency, left, right) {
  if (left == null || right == null || left === right) return;
  if (!adjacency.has(left)) adjacency.set(left, new Set());
  if (!adjacency.has(right)) adjacency.set(right, new Set());
  adjacency.get(left).add(right);
  adjacency.get(right).add(left);
}

function bridgeFindingsForSymbols(db, repository, { maxNodes, maxEdges }) {
  const symbolRows = db.prepare(`
    SELECT s.id, s.stable_key, s.name, s.qualified_name, s.kind, f.path AS file_path,
      COUNT(*) OVER() AS total_nodes
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ?
    ORDER BY s.id
    LIMIT ?
  `).all(repository.id, maxNodes + 1);
  const symbols = symbolRows.slice(0, maxNodes);
  const nodeTruncated = symbolRows.length > maxNodes;
  const byId = new Map(symbols.map((row) => [Number(row.id), row]));
  const adjacency = new Map(symbols.map((row) => [Number(row.id), new Set()]));
  const incoming = new Map();
  const outgoing = new Map();
  const kinds = new Map();
  const edgeRows = db.prepare(`
    SELECT source_symbol_id, target_symbol_id, kind, COUNT(*) OVER() AS total_edges FROM edges
    WHERE repo_id = ? AND source_symbol_id IS NOT NULL AND target_symbol_id IS NOT NULL
    ORDER BY id
    LIMIT ?
  `).all(repository.id, maxEdges + 1);
  const edgeTruncated = edgeRows.length > maxEdges;
  let projectionEdges = 0;
  for (const edge of edgeRows.slice(0, maxEdges)) {
    const source = Number(edge.source_symbol_id);
    const target = Number(edge.target_symbol_id);
    if (!byId.has(source) || !byId.has(target) || source === target) continue;
    projectionEdges += 1;
    addUndirected(adjacency, source, target);
    outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    const values = kinds.get(source) ?? new Set();
    values.add(edge.kind);
    kinds.set(source, values);
    const targetValues = kinds.get(target) ?? new Set();
    targetValues.add(edge.kind);
    kinds.set(target, targetValues);
  }
  const cuts = articulation(adjacency);
  const findings = [];
  const analysisTruncated = nodeTruncated || edgeTruncated;
  for (const [id, row] of byId) {
    const neighbors = adjacency.get(id) ?? new Set();
    const neighborFiles = new Set([...neighbors].map((neighbor) => byId.get(neighbor)?.file_path).filter(Boolean));
    const partitions = cuts.get(id) ?? 1;
    const boundaryBroker = neighborFiles.size >= 2 && neighbors.size >= 2;
    if (!cuts.has(id) && !boundaryBroker) continue;
    const score = (partitions - 1) * Math.log2(2 + neighbors.size) + neighborFiles.size / Math.max(1, neighbors.size);
    findings.push({
      entity_type: "symbol",
      symbol: row.name,
      qualified_name: row.qualified_name,
      stable_key: row.stable_key,
      kind: row.kind,
      file_path: row.file_path,
      bridge_score: Number(score.toFixed(3)),
      classification: cuts.has(id) ? "articulation" : "boundary_broker",
      evidence: {
        degree: neighbors.size,
        incoming_edges: incoming.get(id) ?? 0,
        outgoing_edges: outgoing.get(id) ?? 0,
        neighbor_files: [...neighborFiles].sort(),
        separated_partitions: cuts.get(id) ?? 1,
        observed_edge_kinds: [...(kinds.get(id) ?? [])].sort(),
      },
      confidence: Number(Math.max(0.3, (cuts.has(id) ? 0.92 : 0.72) - (analysisTruncated ? 0.25 : 0)).toFixed(2)),
      caveats: [
        "Bridge status is computed over the observed undirected static graph; unresolved and runtime-only edges are absent.",
        ...(analysisTruncated ? ["Graph bounds omitted nodes or edges; classification may change on the complete indexed graph."] : []),
      ],
    });
  }
  return {
    findings,
    truncated: analysisTruncated,
    coverage: {
      nodes_analyzed: symbols.length,
      nodes_total: Number(symbolRows[0]?.total_nodes ?? symbols.length),
      edges_scanned: Math.min(edgeRows.length, maxEdges),
      edges_in_projection: projectionEdges,
      edges_total: Number(edgeRows[0]?.total_edges ?? edgeRows.length),
    },
  };
}

function bridgeFindingsForFiles(db, repository, { maxNodes, maxEdges }) {
  const fileRows = db.prepare(`
    SELECT id, path, language, COUNT(*) OVER() AS total_nodes
    FROM files WHERE repo_id = ? ORDER BY id LIMIT ?
  `).all(repository.id, maxNodes + 1);
  const files = fileRows.slice(0, maxNodes);
  const nodeTruncated = fileRows.length > maxNodes;
  const byId = new Map(files.map((row) => [Number(row.id), row]));
  const adjacency = new Map(files.map((row) => [Number(row.id), new Set()]));
  const incoming = new Map();
  const outgoing = new Map();
  const kinds = new Map();
  const edgeRows = db.prepare(`
    SELECT source_file_id, target_file_id, kind, COUNT(*) OVER() AS total_edges FROM edges
    WHERE repo_id = ? AND source_file_id IS NOT NULL AND target_file_id IS NOT NULL
    ORDER BY id
    LIMIT ?
  `).all(repository.id, maxEdges + 1);
  const edgeTruncated = edgeRows.length > maxEdges;
  let projectionEdges = 0;
  for (const edge of edgeRows.slice(0, maxEdges)) {
    const source = Number(edge.source_file_id);
    const target = Number(edge.target_file_id);
    if (!byId.has(source) || !byId.has(target) || source === target) continue;
    projectionEdges += 1;
    addUndirected(adjacency, source, target);
    outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
    const values = kinds.get(source) ?? new Set();
    values.add(edge.kind);
    kinds.set(source, values);
    const targetValues = kinds.get(target) ?? new Set();
    targetValues.add(edge.kind);
    kinds.set(target, targetValues);
  }
  const cuts = articulation(adjacency);
  const findings = [];
  const analysisTruncated = nodeTruncated || edgeTruncated;
  for (const [id, row] of byId) {
    const neighbors = adjacency.get(id) ?? new Set();
    const partitions = cuts.get(id) ?? 1;
    if (!cuts.has(id) && neighbors.size < 3) continue;
    const score = (partitions - 1) * Math.log2(2 + neighbors.size) + Math.log2(1 + neighbors.size);
    findings.push({
      entity_type: "file",
      file_path: row.path,
      language: row.language,
      bridge_score: Number(score.toFixed(3)),
      classification: cuts.has(id) ? "articulation" : "high_degree_broker",
      evidence: {
        degree: neighbors.size,
        incoming_edges: incoming.get(id) ?? 0,
        outgoing_edges: outgoing.get(id) ?? 0,
        neighbor_files: [...neighbors].map((neighbor) => byId.get(neighbor)?.path).filter(Boolean).sort(),
        separated_partitions: cuts.get(id) ?? 1,
        observed_edge_kinds: [...(kinds.get(id) ?? [])].sort(),
      },
      confidence: Number(Math.max(0.3, (cuts.has(id) ? 0.94 : 0.7) - (analysisTruncated ? 0.25 : 0)).toFixed(2)),
      caveats: [
        "File bridge status is computed over observed call/import relationships and does not model runtime loading.",
        ...(analysisTruncated ? ["Graph bounds omitted nodes or edges; classification may change on the complete indexed graph."] : []),
      ],
    });
  }
  return {
    findings,
    truncated: analysisTruncated,
    coverage: {
      nodes_analyzed: files.length,
      nodes_total: Number(fileRows[0]?.total_nodes ?? files.length),
      edges_scanned: Math.min(edgeRows.length, maxEdges),
      edges_in_projection: projectionEdges,
      edges_total: Number(edgeRows[0]?.total_edges ?? edgeRows.length),
    },
  };
}

/** Articulation and boundary brokers in the indexed symbol/file graph. */
export function findBridgeEntities(db, {
  repoId = null, entityType = "both", minimumDegree = 2, limit = 50,
  maxNodes = DEFAULT_MAX_GRAPH_NODES, maxEdges = DEFAULT_MAX_GRAPH_EDGES,
} = {}) {
  const repository = resolveRepository(db, repoId);
  if (!["both", "symbol", "file"].includes(entityType)) throw new Error("entityType must be both, symbol, or file");
  const graphLimits = {
    maxNodes: capped(maxNodes, DEFAULT_MAX_GRAPH_NODES, MAX_GRAPH_NODES),
    maxEdges: capped(maxEdges, DEFAULT_MAX_GRAPH_EDGES, MAX_GRAPH_EDGES),
  };
  const degreeThreshold = nonNegativeNumber(minimumDegree, 2, "minimumDegree");
  const symbolResult = entityType === "both" || entityType === "symbol"
    ? bridgeFindingsForSymbols(db, repository, graphLimits)
    : { findings: [], truncated: false, coverage: null };
  const fileResult = entityType === "both" || entityType === "file"
    ? bridgeFindingsForFiles(db, repository, graphLimits)
    : { findings: [], truncated: false, coverage: null };
  const findings = [
    ...symbolResult.findings,
    ...fileResult.findings,
  ].filter((item) => item.evidence.degree >= degreeThreshold)
    .sort((a, b) => b.bridge_score - a.bridge_score || b.confidence - a.confidence || (a.stable_key ?? a.file_path).localeCompare(b.stable_key ?? b.file_path));
  const appliedLimit = capped(limit);
  return {
    repo_id: repository.repo_id,
    findings: findings.slice(0, appliedLimit),
    truncated: findings.length > appliedLimit || symbolResult.truncated || fileResult.truncated,
    limits: {
      findings: { requested: requestedNumber(limit, 50), applied: appliedLimit, maximum: MAX_FINDINGS },
      graph: { ...graphLimits, maximum_nodes: MAX_GRAPH_NODES, maximum_edges: MAX_GRAPH_EDGES },
    },
    coverage: { symbols: symbolResult.coverage, files: fileResult.coverage },
    methodology: "Iterative Tarjan articulation points plus cross-file/high-degree brokerage over a bounded undirected projection of resolved graph edges; incomplete projections lower confidence.",
  };
}

function preferenceFinding(dimension, counts, caveat) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return null;
  const dominance = entries[0][1] / total;
  const sampleFactor = Math.min(1, Math.log2(total + 1) / 5);
  return {
    dimension,
    preferred: entries[0][0],
    alternatives: entries.slice(1).map(([value, count]) => ({ value, count })),
    evidence: { counts: Object.fromEntries(entries), total, dominance: Number(dominance.toFixed(3)) },
    confidence: Number((0.25 + 0.7 * dominance * sampleFactor).toFixed(2)),
    caveats: [caveat],
  };
}

function indentationCounts(rows) {
  const counts = { tabs: 0, "2-spaces": 0, "4-spaces": 0, other: 0 };
  for (const row of rows) {
    const prefixes = row.body_text.split(/\r?\n/)
      .map((line) => line.match(/^[\t ]+(?=\S)/)?.[0] ?? "")
      .filter(Boolean);
    if (!prefixes.length) continue;
    if (prefixes.some((prefix) => prefix.includes("\t"))) {
      counts.tabs += 1;
      continue;
    }
    const minimum = Math.min(...prefixes.map((prefix) => prefix.length));
    if (minimum <= 2) counts["2-spaces"] += 1;
    else if (minimum <= 4) counts["4-spaces"] += 1;
    else counts.other += 1;
  }
  return counts;
}

/** Empirical, lexical style norms for indexed JS/TS and Python bodies. */
export function getEmpiricalStyleFingerprint(db, {
  repoId = null, filePath = null, language = null, maxSymbols = 2_000,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const repository = resolveRepository(db, repoId);
  const analysisLimits = analysisCaps({ maxSymbols, maxBodyBytes });
  const boundedRows = boundBodyRows(symbolRows(db, repository, {
    filePath, language, maximum: analysisLimits.max_symbols + 1, kinds: CALLABLE_KINDS,
    stratifyByLanguage: !language, supportedOnly: true,
  }), analysisLimits);
  const rows = boundedRows.rows
    .filter((row) => SUPPORTED_COMPLEXITY_LANGUAGES.has(row.language));
  const findings = [];
  const js = rows.filter((row) => row.language === "javascript" || row.language === "typescript");
  const python = rows.filter((row) => row.language === "python");

  if (js.length) {
    const text = js.map((row) => row.body_text).join("\n");
    const declarations = {
      const: (text.match(/\bconst\b/g) ?? []).length,
      let: (text.match(/\blet\b/g) ?? []).length,
      var: (text.match(/\bvar\b/g) ?? []).length,
    };
    const functions = {
      arrow: (text.match(/=>/g) ?? []).length,
      declaration: (text.match(/\bfunction\s+[*A-Za-z_$]/g) ?? []).length,
    };
    const asyncStyle = {
      "async-await": (text.match(/\bawait\b/g) ?? []).length,
      promises: (text.match(/\.(?:then|catch|finally)\s*\(/g) ?? []).length,
    };
    const equality = {
      strict: (text.match(/(?:===|!==)/g) ?? []).length,
      loose: (text.match(/(?<![=!])(?:==|!=)(?!=)/g) ?? []).length,
    };
    const control = {
      "if-else": (text.match(/\bif\s*\(/g) ?? []).length,
      ternary: (text.match(/\?[^?:\n]+:/g) ?? []).length,
    };
    const semicolons = { semicolons: 0, "no-semicolons": 0 };
    for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      if (line.endsWith(";")) semicolons.semicolons += 1;
      else if (/^(?:return|throw|const|let|var|[A-Za-z_$][\w$]*\s*[=(])/.test(line) && !/[{}:]$/.test(line)) semicolons["no-semicolons"] += 1;
    }
    const quoteCounts = { single: 0, double: 0, template: 0 };
    for (const match of text.matchAll(/(['"`])(?:\\.|(?!\1)[^\\\r\n])*\1/g)) {
      quoteCounts[match[1] === "'" ? "single" : match[1] === '"' ? "double" : "template"] += 1;
    }
    for (const finding of [
      preferenceFinding("js.variable_declaration", declarations, "Lexical counts are limited to stored callable bodies; comments and strings can slightly affect them."),
      preferenceFinding("js.function_form", functions, "Callbacks and nested functions influence this lexical preference; comments and strings can slightly affect counts."),
      preferenceFinding("js.async_style", asyncStyle, "Promise chains without then/catch/finally are not detected; comments and strings can slightly affect lexical counts."),
      preferenceFinding("js.equality", equality, "Operators inside comments or string literals can slightly affect lexical counts."),
      preferenceFinding("js.conditional_form", control, "Ternary recognition is lexical and intentionally conservative; comments and strings can slightly affect counts."),
      preferenceFinding("js.quote_style", quoteCounts, "Quotes in comments can slightly affect lexical counts."),
      preferenceFinding("js.semicolon_style", semicolons, "Only statement-like lines in stored callable bodies are compared."),
      preferenceFinding("js.indentation", indentationCounts(js), "Indentation is inferred from the minimum indented line in each callable."),
    ]) if (finding) findings.push(finding);
  }

  if (python.length) {
    const text = python.map((row) => row.body_text).join("\n");
    const asyncStyle = {
      "async-await": python.filter((row) => /\basync\s+def\b|\bawait\b/.test(row.body_text)).length,
      synchronous: python.filter((row) => !/\basync\s+def\b|\bawait\b/.test(row.body_text)).length,
    };
    const collectionStyle = {
      comprehension: (text.match(/[\[({][^\n]*\bfor\b[^\n]*\bin\b/g) ?? []).length,
      loop: (text.match(/^\s*(?:async\s+)?for\b/gm) ?? []).length,
    };
    const formatting = {
      "f-string": (text.match(/\bf["']/g) ?? []).length,
      "str.format": (text.match(/\.format\s*\(/g) ?? []).length,
      "percent-format": (text.match(/["'][^\n]*["']\s*%/g) ?? []).length,
    };
    const pathStyle = {
      pathlib: (text.match(/\bPath\s*\(/g) ?? []).length,
      "os.path": (text.match(/\bos\.path\./g) ?? []).length,
    };
    const quoteCounts = {
      single: (text.match(/'(?:\\.|[^'\\\r\n])*'/g) ?? []).length,
      double: (text.match(/"(?:\\.|[^"\\\r\n])*"/g) ?? []).length,
    };
    const annotations = {
      annotated: python.filter((row) => /\bdef\s+\w+\s*\([^)]*:[^)]*\)|\)\s*->/.test(row.signature)).length,
      unannotated: python.filter((row) => !/\bdef\s+\w+\s*\([^)]*:[^)]*\)|\)\s*->/.test(row.signature)).length,
    };
    for (const finding of [
      preferenceFinding("python.execution_style", asyncStyle, "Async and synchronous evidence is counted once per stored callable."),
      preferenceFinding("python.collection_construction", collectionStyle, "Comprehension recognition is lexical and single-line; comments and strings can slightly affect counts."),
      preferenceFinding("python.string_formatting", formatting, "Only lexical f-strings, str.format, and percent formatting are compared; comments can slightly affect counts."),
      preferenceFinding("python.path_api", pathStyle, "Only direct lexical Path(...) and os.path.* spellings are counted; comments and strings can slightly affect counts."),
      preferenceFinding("python.quote_style", quoteCounts, "Quotes in comments can slightly affect lexical counts."),
      preferenceFinding("python.type_annotations", annotations, "Annotation presence is inferred from indexed signature lines."),
      preferenceFinding("python.indentation", indentationCounts(python), "Indentation is inferred from the minimum indented line in each callable."),
    ]) if (finding) findings.push(finding);
  }

  return {
    repo_id: repository.repo_id,
    findings,
    sample: {
      symbols: rows.length,
      javascript_typescript_symbols: js.length,
      python_symbols: python.length,
      requested_language: language,
      requested_file_path: filePath,
    },
    truncated: boundedRows.truncated,
    limits: {
      requested_symbols: requestedNumber(maxSymbols, 2_000),
      applied_symbols: analysisLimits.max_symbols,
      maximum_symbols: MAX_ANALYSIS_SYMBOLS,
      requested_body_bytes: requestedNumber(maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
      applied_body_bytes: analysisLimits.max_body_bytes,
      body_bytes_analyzed: boundedRows.body_bytes,
      symbols_skipped_by_body_limit: boundedRows.skipped_by_body_limit,
      symbols_skipped_by_individual_body_limit: boundedRows.skipped_by_individual_body_limit,
    },
    methodology: "Empirical lexical counts over a deterministic language-stratified sample of current indexed callable bodies; conventions are emitted only when evidence exists.",
  };
}

export const getStyleFingerprint = getEmpiricalStyleFingerprint;
