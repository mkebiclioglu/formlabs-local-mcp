import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORM, IMAGE, MODEL, inputPath, outputPath } from "../src/paths.js";
import { makeConfig, tmp } from "./helpers.js";

function sandbox() {
  const root = tmp();
  mkdirSync(join(root, "parts"));
  writeFileSync(join(root, "parts", "bracket.stl"), "solid x\nendsolid x\n");
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "keys.stl"), "");
  return { root, cfg: makeConfig({ allowedPaths: [root] }) };
}

describe("inputPath", () => {
  it("accepts a model inside the allowlist and returns the resolved path", () => {
    const { root, cfg } = sandbox();
    expect(inputPath(join(root, "parts", "bracket.stl"), cfg)).toBe(join(root, "parts", "bracket.stl"));
  });
  it("expands ~ against the configured home", () => {
    const { root, cfg } = sandbox();
    expect(inputPath("~/parts/bracket.stl", { ...cfg, home: root })).toBe(join(root, "parts", "bracket.stl"));
  });
  it("rejects relative paths", () => {
    const { cfg } = sandbox();
    expect(() => inputPath("parts/bracket.stl", cfg)).toThrow(/absolute/);
  });
  it("rejects wrong extensions", () => {
    const { root, cfg } = sandbox();
    writeFileSync(join(root, "parts", "notes.txt"), "");
    expect(() => inputPath(join(root, "parts", "notes.txt"), cfg)).toThrow(/must end in/);
  });
  it("rejects missing files", () => {
    const { root, cfg } = sandbox();
    expect(() => inputPath(join(root, "parts", "nope.stl"), cfg)).toThrow(/does not exist/);
  });
  it("rejects paths outside the allowlist", () => {
    const { root, cfg } = sandbox();
    const outside = join(root, "..", `${root.split("/").pop()}-outside`, "x.stl");
    expect(() => inputPath(outside, cfg)).toThrow(/outside the allowed/);
  });
  it("rejects hidden directories unless opted in", () => {
    const { root, cfg } = sandbox();
    expect(() => inputPath(join(root, ".ssh", "keys.stl"), cfg)).toThrow(/hidden/);
    expect(inputPath(join(root, ".ssh", "keys.stl"), { ...cfg, allowHiddenPaths: true })).toContain(".ssh");
  });
  it("rejects symlink escapes", () => {
    const { root, cfg } = sandbox();
    const outside = tmp();
    writeFileSync(join(outside, "secret.stl"), "");
    symlinkSync(outside, join(root, "parts", "link"));
    expect(() => inputPath(join(root, "parts", "link", "secret.stl"), cfg)).toThrow(/outside the allowed/);
  });
  it("covers the common model formats", () => {
    expect(MODEL).toEqual(expect.arrayContaining([".stl", ".obj", ".3mf", ".step", ".stp"]));
  });
});

describe("outputPath", () => {
  it("accepts a new file in an existing directory", () => {
    const { root, cfg } = sandbox();
    expect(outputPath(join(root, "parts", "job.form"), cfg, FORM)).toBe(join(root, "parts", "job.form"));
  });
  it("requires the parent directory to exist", () => {
    const { root, cfg } = sandbox();
    expect(() => outputPath(join(root, "missing", "job.form"), cfg, FORM)).toThrow(/directory/);
  });
  it("enforces the extension", () => {
    const { root, cfg } = sandbox();
    expect(() => outputPath(join(root, "parts", "job.sh"), cfg, FORM)).toThrow(/must end in/);
    expect(outputPath(join(root, "parts", "shot.webp"), cfg, IMAGE)).toMatch(/shot\.webp$/);
  });
});
