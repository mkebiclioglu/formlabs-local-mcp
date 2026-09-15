/**
 * Printer families and materials known to the simulator. Shapes mirror what
 * PreFormServer's /list-materials/ returns so that MCP clients see the same
 * kind of data from a simulated and a real environment. Codes follow
 * PreForm's naming (FLGPBK05 = General Purpose Black V5) but are curated,
 * not exhaustive; a connected environment reports PreForm's real catalog.
 */

export type Technology = "SLA" | "SLS";

export interface PrinterType {
  machine_type: string;
  product_name: string;
  label: string;
  technology: Technology;
  build_volume_mm: { x: number; y: number; z: number };
  /** Seconds per layer at each thickness (mm as string) before volume factors. */
  per_layer_seconds: Record<string, number>;
  /** Extra seconds per mL of material (peel/cure cost scales with area). */
  seconds_per_ml: number;
  /** SLS only: warm-up before the first layer and cool-down after the last, seconds. */
  preheat_seconds?: number;
  cooldown_fraction?: number;
  firmware: string;
  materials: string[];
}

export interface Material {
  code: string;
  name: string;
  family: string;
  technology: Technology;
  layer_thicknesses_mm: number[];
  /** g/cm^3, used for SLS powder mass. */
  density: number;
  cartridge_ml?: number;
  price_usd_per_l?: number;
  color?: string;
}

