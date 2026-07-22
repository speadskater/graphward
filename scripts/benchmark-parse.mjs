import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { IGNORED_DIRECTORIES, SOURCE_EXTENSIONS } from "../src/constants.mjs";
import { detectLanguage, parseSource } from "../src/languages.mjs";

const root = path.resolve(process.argv[2] ?? ".");
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(absolute);
    if (info.size <= 2 * 1024 * 1024) files.push({ absolute, size: info.size });
  }
}

const started = performance.now();
await walk(root);
const samples = [];
const totals = { files: files.length, bytes: 0, symbols: 0, call_relationships: 0, call_occurrences: 0, imports: 0, diagnostics: 0 };
const modes = new Map();
for (const [index, file] of files.entries()) {
  const content = await readFile(file.absolute, "utf8");
  const relative = path.relative(root, file.absolute).split(path.sep).join("/");
  const language = detectLanguage(file.absolute);
  const before = performance.now();
  const parsed = parseSource(content, language, relative);
  const elapsed = performance.now() - before;
  totals.bytes += file.size;
  totals.symbols += parsed.symbols.length;
  totals.call_relationships += parsed.calls.length;
  totals.call_occurrences += parsed.calls.reduce((sum, call) => sum + call.occurrences, 0);
  totals.imports += parsed.imports.length;
  totals.diagnostics += parsed.parser.diagnostics.length;
  modes.set(parsed.parser.mode, (modes.get(parsed.parser.mode) ?? 0) + 1);
  samples.push({ file: relative, language, bytes: file.size, milliseconds: Number(elapsed.toFixed(2)), calls: parsed.calls.length, symbols: parsed.symbols.length });
  if ((index + 1) % 100 === 0) process.stderr.write(`parsed ${index + 1}/${files.length}\n`);
}

const elapsed = performance.now() - started;
process.stdout.write(`${JSON.stringify({
  ...totals,
  elapsed_ms: Number(elapsed.toFixed(2)),
  parser_modes: Object.fromEntries(modes),
  slowest_files: samples.sort((left, right) => right.milliseconds - left.milliseconds).slice(0, 20),
}, null, 2)}\n`);
