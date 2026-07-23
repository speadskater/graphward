import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../src/db.mjs";
import { indexDirectory } from "../../src/indexer.mjs";
import { callTool } from "../../src/tools.mjs";

const READ_ONLY_TOOLS = new Set([
  "find_code",
  "find_symbol",
  "get_api_topology",
  "get_architecture",
  "get_code_graph",
  "get_code_relationships",
  "get_dependency_path",
  "get_execution_flows",
  "get_impact",
  "get_index_diagnostics",
  "get_repo_map",
  "get_repository_stats",
  "get_source_window",
  "get_symbol_context",
]);

const OPERATORS = new Set([
  "contains_match",
  "equals",
  "gte",
  "includes",
  "length_gte",
  "length_lte",
  "lte",
  "sequence",
  "truthy",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateBudget(budget, location) {
  if (budget == null) return;
  if (!isObject(budget)) throw new Error(`${location} must be an object`);
  for (const key of ["max_calls", "max_response_bytes", "min_score"]) {
    if (budget[key] != null && !finiteNonNegative(budget[key])) {
      throw new Error(`${location}.${key} must be a non-negative finite number`);
    }
  }
  if (budget.min_score != null && budget.min_score > 1) {
    throw new Error(`${location}.min_score must be between 0 and 1`);
  }
}

export function validateEvaluationSpecification(specification) {
  if (!isObject(specification)) throw new Error("evaluation specification must be an object");
  if (!Array.isArray(specification.cases) || specification.cases.length === 0) {
    throw new Error("evaluation specification must contain a non-empty cases array");
  }
  if (specification.cases.length > 100) throw new Error("evaluation specifications support at most 100 cases");
  validateBudget(specification.budget, "budget");
  const ids = new Set();
  for (const [caseIndex, evaluationCase] of specification.cases.entries()) {
    const location = `cases[${caseIndex}]`;
    if (!isObject(evaluationCase)) throw new Error(`${location} must be an object`);
    if (typeof evaluationCase.id !== "string" || !evaluationCase.id.trim()) {
      throw new Error(`${location}.id must be a non-empty string`);
    }
    if (ids.has(evaluationCase.id)) throw new Error(`duplicate evaluation case id: ${evaluationCase.id}`);
    ids.add(evaluationCase.id);
    if (typeof evaluationCase.category !== "string" || !evaluationCase.category.trim()) {
      throw new Error(`${location}.category must be a non-empty string`);
    }
    if (!READ_ONLY_TOOLS.has(evaluationCase.tool)) {
      throw new Error(`${location}.tool must be a supported read-only Graphward tool`);
    }
    if (evaluationCase.args != null && !isObject(evaluationCase.args)) {
      throw new Error(`${location}.args must be an object`);
    }
    if (!Array.isArray(evaluationCase.assertions) || evaluationCase.assertions.length === 0) {
      throw new Error(`${location}.assertions must be a non-empty array`);
    }
    if (evaluationCase.assertions.length > 20) throw new Error(`${location} supports at most 20 assertions`);
    if (evaluationCase.weight != null && (!Number.isFinite(evaluationCase.weight) || evaluationCase.weight <= 0)) {
      throw new Error(`${location}.weight must be a positive finite number`);
    }
    if (evaluationCase.max_response_bytes != null && !finiteNonNegative(evaluationCase.max_response_bytes)) {
      throw new Error(`${location}.max_response_bytes must be a non-negative finite number`);
    }
    for (const [assertionIndex, assertion] of evaluationCase.assertions.entries()) {
      const assertionLocation = `${location}.assertions[${assertionIndex}]`;
      if (!isObject(assertion)) throw new Error(`${assertionLocation} must be an object`);
      if (typeof assertion.path !== "string" || !assertion.path.trim()) {
        throw new Error(`${assertionLocation}.path must be a non-empty string`);
      }
      if (!OPERATORS.has(assertion.operator)) throw new Error(`${assertionLocation}.operator is unsupported`);
      if (assertion.max_rank != null && (!Number.isInteger(assertion.max_rank) || assertion.max_rank < 1)) {
        throw new Error(`${assertionLocation}.max_rank must be a positive integer`);
      }
    }
  }
  return specification;
}

function getPath(value, propertyPath) {
  return propertyPath.split(".").reduce((current, segment) => {
    if (current == null) return undefined;
    return current[segment];
  }, value);
}

function partialMatch(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((item, index) => partialMatch(actual[index], item));
  }
  if (isObject(expected)) {
    return isObject(actual)
      && Object.entries(expected).every(([key, item]) => partialMatch(actual[key], item));
  }
  return isDeepStrictEqual(actual, expected);
}

function summarize(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isObject(value)) return { type: "object", keys: Object.keys(value).slice(0, 20) };
  if (typeof value === "string" && value.length > 240) return `${value.slice(0, 237)}...`;
  return value ?? null;
}

