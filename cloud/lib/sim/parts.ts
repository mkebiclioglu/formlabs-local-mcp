/**
 * Where a simulated environment gets geometry from. The hosted MCP cannot
 * read files on the agent's machine, so `import_model` accepts:
 *   - a sample part name (`sample:bracket`, or a file name that contains it),
 *   - an https URL to an STL, which is downloaded and measured for real,
 *   - any other path, which yields a deterministic part derived from the name.
 */
import { createHash } from "node:crypto";

export interface PartGeometry {
  name: string;
  size_mm: { x: number; y: number; z: number };
  volume_ml: number;
  /** Trapped-resin pockets when printed flat. */
  cups: number;
  /** Unsupported local minima before supports. */
  minima: number;
  thin_walls: boolean;
  overhang: "low" | "medium" | "high";
  source: "sample" | "url" | "derived";
  triangles?: number;
}

export interface SamplePart extends Omit<PartGeometry, "source"> {
  key: string;
  aliases: string[];
  description: string;
}

export const SAMPLE_PARTS: SamplePart[] = [
  { key: "bracket", aliases: ["bracket", "mount", "clip"], name: "Bracket", description: "L-shaped mounting bracket with two bolt holes", size_mm: { x: 62, y: 38, z: 24 }, volume_ml: 14.2, cups: 0, minima: 2, thin_walls: false, overhang: "medium" },
  { key: "gear", aliases: ["gear", "sprocket", "cog"], name: "Spur gear", description: "48 mm spur gear, 24 teeth", size_mm: { x: 48, y: 48, z: 12 }, volume_ml: 9.6, cups: 0, minima: 1, thin_walls: false, overhang: "low" },
  { key: "enclosure", aliases: ["enclosure", "case", "housing", "box", "lid"], name: "Electronics enclosure", description: "Open-top box with snap-fit lid features", size_mm: { x: 120, y: 80, z: 22 }, volume_ml: 41, cups: 2, minima: 4, thin_walls: false, overhang: "medium" },
  { key: "manifold", aliases: ["manifold", "nozzle", "fitting", "valve"], name: "Fluid manifold", description: "Manifold block with three internal channels", size_mm: { x: 70, y: 45, z: 40 }, volume_ml: 22, cups: 3, minima: 3, thin_walls: false, overhang: "high" },
  { key: "dental-arch", aliases: ["dental", "arch", "jaw", "crown", "teeth"], name: "Dental arch model", description: "Full-arch dental model, hollow base", size_mm: { x: 65, y: 50, z: 20 }, volume_ml: 11, cups: 0, minima: 1, thin_walls: false, overhang: "low" },
  { key: "ring", aliases: ["ring", "jewelry", "jewellery", "band"], name: "Signet ring", description: "Size 9 signet ring with engraved face", size_mm: { x: 22, y: 22, z: 8 }, volume_ml: 0.9, cups: 0, minima: 2, thin_walls: true, overhang: "medium" },
  { key: "phone-stand", aliases: ["stand", "holder", "dock", "phone"], name: "Phone stand", description: "Angled desk phone stand", size_mm: { x: 90, y: 70, z: 110 }, volume_ml: 33, cups: 0, minima: 2, thin_walls: false, overhang: "medium" },
  { key: "vase", aliases: ["vase", "bottle", "cup", "vessel", "mug"], name: "Vase", description: "Thin-walled vase, closed bottom", size_mm: { x: 60, y: 60, z: 140 }, volume_ml: 48, cups: 1, minima: 1, thin_walls: true, overhang: "low" },
  { key: "miniature", aliases: ["miniature", "mini", "figure", "figurine", "knight", "dragon"], name: "Tabletop miniature", description: "32 mm scale figure with fine details", size_mm: { x: 28, y: 28, z: 40 }, volume_ml: 3.1, cups: 0, minima: 6, thin_walls: true, overhang: "high" },
  { key: "knob", aliases: ["knob", "cap", "button", "dial"], name: "Control knob", description: "Knurled knob for a 6 mm D-shaft", size_mm: { x: 30, y: 30, z: 18 }, volume_ml: 5.4, cups: 1, minima: 1, thin_walls: false, overhang: "low" },
  { key: "impeller", aliases: ["impeller", "fan", "turbine", "propeller"], name: "Impeller", description: "Six-blade closed impeller", size_mm: { x: 55, y: 55, z: 28 }, volume_ml: 12.7, cups: 2, minima: 5, thin_walls: true, overhang: "high" },
  { key: "test-cube", aliases: ["cube", "test", "calibration", "xyz"], name: "Calibration cube", description: "20 mm hollow calibration cube", size_mm: { x: 20, y: 20, z: 20 }, volume_ml: 4.8, cups: 0, minima: 0, thin_walls: false, overhang: "low" },
];

