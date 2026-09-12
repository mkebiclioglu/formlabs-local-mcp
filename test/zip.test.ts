import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkZipEntries, listZipEntries } from "../src/zip.js";
import { makeZip, tmp } from "./helpers.js";

function zipFile(entries: Parameters<typeof makeZip>[0]): string {
  const p = join(tmp(), "t.zip");
  writeFileSync(p, makeZip(entries));
  return p;
}

describe("zip", () => {
  it("lists entries with symlink detection", async () => {
    const p = zipFile([
      { name: "PreFormServer/", data: "" },
      { name: "PreFormServer/app/Contents/MacOS/PreFormServer", data: "bin" },
      { name: "PreFormServer/app/Contents/Frameworks/Qt.framework/Versions/Current", symlinkTo: "A" },
    ]);
    const entries = await listZipEntries(p);
    expect(entries.map((e) => e.name)).toHaveLength(3);
    expect(entries[2]).toEqual(expect.objectContaining({ isSymlink: true, linkTarget: "A" }));
  });

  it("rejects traversal-shaped names even when they resolve inside", async () => {
    const entries = await listZipEntries(zipFile([{ name: "PreFormServer/a.txt", data: "x" }, { name: "PreFormServer/b/../c.txt", data: "y" }]));
    expect(() => checkZipEntries(entries)).toThrow(/unsafe/i);
  });

  it("rejects absolute paths, parent traversal and escaping symlinks", async () => {
    for (const bad of [
      [{ name: "/etc/passwd", data: "" }],
      [{ name: "../../.ssh/authorized_keys", data: "" }],
      [{ name: "PreFormServer/../x", data: "" }],
      [{ name: "PreFormServer/link", symlinkTo: "/etc" }],
      [{ name: "PreFormServer/link", symlinkTo: "../../outside" }],
      [{ name: "C:\\Windows\\evil", data: "" }],
    ]) {
      const entries = await listZipEntries(zipFile(bad));
      expect(() => checkZipEntries(entries), JSON.stringify(bad)).toThrow(/unsafe/i);
    }
  });

  it("allows relative symlinks that stay inside the archive", async () => {
    const entries = await listZipEntries(zipFile([
      { name: "PreFormServer/app/Frameworks/Q.framework/Versions/A/Q", data: "" },
      { name: "PreFormServer/app/Frameworks/Q.framework/Versions/Current", symlinkTo: "A" },
      { name: "PreFormServer/app/Frameworks/Q.framework/Q", symlinkTo: "Versions/Current/Q" },
    ]));
    expect(() => checkZipEntries(entries)).not.toThrow();
  });
});
