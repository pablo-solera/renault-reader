import { extractionFolder } from "@pablosla/core-reader/contract/manifest";
import { FAMILY_PARTS_EXPORTS, CORE_PARTS_EXPORTS, OPTIONAL_PARTS_EXPORTS, LABOUR_QUERY_CODE, isExportEnabled } from "./exports.js";
import { normalizeDescription, normalizeManufacturer } from "./normalize.js";
import type { LabourInput, PartsInput, RequestInput, UnitSummary } from "./request.js";

const GROUP = "RENAULT";

const slug = (value: string) => value.replace(/^[._]+/, "").replaceAll(".", "-");

/** Segments between the resource and the date: the labour family, or the parts model folder and its edition. */
export function scopeSegments(input: RequestInput): string[] {
  return input.resource === "labours"
    ? [input.family]
    : [`${input.axCode}_${normalizeDescription(input.description)}_${input.family}`, input.edition.replace("/", "-")];
}

const resourceFolder = (input: RequestInput) => input.resource === "labours" ? "labour" : "parts";

export function unitFolder(input: RequestInput, unit: string): string {
  return extractionFolder({ group: GROUP, manufacturer: normalizeManufacturer(input.manufacturer), resource: resourceFolder(input), segments: scopeSegments(input), date: input.date, unit });
}

/** The folder of the whole extraction (every unit sits below it); it is what two concurrent requests must not share. */
export function scopeFolder(input: RequestInput): string {
  return unitFolder(input, "_").replace(/\/_$/, "");
}

export function labourUnitName(input: LabourInput): string {
  return `${LABOUR_QUERY_CODE}_${input.language ?? "any"}_${input.range}_${slug(input.format)}${input.publishedAfter ? `_after${input.publishedAfter.replaceAll("-", "")}` : ""}`;
}

const pending = (input: RequestInput, unit: string, queryCode: string, family: string): UnitSummary => ({ unit, queryCode, family, path: unitFolder(input, unit), status: "pending" });

export function labourUnits(input: LabourInput): UnitSummary[] {
  return [pending(input, labourUnitName(input), LABOUR_QUERY_CODE, input.family)];
}

/** REF04 and REF05 first, then the optional exports in the Access order; PR08/PR03 follow once the families are known. */
export function partsUnits(input: PartsInput): UnitSummary[] {
  const codes = [...CORE_PARTS_EXPORTS, ...OPTIONAL_PARTS_EXPORTS.filter(code => isExportEnabled(input.exports, code))];
  return codes.map(code => pending(input, code, code, input.family));
}

export function familyUnits(input: PartsInput, families: string[]): UnitSummary[] {
  return FAMILY_PARTS_EXPORTS.filter(code => isExportEnabled(input.exports, code)).flatMap(code => families.map(family => pending(input, `${code}_${family}`, code, family)));
}

export const needsFamilies = (input: PartsInput) => FAMILY_PARTS_EXPORTS.some(code => isExportEnabled(input.exports, code));

export function initialUnits(input: RequestInput): UnitSummary[] {
  return input.resource === "labours" ? labourUnits(input) : partsUnits(input);
}

/** What a request locks: each labour file, or the whole parts folder (its units are only known step by step). */
export function lockPaths(input: RequestInput, units: UnitSummary[]): string[] {
  return input.resource === "labours" ? units.map(unit => unit.path) : [scopeFolder(input)];
}