export function findSamplePart(nameOrPath: string): SamplePart | undefined {
  const lower = nameOrPath.toLowerCase();
  const base = lower.replace(/^sample:/, "").split(/[\\/]/).pop() ?? lower;
  const exact = SAMPLE_PARTS.find((p) => p.key === base || p.key === base.replace(/\.[a-z0-9]+$/, ""));
  if (exact) return exact;
  return SAMPLE_PARTS.find((p) => p.aliases.some((a) => base.includes(a)));
}

/** Deterministic pseudo-random part for any unknown file name. */
export function derivedPart(nameOrPath: string): PartGeometry {
  const h = createHash("sha256").update(nameOrPath).digest();
  const u = (i: number) => (h[i] ?? 0) / 255;
  const x = Math.round(15 + u(0) * 105);
  const y = Math.round(15 + u(1) * 90);
  const z = Math.round(8 + u(2) * 110);
  const fill = 0.12 + u(3) * 0.3;
  const base = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
  return {
    name: base.replace(/\.[a-z0-9]+$/i, "") || "model",
    size_mm: { x, y, z },
    volume_ml: Math.round(((x * y * z * fill) / 1000) * 10) / 10,
    cups: u(4) > 0.7 ? 1 + Math.floor(u(5) * 2) : 0,
    minima: 1 + Math.floor(u(6) * 4),
    thin_walls: u(7) > 0.8,
    overhang: u(8) > 0.66 ? "high" : u(8) > 0.33 ? "medium" : "low",
    source: "derived",
  };
}

const MAX_STL_BYTES = 25 * 1024 * 1024;

/** Download an STL and measure it: bounding box, signed volume, triangle count. */
export async function measureStlUrl(url: string): Promise<PartGeometry> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs can be imported");
  const resp = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const len = Number(resp.headers.get("content-length") ?? 0);
  if (len > MAX_STL_BYTES) throw new Error(`File too large (${Math.round(len / 1e6)} MB, limit 25 MB)`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_STL_BYTES) throw new Error("File too large (limit 25 MB)");
  const name = (u.pathname.split("/").pop() ?? "model").replace(/\.[a-z0-9]+$/i, "") || "model";
  const g = measureStl(buf);
  return { ...g, name, source: "url" };
}

export function measureStl(buf: Buffer): Omit<PartGeometry, "name" | "source"> {
  const tris = parseStl(buf);
  if (tris.length === 0) throw new Error("No triangles found: the file is not a valid STL");
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let vol = 0;
  for (const t of tris) {
    for (let i = 0; i < 9; i += 3) {
      const x = t[i]!, y = t[i + 1]!, z = t[i + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // signed volume of tetrahedron (origin, a, b, c)
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    vol += (ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!)) / 6;
  }
  const size = { x: round(maxX - minX), y: round(maxY - minY), z: round(maxZ - minZ) };
  const bbox = (size.x * size.y * size.z) / 1000;
  const volume = Math.abs(vol) / 1000; // mm^3 -> mL
  const fill = bbox > 0 ? volume / bbox : 0.3;
  return {
    size_mm: size,
    volume_ml: Math.round(volume * 10) / 10,
    cups: fill < 0.15 && size.z > 20 ? 1 : 0,
    minima: Math.max(1, Math.round(tris.length / 4000)),
    thin_walls: fill < 0.1,
    overhang: fill < 0.2 ? "high" : fill < 0.4 ? "medium" : "low",
    triangles: tris.length,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

type Tri = [number, number, number, number, number, number, number, number, number];

function parseStl(buf: Buffer): Tri[] {
  const head = buf.subarray(0, 5).toString("ascii").toLowerCase();
  if (head === "solid" && !looksBinary(buf)) return parseAscii(buf.toString("utf8"));
  return parseBinary(buf);
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  return 84 + n * 50 === buf.length;
}

function parseBinary(buf: Buffer): Tri[] {
  if (buf.length < 84) return [];
  const n = buf.readUInt32LE(80);
  const out: Tri[] = [];
  let off = 84;
  for (let i = 0; i < n && off + 50 <= buf.length; i++) {
    const t: number[] = [];
    for (let v = 0; v < 3; v++) {
      const base = off + 12 + v * 12;
      t.push(buf.readFloatLE(base), buf.readFloatLE(base + 4), buf.readFloatLE(base + 8));
    }
    out.push(t as Tri);
    off += 50;
  }
  return out;
}

function parseAscii(text: string): Tri[] {
  const out: Tri[] = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m: RegExpExecArray | null;
  let cur: number[] = [];
  while ((m = re.exec(text))) {
    cur.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (cur.length === 9) {
      out.push(cur as Tri);
      cur = [];
    }
  }
  return out;
}

/** Resolve whatever the agent passed as `file` into geometry. */
export async function resolvePart(file: string): Promise<PartGeometry> {
  if (/^https?:\/\//i.test(file)) return measureStlUrl(file);
  const sample = findSamplePart(file);
  if (sample) {
    const { key: _k, aliases: _a, description: _d, ...geom } = sample;
    void _k; void _a; void _d;
    return { ...geom, source: "sample" };
  }
  return derivedPart(file);
}