export const MATERIALS: Material[] = [
  // Form 4 family (V5 general purpose)
  { code: "FLGPBK05", name: "Black V5", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 99, color: "#1b1b1b" },
  { code: "FLGPGR05", name: "Grey V5", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 99, color: "#8a8d90" },
  { code: "FLGPWH05", name: "White V5", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 99, color: "#e8e6e1" },
  { code: "FLGPCL05", name: "Clear V5", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 99, color: "#cfe3ee" },
  { code: "FLFD0001", name: "Fast Model Resin", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.1, 0.16], density: 1.1, cartridge_ml: 1000, price_usd_per_l: 79, color: "#c9c2b4" },
  { code: "FLTO2001", name: "Tough 2000 V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.13, cartridge_ml: 1000, price_usd_per_l: 175, color: "#6f7d8c" },
  { code: "FLTO1501", name: "Tough 1500 V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.11, cartridge_ml: 1000, price_usd_per_l: 175, color: "#9fb1bf" },
  { code: "FLRG1001", name: "Rigid 10K V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.66, cartridge_ml: 1000, price_usd_per_l: 199, color: "#d9d6cf" },
  { code: "FLRG4001", name: "Rigid 4000 V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.5, cartridge_ml: 1000, price_usd_per_l: 199, color: "#e0dcd1" },
  { code: "FLFL8001", name: "Flexible 80A V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.1], density: 1.1, cartridge_ml: 1000, price_usd_per_l: 199, color: "#4a4f57" },
  { code: "FLEL5001", name: "Elastic 50A V1", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.1], density: 1.07, cartridge_ml: 1000, price_usd_per_l: 199, color: "#d3c7b8" },
  { code: "FLHTAM02", name: "High Temp V2", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.18, cartridge_ml: 1000, price_usd_per_l: 199, color: "#e9c37a" },
  { code: "FLDUCL02", name: "Durable V2", family: "Engineering", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.1, cartridge_ml: 1000, price_usd_per_l: 175, color: "#c4d3d6" },
  // Form 3 family (V4 general purpose)
  { code: "FLGPBK04", name: "Black V4", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 149, color: "#1b1b1b" },
  { code: "FLGPGR04", name: "Grey V4", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 149, color: "#8a8d90" },
  { code: "FLGPCL04", name: "Clear V4", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 149, color: "#cfe3ee" },
  { code: "FLGPWH04", name: "White V4", family: "General Purpose", technology: "SLA", layer_thicknesses_mm: [0.025, 0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 149, color: "#e8e6e1" },
  // Dental (Form 4B)
  { code: "FLDMBE02", name: "Model V2 (Beige)", family: "Dental", technology: "SLA", layer_thicknesses_mm: [0.05, 0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 149, color: "#e3c9a8" },
  { code: "FLDGOR02", name: "Dental LT Clear V2", family: "Dental", technology: "SLA", layer_thicknesses_mm: [0.1], density: 1.12, cartridge_ml: 1000, price_usd_per_l: 299, color: "#dcefef" },
  // SLS powders (Fuse)
  { code: "FLP12B01", name: "Nylon 12 Powder", family: "Nylon", technology: "SLS", layer_thicknesses_mm: [0.11], density: 1.01, price_usd_per_l: 100, color: "#bdbcb8" },
  { code: "FLP11B01", name: "Nylon 11 Powder", family: "Nylon", technology: "SLS", layer_thicknesses_mm: [0.11], density: 1.05, price_usd_per_l: 120, color: "#c9c5bd" },
  { code: "FLP12G01", name: "Nylon 12 GF Powder", family: "Nylon", technology: "SLS", layer_thicknesses_mm: [0.11], density: 1.33, price_usd_per_l: 110, color: "#b3b6b9" },
  { code: "FLP11C01", name: "Nylon 11 CF Powder", family: "Nylon", technology: "SLS", layer_thicknesses_mm: [0.11], density: 1.09, price_usd_per_l: 175, color: "#3b3b3b" },
  { code: "FLPPPB01", name: "Polypropylene Powder", family: "Polyolefin", technology: "SLS", layer_thicknesses_mm: [0.11], density: 0.9, price_usd_per_l: 110, color: "#e5e2da" },
  { code: "FLPTPU01", name: "TPU 90A Powder", family: "Elastomer", technology: "SLS", layer_thicknesses_mm: [0.11], density: 1.1, price_usd_per_l: 130, color: "#d8d2c4" },
];

const FORM4_MATERIALS = ["FLGPBK05", "FLGPGR05", "FLGPWH05", "FLGPCL05", "FLFD0001", "FLTO2001", "FLTO1501", "FLRG1001", "FLRG4001", "FLFL8001", "FLEL5001", "FLHTAM02", "FLDUCL02"];
const FORM3_MATERIALS = ["FLGPBK04", "FLGPGR04", "FLGPCL04", "FLGPWH04", "FLTO2001", "FLTO1501", "FLRG1001", "FLRG4001", "FLFL8001", "FLEL5001", "FLHTAM02", "FLDUCL02"];
const FUSE_MATERIALS = ["FLP12B01", "FLP11B01", "FLP12G01", "FLP11C01", "FLPPPB01", "FLPTPU01"];

export const PRINTER_TYPES: PrinterType[] = [
  { machine_type: "FORM-4-0", product_name: "Form 4", label: "Form 4", technology: "SLA", build_volume_mm: { x: 200, y: 125, z: 210 }, per_layer_seconds: { "0.025": 6.5, "0.05": 7.5, "0.1": 9, "0.16": 10, ADAPTIVE: 8 }, seconds_per_ml: 45, firmware: "2.7.1", materials: FORM4_MATERIALS },
  { machine_type: "FORM-4B-0", product_name: "Form 4B", label: "Form 4B", technology: "SLA", build_volume_mm: { x: 200, y: 125, z: 210 }, per_layer_seconds: { "0.025": 6.5, "0.05": 7.5, "0.1": 9, "0.16": 10, ADAPTIVE: 8 }, seconds_per_ml: 45, firmware: "2.7.1", materials: [...FORM4_MATERIALS, "FLDMBE02", "FLDGOR02"] },
  { machine_type: "FORM-4L-0", product_name: "Form 4L", label: "Form 4L", technology: "SLA", build_volume_mm: { x: 353, y: 196, z: 350 }, per_layer_seconds: { "0.05": 11, "0.1": 13, ADAPTIVE: 12 }, seconds_per_ml: 40, firmware: "2.7.1", materials: FORM4_MATERIALS },
  { machine_type: "FORM-3-0", product_name: "Form 3+", label: "Form 3/3+", technology: "SLA", build_volume_mm: { x: 145, y: 145, z: 185 }, per_layer_seconds: { "0.025": 20, "0.05": 24, "0.1": 28, ADAPTIVE: 26 }, seconds_per_ml: 90, firmware: "1.19.8", materials: FORM3_MATERIALS },
  { machine_type: "FORM-3L-0", product_name: "Form 3L", label: "Form 3L", technology: "SLA", build_volume_mm: { x: 335, y: 200, z: 300 }, per_layer_seconds: { "0.05": 36, "0.1": 42, ADAPTIVE: 40 }, seconds_per_ml: 70, firmware: "1.19.8", materials: FORM3_MATERIALS },
  { machine_type: "FS30-1-0", product_name: "Fuse 1+ 30W", label: "Fuse 1+ 30W", technology: "SLS", build_volume_mm: { x: 165, y: 165, z: 300 }, per_layer_seconds: { "0.11": 22 }, seconds_per_ml: 6, preheat_seconds: 3600, cooldown_fraction: 0.5, firmware: "3.1.0", materials: FUSE_MATERIALS },
];

export function printerType(machineType: string): PrinterType | undefined {
  const wanted = machineType.toUpperCase();
  return PRINTER_TYPES.find((p) => p.machine_type === wanted);
}

export function material(code: string): Material | undefined {
  const wanted = code.toUpperCase();
  return MATERIALS.find((m) => m.code === wanted);
}

export function isSLS(machineType: string): boolean {
  const t = machineType.toUpperCase();
  return t.startsWith("FS") || t.startsWith("PILK");
}

/** PreFormServer /list-materials/ compatible payload. */
export function listMaterialsPayload(): { printer_types: unknown[] } {
  return {
    printer_types: PRINTER_TYPES.map((p) => ({
      label: p.label,
      supported_machine_type_ids: [p.machine_type],
      supported_product_names: [p.product_name],
      build_volume_dimensions_mm: p.build_volume_mm,
      technology: p.technology,
      materials: p.materials
        .map(material)
        .filter((m): m is Material => !!m)
        .map((m) => ({
          label: m.name,
          material_code: m.code,
          family: m.family,
          material_settings: m.layer_thicknesses_mm.map((lt) => ({
            label: `${m.name} ${lt} mm`,
            scene_settings: { machine_type: p.machine_type, material_code: m.code, print_setting: "DEFAULT", layer_thickness_mm: lt },
          })),
        })),
    })),
  };
}

export function validSceneSettings(machineType: string, materialCode: string, layer: number | "ADAPTIVE"): { ok: true; printer: PrinterType; material: Material } | { ok: false; reason: string } {
  const printer = printerType(machineType);
  if (!printer) return { ok: false, reason: `Unknown machine_type ${machineType}` };
  const mat = material(materialCode);
  if (!mat) return { ok: false, reason: `Unknown material_code ${materialCode}` };
  if (!printer.materials.includes(mat.code)) return { ok: false, reason: `${mat.name} (${mat.code}) is not available on ${printer.product_name}` };
  if (layer !== "ADAPTIVE" && !mat.layer_thicknesses_mm.includes(layer)) {
    return { ok: false, reason: `${mat.name} supports layer thicknesses ${mat.layer_thicknesses_mm.join(", ")} mm, not ${layer}` };
  }
  if (layer === "ADAPTIVE" && printer.technology === "SLS") return { ok: false, reason: "ADAPTIVE layers are not available on SLS printers" };
  return { ok: true, printer, material: mat };
}
