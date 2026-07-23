import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { indexDirectory } from "../src/indexer.mjs";
import { callTool } from "../src/tools.mjs";
import { evaluateRetrievalResults } from "../scripts/benchmark-retrieval-quality.mjs";

test("retrieval diagnostics require every expected target and report bounded MRR", () => {
  const evaluation = evaluateRetrievalResults([
    { name: "GET /:id", kind: "RouteHandler", file_path: "server/routes/competitions.js" },
  ], [
    { name: "GET /:id", kind: "RouteHandler", file_path: "server/routes/competitions.js" },
    { name: "checkPhaseAdvance", file_path: "server/middleware/phase-check.js" },
  ]);

  assert.equal(evaluation.hit, false);
  assert.equal(evaluation.target_hits, 1);
  assert.equal(evaluation.target_recall, 0.5);
  assert.equal(evaluation.mean_reciprocal_rank, 0.5);
  assert.deepEqual(evaluation.targets.map((target) => target.rank), [1, null]);
});

test("compact retrieval covers authorization audit boundaries within three calls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-retrieval-quality-"));
  const routes = path.join(root, "server", "routes");
  const middleware = path.join(root, "server", "middleware");
  const library = path.join(root, "server", "lib");
  const tests = path.join(root, "server", "__tests__");
  await Promise.all([
    mkdir(routes, { recursive: true }),
    mkdir(middleware, { recursive: true }),
    mkdir(library, { recursive: true }),
    mkdir(tests, { recursive: true }),
  ]);
  const padding = Array.from({ length: 300 }, (_, index) => `// unrelated setup ${index}`).join("\n");
  await writeFile(path.join(routes, "competitions.js"), `const { checkPhaseAdvance } = require('../middleware/phase-check');
${padding}
router.get('/:id', requireCompetitionRole('runner', 'judge'), asyncHandler(async (req, res) => {
  // GET read request mutates updates competition phase state authorization.
  await checkPhaseAdvance(req.params.id);
  const competition = await db.get('SELECT * FROM competitions WHERE id = ?', [req.params.id]);
  res.json(competition);
}));

router.post('/:id/transfer-owner', asyncHandler(async (req, res) => {
  const competition = await db.get('SELECT owner_id FROM competitions WHERE id = ?', [req.params.id]);
  const accountStaff = await db.get('SELECT 1 FROM organizer_staff WHERE owner_user_id = ? AND staff_user_id = ?', [competition.owner_id, req.user.id]);
  if (!req.user.isOwner && !accountStaff) return res.status(403).json({ error: 'forbidden' });
  await db.run('UPDATE competitions SET owner_id = ? WHERE id = ?', [req.body.target_user_id, req.params.id]);
  res.json({ ok: true });
}));
`);
  await writeFile(path.join(middleware, "auth.js"), `
async function requireAuth(req, res, next) {
  const decoded = verifySessionToken(req.cookies.session);
  if (decoded.viewingAs) blockMutationsIfViewingAs(req, res, next);
  req.user = await loadUser(decoded.viewingAs?.targetUserId ?? decoded.id);
  return next();
}
async function optionalAuth(req, res, next) {
  const decoded = verifySessionToken(req.cookies.session);
  req.user = await loadUser(decoded.id);
  return next();
}
module.exports = { requireAuth, optionalAuth };
`);
  await writeFile(path.join(middleware, "block-mutations.js"), `
function blockMutationsIfViewingAs(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).json({ error: 'view-as is read-only' });
  return next();
}
module.exports = { blockMutationsIfViewingAs };
`);
  await writeFile(path.join(middleware, "phase-check.js"), `
async function checkPhaseAdvance(competitionId) {
  await db.run('UPDATE competition_phases SET status = ? WHERE competition_id = ?', ['active', competitionId]);
}
module.exports = { checkPhaseAdvance };
`);
  await writeFile(path.join(library, "audit-decoys.js"), Array.from({ length: 8 }, (_, index) => `
function auditReadMutation${index}() {
  return 'updates competition phase state';
}
`).join("\n"));
  await writeFile(path.join(tests, "authorization-audit.test.js"), `
describe('competition ownership transfer authorization staff role privilege', () => {});
describe('optional authentication view as mutation public post bypass', () => {});
describe('GET read request mutates updates competition phase state authorization', () => {});
`);

  const db = openDatabase(path.join(root, "index.sqlite"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await indexDirectory(db, root, { repoId: "retrieval-quality" });
  const context = {
    db,
    defaultRoot: root,
    defaultRepoId: "retrieval-quality",
    surface: "mcp",
    responseEvidenceHashes: new Set(),
  };
  const cases = [
    {
      query: "competition ownership transfer authorization staff role privilege",
      matches: [(result) => result.name === "POST /:id/transfer-owner"],
    },
    {
      query: "optional authentication view as mutation public post bypass",
      matches: [(result) => result.name === "optionalAuth"],
    },
    {
      query: "GET read request mutates updates competition phase state authorization",
      matches: [
        (result) => result.name === "GET /:id",
        (result) => result.name === "checkPhaseAdvance",
      ],
    },
  ];
  let responseBytes = 0;
  for (const benchmarkCase of cases) {
    const response = await callTool("find_code", {
      repo_id: "retrieval-quality",
      query: benchmarkCase.query,
      limit: 5,
      context_lines: 4,
    }, context);
    responseBytes += Buffer.byteLength(JSON.stringify(response), "utf8");
    assert.equal(response.response_detail, "compact");
    for (const matches of benchmarkCase.matches) {
      const target = response.results.find(matches);
      assert.ok(target, `${benchmarkCase.query}\nreturned: ${response.results.map((result) => `${result.name} (${result.file_path})`).join(", ")}`);
      assert.ok(target.literal_matches.length > 0, `${benchmarkCase.query} lacked centered evidence`);
    }
  }
  assert.ok(responseBytes <= 18_000, `compact retrieval used ${responseBytes} bytes`);
});
