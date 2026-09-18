/**
 * Translate validated local file paths into the form PreFormServer expects
 * when it does not share this machine's view of the filesystem.
 *
 * Two cases, both from running the Windows build under Wine (see
 * https://github.com/mkebiclioglu/preform-linux):
 *
 * - PreFormServer runs under Wine on this host. Wine exposes the root
 *   filesystem as drive Z:, so `/home/me/part.stl` is `Z:/home/me/part.stl`.
 * - PreFormServer runs in a container that mounts one of our directories
 *   somewhere else, e.g. `~/jobs` at `/jobs`, which Wine shows as `Z:/jobs`.
 *   PREFORM_PATH_MAP lists such `local=remote` pairs.
 *
 * Only the string sent to PreFormServer changes; the guard rails in ./paths.ts
 * have already run on the local path, and outputs are collected locally.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./config.js";

export type PathStyle = "native" | "wine";

export interface PathMapping {
  /** Local directory (resolved through symlinks so it matches what ./paths.ts returns). */
  local: string;
  /** The same directory as PreFormServer sees it, e.g. `Z:/jobs` or `C:\\jobs`. */
  remote: string;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Parse `local=remote[,local=remote...]`. Longest local prefix wins at lookup time. */
export function parsePathMap(raw: string | undefined, home: string): PathMapping[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0 || eq === pair.length - 1) {
        throw new Error(`PREFORM_PATH_MAP entry ${JSON.stringify(pair)} must look like /local/dir=Z:/remote/dir`);
      }
      const local = path.resolve(expandHome(pair.slice(0, eq).trim(), home));
      const remote = pair.slice(eq + 1).trim().replace(/[\\/]+$/, "");
      return { local: realpathOrSelf(local), remote };
    })
    .sort((a, b) => b.local.length - a.local.length);
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True for `Z:/...`, `C:\\...` and UNC paths: joined with `/` (Wine and Windows both accept it). */
function isWindowsStyle(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.startsWith("\\\\");
}

/** The path to send to PreFormServer for a validated local path. */
export function toServerPath(localPath: string, style: PathStyle, map: PathMapping[]): string {
  const resolved = path.resolve(localPath);
  for (const m of map) {
    if (!isUnder(resolved, m.local)) continue;
    const rel = path.relative(m.local, resolved).split(path.sep).filter(Boolean);
    if (rel.length === 0) return m.remote;
    return `${m.remote}/${rel.join("/")}`;
  }
  if (style === "wine" && !isWindowsStyle(resolved)) {
    // Wine maps the host root to Z:; forward slashes are fine for the Windows API.
    // (On a Windows host "resolved" already carries a drive letter and is left alone.)
    return `Z:${resolved.split(path.sep).join("/")}`;
  }
  return resolved;
}
