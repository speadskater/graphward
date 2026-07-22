import path from "node:path";
import { createHash } from "node:crypto";
import { CALL_KEYWORDS, SOURCE_EXTENSIONS } from "./constants.mjs";
import { parseJavaScriptSource } from "./javascript-parser.mjs";
import { extractJavaScriptRelationships } from "./javascript-relationships.mjs";
import { parsePythonSource } from "./python-parser.mjs";

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function detectLanguage(filePath) {
  return SOURCE_EXTENSIONS.get(path.extname(filePath).toLowerCase()) ?? null;
}

function normalizedSignature(line) {
  return line.trim().replace(/\s+/g, " ").slice(0, 500);
}

function indentation(line) {
  const prefix = line.match(/^[\t ]*/)?.[0] ?? "";
  return [...prefix].reduce((count, char) => count + (char === "\t" ? 4 : 1), 0);
}

function stripStringsAndComments(line) {
  return line
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/(?![/*])(?:\\.|[^/\\\r\n])+\/[dgimsuvy]*/g, "REGEX")
    .replace(/\/\/.*$/g, " ")
    .replace(/#.*$/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function findBraceBlockEnd(lines, startIndex) {
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const clean = stripStringsAndComments(lines[index]);
    for (const char of clean) {
      if (char === "{") {
        opened = true;
        depth += 1;
      } else if (char === "}" && opened) {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) return index;
    if (!opened && index > startIndex + 8) return startIndex;
  }
  return opened ? lines.length - 1 : startIndex;
}

function findIndentedBlockEnd(lines, startIndex) {
  const baseIndent = indentation(lines[startIndex]);
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
    if (indentation(lines[index]) <= baseIndent) return index - 1;
  }
  return lines.length - 1;
}

function findRubyBlockEnd(lines, startIndex) {
  let depth = 0;
  const opener = /^\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b|\bdo\s*(?:\|[^|]*\|)?\s*$/;
  for (let index = startIndex; index < lines.length; index += 1) {
    const clean = stripStringsAndComments(lines[index]);
    if (opener.test(clean)) depth += 1;
    if (/^\s*end\b/.test(clean)) {
      depth -= 1;
      if (depth <= 0) return index;
    }
  }
  return lines.length - 1;
}

function enclosingClass(classRanges, lineIndex) {
  const matches = classRanges.filter(
    (range) => range.startIndex < lineIndex && range.endIndex >= lineIndex,
  );
  return matches.sort((a, b) => b.startIndex - a.startIndex)[0] ?? null;
}

function addSymbol(symbols, lines, definition, occurrenceCounts) {
  const startIndex = Math.max(0, definition.startIndex);
  const endIndex = Math.max(startIndex, Math.min(lines.length - 1, definition.endIndex));
  const baseKey = `${definition.qualifiedName}|${definition.kind}`;
  const occurrence = occurrenceCounts.get(baseKey) ?? 0;
  occurrenceCounts.set(baseKey, occurrence + 1);
  symbols.push({
    internalId: definition.internalId ?? null,
    name: definition.name,
    qualifiedName: definition.qualifiedName,
    kind: definition.kind,
    signature: normalizedSignature(lines[startIndex] ?? definition.name),
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    exported: Boolean(definition.exported),
    stableSuffix: occurrence ? `#${occurrence + 1}` : "",
    bodyText: lines.slice(startIndex, endIndex + 1).join("\n"),
  });
}

function parseJavaScriptLike(lines) {
  const definitions = [];
  const classRanges = [];

  lines.forEach((line, startIndex) => {
    let match = line.match(/^\s*(export\s+(?:default\s+)?)?(?:declare\s+|abstract\s+)?(class|interface|enum)\s+([A-Za-z_$][\w$]*)/);
    if (match) {
      const kind = match[2][0].toUpperCase() + match[2].slice(1);
      const endIndex = findBraceBlockEnd(lines, startIndex);
      const range = { name: match[3], startIndex, endIndex };
      classRanges.push(range);
      definitions.push({ ...range, qualifiedName: match[3], kind, exported: Boolean(match[1]) });
      return;
    }

    match = line.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (match) {
      definitions.push({
        name: match[2],
        qualifiedName: match[2],
        kind: "Function",
        startIndex,
        endIndex: findBraceBlockEnd(lines, startIndex),
        exported: Boolean(match[1]),
      });
      return;
    }

    match = line.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (match) {
      definitions.push({
        name: match[2],
        qualifiedName: match[2],
        kind: "Function",
        startIndex,
        endIndex: findBraceBlockEnd(lines, startIndex),
        exported: Boolean(match[1]),
      });
      return;
    }

    match = line.match(/^\s*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      definitions.push({
        name: match[2],
        qualifiedName: match[2],
        kind: "TypeAlias",
        startIndex,
        endIndex: line.includes("{") ? findBraceBlockEnd(lines, startIndex) : startIndex,
        exported: Boolean(match[1]),
      });
    }
  });

  for (const range of classRanges) {
    for (let startIndex = range.startIndex + 1; startIndex < range.endIndex; startIndex += 1) {
      const line = lines[startIndex];
      const match = line.match(/^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::[^={]+)?\s*[{;]/);
      if (!match || CALL_KEYWORDS.has(match[1])) continue;
      const name = match[1];
      definitions.push({
        name,
        qualifiedName: `${range.name}.${name}`,
        kind: name === "constructor" ? "Constructor" : "Method",
        startIndex,
        endIndex: line.includes("{") ? findBraceBlockEnd(lines, startIndex) : startIndex,
        exported: false,
      });
    }
  }
  return definitions;
}

function parsePython(lines) {
  const definitions = [];
  const classRanges = [];
  lines.forEach((line, startIndex) => {
    let match = line.match(/^\s*class\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      const endIndex = findIndentedBlockEnd(lines, startIndex);
      classRanges.push({ name: match[1], startIndex, endIndex });
      definitions.push({ name: match[1], qualifiedName: match[1], kind: "Class", startIndex, endIndex });
      return;
    }
    match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (!match) return;
    const owner = enclosingClass(classRanges, startIndex);
    definitions.push({
      name: match[1],
      qualifiedName: owner ? `${owner.name}.${match[1]}` : match[1],
      kind: owner ? "Method" : "Function",
      startIndex,
      endIndex: findIndentedBlockEnd(lines, startIndex),
      exported: !match[1].startsWith("_"),
    });
  });
  return definitions;
}

function parseGo(lines) {
  const definitions = [];
  lines.forEach((line, startIndex) => {
    let match = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/);
    if (match) {
      definitions.push({
        name: match[1], qualifiedName: match[1], kind: "Function", startIndex,
        endIndex: findBraceBlockEnd(lines, startIndex), exported: /^[A-Z]/.test(match[1]),
      });
      return;
    }
    match = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/);
    if (match) {
      definitions.push({
        name: match[1], qualifiedName: match[1], kind: match[2] === "struct" ? "Struct" : "Interface",
        startIndex, endIndex: findBraceBlockEnd(lines, startIndex), exported: /^[A-Z]/.test(match[1]),
      });
    }
  });
  return definitions;
}

