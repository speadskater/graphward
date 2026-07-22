#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_DIR, DEFAULT_DB_NAME, VERSION } from "./constants.mjs";
import { startDashboard } from "./dashboard.mjs";
import { openDatabase } from "./db.mjs";
import { getArchitecture, getRepoMap } from "./graph-analysis.mjs";
import { getCochangeContext } from "./history.mjs";
import { indexDirectory } from "./indexer.mjs";
import { serveMcp } from "./mcp.mjs";
import { findCode, getApiTopology, getCodeRelationships, getImpact, getIndexDiagnostics, getRepositoryStats, getSourceWindow, listIndexedRepositories } from "./queries.mjs";
import { WatchManager } from "./watcher.mjs";
import { changePreflight, findDependencyPath, inferExecutionFlows } from "./workflow-analysis.mjs";
import { getDefaultGraphwardDatabasePath, getGraphwardServiceStatus, getSavedGraphwardServiceProfile, startGraphwardService, stopGraphwardService } from "./service-lifecycle.mjs";
import { getSystemResourcePlan } from "./system-resources.mjs";
import { defaultMcpProjectRoot, setupClients } from "./client-setup.mjs";

function parseArguments(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Graphward ${VERSION} — local-only code graph and MCP server

Usage:
  graphward index [path] [--db PATH] [--repo-id ID]
  graphward start [--db PATH] [--port 7331]
  graphward status [--port 7331]
  graphward stop [--port 7331]
  graphward setup [codex|claude|all] [--only codex,claude] [--dry-run] [--force]
  graphward serve [--root PATH] [--db PATH] [--repo-id ID] [--index] [--watch]
  graphward dashboard [--root PATH] [--db PATH] [--repo-id ID] [--index] [--watch] [--port 7331]
  graphward stats [--root PATH] [--db PATH] [--repo-id ID]
  graphward diagnostics [--root PATH] [--db PATH] [--repo-id ID] [--limit N]
  graphward architecture [--root PATH] [--db PATH] [--repo-id ID]
  graphward map [focus] [--tokens N] [--db PATH] [--repo-id ID]
  graphward api [path] [--method GET] [--db PATH] [--repo-id ID]
  graphward cochange <file-or-symbol> [--since "1 year ago"] [--db PATH] [--repo-id ID]
  graphward search <query> [--root PATH] [--db PATH] [--repo-id ID]
  graphward source <file> [--start N] [--end N] [--db PATH] [--repo-id ID]
  graphward relationships [symbol] [--file-path PATH] [--category export|heritage|type_reference|member_hint|endpoint_definition|endpoint_usage] [--db PATH] [--repo-id ID]
  graphward impact <symbol> [--direction upstream|downstream|both] [--depth N] [--db PATH] [--repo-id ID]
  graphward path <source-symbol> <target-symbol> [--max-depth N] [--min-confidence N] [--db PATH] [--repo-id ID]
  graphward flows [--route-path PATH] [--method GET] [--max-depth N] [--max-results N] [--db PATH] [--repo-id ID]
  graphward preflight [diff-file] [--impact-depth N] [--no-cochange] [--db PATH] [--repo-id ID]
  graphward doctor [--root PATH] [--db PATH]

The MCP server additionally exposes bounded hybrid search, temporal replay, structured decisions,
worktree overlays, service topology, quality analysis, persistent static processes, briefings, and
local diff review. Use the tool schemas for per-call limits; history replay is explicit and opt-in.
The optional visual loopback dashboard serves bundled local assets with token-protected APIs.
  No command makes outbound network requests. The background dashboard and MCP server share a per-user Graphward database.`;
}

async function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  const command = positional.shift() ?? "help";
  if (command === "version" || command === "--version" || flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const acceptsRootPosition = ["index", "start"].includes(command);
  const defaultRoot = command === "serve" ? defaultMcpProjectRoot() : process.cwd();
  const root = path.resolve(flags.root ?? (acceptsRootPosition && positional[0] ? positional[0] : defaultRoot));
  const requestedPort = Number(flags.port ?? 7331);
  const usesServiceDatabase = ["start", "serve", "dashboard"].includes(command);
  const savedProfile = usesServiceDatabase && flags.db == null
    ? getSavedGraphwardServiceProfile({ port: requestedPort })
    : null;
  const databasePath = path.resolve(flags.db ?? savedProfile?.database ?? (
    usesServiceDatabase ? getDefaultGraphwardDatabasePath({ port: requestedPort }) : path.join(root, DEFAULT_DB_DIR, DEFAULT_DB_NAME)
  ));
  const lifecycleOptions = {
    initialRoot: flags.root || positional[0] ? root : os.homedir(),
    databasePath,
    host: flags.host ?? savedProfile?.host ?? "127.0.0.1",
    port: Number(flags.port ?? savedProfile?.port ?? 7331),
  };
  if (command === "start") {
    print(await startGraphwardService({ ...lifecycleOptions, cliPath: fileURLToPath(import.meta.url) }));
    return;
  }
  if (command === "status") {
    print(getGraphwardServiceStatus({ port: lifecycleOptions.port }));
    return;
  }
  if (command === "stop") {
    print(stopGraphwardService({ port: lifecycleOptions.port }));
    return;
  }
  if (command === "setup") {
    if (flags.only && positional.length > 0) throw new Error("setup accepts either a target argument or --only, not both");
    if (positional.length > 1) throw new Error("setup accepts one target argument or a comma-separated --only list");
    const result = await setupClients({
      targets: flags.only ?? positional[0] ?? null,
      cliPath: fileURLToPath(import.meta.url),
      dryRun: Boolean(flags.dry_run),
      force: Boolean(flags.force),
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const db = openDatabase(databasePath);
  const watchManager = new WatchManager(db, (message) => console.error(`[graphward] ${message}`));
  let closeWhenDone = true;
  try {
    switch (command) {
      case "index":
        print(await indexDirectory(db, root, {
          repoId: flags.repo_id,
          force: Boolean(flags.force),
          onProgress: (progress) => console.error(`[graphward] ${JSON.stringify(progress)}`),
        }));
        break;
      case "serve": {
        if (flags.index) await indexDirectory(db, root, { repoId: flags.repo_id });
        if (flags.watch) await watchManager.start(root, { repoId: flags.repo_id });
        closeWhenDone = false;
        await serveMcp({ db, defaultRoot: root, watchManager });
        break;
      }
      case "dashboard": {
        if (flags.index) await indexDirectory(db, root, { repoId: flags.repo_id });
        if (flags.watch) await watchManager.start(root, { repoId: flags.repo_id });
        if (flags.watch_indexed) {
          for (const repository of listIndexedRepositories(db)) {
            try {
              await watchManager.start(repository.root, { repoId: repository.repo_id });
            } catch (error) {
              console.error(`[graphward] unable to restore watcher for ${repository.root}: ${error.message}`);
            }
          }
        }
        const dashboard = await startDashboard({
          db,
          defaultRoot: root,
          defaultRepoId: flags.repo_id ?? null,
          watchManager,
          host: flags.host ?? "127.0.0.1",
          port: Number(flags.port ?? 7331),
        });
        process.stdout.write(`Graphward dashboard: ${dashboard.url}\n`);
        await new Promise((resolve, reject) => {
          let closing = false;
          const close = () => {
            if (closing) return;
            closing = true;
            dashboard.close().then(resolve, reject);
          };
          process.once("SIGINT", close);
          process.once("SIGTERM", close);
        });
        break;
      }
      case "stats":
        print(flags.repo_id ? getRepositoryStats(db, flags.repo_id) : { repositories: listIndexedRepositories(db) });
        break;
      case "diagnostics":
        print(getIndexDiagnostics(db, { repoId: flags.repo_id, limit: Number(flags.limit ?? 25) }));
        break;
      case "architecture":
        print(getArchitecture(db, { repoId: flags.repo_id, maxCommunities: Number(flags.max_communities ?? 12), maxSymbols: Number(flags.max_symbols ?? 20) }));
        break;
      case "map":
        print(getRepoMap(db, { repoId: flags.repo_id, focus: positional.join(" ") || null, tokenBudget: Number(flags.tokens ?? 2000), maxSymbols: Number(flags.max_symbols ?? 120) }));
        break;
      case "api":
        print(getApiTopology(db, { repoId: flags.repo_id, path: positional.join(" ") || null, method: flags.method, limit: Number(flags.limit ?? 5000) }));
        break;
      case "cochange": {
        const target = positional.join(" ");
        if (!target) throw new Error("cochange requires an indexed file path or symbol");
        print(getCochangeContext(db, { repoId: flags.repo_id, target, since: flags.since ?? "1 year ago", limit: Number(flags.limit ?? 30) }));
        break;
      }
      case "search": {
        const query = positional.join(" ");
        if (!query) throw new Error("search requires a query");
        print({ results: findCode(db, { repoId: flags.repo_id, query, limit: Number(flags.limit ?? 20) }) });
        break;
      }
      case "source": {
        const filePath = positional.join(" ");
        if (!filePath) throw new Error("source requires a repository-relative file path");
        print(getSourceWindow(db, {
          repoId: flags.repo_id,
          filePath,
          startLine: Number(flags.start ?? 1),
          endLine: flags.end == null ? null : Number(flags.end),
        }));
        break;
      }
      case "impact": {
        const target = positional.join(" ");
        if (!target) throw new Error("impact requires a symbol");
        print(getImpact(db, {
          repoId: flags.repo_id,
          target,
          direction: flags.direction ?? "upstream",
          depth: Number(flags.depth ?? 5),
        }));
        break;
      }
      case "relationships":
        print(getCodeRelationships(db, {
          repoId: flags.repo_id,
          symbol: positional.join(" ") || null,
          filePath: flags.file_path,
          category: flags.category,
          limit: Number(flags.limit ?? 200),
        }));
        break;
      case "path": {
        const [source, target] = positional;
        if (!source || !target) throw new Error("path requires source and target symbols");
        print(findDependencyPath(db, {
          repoId: flags.repo_id,
          source,
          target,
          sourceFilePath: flags.source_file,
          targetFilePath: flags.target_file,
          maxDepth: Number(flags.max_depth ?? 12),
          minConfidence: Number(flags.min_confidence ?? 0),
        }));
        break;
      }
      case "flows":
        print(inferExecutionFlows(db, {
          repoId: flags.repo_id,
          includeRoutes: !flags.no_routes,
          includeEntryPoints: !flags.no_entry_points,
          routePath: flags.route_path,
          method: flags.method,
          maxDepth: Number(flags.max_depth ?? 6),
          maxResults: Number(flags.max_results ?? 100),
          minConfidence: Number(flags.min_confidence ?? 0.5),
        }));
        break;
      case "preflight": {
        const diffPath = positional[0];
        const diff = diffPath ? await readFile(path.resolve(diffPath), "utf8") : null;
        print(changePreflight(db, {
          repoId: flags.repo_id,
          diff,
          impactDepth: Number(flags.impact_depth ?? 5),
          includeCochange: !flags.no_cochange,
          cochangeSince: flags.cochange_since ?? "1 year ago",
        }));
        break;
      }
      case "doctor":
        print({
          ok: true,
          version: VERSION,
          node: process.version,
          root,
          database: databasePath,
          network_required: false,
          resources: getSystemResourcePlan(),
          repositories: listIndexedRepositories(db),
        });
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${usage()}`);
    }
  } finally {
    if (closeWhenDone) {
      watchManager.close();
      db.close();
    } else {
      watchManager.close();
      db.close();
    }
  }
}

main().catch((error) => {
  console.error(`graphward: ${error.message}`);
  process.exitCode = 1;
});
