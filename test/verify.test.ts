import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkPinnedRoot, isFormlabsSubject, MS_ROOT_PEM, verifyLinux } from "../src/installer.js";
import { makeConfig, tmp } from "./helpers.js";

const GOOD = `Signer's certificate:
\tSigner #0:
\t\tSubject: CN=Formlabs Inc.,O=Formlabs Inc.,L=Somerville,ST=Massachusetts,C=US
Timestamp Server Signature verification: ok
Signature verification time: Aug 19 12:11:03 2026 GMT
Signature verification: ok

Number of verified signatures: 1
Succeeded
`;

describe("pinned Microsoft root", () => {
  it("ships the pinned certificate and detects a swapped file", () => {
    expect(checkPinnedRoot()).toBe(MS_ROOT_PEM);
    expect(readFileSync(MS_ROOT_PEM, "utf8")).toContain("BEGIN CERTIFICATE");
    const other = `${tmp()}/other.pem`;
    // any other valid cert would do; a garbage file must also fail
    writeFileSync(other, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    expect(() => checkPinnedRoot(other)).toThrow();
  });
  it("matches Formlabs' signing subject in both PowerShell and legacy OpenSSL formats, and nothing looser", () => {
    expect(isFormlabsSubject("CN=Formlabs Inc.,O=Formlabs Inc.,L=Somerville,ST=Massachusetts,C=US")).toBe(true);
    expect(isFormlabsSubject("CN=Formlabs Inc., O=Formlabs Inc., L=Somerville, S=Massachusetts, C=US")).toBe(true);
    expect(isFormlabsSubject("/C=US/ST=Massachusetts/L=Somerville/O=Formlabs Inc./CN=Formlabs Inc.")).toBe(true);
    expect(isFormlabsSubject("CN=Formlabs Fan Club,O=Formlabs Inc.")).toBe(false);
    expect(isFormlabsSubject("CN=Formlabs Inc.,O=Evil Corp")).toBe(false);
    expect(isFormlabsSubject("CN=Formlabs Inc.X,O=Formlabs Inc.")).toBe(false);
    expect(isFormlabsSubject("OU=CN=Formlabs Inc.,O=Formlabs Inc.")).toBe(false);
  });
});

describe("verifyLinux", () => {
  it("passes osslsigncode both chains anchored on the pinned root and accepts a good result", async () => {
    let seen: string[] = [];
    await verifyLinux("/x", makeConfig(), async (args) => { seen = args; return { stdout: GOOD, stderr: "" }; });
    expect(seen).toEqual(["verify", "-in", path.join("/x", "PreFormServer.exe"), "-CAfile", MS_ROOT_PEM, "-TSA-CAfile", MS_ROOT_PEM]);
  });
  it("accepts older osslsigncode output: no trailing Succeeded line, slash-separated subject", async () => {
    const legacy = GOOD.replace("Succeeded\n", "").replace("CN=Formlabs Inc.,O=Formlabs Inc.,L=Somerville,ST=Massachusetts,C=US", "/C=US/ST=Massachusetts/L=Somerville/O=Formlabs Inc./CN=Formlabs Inc.");
    await expect(verifyLinux("/x", makeConfig(), async () => ({ stdout: legacy, stderr: "" }))).resolves.toBeUndefined();
  });
  it("rejects a failed verification, a wrong subject, and a missing tool", async () => {
    await expect(verifyLinux("/x", makeConfig(), async () => ({ stdout: GOOD.replace("Signature verification: ok", "Signature verification: failed").replace("Succeeded", "Failed"), stderr: "" }))).rejects.toThrow(/Cannot verify/);
    await expect(verifyLinux("/x", makeConfig(), async () => ({ stdout: GOOD.replace(/Formlabs Inc\./g, "Someone Else"), stderr: "" }))).rejects.toThrow(/Cannot verify/);
    await expect(verifyLinux("/x", makeConfig(), async () => { throw new Error("osslsigncode is not installed"); })).rejects.toThrow(/not installed/);
  });
  it("honours the explicit unverified opt-in only", async () => {
    await expect(verifyLinux("/x", makeConfig({ installUnverified: true }), async () => { throw new Error("osslsigncode is not installed"); })).resolves.toBeUndefined();
  });
});