function summarizeCollection(value) {
  if (!Array.isArray(value)) return summarize(value);
  const diagnosticFields = [
    "name",
    "qualified_name",
    "kind",
    "file_path",
    "start_line",
    "method",
    "path",
    "source_name",
    "target_name",
  ];
  return {
    type: "array",
    length: value.length,
    sample: value.slice(0, 5).map((item) => {
      if (!isObject(item)) return summarize(item);
      const selected = Object.fromEntries(diagnosticFields
        .filter((field) => item[field] !== undefined)
        .map((field) => [field, item[field]]));
      return Object.keys(selected).length > 0 ? selected : summarize(item);
    }),
  };
}

function evaluateAssertion(response, assertion) {
  const actual = getPath(response, assertion.path);
  let passed = false;
  let rank = null;
  switch (assertion.operator) {
    case "equals":
      passed = isDeepStrictEqual(actual, assertion.value);
      break;
    case "truthy":
      passed = Boolean(actual);
      break;
    case "gte":
      passed = typeof actual === "number" && actual >= assertion.value;
      break;
    case "lte":
      passed = typeof actual === "number" && actual <= assertion.value;
      break;
    case "length_gte":
      passed = actual != null && Number.isInteger(actual.length) && actual.length >= assertion.value;
      break;
    case "length_lte":
      passed = actual != null && Number.isInteger(actual.length) && actual.length <= assertion.value;
      break;
    case "includes":
      passed = actual != null && typeof actual.includes === "function" && actual.includes(assertion.value);
      break;
    case "contains_match": {
      const index = Array.isArray(actual) ? actual.findIndex((item) => partialMatch(item, assertion.value)) : -1;
      rank = index >= 0 ? index + 1 : null;
      passed = index >= 0 && (assertion.max_rank == null || rank <= assertion.max_rank);
      break;
    }
    case "sequence":
      passed = Array.isArray(actual)
        && Array.isArray(assertion.value)
        && actual.length >= assertion.value.length
        && assertion.value.every((item, index) => partialMatch(actual[index], item));
      break;
    default:
      passed = false;
  }
  return {
    path: assertion.path,
    operator: assertion.operator,
    passed,
    expected: assertion.value ?? true,
    observed: assertion.operator === "contains_match" || assertion.operator === "sequence"
      ? summarizeCollection(actual)
      : summarize(actual),
    ...(rank == null ? {} : { rank }),
    ...(assertion.max_rank == null ? {} : { max_rank: assertion.max_rank }),
  };
}

