import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { getCodeRelationships, getImpact } from "../src/queries.mjs";

test("links semantic DOM-selector registries, JSX producers, and walkthrough consumers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-dom-selector-"));
  const source = path.join(root, "src");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "targets.js"), `
    export function createTourTargetRegistry(value) { return value; }
    export const TOUR_TARGETS = createTourTargetRegistry({ SUBMIT: "submission-submit" });
  `);
  await writeFile(path.join(source, "SubmitButton.jsx"), `
    import { TOUR_TARGETS } from "./targets.js";
    export function SubmitButton() { return <button {...TOUR_TARGETS.SUBMIT.props}>Submit</button>; }
  `);
  await writeFile(path.join(source, "walkthrough.js"), `
    import { TOUR_TARGETS } from "./targets.js";
    export const submitWalkthrough = () => ({ element: TOUR_TARGETS.SUBMIT.selector });
    export function audit(root) { return root.querySelector('[data-tour="submission-submit"]'); }
  `);
  const db = openDatabase(path.join(root, "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  await indexDirectory(db, root, { repoId: "dom-selector" });
  const relationships = getCodeRelationships(db, { repoId: "dom-selector", category: "dom_selector" });
  assert.ok(relationships.results.some((item) => item.kind === "registry-definition" && item.target_name === "data-tour=submission-submit"));
  assert.ok(relationships.results.some((item) => item.kind === "registry-producer" && item.source_name === "TOUR_TARGETS.SUBMIT"));
  assert.ok(relationships.results.some((item) => item.kind === "registry-consumer" && item.source_name === "TOUR_TARGETS.SUBMIT"));
  assert.ok(relationships.results.some((item) => item.kind === "consumer" && item.target_name === "data-tour=submission-submit"));

  const edges = db.prepare(`
    SELECT e.kind, e.label, source.name AS source_name, target.name AS target_name
    FROM edges e
    JOIN symbols source ON source.id = e.source_symbol_id
    JOIN symbols target ON target.id = e.target_symbol_id
    WHERE e.kind = 'dom-selector'
    ORDER BY source.name, target.name
  `).all();
  assert.ok(edges.some((edge) => edge.source_name === "submitWalkthrough" && edge.target_name === "SubmitButton"));
  assert.ok(edges.some((edge) => edge.source_name === "audit" && edge.target_name === "SubmitButton"));

  const impact = getImpact(db, { repoId: "dom-selector", target: "SubmitButton", direction: "upstream" });
  assert.ok(impact.results.some((item) => item.name === "submitWalkthrough" && item.edge_kind === "dom-selector"));
});
