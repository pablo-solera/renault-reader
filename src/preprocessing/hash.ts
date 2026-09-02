import { createHash } from "node:crypto";

const fields = ["plateId", "illustrationFile", "sectionApplicabilityCleanedComparison", "hotSpotNumber", "partNumber", "partsApplicabilityCleanedComparison", "additionalParts", "designationEN", "partKitList", "partKitFlag", "partStatus", "latestReplacementPart", "latestReplacementType", "partCodifiedSigns"];

export function createCatalogHash(record: Record<string, unknown>): string {
  const value = fields.map((field) => String(record[field] ?? (field === "latestReplacementType" ? record.LasteReplacementType : "") ?? "").replaceAll(" ", "")).join("");
  return createHash("sha1").update(value).digest("base64");
}
