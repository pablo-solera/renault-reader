import { createHash } from "node:crypto";

export type CatalogRecord = Record<string, any>;
export type ImageHashes = Record<string, string>;
export type CompareType = "" | "MinorChange" | "PartKitList" | "AdditionalParts" | "PartsDescription" | "SectionApplicability" | "Replacement" | "PartsApplicability" | "PartNumberNoFound" | "PartNumberCode" | "Illustration" | "NewSection" | "NewPartNumber" | "DeletedSection" | "DeletedPartNumber";
export type ComparedCatalog = { current: CatalogRecord[]; previous: CatalogRecord[]; newRows: CatalogRecord[]; deletedRows: CatalogRecord[]; newSections: string[]; deletedSections: string[] };

const active = (row: CatalogRecord) => row.ActiveSection === 1 && row.ActivePartsNumber === 1;
const section = (row: CatalogRecord) => String(row.plateId ?? "");
const hotspot = (row: CatalogRecord) => String(row.hotSpotNumber ?? "");
const imageBase = (name: unknown) => String(name ?? "").split("_").slice(0, 2).join("_");
const rowHash = (row: CatalogRecord) => row.Hash ?? createHash("sha1").update(JSON.stringify(row)).digest("base64");
const imageEqual = (current: CatalogRecord, previous: CatalogRecord, currentImages: ImageHashes, previousImages: ImageHashes) => {
  const currentName = String(current.illustrationFile ?? "");
  const previousName = String(previous.illustrationFile ?? "");
  return imageBase(currentName) === imageBase(previousName) || Boolean(currentImages[currentName] && previousImages[previousName] && currentImages[currentName] === previousImages[previousName]);
};

const priorities: CompareType[] = ["", "MinorChange", "PartKitList", "AdditionalParts", "PartsDescription", "SectionApplicability", "Replacement", "PartsApplicability", "PartNumberNoFound", "PartNumberCode", "Illustration"];
const priority = (type: CompareType) => priorities.indexOf(type);

function changeType(current: CatalogRecord, previous: CatalogRecord, currentImages: ImageHashes, previousImages: ImageHashes): CompareType {
  if (!imageEqual(current, previous, currentImages, previousImages)) return "Illustration";
  if (hotspot(current) !== hotspot(previous)) return "PartNumberCode";
  if (String(current.partNumber ?? "") !== String(previous.partNumber ?? "")) return "PartNumberNoFound";
  if (String(current.partsApplicabilityCleanedComparison ?? "") !== String(previous.partsApplicabilityCleanedComparison ?? "") || String(current.partCodifiedSigns ?? "") !== String(previous.partCodifiedSigns ?? "")) return "PartsApplicability";
  if (String(current.latestReplacementPart ?? "") !== String(previous.latestReplacementPart ?? "")) return "Replacement";
  if (String(current.sectionApplicabilityCleanedComparison ?? "") !== String(previous.sectionApplicabilityCleanedComparison ?? "")) return "SectionApplicability";
  if (String(current.designationEN ?? "") !== String(previous.designationEN ?? "")) return "PartsDescription";
  if (String(current.additionalParts ?? "") !== String(previous.additionalParts ?? "")) return "AdditionalParts";
  if (String(current.sourcing ?? "") === "External" && String(current.partKitList ?? "") !== String(previous.partKitList ?? "")) return "PartKitList";
  return "";
}

function unmatched(rows: CatalogRecord[], plateId: string) {
  return rows.filter((row) => active(row) && section(row) === plateId && row.Compare === 0);
}

export function compareCatalogs(currentInput: CatalogRecord[], previousInput: CatalogRecord[], currentImages: ImageHashes = {}, previousImages: ImageHashes = {}): ComparedCatalog {
  const current = currentInput.map((row) => ({ ...row, Compare: 0, TypeCompare: null as CompareType | null }));
  const previous = previousInput.map((row) => ({ ...row, Compare: 0, TypeCompare: null as CompareType | null }));
  const oldByHash = new Map<string, CatalogRecord[]>();
  for (const row of previous.filter(active)) oldByHash.set(rowHash(row), [...(oldByHash.get(rowHash(row)) ?? []), row]);
  for (const row of current.filter(active)) {
    const candidates = oldByHash.get(rowHash(row));
    const old = candidates?.find((candidate) => candidate.Compare === 0);
    if (old) { row.Compare = 1; old.Compare = 1; }
  }
  const currentSections = new Set(current.filter(active).map(section));
  const previousSections = new Set(previous.filter(active).map(section));
  const newSections = [...currentSections].filter((value) => !previousSections.has(value));
  const deletedSections = [...previousSections].filter((value) => !currentSections.has(value));
  let link = 2;
  for (const plateId of [...currentSections].filter((value) => previousSections.has(value))) {
    const now = unmatched(current, plateId);
    const old = unmatched(previous, plateId);
    for (const row of now) {
      let best: CatalogRecord | undefined;
      let bestType: CompareType = "NewPartNumber";
      for (const candidate of old) {
        const type = changeType(row, candidate, currentImages, previousImages);
        if (candidate.Compare !== 0) continue;
        if (!best || priority(type) < priority(bestType)) { best = candidate; bestType = type; }
      }
      if (!best) continue;
      if (bestType === "PartNumberNoFound") {
        row.TypeCompare = bestType;
        row.Compare = 0;
        continue;
      }
      row.Compare = link;
      row.TypeCompare = bestType;
      best.Compare = link;
      best.TypeCompare = bestType;
      link++;
    }
  }
  for (const row of current.filter((item) => active(item) && item.Compare === 0)) row.TypeCompare = newSections.includes(section(row)) ? "NewSection" : "NewPartNumber";
  for (const row of previous.filter((item) => active(item) && item.Compare === 0)) row.TypeCompare = deletedSections.includes(section(row)) ? "DeletedSection" : "DeletedPartNumber";
  return { current, previous, newRows: current.filter((row) => active(row) && row.Compare === 0), deletedRows: previous.filter((row) => active(row) && row.Compare === 0), newSections, deletedSections };
}
