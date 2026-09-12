import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("parseArgs", () => {
  it("defaults to serve", () => {
    expect(parseArgs([]).command).toBe("serve");
    expect(parseArgs(["serve"]).command).toBe("serve");
  });
  it("maps install and doctor with aliases and --force", () => {
    expect(parseArgs(["install-preform"])).toEqual({ command: "install-preform", force: false });
    expect(parseArgs(["install", "--force"])).toEqual({ command: "install-preform", force: true });
    expect(parseArgs(["doctor"]).command).toBe("doctor");
    expect(parseArgs(["status"]).command).toBe("doctor");
  });
  it("handles version and unknown commands", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["frobnicate"]).command).toBe("help");
  });
});
