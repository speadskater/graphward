import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runGit(root, args, { trim = true } = {}) {
  const result = spawnSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout.replace(/\r?\n$/, "")) : null;
}

function portablePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function statusPaths(status) {
  return String(status ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value = line.slice(3).trim();
      const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
      return renamed.replace(/^"|"$/g, "");
    })
    .filter((filePath) => !filePath.replaceAll("\\", "/").split("/").some((part) => [".graphward", ".memtrace", ".memdb"].includes(part)));
}

function dirtyFileEvidence(root, files) {
  return files.map((filePath) => {
    try {
      const info = statSync(path.resolve(root, filePath));
      return `${filePath}:${info.size}:${info.mtimeMs}`;
    } catch {
      return `${filePath}:missing`;
    }
  });
}

export function inspectRepositoryState(root) {
  const resolvedRoot = path.resolve(root);
  const head = runGit(resolvedRoot, ["rev-parse", "HEAD"]);
  const gitDirectoryValue = runGit(resolvedRoot, ["rev-parse", "--absolute-git-dir"]);
  const commonDirectoryValue = runGit(resolvedRoot, ["rev-parse", "--git-common-dir"]);
  const branch = runGit(resolvedRoot, ["branch", "--show-current"]);
  const status = runGit(resolvedRoot, ["status", "--porcelain=v1", "--untracked-files=all"], { trim: false }) ?? "";
  const dirtyFiles = statusPaths(status);
  const gitDirectory = gitDirectoryValue ? path.resolve(resolvedRoot, gitDirectoryValue) : null;
  const commonDirectory = commonDirectoryValue ? path.resolve(resolvedRoot, commonDirectoryValue) : null;
  const worktreeId = createHash("sha256").update(portablePath(resolvedRoot).toLowerCase()).digest("hex").slice(0, 12);
  const evidence = {
    root: portablePath(resolvedRoot),
    head,
    branch: branch || null,
    status: dirtyFiles,
    dirty_files: dirtyFileEvidence(resolvedRoot, dirtyFiles),
  };
  return {
    root: resolvedRoot,
    head_commit: head,
    branch: branch || null,
    git_directory: gitDirectory,
    git_common_directory: commonDirectory,
    is_git_repository: Boolean(gitDirectory),
    is_linked_worktree: Boolean(gitDirectory && commonDirectory && portablePath(gitDirectory) !== portablePath(commonDirectory)),
    worktree_id: worktreeId,
    dirty: dirtyFiles.length > 0,
    dirty_file_count: dirtyFiles.length,
    dirty_files: dirtyFiles.slice(0, 200),
    snapshot_id: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
}

export function storedIndexSnapshot(repository) {
  let details = {};
  try {
    details = JSON.parse(repository.snapshot_json ?? "{}");
  } catch {
    details = {};
  }
  return {
    snapshot_id: repository.snapshot_id ?? null,
    index_generation: Number(repository.index_generation ?? 0),
    indexed_at: repository.indexed_at ?? null,
    root: repository.root,
    head_commit: repository.head_commit ?? null,
    branch: repository.branch ?? details.branch ?? null,
    worktree_id: repository.worktree_id ?? details.worktree_id ?? null,
    is_linked_worktree: Boolean(repository.is_linked_worktree ?? details.is_linked_worktree),
    dirty: Boolean(repository.dirty ?? details.dirty),
    dirty_file_count: Number(repository.dirty_file_count ?? details.dirty_file_count ?? 0),
    dirty_files: details.dirty_files ?? [],
  };
}

export function getIndexFreshness(repository) {
  const indexed = storedIndexSnapshot(repository);
  const current = inspectRepositoryState(repository.root);
  const stale = !indexed.snapshot_id || indexed.snapshot_id !== current.snapshot_id;
  return {
    ...indexed,
    stale,
    current_snapshot_id: current.snapshot_id,
    current_head_commit: current.head_commit,
    current_dirty: current.dirty,
    current_dirty_file_count: current.dirty_file_count,
    warning: stale
      ? "The working tree changed after this index generation. Refresh before trusting symbol, relationship, or impact results."
      : null,
  };
}
