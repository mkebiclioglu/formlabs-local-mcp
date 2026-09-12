/**
 * Download, verify and install PreFormServer from Formlabs.
 *
 * Trust boundary: the download page is fetched over HTTPS from formlabs.com,
 * and only links on downloads.formlabs.com with Formlabs' release layout are
 * accepted. The archive is scanned for path traversal before extraction, and
 * the extracted app is verified against Formlabs' code-signing identity before
 * anything is moved into place. A failed check leaves the previous install
 * untouched.
 */

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DOWNLOAD_PAGE, managedExecutable, managedInstallDir, type Config, type Platform } from "./config.js";
import { checkZipEntries, extractZipNode, listZipEntries } from "./zip.js";

const run = promisify(execFile);

export const FORMLABS_TEAM_ID = "KVPE3R79SR"; // Developer ID Application: Formlabs Inc.
export const FORMLABS_BUNDLE_ID = "com.formlabs.PreFormServer";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export interface Release {
  version: string;
  apiVersion?: string;
  date?: string;
  urls: { mac?: string; win?: string };
}

export interface InstallResult {
  status: "installed" | "up_to_date";
  version: string;
  apiVersion?: string | undefined;
  executable: string;
  installDir: string;
  sourceUrl?: string | undefined;
}

export interface InstallOptions {
  downloadsPageUrl?: string;
  force?: boolean;
  /** Test hook: where to actually fetch from, after the real URL has been validated. */
  rewriteUrl?: (url: string) => string;
  /** Signature verification; defaults to the platform verifier. */
  verify?: (bundlePath: string, cfg: Config) => Promise<void>;
  extract?: "system" | "node";
  log?: (line: string) => void;
  progress?: (fraction: number, message: string) => Promise<void>;
}

const RELEASE_PATH = /^\/PreFormServer\/Release\/(\d+\.\d+\.\d+)\/PreForm_Server_(mac|win)_[A-Za-z0-9._-]+\.zip$/;

export function validateDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS download URL ${raw}`);
  if (url.hostname !== "downloads.formlabs.com") throw new Error(`Refusing download from ${url.hostname}; only downloads.formlabs.com is trusted`);
  if (url.pathname.split("/").includes("..") || !RELEASE_PATH.test(url.pathname)) {
    throw new Error(`Download URL does not match Formlabs' PreFormServer release layout: ${raw}`);
  }
  return url;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Parse the Formlabs downloads page. Rows carry the API version, date and both platform links. */