function parseRust(lines) {
  const definitions = [];
  lines.forEach((line, startIndex) => {
    let match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/);
    if (match) {
      definitions.push({
        name: match[1], qualifiedName: match[1], kind: "Function", startIndex,
        endIndex: findBraceBlockEnd(lines, startIndex), exported: /^\s*pub\b/.test(line),
      });
      return;
    }
    match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod)\s+([A-Za-z_][\w]*)\b/);
    if (match) {
      const names = { struct: "Struct", enum: "Enum", trait: "Trait", type: "TypeAlias", mod: "Module" };
      definitions.push({
        name: match[2], qualifiedName: match[2], kind: names[match[1]], startIndex,
        endIndex: line.includes("{") ? findBraceBlockEnd(lines, startIndex) : startIndex,
        exported: /^\s*pub\b/.test(line),
      });
    }
  });
  return definitions;
}

function parseClassAndMethods(lines, language) {
  const definitions = [];
  const classRanges = [];
  lines.forEach((line, startIndex) => {
    const match = line.match(/^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|static|final|data|partial)\s+)*(class|interface|enum|record|struct)\s+([A-Za-z_][\w]*)\b/);
    if (!match) return;
    const kinds = { class: "Class", interface: "Interface", enum: "Enum", record: "Record", struct: "Struct" };
    const endIndex = findBraceBlockEnd(lines, startIndex);
    classRanges.push({ name: match[2], startIndex, endIndex });
    definitions.push({ name: match[2], qualifiedName: match[2], kind: kinds[match[1]], startIndex, endIndex, exported: /\bpublic\b/.test(line) });
  });

  const methodPattern = language === "kotlin"
    ? /^\s*(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|infix|tailrec)\s+)*fun\s+([A-Za-z_][\w]*)\s*\(/
    : /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|synchronized|async|unsafe|extern|native)\s+)*(?:<[^>]+>\s*)?[A-Za-z_][\w<>,.?\[\] ]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\s*\{/;

  lines.forEach((line, startIndex) => {
    const match = line.match(methodPattern);
    if (!match || CALL_KEYWORDS.has(match[1])) return;
    const owner = enclosingClass(classRanges, startIndex);
    definitions.push({
      name: match[1], qualifiedName: owner ? `${owner.name}.${match[1]}` : match[1],
      kind: owner ? "Method" : "Function", startIndex,
      endIndex: findBraceBlockEnd(lines, startIndex), exported: /\bpublic\b/.test(line),
    });
  });
  return definitions;
}

