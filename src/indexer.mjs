import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { IGNORED_DIRECTORIES, SOURCE_EXTENSIONS } from "./constants.mjs";
import { normalizeApiPath } from "./api-utils.mjs";
import {
  deleteFtsForFile,
  ensureRepository,
  withTransaction,
} from "./db.mjs";
import { detectLanguage, hashText, parseSource } from "./languages.mjs";
import { inspectRepositoryState } from "./repository-state.mjs";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const INDEX_FORMAT_VERSION = "8";

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join("/");
}

function defaultRepoId(root) {
  const name = path.basename(root) || "repository";
  const suffix = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 8);
  return `${name}-${suffix}`;
}

async function walkSourceFiles(root) {
  const results = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const info = await stat(absolute);
      if (info.size > MAX_SOURCE_BYTES) continue;
      results.push({ absolute, relative: normalizeRelative(path.relative(root, absolute)), info });
    }
  }
  await visit(root);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

function getGitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  if (result.status === 0) return result.stdout.trim();

  try {
    let gitDirectory = path.join(root, ".git");
    if (statSync(gitDirectory).isFile()) {
      const pointer = readFileSync(gitDirectory, "utf8").trim();
      if (!pointer.startsWith("gitdir:")) return null;
      gitDirectory = path.resolve(root, pointer.slice("gitdir:".length).trim());
    }
    const head = readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;
    if (!head.startsWith("ref:")) return null;
    const reference = head.slice("ref:".length).trim();
    const looseReference = path.join(gitDirectory, ...reference.split("/"));
    if (existsSync(looseReference)) return readFileSync(looseReference, "utf8").trim();
    const packedRefs = path.join(gitDirectory, "packed-refs");
    if (!existsSync(packedRefs)) return null;
    const match = readFileSync(packedRefs, "utf8")
      .split(/\r?\n/)
      .find((line) => line.endsWith(` ${reference}`));
    return match?.split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

function resolveImportPath(sourcePath, specifier, filePaths, pathsByBasename = new Map()) {
  const candidates = [];
  const sourceDirectory = path.posix.dirname(sourcePath);
  if (specifier.startsWith(".")) {
    candidates.push(path.posix.normalize(path.posix.join(sourceDirectory, specifier)));
  } else if (specifier.includes("/") && !specifier.startsWith("@")) {
    candidates.push(specifier.replace(/^\//, ""));
  }
  if (/^[.\w]+$/.test(specifier)) {
    const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const pythonPath = specifier.slice(leadingDots).replaceAll(".", "/");
    let pythonDirectory = sourceDirectory;
    for (let level = 1; level < leadingDots; level += 1) pythonDirectory = path.posix.dirname(pythonDirectory);
    candidates.push(pythonPath, path.posix.join(pythonDirectory, pythonPath));
  }
  candidates.push(specifier.replaceAll("\\", "/"));

  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java", ".cs"];
  for (const base of candidates) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (filePaths.has(candidate)) return candidate;
    }
    for (const indexName of ["index.ts", "index.tsx", "index.js", "index.py", "__init__.py", "mod.rs"]) {
      const candidate = path.posix.join(base, indexName);
      if (filePaths.has(candidate)) return candidate;
    }
  }
  const basename = path.posix.basename(specifier).replace(/\.[^.]+$/, "");
  const basenameMatches = pathsByBasename.get(basename) ?? [];
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function parseImportBindings(value) {
  try {
    const bindings = JSON.parse(value);
    if (!Array.isArray(bindings)) return [];
    return bindings.map((binding) => typeof binding === "string"
      ? { kind: "named", local: binding, imported: binding }
      : binding);
  } catch {
    return [];
  }
}

function uniqueTarget(candidates) {
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function rebuildEdges(db, repository) {
  const now = new Date().toISOString();
  db.prepare("DELETE FROM edges WHERE repo_id = ?").run(repository.id);
  const files = db.prepare("SELECT * FROM files WHERE repo_id = ?").all(repository.id);
  const fileById = new Map(files.map((file) => [file.id, file]));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const filePaths = new Set(fileByPath.keys());
  const pathsByBasename = new Map();
  for (const filePath of filePaths) {
    const basename = path.posix.basename(filePath).replace(/\.[^.]+$/, "");
    const values = pathsByBasename.get(basename) ?? [];
    values.push(filePath);
    pathsByBasename.set(basename, values);
  }
  const imports = db.prepare("SELECT * FROM file_imports WHERE repo_id = ?").all(repository.id);
  const importedTargetsByFile = new Map();
  const edgeRows = [];
  const edgeKeys = new Set();
  const addEdge = (edge) => {
    const key = [edge.kind, edge.sourceSymbolId ?? "", edge.targetSymbolId ?? "", edge.sourceFileId ?? "", edge.targetFileId ?? "", edge.label ?? ""].join(":");
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edgeRows.push([
      repository.id,
      edge.sourceSymbolId ?? null,
      edge.targetSymbolId ?? null,
      edge.sourceFileId ?? null,
      edge.targetFileId ?? null,
      edge.kind,
      edge.label ?? null,
      edge.confidence ?? 1,
      now,
    ]);
  };

  for (const imported of imports) {
    const sourceFile = fileById.get(imported.file_id);
    if (!sourceFile) continue;
    const resolvedPath = resolveImportPath(sourceFile.path, imported.specifier, filePaths, pathsByBasename);
    const targetFile = resolvedPath ? fileByPath.get(resolvedPath) : null;
    if (!targetFile) continue;
    addEdge({
      sourceFileId: sourceFile.id,
      targetFileId: targetFile.id,
      kind: "imports",
      label: imported.specifier,
      confidence: 0.99,
    });
    const targets = importedTargetsByFile.get(sourceFile.id) ?? [];
    targets.push({
      targetFileId: targetFile.id,
      specifier: imported.specifier,
      bindings: parseImportBindings(imported.imported_names),
    });
    importedTargetsByFile.set(sourceFile.id, targets);
  }

  const symbols = db.prepare("SELECT * FROM symbols WHERE repo_id = ? ORDER BY id").all(repository.id);
  const symbolByStableKey = new Map(symbols.map((symbol) => [symbol.stable_key, symbol]));
  const symbolsByName = new Map();
  const symbolsByFile = new Map();
  for (const symbol of symbols) {
    const named = symbolsByName.get(symbol.name) ?? [];
    named.push(symbol);
    symbolsByName.set(symbol.name, named);
    const inFile = symbolsByFile.get(symbol.file_id) ?? [];
    inFile.push(symbol);
    symbolsByFile.set(symbol.file_id, inFile);
  }

  const relationships = db.prepare("SELECT * FROM code_relationships WHERE repo_id = ? ORDER BY id").all(repository.id);
  const exportRowsByFile = new Map();
  const endpointDefinitionsByFile = new Map();
  for (const relationship of relationships) {
    if (relationship.category === "export") {
      const rows = exportRowsByFile.get(relationship.file_id) ?? [];
      rows.push(relationship);
      exportRowsByFile.set(relationship.file_id, rows);
    } else if (relationship.category === "endpoint_definition") {
      const rows = endpointDefinitionsByFile.get(relationship.file_id) ?? [];
      rows.push(relationship);
      endpointDefinitionsByFile.set(relationship.file_id, rows);
    }
  }
  const resolvedImportedFile = (sourceFileId, specifier) => {
    const sourceFile = fileById.get(sourceFileId);
    if (!sourceFile || !specifier) return null;
    const resolvedPath = resolveImportPath(sourceFile.path, specifier, filePaths, pathsByBasename);
    return resolvedPath ? fileByPath.get(resolvedPath) ?? null : null;
  };
  const symbolInFile = (fileId, name) => uniqueTarget((symbolsByFile.get(fileId) ?? []).filter((candidate) =>
    candidate.name === name || candidate.qualified_name === name,
  ));
  const resolveExportTarget = (fileId, exportedName, visited = new Set()) => {
    const key = `${fileId}:${exportedName}`;
    if (visited.has(key)) return null;
    const nextVisited = new Set(visited).add(key);
    const exactRows = (exportRowsByFile.get(fileId) ?? []).filter((row) => row.target_name === exportedName);
    const starRows = (exportRowsByFile.get(fileId) ?? []).filter((row) => row.kind === "export-all");
    for (const row of [...exactRows, ...starRows]) {
      if (["local", "alias", "default", "commonjs-named", "commonjs-default"].includes(row.kind)) {
        const localName = row.source_name || (exportedName === "default" ? null : exportedName);
        const local = localName ? symbolInFile(fileId, localName) : null;
        if (local) return local;
        if (exportedName === "default") {
          const fallback = uniqueTarget((symbolsByFile.get(fileId) ?? []).filter((candidate) =>
            candidate.exported && ["Function", "Class"].includes(candidate.kind),
          ));
          if (fallback) return fallback;
        }
      }
      if (["re-export", "export-all"].includes(row.kind) && row.specifier) {
        const targetFile = resolvedImportedFile(fileId, row.specifier);
        if (!targetFile) continue;
        const targetName = row.kind === "export-all" ? exportedName : row.source_name;
        const resolved = resolveExportTarget(targetFile.id, targetName, nextVisited)
          ?? symbolInFile(targetFile.id, targetName);
        if (resolved) return resolved;
      }
    }
    return symbolInFile(fileId, exportedName);
  };
  const resolveRelationshipTarget = (sourceFileId, targetName) => {
    if (!targetName) return null;
    const sameFile = symbolInFile(sourceFileId, targetName);
    if (sameFile) return sameFile;
    const [rootName, ...rest] = targetName.split(".");
    for (const imported of importedTargetsByFile.get(sourceFileId) ?? []) {
      const binding = imported.bindings.find((item) => item.local === rootName);
      if (!binding) continue;
      const importedName = binding.kind === "namespace"
        ? (rest.join(".") || rootName)
        : [binding.imported, ...rest].filter(Boolean).join(".");
      const resolved = resolveExportTarget(imported.targetFileId, importedName)
        ?? symbolInFile(imported.targetFileId, importedName);
      if (resolved) return resolved;
    }
    return uniqueTarget((symbolsByName.get(targetName.split(".").at(-1)) ?? []));
  };

  const selectorDefinitionsByFile = new Map();
  for (const relationship of relationships.filter((row) => row.category === "dom_selector" && row.kind === "registry-definition")) {
    const definitions = selectorDefinitionsByFile.get(relationship.file_id) ?? new Map();
    definitions.set(relationship.source_name, relationship.target_name);
    selectorDefinitionsByFile.set(relationship.file_id, definitions);
  }
  const canonicalSelectorKey = (relationship) => {
    if (relationship.target_name) return relationship.target_name;
    const reference = relationship.source_name;
    if (!reference) return null;
    const sameFile = selectorDefinitionsByFile.get(relationship.file_id)?.get(reference);
    if (sameFile) return sameFile;
    const [rootName, ...suffix] = reference.split(".");
    for (const imported of importedTargetsByFile.get(relationship.file_id) ?? []) {
      const binding = imported.bindings.find((item) => item.local === rootName);
      if (!binding) continue;
      const importedReference = binding.kind === "namespace"
        ? suffix.join(".")
        : [binding.imported, ...suffix].filter(Boolean).join(".");
      const resolved = selectorDefinitionsByFile.get(imported.targetFileId)?.get(importedReference);
      if (resolved) return resolved;
    }
    return null;
  };
  const selectorProducers = new Map();
  const selectorConsumers = [];
  for (const relationship of relationships.filter((row) => row.category === "dom_selector")) {
    const selectorKey = canonicalSelectorKey(relationship);
    if (!selectorKey) continue;
    if (["producer", "registry-producer"].includes(relationship.kind)) {
      const producers = selectorProducers.get(selectorKey) ?? [];
      producers.push(relationship);
      selectorProducers.set(selectorKey, producers);
    } else if (["consumer", "registry-consumer"].includes(relationship.kind)) {
      selectorConsumers.push({ relationship, selectorKey });
    }
  }
  for (const { relationship: consumer, selectorKey } of selectorConsumers) {
    const source = symbolByStableKey.get(consumer.source_stable_key);
    if (!source) continue;
    for (const producer of selectorProducers.get(selectorKey) ?? []) {
      const target = symbolByStableKey.get(producer.source_stable_key);
      if (!target || source.id === target.id) continue;
      addEdge({
        sourceSymbolId: source.id,
        targetSymbolId: target.id,
        sourceFileId: source.file_id,
        targetFileId: target.file_id,
        kind: "dom-selector",
        label: selectorKey,
        confidence: Math.min(Number(consumer.confidence) || 0.9, Number(producer.confidence) || 0.9),
      });
    }
  }

  for (const relationship of relationships) {
    if (!["heritage", "type_reference"].includes(relationship.category)) continue;
    const source = symbolByStableKey.get(relationship.source_stable_key);
    const target = source ? resolveRelationshipTarget(source.file_id, relationship.target_name) : null;
    if (!source || !target || source.id === target.id) continue;
    addEdge({
      sourceSymbolId: source.id,
      targetSymbolId: target.id,
      sourceFileId: source.file_id,
      targetFileId: target.file_id,
      kind: relationship.category === "type_reference" ? "type-reference" : relationship.kind,
      label: relationship.target_name,
      confidence: relationship.confidence,
    });
  }

  const calls = db.prepare("SELECT * FROM symbol_calls WHERE repo_id = ? ORDER BY id").all(repository.id);
  const resolvedCallRows = [];
  for (const call of calls) {
    const source = symbolByStableKey.get(call.source_stable_key);
    if (!source) {
      resolvedCallRows.push([
        call.repo_id, call.file_id, call.source_stable_key, call.callee_name, call.qualifier,
        call.call_line, call.syntax, call.occurrences, "missing-source", null, null,
      ]);
      continue;
    }

    const sameFileSymbols = symbolsByFile.get(source.file_id) ?? [];
    const importsForFile = importedTargetsByFile.get(source.file_id) ?? [];
    const rootQualifier = call.qualifier?.split(".")[0] ?? null;
    let target = null;
    let confidence = null;

    if (["this", "super", "self", "cls"].includes(call.qualifier)) {
      const owner = source.qualified_name.includes(".")
        ? source.qualified_name.split(".").slice(0, -1).join(".")
        : null;
      if (owner) target = uniqueTarget(sameFileSymbols.filter((candidate) => candidate.qualified_name === `${owner}.${call.callee_name}`));
      if (target) confidence = 0.99;
    } else if (call.qualifier) {
      target = uniqueTarget(sameFileSymbols.filter((candidate) => candidate.qualified_name === `${call.qualifier}.${call.callee_name}`));
      if (target) confidence = 0.99;
      if (!target && rootQualifier) {
        for (const imported of importsForFile) {
          const namespace = imported.bindings.find((binding) => ["namespace", "commonjs"].includes(binding.kind) && binding.local === rootQualifier);
          if (!namespace) continue;
          target = resolveExportTarget(imported.targetFileId, call.callee_name)
            ?? uniqueTarget((symbolsByFile.get(imported.targetFileId) ?? []).filter((candidate) => candidate.name === call.callee_name));
          if (target) {
            confidence = 0.97;
            break;
          }
        }
      }
    } else {
      target = uniqueTarget(sameFileSymbols.filter((candidate) => candidate.name === call.callee_name));
      if (target) confidence = 0.99;
      if (!target) {
        for (const imported of importsForFile) {
          const binding = imported.bindings.find((value) => value.local === call.callee_name && ["named", "default", "commonjs"].includes(value.kind));
          if (!binding) continue;
          const targetFileSymbols = symbolsByFile.get(imported.targetFileId) ?? [];
          if (binding.kind === "named") {
            target = resolveExportTarget(imported.targetFileId, binding.imported)
              ?? uniqueTarget(targetFileSymbols.filter((candidate) => candidate.name === binding.imported));
          } else if (binding.kind === "commonjs") {
            target = uniqueTarget(targetFileSymbols.filter((candidate) => candidate.name === call.callee_name))
              ?? uniqueTarget(targetFileSymbols.filter((candidate) => candidate.name === "default"))
              ?? uniqueTarget(targetFileSymbols.filter((candidate) => candidate.exported && ["Function", "Class"].includes(candidate.kind)));
          } else {
            target = resolveExportTarget(imported.targetFileId, "default")
              ?? uniqueTarget(targetFileSymbols.filter((candidate) => candidate.name === "default"))
              ?? uniqueTarget(targetFileSymbols.filter((candidate) => candidate.exported && ["Function", "Class"].includes(candidate.kind)));
          }
          if (target) {
            confidence = 0.97;
            break;
          }
        }
      }
      if (!target) {
        target = uniqueTarget(symbolsByName.get(call.callee_name) ?? []);
        if (target) confidence = 0.7;
      }
    }

    if (target) {
      addEdge({
        sourceSymbolId: source.id,
        targetSymbolId: target.id,
        sourceFileId: source.file_id,
        targetFileId: target.file_id,
        kind: "calls",
        label: call.qualifier ? `${call.qualifier}.${call.callee_name}` : call.callee_name,
        confidence,
      });
    }
    const status = target
      ? "resolved"
      : (symbolsByName.get(call.callee_name) ?? []).length > 1
        ? "ambiguous"
        : "unresolved";
    resolvedCallRows.push([
      call.repo_id, call.file_id, call.source_stable_key, call.callee_name, call.qualifier,
      call.call_line, call.syntax, call.occurrences, status, target?.id ?? null, confidence,
    ]);
  }

  const endpointDefinition = (fileId, symbolPath) =>
    (endpointDefinitionsByFile.get(fileId) ?? []).find((row) => row.source_name === symbolPath) ?? null;
  const resolveEndpointDefinition = (usage) => {
    const direct = endpointDefinition(usage.file_id, usage.source_name);
    if (direct) return direct;
    const [rootName, ...suffix] = String(usage.source_name ?? "").split(".");
    for (const imported of importedTargetsByFile.get(usage.file_id) ?? []) {
      const binding = imported.bindings.find((item) => item.local === rootName);
      if (!binding) continue;
      if (binding.kind === "namespace") {
        const namespacePath = suffix.join(".");
        const found = endpointDefinition(imported.targetFileId, namespacePath);
        if (found) return found;
        const exported = resolveExportTarget(imported.targetFileId, suffix[0]);
        if (exported) {
          const mapped = [exported.name, ...suffix.slice(1)].filter(Boolean).join(".");
          const resolved = endpointDefinition(exported.file_id, mapped);
          if (resolved) return resolved;
        }
      } else {
        const importedName = binding.imported === "default" ? "default" : binding.imported;
        const exported = resolveExportTarget(imported.targetFileId, importedName);
        const mappedRoot = exported?.name ?? importedName;
        const mapped = [mappedRoot, ...suffix].filter(Boolean).join(".");
        const resolved = endpointDefinition(exported?.file_id ?? imported.targetFileId, mapped);
        if (resolved) return resolved;
      }
    }
    return null;
  };
  db.prepare("DELETE FROM api_operations WHERE repo_id = ? AND handler_name LIKE 'graphward:endpoint:%'").run(repository.id);
  const insertDerivedApi = db.prepare(`
    INSERT INTO api_operations(
      repo_id, file_id, source_stable_key, kind, method, raw_path, normalized_path,
      framework, line, confidence, handler_name
    ) VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const usage of relationships.filter((row) => row.category === "endpoint_usage")) {
    const definition = usage.target_name ? null : resolveEndpointDefinition(usage);
    const rawPath = usage.target_name ?? definition?.target_name ?? null;
    const normalizedPath = normalizeApiPath(rawPath);
    if (!normalizedPath || !usage.source_stable_key) continue;
    insertDerivedApi.run(
      repository.id,
      usage.file_id,
      usage.source_stable_key,
      usage.kind,
      rawPath,
      normalizedPath,
      `endpoint-value:${usage.specifier ?? "http-client"}`,
      usage.start_line,
      Math.min(Number(usage.confidence) || 0.8, definition ? 0.97 : 0.99),
      `graphward:endpoint:${usage.source_name ?? "unknown"}`,
    );
  }
  for (let offset = 0; offset < edgeRows.length; offset += 250) {
    const chunk = edgeRows.slice(offset, offset + 250);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    db.prepare(`
      INSERT INTO edges(
        repo_id, source_symbol_id, target_symbol_id, source_file_id, target_file_id,
        kind, label, confidence, created_at
      ) VALUES ${placeholders}
    `).run(...chunk.flat());
  }
  db.prepare("DELETE FROM symbol_calls WHERE repo_id = ?").run(repository.id);
  for (let offset = 0; offset < resolvedCallRows.length; offset += 200) {
    const chunk = resolvedCallRows.slice(offset, offset + 200);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    db.prepare(`
      INSERT INTO symbol_calls(
        repo_id, file_id, source_stable_key, callee_name, qualifier, call_line, syntax,
        occurrences, resolution_status, target_symbol_id, confidence
      ) VALUES ${placeholders}
    `).run(...chunk.flat());
  }
  return edgeKeys.size;
}

function serializeSymbol(symbol, filePath) {
  return {
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    kind: symbol.kind,
    file_path: filePath,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
  };
}

export async function indexDirectory(db, requestedRoot, options = {}) {
  const startedAt = performance.now();
  const report = (stage, detail = {}) => options.onProgress?.({ stage, elapsed_ms: Number((performance.now() - startedAt).toFixed(1)), ...detail });
  const root = await realpath(path.resolve(requestedRoot));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${root}`);
  const repoId = options.repoId ?? defaultRepoId(root);
  const repoName = options.name ?? path.basename(root) ?? repoId;
  const preexistingRepository = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId) ?? null;
  const preexistingVersion = preexistingRepository
    ? db.prepare("SELECT value FROM metadata WHERE key = ?").get(`index_format:${preexistingRepository.id}`)?.value ?? null
    : null;
  const canReuseFileMetadata = Boolean(
    preexistingRepository
      && path.resolve(preexistingRepository.root) === root
      && !options.force
      && preexistingVersion === INDEX_FORMAT_VERSION,
  );
  const existingFileMetadata = canReuseFileMetadata
    ? new Map(db.prepare("SELECT * FROM files WHERE repo_id = ?").all(preexistingRepository.id).map((file) => [file.path, file]))
    : new Map();
  const sourceFiles = await walkSourceFiles(root);
  report("scanned", { files: sourceFiles.length });
  const snapshots = [];
  let filesParsed = 0;
  for (const file of sourceFiles) {
    const language = detectLanguage(file.absolute);
    if (!language) continue;
    const existing = existingFileMetadata.get(file.relative);
    if (existing
      && existing.size === file.info.size
      && Math.abs(existing.mtime_ms - file.info.mtimeMs) < 0.01) {
      snapshots.push({
        ...file,
        language,
        contentHash: existing.content_hash,
        parsed: null,
      });
      continue;
    }
    const content = await readFile(file.absolute, "utf8");
    filesParsed += 1;
    snapshots.push({
      ...file,
      content,
      language,
      contentHash: hashText(content),
      parsed: parseSource(content, language, file.relative),
    });
  }
  const parsedAt = performance.now();
  report("parsed", {
    files: filesParsed,
    reused_files: snapshots.length - filesParsed,
    symbols: snapshots.reduce((sum, snapshot) => sum + (snapshot.parsed?.symbols.length ?? 0), 0),
    call_relationships: snapshots.reduce((sum, snapshot) => sum + (snapshot.parsed?.calls.length ?? 0), 0),
    semantic_relationships: snapshots.reduce((sum, snapshot) => {
      const relationships = snapshot.parsed?.relationships;
      return sum
        + (relationships?.exports.length ?? 0)
        + (relationships?.heritage.length ?? 0)
        + (relationships?.typeReferences.length ?? 0)
        + (relationships?.memberHints.length ?? 0)
        + (relationships?.endpointValues.definitions.length ?? 0)
        + (relationships?.endpointValues.usages.length ?? 0)
        + (relationships?.domSelectors.length ?? 0);
    }, 0),
  });

  const repositoryState = inspectRepositoryState(root);
  const headCommit = repositoryState.head_commit ?? getGitHead(root);
  return withTransaction(db, () => {
    const repository = ensureRepository(db, root, repoId, repoName);
    const versionKey = `index_format:${repository.id}`;
    const storedVersion = db.prepare("SELECT value FROM metadata WHERE key = ?").get(versionKey)?.value ?? null;
    const fullReparse = Boolean(options.force) || storedVersion !== INDEX_FORMAT_VERSION;
    const existingFiles = db.prepare("SELECT * FROM files WHERE repo_id = ?").all(repository.id);
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const previousSymbolsByFile = new Map();
    if (fullReparse) {
      for (const symbol of db.prepare("SELECT * FROM symbols WHERE repo_id = ?").all(repository.id)) {
        const values = previousSymbolsByFile.get(symbol.file_id) ?? [];
        values.push(symbol);
        previousSymbolsByFile.set(symbol.file_id, values);
      }
      db.prepare("DELETE FROM symbols_fts WHERE repo_row_id = ?").run(repository.id);
      db.prepare("DELETE FROM edges WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM symbol_calls WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM file_imports WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM file_diagnostics WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM code_relationships WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM api_operations WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repository.id);
      db.prepare("DELETE FROM files WHERE repo_id = ?").run(repository.id);
    }
    const currentPaths = new Set(snapshots.map((file) => file.relative));
    const changes = [];
    const ftsRows = [];
    let filesChanged = 0;

    for (const snapshot of snapshots) {
      const existingFile = existingByPath.get(snapshot.relative);
      if (!fullReparse && existingFile?.content_hash === snapshot.contentHash) continue;
      filesChanged += 1;
      const previousSymbols = existingFile
        ? fullReparse
          ? previousSymbolsByFile.get(existingFile.id) ?? []
          : db.prepare("SELECT * FROM symbols WHERE file_id = ?").all(existingFile.id)
        : [];
      const previousByKey = new Map(previousSymbols.map((symbol) => [symbol.stable_key, symbol]));
      if (existingFile && !fullReparse) {
        if (!fullReparse) deleteFtsForFile(db, existingFile.id);
        db.prepare("DELETE FROM file_imports WHERE file_id = ?").run(existingFile.id);
        db.prepare("DELETE FROM symbol_calls WHERE file_id = ?").run(existingFile.id);
        db.prepare("DELETE FROM file_diagnostics WHERE file_id = ?").run(existingFile.id);
        db.prepare("DELETE FROM code_relationships WHERE file_id = ?").run(existingFile.id);
        db.prepare("DELETE FROM api_operations WHERE file_id = ?").run(existingFile.id);
        db.prepare("DELETE FROM symbols WHERE file_id = ?").run(existingFile.id);
      }

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO files(repo_id, path, language, size, mtime_ms, content_hash, line_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, path) DO UPDATE SET
          language = excluded.language,
          size = excluded.size,
          mtime_ms = excluded.mtime_ms,
          content_hash = excluded.content_hash,
          line_count = excluded.line_count,
          indexed_at = excluded.indexed_at
      `).run(
        repository.id,
        snapshot.relative,
        snapshot.language,
        snapshot.info.size,
        snapshot.info.mtimeMs,
        snapshot.contentHash,
        snapshot.parsed.lineCount,
        now,
      );
      const fileRecord = db.prepare("SELECT * FROM files WHERE repo_id = ? AND path = ?").get(repository.id, snapshot.relative);
      const insertSymbol = db.prepare(`
        INSERT INTO symbols(
          repo_id, file_id, stable_key, name, qualified_name, kind, signature,
          start_line, end_line, exported, body_hash, body_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const currentKeys = new Set();
      for (const symbol of snapshot.parsed.symbols) {
        currentKeys.add(symbol.stableKey);
        const previous = previousByKey.get(symbol.stableKey);
        const result = insertSymbol.run(
          repository.id,
          fileRecord.id,
          symbol.stableKey,
          symbol.name,
          symbol.qualifiedName,
          symbol.kind,
          symbol.signature,
          symbol.startLine,
          symbol.endLine,
          symbol.exported ? 1 : 0,
          symbol.bodyHash,
          symbol.bodyText,
          previous?.created_at ?? now,
          now,
        );
        const inserted = {
          id: Number(result.lastInsertRowid),
          repo_id: repository.id,
          file_id: fileRecord.id,
          stable_key: symbol.stableKey,
          name: symbol.name,
          qualified_name: symbol.qualifiedName,
          kind: symbol.kind,
          signature: symbol.signature,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
          exported: symbol.exported ? 1 : 0,
          body_hash: symbol.bodyHash,
          body_text: symbol.bodyText,
          created_at: previous?.created_at ?? now,
          updated_at: now,
        };
        ftsRows.push([
          inserted.id, inserted.repo_id, inserted.name, inserted.qualified_name,
          inserted.signature, inserted.body_text,
        ]);
        const changeType = !previous ? "added" : previous.body_hash !== symbol.bodyHash ? "modified" : null;
        if (changeType) changes.push({ changeType, entityType: "symbol", stableKey: symbol.stableKey, detail: serializeSymbol(inserted, snapshot.relative) });
      }
      for (const previous of previousSymbols) {
        if (!currentKeys.has(previous.stable_key)) {
          changes.push({ changeType: "removed", entityType: "symbol", stableKey: previous.stable_key, detail: serializeSymbol(previous, snapshot.relative) });
        }
      }
      const insertImport = db.prepare("INSERT INTO file_imports(repo_id, file_id, specifier, imported_names) VALUES (?, ?, ?, ?)");
      for (const imported of snapshot.parsed.imports) {
        insertImport.run(repository.id, fileRecord.id, imported.specifier, JSON.stringify(imported.bindings ?? imported.names ?? []));
      }
      const callRows = snapshot.parsed.calls.map((call) => [
          repository.id,
          fileRecord.id,
          call.sourceStableKey,
          call.calleeName,
          call.qualifier ?? null,
          call.callLine ?? null,
          call.syntax ?? "call",
          call.occurrences ?? 1,
      ]);
      for (let offset = 0; offset < callRows.length; offset += 250) {
        const chunk = callRows.slice(offset, offset + 250);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        db.prepare(`
          INSERT INTO symbol_calls(
            repo_id, file_id, source_stable_key, callee_name, qualifier, call_line, syntax, occurrences
          ) VALUES ${placeholders}
        `).run(...chunk.flat());
      }
      const apiRows = (snapshot.parsed.apiOperations ?? []).map((operation) => [
        repository.id,
        fileRecord.id,
        operation.sourceStableKey,
        operation.kind,
        operation.method,
        operation.rawPath,
        operation.normalizedPath,
        operation.framework,
        operation.line ?? null,
        operation.confidence ?? 1,
        operation.handlerName ?? null,
      ]);
      for (let offset = 0; offset < apiRows.length; offset += 200) {
        const chunk = apiRows.slice(offset, offset + 200);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        db.prepare(`
          INSERT INTO api_operations(
            repo_id, file_id, source_stable_key, kind, method, raw_path, normalized_path,
            framework, line, confidence, handler_name
          ) VALUES ${placeholders}
        `).run(...chunk.flat());
      }
      const semanticRows = [];
      const addRelationship = (category, kind, record, values = {}) => {
        semanticRows.push([
          repository.id,
          fileRecord.id,
          category,
          kind,
          values.sourceStableKey ?? record.sourceStableKey ?? null,
          values.sourceName ?? null,
          values.targetName ?? null,
          values.specifier ?? null,
          record.span?.start.line ?? null,
          record.span?.end.line ?? record.span?.start.line ?? null,
          values.confidence ?? record.confidence ?? 1,
          JSON.stringify(record),
        ]);
      };
      const semantic = snapshot.parsed.relationships;
      for (const record of semantic?.exports ?? []) {
        addRelationship("export", record.kind, record, {
          sourceName: record.localName ?? record.importedName,
          targetName: record.exportedName,
          specifier: record.source,
        });
      }
      for (const record of semantic?.heritage ?? []) {
        addRelationship("heritage", record.relation, record, {
          sourceName: record.subjectName,
          targetName: record.targetName,
          confidence: 0.99,
        });
      }
      for (const record of semantic?.typeReferences ?? []) {
        addRelationship("type_reference", record.context ?? "annotation", record, {
          sourceName: record.ownerName,
          targetName: record.targetName,
          confidence: 0.95,
        });
      }
      for (const record of semantic?.memberHints ?? []) {
        addRelationship("member_hint", record.kind, record, {
          sourceName: record.ownerName,
          targetName: record.expression,
          confidence: 0.9,
        });
      }
      for (const record of semantic?.endpointValues.definitions ?? []) {
        addRelationship("endpoint_definition", record.kind, record, {
          sourceName: record.symbolPath,
          targetName: record.valueTemplate,
          confidence: 0.99,
        });
      }
      for (const record of semantic?.endpointValues.usages ?? []) {
        addRelationship("endpoint_usage", record.method, record, {
          sourceName: record.valueExpression,
          targetName: record.valueTemplate,
          specifier: record.framework,
          confidence: record.confidence,
        });
      }
      for (const record of semantic?.domSelectors ?? []) {
        addRelationship("dom_selector", record.kind, record, {
          sourceStableKey: record.sourceStableKey,
          sourceName: record.registryReference ?? record.ownerName,
          targetName: record.selectorKey,
          specifier: record.selector,
          confidence: record.kind.startsWith("registry-") ? 0.98 : 0.99,
        });
      }
      for (let offset = 0; offset < semanticRows.length; offset += 150) {
        const chunk = semanticRows.slice(offset, offset + 150);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        db.prepare(`
          INSERT INTO code_relationships(
            repo_id, file_id, category, kind, source_stable_key, source_name, target_name,
            specifier, start_line, end_line, confidence, details_json
          ) VALUES ${placeholders}
        `).run(...chunk.flat());
      }
      db.prepare(`
        INSERT INTO file_diagnostics(
          file_id, repo_id, parser_mode, diagnostic_count, diagnostics_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        fileRecord.id,
        repository.id,
        snapshot.parsed.parser.mode,
        snapshot.parsed.parser.diagnostics.length,
        JSON.stringify(snapshot.parsed.parser.diagnostics),
        now,
      );
    }

    for (const existingFile of existingFiles) {
      if (currentPaths.has(existingFile.path)) continue;
      filesChanged += 1;
      const previousSymbols = fullReparse
        ? previousSymbolsByFile.get(existingFile.id) ?? []
        : db.prepare("SELECT * FROM symbols WHERE file_id = ?").all(existingFile.id);
      for (const symbol of previousSymbols) {
        changes.push({ changeType: "removed", entityType: "symbol", stableKey: symbol.stable_key, detail: serializeSymbol(symbol, existingFile.path) });
      }
      if (!fullReparse) {
        deleteFtsForFile(db, existingFile.id);
        db.prepare("DELETE FROM files WHERE id = ?").run(existingFile.id);
      }
    }

    for (let offset = 0; offset < ftsRows.length; offset += 250) {
      const chunk = ftsRows.slice(offset, offset + 250);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      db.prepare(`
        INSERT INTO symbols_fts(symbol_id, repo_row_id, name, qualified_name, signature, body_text)
        VALUES ${placeholders}
      `).run(...chunk.flat());
    }

    const persistedAt = performance.now();
    report("persisted", { files_changed: filesChanged });
    const edgeCount = fullReparse || filesChanged
      ? rebuildEdges(db, repository)
      : Number(db.prepare("SELECT COUNT(*) AS count FROM edges WHERE repo_id = ?").get(repository.id).count);
    const resolvedAt = performance.now();
    report("resolved", { edges: edgeCount });
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE repositories SET
        indexed_at = ?, head_commit = ?, branch = ?, git_common_dir = ?, git_dir = ?,
        worktree_id = ?, is_linked_worktree = ?, dirty = ?, dirty_file_count = ?,
        snapshot_id = ?, snapshot_json = ?, index_generation = index_generation + 1
      WHERE id = ?
    `).run(
      now,
      headCommit,
      repositoryState.branch,
      repositoryState.git_common_directory,
      repositoryState.git_directory,
      repositoryState.worktree_id,
      repositoryState.is_linked_worktree ? 1 : 0,
      repositoryState.dirty ? 1 : 0,
      repositoryState.dirty_file_count,
      repositoryState.snapshot_id,
      JSON.stringify(repositoryState),
      repository.id,
    );
    db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(versionKey, INDEX_FORMAT_VERSION);
    let episodeId = null;
    if (changes.length || filesChanged) {
      const summary = {
        files_changed: filesChanged,
        symbols_added: changes.filter((item) => item.changeType === "added").length,
        symbols_modified: changes.filter((item) => item.changeType === "modified").length,
        symbols_removed: changes.filter((item) => item.changeType === "removed").length,
      };
      const episode = db.prepare(`
        INSERT INTO episodes(repo_id, type, reference_time, source_id, summary_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(repository.id, options.episodeType ?? "index", now, headCommit, JSON.stringify(summary));
      episodeId = Number(episode.lastInsertRowid);
      const insertChange = db.prepare(`
        INSERT INTO episode_changes(episode_id, change_type, entity_type, stable_key, detail_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const change of changes) {
        insertChange.run(episodeId, change.changeType, change.entityType, change.stableKey, JSON.stringify(change.detail));
      }
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files WHERE repo_id = ?) AS files,
        (SELECT COUNT(*) FROM symbols WHERE repo_id = ?) AS symbols,
        (SELECT COUNT(*) FROM edges WHERE repo_id = ?) AS edges
    `).get(repository.id, repository.id, repository.id);
    const persistedRepository = db.prepare("SELECT * FROM repositories WHERE id = ?").get(repository.id);
    return {
      ok: true,
      repo_id: repoId,
      root,
      indexed_at: now,
      files_scanned: snapshots.length,
      files_parsed: filesParsed,
      files_changed: filesChanged,
      full_reparse: fullReparse,
      episode_id: episodeId,
      ...stats,
      edge_count: edgeCount,
      index_snapshot: {
        snapshot_id: persistedRepository.snapshot_id,
        index_generation: Number(persistedRepository.index_generation),
        head_commit: persistedRepository.head_commit,
        branch: persistedRepository.branch,
        worktree_id: persistedRepository.worktree_id,
        is_linked_worktree: Boolean(persistedRepository.is_linked_worktree),
        dirty: Boolean(persistedRepository.dirty),
        dirty_file_count: Number(persistedRepository.dirty_file_count),
        dirty_files: repositoryState.dirty_files,
        stale: false,
        warning: null,
      },
      timings_ms: {
        scan_and_parse: Number((parsedAt - startedAt).toFixed(1)),
        persist: Number((persistedAt - parsedAt).toFixed(1)),
        resolve: Number((resolvedAt - persistedAt).toFixed(1)),
        total: Number((performance.now() - startedAt).toFixed(1)),
      },
    };
  });
}

export function databaseLooksIndexed(db, root) {
  const resolved = path.resolve(root);
  return Boolean(db.prepare("SELECT 1 FROM repositories WHERE root = ?").get(resolved));
}

export function pathExists(value) {
  return existsSync(path.resolve(value));
}
