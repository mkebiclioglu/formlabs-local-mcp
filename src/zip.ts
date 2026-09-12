/**
 * Just enough zip parsing to (a) scan every entry name before extraction so a
 * hostile archive cannot write outside its target directory, and (b) extract
 * archives ourselves when the platform has no suitable tool.
 *
 * Only the central directory is read for scanning; extraction reads entries
 * on demand. Zip64 archives are rejected (PreFormServer's are far below the
 * limits).
 */

import { closeSync, mkdirSync, openSync, readSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  linkTarget?: string;
  mode: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

export async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const size = statSync(zipPath).size;
  const fd = openSync(zipPath, "r");
  try {
    const tailLen = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("Zip64 archives are not supported");
    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) throw new Error("Corrupt zip central directory");
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      const mode = (externalAttr >>> 16) & 0xffff;
      const isSymlink = (mode & 0xf000) === 0xa000;
      const isDirectory = name.endsWith("/") || (mode & 0xf000) === 0x4000;
      const entry: ZipEntry = { name, isDirectory, isSymlink, mode: mode & 0o7777, compressedSize, uncompressedSize, method, localHeaderOffset };
      if (isSymlink) entry.linkTarget = readEntryData(fd, entry).toString("utf8");
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

function readEntryData(fd: number, e: ZipEntry): Buffer {
  const header = readAt(fd, e.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`Corrupt local header for ${e.name}`);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = readAt(fd, start, e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${e.method} for ${e.name}`);
}

function segments(name: string): string[] {
  return name.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Throw if any entry could escape the extraction directory: absolute paths,
 * backslashes, drive letters, ".." segments, or symlinks pointing outside.
 */
export function checkZipEntries(entries: ZipEntry[]): void {
  for (const e of entries) {
    const bad = (why: string): never => {
      throw new Error(`Unsafe zip entry ${JSON.stringify(e.name)}: ${why}`);
    };
    if (e.name.includes("\\")) bad("backslash in name");
    if (e.name.startsWith("/")) bad("absolute path");
    if (/^[A-Za-z]:/.test(e.name)) bad("drive letter");
    if (e.name.includes("\0")) bad("NUL in name");
    const segs = segments(e.name);
    if (segs.includes("..")) bad("parent traversal");
    if (e.isSymlink) {
      const target = e.linkTarget ?? "";
      if (target.startsWith("/") || target.includes("\\") || /^[A-Za-z]:/.test(target)) bad("absolute symlink target");
      const dir = segs.slice(0, -1);
      const resolved = path.posix.normalize(path.posix.join(...dir, target));
      if (resolved === ".." || resolved.startsWith("../")) bad("symlink escapes archive");
    }
  }
}

/** Pure-Node extraction (store + deflate). Preserves symlinks and executable bits. */
export function extractZipNode(zipPath: string, dest: string, entries: ZipEntry[]): void {
  checkZipEntries(entries);
  const fd = openSync(zipPath, "r");
  try {
    for (const e of entries) {
      const target = path.join(dest, ...segments(e.name));
      if (e.isDirectory) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      if (e.isSymlink) {
        symlinkSync(e.linkTarget ?? "", target);
        continue;
      }
      const data = readEntryData(fd, e);
      writeFileSync(target, data, { mode: e.mode || 0o644 });
    }
  } finally {
    closeSync(fd);
  }
}
