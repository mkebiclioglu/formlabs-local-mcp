/**
 * Guard rails for every tool that hands a file path to PreFormServer.
 *
 * PreFormServer reads and writes whatever absolute path it is given, as the
 * user running it. A prompt-injected model could otherwise be talked into
 * writing `~/.ssh/authorized_keys` or reading `/etc/passwd`. Four checks keep
 * that surface small:
 *
 * 1. The path must be absolute (PreFormServer rejects anything else anyway).
 * 2. It must resolve (symlinks included) to somewhere under an allowed root.
 *    Default root: the user's home directory.
 * 3. No path component under the root may be hidden (start with ".") unless
 *    explicitly allowed, which keeps ~/.ssh, ~/.aws and friends off limits.
 * 4. The extension must match what the tool is for (models in, .form out).
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome, type Config } from "./config.js";

export const MODEL = [".stl", ".obj", ".3mf", ".step", ".stp", ".form"];
export const FORM = [".form"];
export const FPS = [".fps"];
export const IMAGE = [".png", ".webp"];

export class PathNotAllowed extends Error {}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Resolve as much of `p` as exists, so a not-yet-created output file still gets symlink-checked. */
function resolveDeep(p: string): string {
  const parent = path.dirname(p);
  if (existsSync(p)) return realpathOrSelf(p);
  if (parent === p) return p;
  return path.join(resolveDeep(parent), path.basename(p));
}

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function check(raw: string, cfg: Config, extensions: string[], mustExist: boolean): string {
  if (!raw || !raw.trim()) throw new PathNotAllowed("A file path is required.");
  const expanded = expandHome(raw, cfg.home);
  if (!path.isAbsolute(expanded)) {
    throw new PathNotAllowed(
      `Path must be absolute (got ${JSON.stringify(raw)}). Resolve it against the working directory first; PreFormServer does not accept relative paths.`,
    );
  }
  const resolved = resolveDeep(path.normalize(expanded));
  const ext = path.extname(resolved).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new PathNotAllowed(`${JSON.stringify(raw)} must end in one of: ${extensions.join(", ")}.`);
  }
  const roots = cfg.allowedPaths.map(realpathOrSelf);
  const root = roots.find((r) => isUnder(resolved, r));
  if (root === undefined) {
    throw new PathNotAllowed(
      `${JSON.stringify(raw)} is outside the allowed directories (${roots.join(", ")}). Set FORMLABS_ALLOWED_PATHS to add more.`,
    );
  }
  if (!cfg.allowHiddenPaths) {
    const hidden = path.relative(root, resolved).split(path.sep).find((part) => part.startsWith("."));
    if (hidden) {
      throw new PathNotAllowed(
        `${JSON.stringify(raw)} passes through a hidden directory or file (${hidden}). Set FORMLABS_ALLOW_HIDDEN_PATHS=1 if that is intentional.`,
      );
    }
  }
  if (mustExist) {
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new PathNotAllowed(`${JSON.stringify(raw)} does not exist or is not a file.`);
    }
  } else if (!existsSync(path.dirname(resolved)) || !statSync(path.dirname(resolved)).isDirectory()) {
    throw new PathNotAllowed(`The directory for ${JSON.stringify(raw)} does not exist.`);
  }
  return resolved;
}

/** Validate a path PreFormServer will read. Returns the resolved absolute path. */
export function inputPath(raw: string, cfg: Config, extensions: string[] = MODEL): string {
  return check(raw, cfg, extensions, true);
}

/** Validate a path PreFormServer will write. Returns the resolved absolute path. */
export function outputPath(raw: string, cfg: Config, extensions: string[]): string {
  return check(raw, cfg, extensions, false);
}
