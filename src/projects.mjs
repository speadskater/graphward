import { pathIdentity } from "./path-utils.mjs";
import { listIndexedRepositories } from "./queries.mjs";

function repositoryOrder(left, right) {
  const linked = Number(Boolean(left.index_snapshot?.is_linked_worktree))
    - Number(Boolean(right.index_snapshot?.is_linked_worktree));
  return linked
    || String(left.index_snapshot?.branch ?? "").localeCompare(String(right.index_snapshot?.branch ?? ""))
    || left.repo_id.localeCompare(right.repo_id);
}

export function groupIndexedProjects(db, repositories = listIndexedRepositories(db)) {
  const metadata = new Map(db.prepare(`
    SELECT repo_id, git_common_dir
    FROM repositories
  `).all().map((row) => [row.repo_id, row]));
  const groups = new Map();

  for (const repository of repositories) {
    const commonDirectory = metadata.get(repository.repo_id)?.git_common_dir;
    const key = pathIdentity(commonDirectory || repository.root);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(repository);
  }

  return [...groups.values()].map((members) => {
    const ordered = [...members].sort(repositoryOrder);
    const mainRepository = ordered.find((repository) => !repository.index_snapshot?.is_linked_worktree) ?? null;
    const primaryRepository = mainRepository ?? ordered[0];
    const worktrees = ordered.filter((repository) => repository.index_snapshot?.is_linked_worktree);
    return {
      project_id: primaryRepository.repo_id,
      name: primaryRepository.name ?? primaryRepository.repo_id,
      root: primaryRepository.root,
      primary_repo_id: primaryRepository.repo_id,
      main_repo_id: mainRepository?.repo_id ?? null,
      has_main_checkout: Boolean(mainRepository),
      main_repository: mainRepository,
      worktree_count: worktrees.length,
      worktrees,
      repo_ids: ordered.map((repository) => repository.repo_id),
      repositories: ordered,
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.project_id.localeCompare(right.project_id));
}

export function resolveIndexedProject(db, repoId) {
  const project = groupIndexedProjects(db).find((candidate) => candidate.repo_ids.includes(repoId));
  if (!project) throw new Error(`Unknown repo_id: ${repoId}`);
  return project;
}