function ratio(value, total) {
  return total ? Number((value / total).toFixed(4)) : 0;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

export async function runSystemEvaluation({ root, specification, repoId = "system-evaluation" }) {
  validateEvaluationSpecification(specification);
  const absoluteRoot = path.resolve(root);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "graphward-system-evaluation-"));
  const db = openDatabase(path.join(temporary, "index.sqlite"));
  const startedAt = performance.now();
  try {
    const indexed = await indexDirectory(db, absoluteRoot, { repoId });
    const context = {
      db,
      defaultRoot: absoluteRoot,
      defaultRepoId: repoId,
      surface: "mcp",
      responseEvidenceHashes: new Set(),
    };
    const cases = [];
    for (const evaluationCase of specification.cases) {
      const caseStartedAt = performance.now();
      let response;
      let error = null;
      try {
        response = await callTool(evaluationCase.tool, {
          ...(evaluationCase.args ?? {}),
          repo_id: repoId,
        }, context);
      } catch (caught) {
        error = caught;
      }
      const responseBytes = response == null ? 0 : Buffer.byteLength(JSON.stringify(response), "utf8");
      const assertions = error == null
        ? evaluationCase.assertions.map((assertion) => evaluateAssertion(response, assertion))
        : evaluationCase.assertions.map((assertion) => ({
          path: assertion.path,
          operator: assertion.operator,
          passed: false,
          expected: assertion.value ?? true,
          observed: null,
        }));
      const bytesPassed = evaluationCase.max_response_bytes == null
        || responseBytes <= evaluationCase.max_response_bytes;
      cases.push({
        id: evaluationCase.id,
        category: evaluationCase.category,
        tool: evaluationCase.tool,
        weight: evaluationCase.weight ?? 1,
        passed: error == null && bytesPassed && assertions.every((assertion) => assertion.passed),
        response_bytes: responseBytes,
        estimated_tokens: Math.ceil(responseBytes / 4),
        duration_ms: rounded(performance.now() - caseStartedAt),
        max_response_bytes: evaluationCase.max_response_bytes ?? null,
        bytes_passed: bytesPassed,
        assertions,
        ...(error == null ? {} : { error: error.message }),
      });
    }

    const totalWeight = cases.reduce((sum, evaluationCase) => sum + evaluationCase.weight, 0);
    const passedWeight = cases
      .filter((evaluationCase) => evaluationCase.passed)
      .reduce((sum, evaluationCase) => sum + evaluationCase.weight, 0);
    const responseBytes = cases.reduce((sum, evaluationCase) => sum + evaluationCase.response_bytes, 0);
    const rankedAssertions = cases.flatMap((evaluationCase) => evaluationCase.assertions)
      .filter((assertion) => assertion.operator === "contains_match" && assertion.max_rank != null);
    const categoryNames = [...new Set(cases.map((evaluationCase) => evaluationCase.category))];
    const categories = Object.fromEntries(categoryNames.map((category) => {
      const matching = cases.filter((evaluationCase) => evaluationCase.category === category);
      const categoryWeight = matching.reduce((sum, evaluationCase) => sum + evaluationCase.weight, 0);
      const categoryPassedWeight = matching
        .filter((evaluationCase) => evaluationCase.passed)
        .reduce((sum, evaluationCase) => sum + evaluationCase.weight, 0);
      return [category, {
        cases: matching.length,
        passed: matching.filter((evaluationCase) => evaluationCase.passed).length,
        score: ratio(categoryPassedWeight, categoryWeight),
        response_bytes: matching.reduce((sum, evaluationCase) => sum + evaluationCase.response_bytes, 0),
      }];
    }));
    const score = ratio(passedWeight, totalWeight);
    const budget = specification.budget ?? {};
    const budgetResult = {
      max_calls: budget.max_calls ?? null,
      min_score: budget.min_score ?? null,
      max_response_bytes: budget.max_response_bytes ?? null,
      calls_passed: budget.max_calls == null || cases.length <= budget.max_calls,
      score_passed: budget.min_score == null || score >= budget.min_score,
      bytes_passed: budget.max_response_bytes == null || responseBytes <= budget.max_response_bytes,
    };
    const failedCases = cases.filter((evaluationCase) => !evaluationCase.passed).map((evaluationCase) => evaluationCase.id);
    const output = {
      name: specification.name ?? "Graphward system evaluation",
      root: absoluteRoot,
      passed: budgetResult.calls_passed
        && budgetResult.score_passed
        && budgetResult.bytes_passed,
      indexed: {
        files: indexed.files,
        symbols: indexed.symbols,
        edges: indexed.edges,
      },
      metrics: {
        calls: cases.length,
        cases: cases.length,
        passed: cases.length - failedCases.length,
        score,
        mean_reciprocal_rank: rankedAssertions.length
          ? Number((rankedAssertions.reduce((sum, assertion) => sum + (assertion.rank ? 1 / assertion.rank : 0), 0)
            / rankedAssertions.length).toFixed(4))
          : null,
        ranked_assertions: rankedAssertions.length,
        response_bytes: responseBytes,
        estimated_tokens: Math.ceil(responseBytes / 4),
        duration_ms: rounded(performance.now() - startedAt),
      },
      categories,
      budget: budgetResult,
      diagnostics: {
        failed_cases: failedCases,
        case_errors: cases.filter((evaluationCase) => evaluationCase.error).map((evaluationCase) => ({
          case_id: evaluationCase.id,
          error: evaluationCase.error,
        })),
        response_budget_failures: cases.filter((evaluationCase) => !evaluationCase.bytes_passed).map((evaluationCase) => ({
          case_id: evaluationCase.id,
          response_bytes: evaluationCase.response_bytes,
          max_response_bytes: evaluationCase.max_response_bytes,
        })),
        failed_assertions: cases.flatMap((evaluationCase) => evaluationCase.assertions
          .filter((assertion) => !assertion.passed)
          .map((assertion) => ({
            case_id: evaluationCase.id,
            path: assertion.path,
            operator: assertion.operator,
            expected: assertion.expected,
            observed: assertion.observed,
            ...(assertion.rank == null ? {} : { rank: assertion.rank }),
          }))),
      },
      cases,
      methodology: "The fixture is indexed once, then each manifest case makes one compact read-only Graphward tool call in a shared MCP session. Scores are weighted case pass rates. Bytes are serialized UTF-8 response bytes; estimated tokens use bytes/4 and are not billing data.",
    };
    return output;
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