function parseRuby(lines) {
  const definitions = [];
  const classRanges = [];
  lines.forEach((line, startIndex) => {
    let match = line.match(/^\s*class\s+([A-Za-z_][\w:]*)/);
    if (match) {
      const endIndex = findRubyBlockEnd(lines, startIndex);
      classRanges.push({ name: match[1], startIndex, endIndex });
      definitions.push({ name: match[1], qualifiedName: match[1], kind: "Class", startIndex, endIndex });
      return;
    }
    match = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/);
    if (!match) return;
    const owner = enclosingClass(classRanges, startIndex);
    definitions.push({
      name: match[1], qualifiedName: owner ? `${owner.name}.${match[1]}` : match[1],
      kind: owner ? "Method" : "Function", startIndex, endIndex: findRubyBlockEnd(lines, startIndex),
    });
  });
  return definitions;
}

function parseDefinitions(lines, language) {
  if (language === "javascript" || language === "typescript") return parseJavaScriptLike(lines);
  if (language === "python") return parsePython(lines);
  if (language === "go") return parseGo(lines);
  if (language === "rust") return parseRust(lines);
  if (["java", "csharp", "kotlin", "swift", "c", "cpp", "php"].includes(language)) {
    return parseClassAndMethods(lines, language);
  }
  if (language === "ruby") return parseRuby(lines);
  return [];
}

function parseImports(content, language) {
  const imports = [];
  if (language === "javascript" || language === "typescript") {
    const importPattern = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[2] ?? match[3] ?? match[4];
      const clause = match[1] ?? "";
      const names = [...clause.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
        .map((item) => item[1])
        .filter((name) => !["as", "type"].includes(name));
      imports.push({ specifier, names: [...new Set(names)] });
    }
  } else if (language === "python") {
    for (const line of content.split(/\r?\n/)) {
      let match = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
      if (match) {
        const names = match[2].split(",").map((value) => value.trim().split(/\s+as\s+/).pop()).filter(Boolean);
        imports.push({ specifier: match[1], names });
        continue;
      }
      match = line.match(/^\s*import\s+(.+)$/);
      if (match) {
        for (const value of match[1].split(",")) {
          const specifier = value.trim().split(/\s+as\s+/)[0];
          if (specifier) imports.push({ specifier, names: [] });
        }
      }
    }
  } else {
    const patterns = [
      /^\s*use\s+([^;]+);/gm,
      /^\s*using\s+([^;]+);/gm,
      /^\s*import\s+(?:static\s+)?([\w.*]+);/gm,
      /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) imports.push({ specifier: match[1], names: [] });
    }
  }
  return imports.filter((item) => item.specifier);
}

