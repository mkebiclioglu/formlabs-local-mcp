import { describe, expect, it } from "vitest";
import { namesInServerDir } from "../src/backend.js";

describe("namesInServerDir", () => {
  it("accepts files directly in the export directory, with either separator", () => {
    expect(namesInServerDir("/home/me/out", ["/home/me/out/a.stl", "/home/me/out/b_x.stl"])).toEqual(["a.stl", "b_x.stl"]);
    expect(namesInServerDir("Z:/home/me/out", ["Z:\\home\\me\\out\\a.stl"])).toEqual(["a.stl"]);
    expect(namesInServerDir("C:\\Users\\me\\out\\", ["c:/users/me/out/a.stl"])).toEqual(["a.stl"]);
  });
  it("refuses anything outside it or with an unusual name", () => {
    for (const bad of ["/home/me/a.stl", "/home/me/out/sub/a.stl", "/home/me/out/..", "/home/me/out/a b.stl", "/home/me/out/$(x).stl", "/etc/passwd"]) {
      expect(() => namesInServerDir("/home/me/out", [bad]), bad).toThrow(/outside the export directory/);
    }
  });
});
