import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfig, type Config } from "../src/config.js";

export function tmp(prefix = "formlabs-test-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ env: {}, home: tmp("home-"), platform: "darwin", findServer: () => undefined });
  return { ...base, pollIntervalMs: 5, pollTimeoutMs: 500, ...overrides };
}

export type Route = (req: IncomingMessage, body: string, res: ServerResponse) => void;

/** Tiny fake PreFormServer: routes keyed by "METHOD /path". Returns base URL. */
export async function fakePreform(routes: Record<string, Route>): Promise<{ url: string; server: Server; calls: { method: string; path: string; body: string }[] }> {
  const calls: { method: string; path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      calls.push({ method: req.method ?? "", path, body });
      const route = routes[`${req.method} ${path}`];
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `no route ${req.method} ${path}` } }));
        return;
      }
      route(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, calls };
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Minimal store-only zip writer for tests (supports symlink entries). */
export function makeZip(entries: { name: string; data?: string; symlinkTo?: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.symlinkTo ?? e.data ?? "", "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    const mode = e.symlinkTo ? 0o120777 : e.name.endsWith("/") ? 0o040755 : 0o100644;
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}

/** Put fake `ssh`/`scp` executables on PATH that log their argv and behave just enough. */
export function fakeSshBin(): { dir: string; log: string } {
  const dir = tmp("fakessh-");
  const log = join(dir, "calls.log");
  mkdirSync(join(dir, "remote"), { recursive: true });
  const ssh = `#!/bin/sh
printf '%s\\n' "ssh $*" >> "${log}"
# find the remote command after "--"
cmd=""; seen=0
for a in "$@"; do
  if [ $seen = 1 ]; then cmd="$cmd $a"; fi
  if [ "$a" = "--" ]; then seen=1; fi
done
case "$cmd" in
  *"--port"*) echo "READY FOR INPUT"; sleep 30; exit 0 ;;
  *"mkdir -p"*) mkdir -p "${dir}/remote/stage"; echo "${dir}/remote/stage"; exit 0 ;;
  *"rm -rf"*) exit 0 ;;
  *) exit 0 ;;
esac
`;
  const scp = `#!/bin/sh
printf '%s\\n' "scp $*" >> "${log}"
src=""; dst=""
for a in "$@"; do case "$a" in -*) ;; *) if [ -z "$src" ]; then src="$a"; else dst="$a"; fi ;; esac; done
strip() { echo "$1" | sed 's/^[^:]*://'; }
case "$src" in *:*) cp "$(strip "$src")" "$dst" ;; *) cp "$src" "$(strip "$dst")" ;; esac
`;
  writeFileSync(join(dir, "ssh"), ssh, { mode: 0o755 });
  writeFileSync(join(dir, "scp"), scp, { mode: 0o755 });
  return { dir, log };
}