export function parseSource(content, language, relativePath) {
  const lines = content.split(/\r?\n/);
  const occurrenceCounts = new Map();
  const symbols = [];
  const isJavaScript = language === "javascript" || language === "typescript";
  const isPython = language === "python";
  const structured = isJavaScript
    ? parseJavaScriptSource(content, relativePath)
    : isPython
      ? parsePythonSource(content, relativePath)
      : null;
  const javascriptRelationships = isJavaScript
    ? extractJavaScriptRelationships(content, relativePath)
    : null;
  const definitions = structured?.ok ? structured.definitions : parseDefinitions(lines, language);
  for (const definition of definitions) {
    addSymbol(symbols, lines, definition, occurrenceCounts);
  }
  const coveredLines = new Set();
  for (const symbol of symbols) {
    for (let line = symbol.startLine; line <= symbol.endLine; line += 1) coveredLines.add(line);
  }
  const moduleBody = lines
    .map((line, index) => coveredLines.has(index + 1) ? "" : line)
    .join("\n");
  const needsModule = moduleBody.trim() || structured?.calls?.some((call) => call.ownerInternalId == null);
  if (needsModule) {
    symbols.push({
      internalId: null,
      name: path.posix.basename(relativePath),
      qualifiedName: `<module:${relativePath}>`,
      kind: "Module",
      signature: relativePath,
      startLine: 1,
      endLine: lines.length,
      exported: true,
      bodyText: moduleBody,
      stableSuffix: "",
    });
  }
  const stableKeyByInternalId = new Map();
  let moduleStableKey = null;
  for (const symbol of symbols) {
    symbol.stableKey = `${relativePath}:${symbol.qualifiedName}:${symbol.kind}${symbol.stableSuffix}`;
    symbol.bodyHash = hashText(symbol.bodyText);
    if (symbol.internalId != null) stableKeyByInternalId.set(symbol.internalId, symbol.stableKey);
    if (symbol.kind === "Module") moduleStableKey = symbol.stableKey;
    delete symbol.stableSuffix;
    delete symbol.internalId;
  }
  const rawCalls = structured?.ok
    ? structured.calls
      .map((call) => ({
        sourceStableKey: call.ownerInternalId == null ? moduleStableKey : stableKeyByInternalId.get(call.ownerInternalId),
        calleeName: call.calleeName,
        qualifier: call.qualifier,
        callLine: call.callLine,
        syntax: call.syntax,
      }))
      .filter((call) => call.sourceStableKey)
    : symbols.flatMap((symbol) => extractCallNames(symbol.bodyText).map((calleeName) => ({
      sourceStableKey: symbol.stableKey,
      calleeName,
      qualifier: null,
      callLine: null,
      syntax: "heuristic-call",
    })));
  const callsByRelationship = new Map();
  for (const call of rawCalls) {
    const key = [call.sourceStableKey, call.calleeName, call.qualifier ?? "", call.syntax].join("\u0000");
    const existing = callsByRelationship.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (call.callLine != null && (existing.callLine == null || call.callLine < existing.callLine)) existing.callLine = call.callLine;
    } else {
      callsByRelationship.set(key, { ...call, occurrences: 1 });
    }
  }
  const calls = [...callsByRelationship.values()];
  const apiOperations = structured?.ok
    ? structured.apiOperations
      .map((operation) => ({
        sourceStableKey: operation.ownerInternalId == null ? moduleStableKey : stableKeyByInternalId.get(operation.ownerInternalId),
        kind: operation.kind,
        method: operation.method,
        rawPath: operation.rawPath,
        normalizedPath: operation.normalizedPath,
        framework: operation.framework,
        line: operation.line,
        confidence: operation.confidence,
        handlerName: operation.handlerName,
      }))
      .filter((operation) => operation.sourceStableKey && operation.normalizedPath)
    : [];
  const symbolForRelationship = (name, line) => {
    const exact = symbols.find((symbol) => symbol.qualifiedName === name)
      ?? symbols.find((symbol) => symbol.name === name);
    if (exact) return exact;
    const containing = symbols
      .filter((symbol) => symbol.kind !== "Module" && line >= symbol.startLine && line <= symbol.endLine)
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    return containing ?? symbols.find((symbol) => symbol.kind === "Module") ?? null;
  };
  const relationships = javascriptRelationships?.ok
    ? {
      exports: javascriptRelationships.exports.map((record) => ({
        ...record,
        sourceStableKey: record.localName
          ? symbolForRelationship(record.localName, record.span.start.line)?.stableKey ?? null
          : null,
      })),
      heritage: javascriptRelationships.heritage.map((record) => ({
        ...record,
        sourceStableKey: symbolForRelationship(record.subjectName, record.span.start.line)?.stableKey ?? null,
      })),
      typeReferences: javascriptRelationships.typeReferences.map((record) => ({
        ...record,
        sourceStableKey: symbolForRelationship(record.ownerName, record.span.start.line)?.stableKey ?? null,
      })),
      memberHints: javascriptRelationships.memberHints
        // Ordinary calls already have a compact, resolution-aware symbol_calls
        // representation. Retain constructor hints without duplicating every call.
        .filter((record) => record.kind === "construct")
        .map((record) => ({
          ...record,
          sourceStableKey: symbolForRelationship(record.ownerName, record.span.start.line)?.stableKey ?? null,
        })),
      endpointValues: {
        definitions: javascriptRelationships.endpointValues.definitions,
        usages: javascriptRelationships.endpointValues.usages.map((record) => ({
          ...record,
          sourceStableKey: symbolForRelationship(null, record.span.start.line)?.stableKey ?? null,
        })),
      },
      domSelectors: javascriptRelationships.domSelectors.map((record) => ({
        ...record,
        sourceStableKey: symbolForRelationship(record.ownerName, record.span.start.line)?.stableKey ?? null,
      })),
    }
    : { exports: [], heritage: [], typeReferences: [], memberHints: [], endpointValues: { definitions: [], usages: [] }, domSelectors: [] };
  const fallbackDiagnostic = structured && !structured.ok ? [structured.error] : [];
  return {
    symbols,
    imports: structured?.ok ? structured.imports : parseImports(content, language),
    calls,
    apiOperations,
    relationships,
    lineCount: lines.length,
    parser: structured?.ok
      ? structured.parser
      : {
        mode: isJavaScript || isPython ? "heuristic-fallback" : "heuristic",
        diagnostics: fallbackDiagnostic,
      },
  };
}

export function extractCallNames(bodyText) {
  const clean = bodyText.split(/\r?\n/).map(stripStringsAndComments).join("\n");
  const names = [];
  for (const match of clean.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^>\n]+>)?\s*\(/g)) {
    const name = match[1];
    if (!CALL_KEYWORDS.has(name)) names.push(name);
  }
  return [...new Set(names)];
}
