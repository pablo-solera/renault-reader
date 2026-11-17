export const LABOUR_QUERY_CODE = "TM01";

export const PARTS_EXPORT_CODES = ["REF01", "REF02", "REF03", "REF04", "REF05", "PR03", "PR05", "PR06", "PR08"] as const;
export type PartsExportCode = (typeof PARTS_EXPORT_CODES)[number];

/** REF04 (model vehicles) and REF05 (powertrain) are always extracted: they decide which families PR08 and PR03 are requested for. */
export const CORE_PARTS_EXPORTS = ["REF04", "REF05"] as const satisfies readonly PartsExportCode[];
export const OPTIONAL_PARTS_EXPORTS = ["REF01", "REF02", "REF03", "PR05", "PR06"] as const satisfies readonly PartsExportCode[];
/** Extracted once per family derived from the selected models. */
export const FAMILY_PARTS_EXPORTS = ["PR08", "PR03"] as const satisfies readonly PartsExportCode[];

export type ExportSwitches = Partial<Record<PartsExportCode, boolean>>;

export const isExportEnabled = (exports: ExportSwitches | undefined, code: PartsExportCode) => exports?.[code] !== false;
