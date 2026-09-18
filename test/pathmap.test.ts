import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePathMap, toServerPath } from "../src/pathmap.js";
import { tmp } from "./helpers.js";

describe("parsePathMap", () => {
  it("returns nothing for unset or blank", () => {
    expect(parsePathMap(undefined, "/h")).toEqual([]);
    expect(parsePathMap("  ", "/h")).toEqual([]);
  });
  it("parses pairs, expands ~, strips trailing slashes and sorts longest local first", () => {
    const home = tmp();
    const map = parsePathMap(`~/jobs=Z:/jobs/, ${home}/jobs/deep=Z:/deep`, home);
    expect(map.map((m) => m.remote)).toEqual(["Z:/deep", "Z:/jobs"]);
    expect(map[1]!.local).toBe(join(home, "jobs"));
  });
  it("rejects malformed entries", () => {
    expect(() => parsePathMap("/a", "/h")).toThrow(/local\/dir=Z:/);
    expect(() => parsePathMap("=Z:/x", "/h")).toThrow(/PREFORM_PATH_MAP/);
    expect(() => parsePathMap("/a=", "/h")).toThrow(/PREFORM_PATH_MAP/);
  });
});

describe("toServerPath", () => {
  const posix = it.skipIf(process.platform === "win32"); // Wine hosts are POSIX; Windows resolves /x to a drive
  posix("leaves native paths alone", () => {
    expect(toServerPath("/home/me/part.stl", "native", [])).toBe("/home/me/part.stl");
  });
  posix("prefixes Z: for a Wine-hosted PreFormServer on this host", () => {
    expect(toServerPath("/home/me/parts/part.stl", "wine", [])).toBe("Z:/home/me/parts/part.stl");
  });
  it("rewrites mounted directories with the longest match, whatever the style", () => {
    const map = parsePathMap("/srv/jobs=Z:/jobs,/srv/jobs/fast=Z:/fast", "/h");
    expect(toServerPath("/srv/jobs/a/b.stl", "native", map)).toBe("Z:/jobs/a/b.stl");
    expect(toServerPath("/srv/jobs/fast/c.form", "wine", map)).toBe("Z:/fast/c.form");
    expect(toServerPath("/srv/jobs", "wine", map)).toBe("Z:/jobs");
    expect(toServerPath("/srv/other/x.stl", "wine", map)).toBe("Z:/srv/other/x.stl");
    expect(toServerPath("/srv/jobsx/x.stl", "native", map)).toBe("/srv/jobsx/x.stl");
  });
  it("matches paths that go through a symlinked mapping root", () => {
    const root = tmp();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "p.stl"), "");
    const map = parsePathMap(`${root}/real=Z:/jobs`, "/h");
    expect(toServerPath(join(root, "real", "p.stl"), "native", map)).toBe("Z:/jobs/p.stl");
  });
});
