import { createHmac } from "node:crypto";

const fields = ["plateId", "illustrationFile", "sectionApplicabilityCleanedComparison", "hotSpotNumber", "partNumber", "partsApplicabilityCleanedComparison", "additionalParts", "designationEN", "partKitList", "partKitFlag", "partStatus", "latestReplacementPart", "latestReplacementType", "partCodifiedSigns"];

export function createCatalogHash(record: Record<string, unknown>): string {
  const value = fields.map((field) => String(record[field] ?? (field === "latestReplacementType" ? record.LasteReplacementType : "") ?? "").replaceAll(" ", "")).join("");
  return accessHash(value);
}

export function accessHash(value: string): string {
  return createHmac("sha1", value).update(value).digest("base64");
}
