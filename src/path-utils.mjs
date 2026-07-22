import { realpathSync } from "node:fs";
import path from "node:path";

export function resolveRealPath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Identity checks must remain usable when a sandbox denies realpath; access-sensitive callers still stat the result.
    return resolved;
  }
}

export function pathIdentity(value) {
  const resolved = resolveRealPath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}
