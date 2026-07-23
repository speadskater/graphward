import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSystemEvaluation, validateEvaluationSpecification } from "../scripts/lib/system-evaluation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deterministic system evaluation protects quality and response budgets", async () => {
  const specification = JSON.parse(await readFile(path.join(projectRoot, "benchmarks", "system-evaluation.json"), "utf8"));
  const result = await runSystemEvaluation({
    root: path.join(projectRoot, "test", "fixtures", "sample"),
    specification,
  });
  assert.equal(result.passed, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.metrics.calls, specification.cases.length);
  assert.equal(result.metrics.score, 1);
  assert.ok(result.metrics.mean_reciprocal_rank > 0 && result.metrics.mean_reciprocal_rank <= 1);
  assert.deepEqual(result.diagnostics.failed_cases, []);
  assert.ok(Object.values(result.categories).every((category) => category.score === 1));
});

test("evaluation specifications reject mutation tools and malformed assertions", () => {
  assert.throws(() => validateEvaluationSpecification({
    cases: [{
      id: "unsafe",
      category: "safety",
      tool: "record_decision",
      assertions: [{ path: "ok", operator: "truthy" }],
    }],
  }), /read-only/);
  assert.throws(() => validateEvaluationSpecification({
    cases: [{
      id: "malformed",
      category: "safety",
      tool: "find_symbol",
      assertions: [{ path: "results", operator: "exec" }],
    }],
  }), /unsupported/);
});
