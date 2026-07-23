import { watch } from "node:fs";
import path from "node:path";
import { IGNORED_DIRECTORIES } from "./constants.mjs";
import { indexDirectory } from "./indexer.mjs";

function isIgnored(filename) {
  if (!filename) return false;
  return filename.split(/[\\/]/).some((part) => IGNORED_DIRECTORIES.has(part));
}

export class WatchManager {
  constructor(db, log = () => {}) {
    this.db = db;
    this.log = log;
    this.watchers = new Map();
  }

  async start(root, options = {}) {
    const resolved = path.resolve(root);
    if (this.watchers.has(resolved)) return { ok: true, path: resolved, already_watching: true };
    let timer = null;
    let indexing = false;
    let queued = false;
    let active = true;
    const reindex = async () => {
      if (!active) return;
      if (indexing) {
        queued = true;
        return;
      }
      indexing = true;
      try {
        const result = await indexDirectory(this.db, resolved, { ...options, episodeType: "working_tree" });
        this.log(`watch index complete: ${result.files_changed} file(s) changed`);
      } catch (error) {
        this.log(`watch index failed: ${error.message}`);
      } finally {
        indexing = false;
        if (active && queued) {
          queued = false;
          void reindex();
        }
      }
    };
    const watcher = watch(resolved, { recursive: true }, (_eventType, filename) => {
      if (!active || isIgnored(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reindex();
      }, options.debounceMs ?? 600);
    });
    watcher.on("error", (error) => this.log(`watcher error: ${error.message}`));
    const stop = () => {
      active = false;
      queued = false;
      clearTimeout(timer);
      timer = null;
      watcher.close();
    };
    this.watchers.set(resolved, { watcher, stop, startedAt: new Date().toISOString() });
    return { ok: true, path: resolved, already_watching: false };
  }

  stop(root) {
    const resolved = path.resolve(root);
    const entry = this.watchers.get(resolved);
    if (!entry) return { ok: true, path: resolved, was_watching: false };
    entry.stop();
    this.watchers.delete(resolved);
    return { ok: true, path: resolved, was_watching: true };
  }

  list() {
    return [...this.watchers.entries()].map(([watchedPath, value]) => ({
      path: watchedPath,
      started_at: value.startedAt,
    }));
  }

  close() {
    for (const entry of this.watchers.values()) entry.stop();
    this.watchers.clear();
  }
}
