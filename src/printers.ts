/**
 * Printer families PreFormServer accepts scenes for but leaves out of /list-materials/.
 *
 * Verified against PreFormServer 3.63.0: `POST /scene/` with FUSX-1-0 / FLP12G01 /
 * 0.11 mm creates a 330 x 330 x 565 mm Fuse X1 scene, yet the printer family is not
 * in the materials list, so a client that only trusts the list never learns the code.
 * Every other (material, layer) pair for FUSX-1-0 answers "Scene type not supported",
 * which is the server's message for "no print setting for that combination".
 *
 * Entries are merged into list_printer_types and list_materials only while the server
 * still omits their machine type, so they disappear on their own once Formlabs lists
 * them.
 */
import { isRecord, type Json } from "./client.js";

export const UNLISTED_PRINTER_TYPES: Json[] = [
  {
    label: "Fuse X1",
    supported_machine_type_ids: ["FUSX-1-0"],
    supported_product_names: ["Fuse X1"],
    build_volume_dimensions_mm: [330, 330, 565],
    materials: [
      {
        label: "Nylon 12 GF V1",
        description: "The one Fuse X1 print setting PreFormServer 3.63.0 ships",
        material_settings: [
          {
            label: "0.110 mm (Default settings)",
            scene_settings: { layer_thickness_mm: 0.11, machine_type: "FUSX-1-0", material_code: "FLP12G01", print_setting: "DEFAULT" },
          },
        ],
      },
    ],
    unlisted: "Not returned by PreFormServer's /list-materials/ (3.63.0); create_scene accepts these settings.",
  },
];

/** The server's printer_types plus any unlisted family whose machine types it does not mention. */
export function withUnlistedPrinterTypes(data: Json): Json[] {
  const listed = Array.isArray(data["printer_types"]) ? data["printer_types"].filter(isRecord) : [];
  const known = new Set(
    listed.flatMap((p) => (Array.isArray(p["supported_machine_type_ids"]) ? p["supported_machine_type_ids"] : [])).map((x) => String(x).toUpperCase()),
  );
  const extra = UNLISTED_PRINTER_TYPES.filter((p) => {
    const ids = Array.isArray(p["supported_machine_type_ids"]) ? p["supported_machine_type_ids"] : [];
    return !ids.some((id) => known.has(String(id).toUpperCase()));
  });
  return [...listed, ...extra];
}
