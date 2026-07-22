import { spawnSync } from "node:child_process";
import { resolveRepository } from "./queries.mjs";

const NOISY_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
  "composer.lock", "Gemfile.lock", "Pipfile.lock",
]);

function trackable(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1);
  if (NOISY_BASENAMES.has(basename)) return false;
  if (/(^|\/)(?:node_modules|vendor|__pycache__|\.cache)\//.test(normalized)) return false;
  return !/\.(?:lock|sum|min\.js|min\.css|map|wasm|png|jpe?g|gif|ico|svg)$/i.test(normalized);
}

function resolveTargetFile(db, repository, target) {
  const normalized = String(target ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const exact = db.prepare("SELECT path FROM files WHERE repo_id = ? AND path = ?").get(repository.id, normalized);
  if (exact) return exact.path;
  const symbol = db.prepare(`
    SELECT f.path
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE s.repo_id = ? AND (s.qualified_name = ? OR s.name = ?)
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.exported DESC, f.path
    LIMIT 1
  `).get(repository.id, target, target, target);
  if (symbol) return symbol.path;
  throw new Error(`Indexed file or symbol not found: ${target}`);
}

function gitCommits(root, since, maxCommits) {
  const marker = "--GRAPHWARD-COMMIT--";
  const result = spawnSync("git", [
    "-c", `safe.directory=${root}`,
    "log", `--since=${since}`, `--max-count=${maxCommits}`, "--name-only",
    `--pretty=format:${marker}%n%H%x09%ct`,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || "not a Git repository or git is unavailable";
    throw new Error(`Unable to read git history: ${detail}`);
  }
  const commits = [];
  let current = null;
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === marker) {
      if (current) commits.push(current);
      current = { hash: null, timestamp: null, files: [] };
      continue;
    }
    if (!current) continue;
    if (!current.hash) {
      const [hash, timestamp] = line.split("\t");
      current.hash = hash;
      current.timestamp = Number(timestamp) || null;
    } else if (trackable(line)) {
      current.files.push(line.replaceAll("\\", "/"));
    }
  }
  if (current) commits.push(current);
  return commits;
}

export function getCochangeContext(db, {
  repoId = null,
  target,
  since = "1 year ago",
  maxCommits = 10000,
  maxFilesPerCommit = 20,
  minCochanges = 2,
  limit = 30,
} = {}) {
  if (!target?.trim()) throw new Error("target is required");
  const repository = resolveRepository(db, repoId);
  const targetFile = resolveTargetFile(db, repository, target);
  const indexed = new Set(db.prepare("SELECT path FROM files WHERE repo_id = ?").all(repository.id).map((row) => row.path));
  const commits = gitCommits(repository.root, String(since), Math.max(1, Math.min(Number(maxCommits) || 10000, 50000)));
  const eligible = commits
    .map((commit) => ({ ...commit, files: [...new Set(commit.files.filter((file) => indexed.has(file)))] }))
    .filter((commit) => commit.files.length > 0 && commit.files.length <= Math.max(2, Math.min(Number(maxFilesPerCommit) || 20, 200)));
  const fileCounts = new Map();
  for (const commit of eligible) {
    for (const file of commit.files) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
  }
  const targetCommits = eligible.filter((commit) => commit.files.includes(targetFile));
  const partners = new Map();
  for (const commit of targetCommits) {
    for (const file of commit.files) {
      if (file === targetFile) continue;
      const partner = partners.get(file) ?? { file_path: file, cochanges: 0, last_timestamp: 0, commits: [] };
      partner.cochanges += 1;
      partner.last_timestamp = Math.max(partner.last_timestamp, commit.timestamp ?? 0);
      if (partner.commits.length < 5) partner.commits.push(commit.hash);
      partners.set(file, partner);
    }
  }
  const targetCount = targetCommits.length;
  const results = [...partners.values()]
    .filter((partner) => partner.cochanges >= Math.max(1, Math.min(Number(minCochanges) || 2, 100)))
    .map((partner) => {
      const partnerCount = fileCounts.get(partner.file_path) ?? partner.cochanges;
      return {
        ...partner,
        partner_commits: partnerCount,
        coupling: partner.cochanges / Math.max(1, Math.min(targetCount, partnerCount)),
        jaccard: partner.cochanges / Math.max(1, targetCount + partnerCount - partner.cochanges),
        last_cochange: partner.last_timestamp ? new Date(partner.last_timestamp * 1000).toISOString() : null,
      };
    })
    .sort((a, b) => b.coupling - a.coupling || b.cochanges - a.cochanges || a.file_path.localeCompare(b.file_path))
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 200)));
  return {
    repo_id: repository.repo_id,
    target_file: targetFile,
    since,
    commits_scanned: commits.length,
    eligible_commits: eligible.length,
    target_commits: targetCount,
    results,
    methodology: "Commits touching more than max_files_per_commit and generated/lock assets are excluded. Coupling is cochanges / min(target commits, partner commits).",
  };
}