export function parseDownloadsPage(html: string): Release[] {
  const byVersion = new Map<string, Release>();
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  for (const row of rows) {
    const links = [...row.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
    let release: Release | undefined;
    for (const link of links) {
      let url: URL;
      try {
        url = validateDownloadUrl(link);
      } catch {
        continue;
      }
      const m = RELEASE_PATH.exec(url.pathname)!;
      const version = m[1]!;
      const kind = m[2] as "mac" | "win";
      release = byVersion.get(version) ?? { version, urls: {} };
      release.urls[kind] = url.toString();
      byVersion.set(version, release);
    }
    if (!release) continue;
    const api = /formlabs-local-api-v(\d+\.\d+\.\d+)\.html/.exec(row);
    if (api?.[1] && !release.apiVersion) release.apiVersion = api[1];
    const date = />\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*</.exec(row);
    if (date?.[1] && !release.date) release.date = date[1];
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export function chooseRelease(releases: Release[], platform: Platform): { release: Release; url: string; kind: "mac" | "win" } {
  const kind: "mac" | "win" = platform === "darwin" ? "mac" : "win"; // Linux runs the Windows build under Wine
  for (const release of releases) {
    const url = release.urls[kind];
    if (url) return { release, url, kind };
  }
  throw new Error(`No PreFormServer release found for ${platform} on the Formlabs downloads page`);
}

export async function fetchReleases(pageUrl: string = DOWNLOAD_PAGE): Promise<Release[]> {
  const resp = await fetch(pageUrl, { headers: { "user-agent": "formlabs-local-mcp" }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Could not read ${pageUrl}: HTTP ${resp.status}`);
  const releases = parseDownloadsPage(await resp.text());
  if (releases.length === 0) throw new Error(`No PreFormServer downloads found on ${pageUrl}; the page layout may have changed`);
  return releases;
}

export interface InstallMeta {
  version: string;
  apiVersion?: string;
  sourceUrl?: string;
  installedAt?: string;
  platform?: string;
}

export function readInstallMeta(installDir: string): InstallMeta | undefined {
  try {
    return JSON.parse(readFileSync(path.join(installDir, "install.json"), "utf8")) as InstallMeta;
  } catch {
    return undefined;
  }
}

async function download(url: string, dest: string, log: (l: string) => void, progress?: InstallOptions["progress"]): Promise<void> {
  const resp = await fetch(url, { redirect: "follow", headers: { "user-agent": "formlabs-local-mcp" }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!resp.ok || !resp.body) throw new Error(`Download failed: HTTP ${resp.status} for ${url}`);
  if (new URL(resp.url || url).hostname !== new URL(url).hostname) throw new Error(`Download redirected off ${new URL(url).hostname}; refusing`);
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Download too large (${declared} bytes)`);
  const out = createWriteStream(dest);
  let received = 0;
  let lastPct = -1;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error(`Download too large (> ${MAX_DOWNLOAD_BYTES} bytes)`);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      if (declared > 0) {
        const pct = Math.floor((received / declared) * 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          log(`downloading PreFormServer: ${pct}%`);
          await progress?.(0.1 + (received / declared) * 0.6, `downloading ${pct}%`);
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  }
  if (declared > 0 && received !== declared) throw new Error(`Download truncated: got ${received} of ${declared} bytes`);
}

async function extractSystem(zipPath: string, dest: string, platform: Platform): Promise<boolean> {
  try {
    if (platform === "darwin") {
      await run("ditto", ["-x", "-k", zipPath, dest]); // Apple's own tool: keeps symlinks, xattrs, signatures intact
      return true;
    }
    if (platform === "win32") {
      await run("tar", ["-xf", zipPath, "-C", dest]); // bsdtar ships with Windows 10+
      return true;
    }
    try {
      await run("bsdtar", ["-xf", zipPath, "-C", dest]);
      return true;
    } catch {
      await run("unzip", ["-q", zipPath, "-d", dest]);
      return true;
    }
  } catch {
    return false;
  }
}

function findBundle(root: string, platform: Platform, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    const st = statSync(full);
    if (platform === "darwin" && name === "PreFormServer.app" && st.isDirectory()) return full;
    if (platform !== "darwin" && name.toLowerCase() === "preformserver.exe" && st.isFile()) return path.dirname(full);
    if (st.isDirectory()) {
      const inner = findBundle(full, platform, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

export async function verifyMac(appPath: string): Promise<void> {
  await run("codesign", ["--verify", "--deep", "--strict", appPath]).catch((e: Error) => {
    throw new Error(`Code signature check failed for ${appPath}: ${e.message}`);
  });
  const { stderr, stdout } = await run("codesign", ["-dv", "--verbose=2", appPath]);
  const info = `${stdout}\n${stderr}`;
  const team = /TeamIdentifier=(\S+)/.exec(info)?.[1];
  const ident = /^Identifier=(\S+)/m.exec(info)?.[1];
  if (team !== FORMLABS_TEAM_ID) throw new Error(`Refusing to install: signed by team ${team ?? "unknown"}, expected Formlabs (${FORMLABS_TEAM_ID})`);
  if (ident !== FORMLABS_BUNDLE_ID) throw new Error(`Refusing to install: bundle identifier ${ident ?? "unknown"}, expected ${FORMLABS_BUNDLE_ID}`);
  await run("spctl", ["--assess", "--type", "exec", appPath]).catch((e: Error) => {
    throw new Error(`Gatekeeper rejected ${appPath} (not notarized?): ${e.message}`);
  });
}

export async function verifyWindows(exeDir: string): Promise<void> {
  const exe = path.join(exeDir, "PreFormServer.exe");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; ` +
    `[pscustomobject]@{ Status = $s.Status.ToString(); Subject = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress`;
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const sig = JSON.parse(stdout) as { Status: string; Subject: string | null };
  if (sig.Status !== "Valid") throw new Error(`Authenticode signature on PreFormServer.exe is ${sig.Status}, expected Valid`);
  if (!/Formlabs/i.test(sig.Subject ?? "")) throw new Error(`Refusing to install: PreFormServer.exe signed by ${sig.Subject ?? "unknown"}, expected Formlabs Inc.`);
}

export async function verifyLinux(exeDir: string, cfg: Config): Promise<void> {
  const exe = path.join(exeDir, "PreFormServer.exe");
  try {
    const { stdout } = await run("osslsigncode", ["verify", "-in", exe]);
    if (!/Signature verification: ok/i.test(stdout)) throw new Error("osslsigncode did not report a valid signature");
    if (!/Formlabs/i.test(stdout)) throw new Error("signature is not from Formlabs");
    return;
  } catch (err) {
    if (cfg.installUnverified) return;
    throw new Error(
      `Cannot verify PreFormServer.exe on Linux (${(err as Error).message}). Install osslsigncode, or set PREFORM_INSTALL_UNVERIFIED=1 to accept the download on the strength of HTTPS to downloads.formlabs.com alone.`,
    );
  }
}

function defaultVerify(platform: Platform): (bundle: string, cfg: Config) => Promise<void> {
  if (platform === "darwin") return (b) => verifyMac(b);
  if (platform === "win32") return (b) => verifyWindows(b);
  return (b, cfg) => verifyLinux(b, cfg);
}

export async function installPreformServer(cfg: Config, opts: InstallOptions = {}): Promise<InstallResult> {
  const log = opts.log ?? ((l) => console.error(`[install] ${l}`));
  const progress = opts.progress ?? (async () => {});
  const installDir = managedInstallDir(cfg.platform, cfg.home, cfg.env);
  const executable = managedExecutable(cfg.platform, cfg.home, cfg.env);

  await progress(0.02, "checking Formlabs downloads");
  const releases = await fetchReleases(opts.downloadsPageUrl);
  const { release, url } = chooseRelease(releases, cfg.platform);
  const current = readInstallMeta(installDir);
  if (!opts.force && current?.version === release.version && existsSync(executable)) {
    log(`PreFormServer ${release.version} is already installed`);
    return { status: "up_to_date", version: release.version, apiVersion: release.apiVersion, executable, installDir, sourceUrl: current.sourceUrl };
  }

  validateDownloadUrl(url);
  const fetchUrl = opts.rewriteUrl ? opts.rewriteUrl(url) : url;
  mkdirSync(installDir, { recursive: true });
  const staging = path.join(installDir, `.staging-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const zipPath = path.join(staging, "PreFormServer.zip");
    log(`downloading PreFormServer ${release.version} from ${url}`);
    await download(fetchUrl, zipPath, log, progress);

    await progress(0.75, "checking archive");
    const entries = await listZipEntries(zipPath);
    checkZipEntries(entries);

    await progress(0.8, "extracting");
    const extractDir = path.join(staging, "extract");
    mkdirSync(extractDir);
    const mode = opts.extract ?? "system";
    const extracted = mode === "system" ? await extractSystem(zipPath, extractDir, cfg.platform) : false;
    if (!extracted) extractZipNode(zipPath, extractDir, entries);

    const bundle = findBundle(extractDir, cfg.platform);
    if (!bundle) throw new Error("Archive did not contain PreFormServer");

    await progress(0.9, "verifying signature");
    await (opts.verify ?? defaultVerify(cfg.platform))(bundle, cfg);

    const finalBundle = cfg.platform === "darwin" ? path.join(installDir, "PreFormServer.app") : path.join(installDir, "PreFormServer");
    rmSync(finalBundle, { recursive: true, force: true });
    renameSync(bundle, finalBundle);
    const meta: InstallMeta = { version: release.version, sourceUrl: url, installedAt: new Date().toISOString(), platform: cfg.platform };
    if (release.apiVersion) meta.apiVersion = release.apiVersion;
    writeFileSync(path.join(installDir, "install.json"), JSON.stringify(meta, null, 2));
    log(`installed PreFormServer ${release.version} to ${finalBundle}`);
    await progress(1, "installed");
    return { status: "installed", version: release.version, apiVersion: release.apiVersion, executable, installDir, sourceUrl: url };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Best-effort version of an installed PreFormServer (managed metadata, then the app bundle). */
export async function installedVersion(executable: string | undefined, cfg: Config): Promise<string | undefined> {
  if (!executable || !existsSync(executable)) return undefined;
  const managed = managedExecutable(cfg.platform, cfg.home, cfg.env);
  if (executable === managed) {
    const meta = readInstallMeta(managedInstallDir(cfg.platform, cfg.home, cfg.env));
    if (meta?.version) return meta.version;
  }
  if (cfg.platform === "darwin") {
    const plist = path.join(path.dirname(path.dirname(executable)), "Info.plist");
    try {
      const { stdout } = await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (cfg.platform === "win32") {
    try {
      const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo.ProductVersion`]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
