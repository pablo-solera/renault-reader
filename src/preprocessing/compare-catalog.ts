import { createHash } from "node:crypto";

export type CatalogRecord = Record<string, any>;
export type ImageHashes = Record<string, string>;
export type CompareType = "" | "MinorChange" | "PartKitList" | "AdditionalParts" | "PartsDescription" | "SectionApplicability" | "Replacement" | "PartsApplicability" | "PartNumberNoFound" | "PartNumberCode" | "Illustration" | "NewSection" | "NewPartNumber" | "DeletedSection" | "DeletedPartNumber";

export type ComparedCatalog = {
  current: CatalogRecord[];
  previous: CatalogRecord[];
  newRows: CatalogRecord[];
  deletedRows: CatalogRecord[];
  newSections: string[];
  deletedSections: string[];
};

const active = (row: CatalogRecord) => row.ActiveSection === 1 && row.ActivePartsNumber === 1;
const section = (row: CatalogRecord) => String(row.plateId ?? "");
const hotspot = (row: CatalogRecord) => String(row.hotSpotNumber ?? "");
const imageBase = (name: unknown) => String(name ?? "").split("_").slice(0, 2).join("_");
const imageEqual = (current: CatalogRecord, previous: CatalogRecord, currentImages: ImageHashes, previousImages: ImageHashes) => {
  const currentName = String(current.illustrationFile ?? "");
  const previousName = String(previous.illustrationFile ?? "");
  if (imageBase(currentName) === imageBase(previousName)) return true;
  return Boolean(currentImages[currentName] && previousImages[previousName] && currentImages[currentName] === previousImages[previousName]);
};
const hash = (row: CatalogRecord) => row.Hash ?? createHash("sha1").update(JSON.stringify(row)).digest("hex");

function changeType(current: CatalogRecord, previous: CatalogRecord, currentImages: ImageHashes, previousImages: ImageHashes): CompareType {
  if (!imageEqual(current, previous, currentImages, previousImages)) return "Illustration";
  if (hotspot(current) !== hotspot(previous)) return "PartNumberNoFound";
  if (String(current.partNumber ?? "") !== String(previous.partNumber ?? "")) return "PartNumberCode";
  if (String(current.partsApplicabilityCleanedComparison ?? "") !== String(previous.partsApplicabilityCleanedComparison ?? "") || String(current.partCodifiedSigns ?? "") !== String(previous.partCodifiedSigns ?? "")) return "PartsApplicability";
  if (String(current.latestReplacementPart ?? "") !== String(previous.latestReplacementPart ?? "")) return "Replacement";
  if (String(current.sectionApplicabilityCleanedComparison ?? "") !== String(previous.sectionApplicabilityCleanedComparison ?? "")) return "SectionApplicability";
  if (String(current.designationEN ?? "") !== String(previous.designationEN ?? "")) return "PartsDescription";
  if (String(current.additionalParts ?? "") !== String(previous.additionalParts ?? "")) return "AdditionalParts";
  if (String(current.sourcing ?? "") === "External" && String(previous.sourcing ?? "") === "External" && String(current.partKitList ?? "") !== String(previous.partKitList ?? "")) return "PartKitList";
  return "";
}

const priority: Record<CompareType, number> = { "": 0, MinorChange: 1, PartKitList: 2, AdditionalParts: 3, PartsDescription: 4, SectionApplicability: 5, Replacement: 6, PartsApplicability: 7, PartNumberNoFound: 8, PartNumberCode: 9, Illustration: 10, NewSection: 20, NewPartNumber: 20, DeletedSection: 20, DeletedPartNumber: 20 };

export function compareCatalogs(currentInput: CatalogRecord[], previousInput: CatalogRecord[], currentImages: ImageHashes = {}, previousImages: ImageHashes = {}): ComparedCatalog {
  const current = currentInput.map((row) => ({ ...row, Compare: 0, TypeCompare: null as CompareType | null }));
  const previous = previousInput.map((row) => ({ ...row, Compare: 0, TypeCompare: null as CompareType | null }));
  const currentActive = current.filter(active);
  const previousActive = previous.filter(active);
  const previousByHash = new Map<string, CatalogRecord[]>();
  for (const row of previousActive) previousByHash.set(hash(row), [...(previousByHash.get(hash(row)) ?? []), row]);
  for (const row of currentActive) {
    const matches = previousByHash.get(hash(row));
    const old = matches?.shift();
    if (old) { row.Compare = 1; old.Compare = 1; }
  }
  const currentSections = new Set(currentActive.map(section));
  const previousSections = new Set(previousActive.map(section));
  const newSections = [...currentSections].filter((value) => !previousSections.has(value));
  const deletedSections = [...previousSections].filter((value) => !currentSections.has(value));
  const bySection = (rows: CatalogRecord[], value: string) => rows.filter((row) => active(row) && section(row) === value && row.Compare !== 1);
  for (const value of [...currentSections].filter((item) => previousSections.has(item))) {
    const now = bySection(current, value);
    const old = bySection(previous, value);
    for (const [rowIndex, row] of now.entries()) {
      let best: CatalogRecord | undefined;
      let type: CompareType = "NewPartNumber";
      for (const candidate of old) {
        if (candidate.Compare === 1) continue;
        const candidateType = changeType(row, candidate, currentImages, previousImages);
        if (!best || priority[candidateType] < priority[type]) { best = candidate; type = candidateType; }
      }
      if (best) {
        const matchMarker = 2 + rowIndex;
        row.Compare = matchMarker;
        row.TypeCompare = type;
        best.Compare = matchMarker;
        best.TypeCompare = type;
      }
    }
  }
  for (const row of currentActive.filter((item) => item.Compare === 0)) row.TypeCompare = newSections.includes(section(row)) ? "NewSection" : "NewPartNumber";
  for (const row of previousActive.filter((item) => item.Compare === 0)) row.TypeCompare = deletedSections.includes(section(row)) ? "DeletedSection" : "DeletedPartNumber";
  return { current, previous, newRows: current.filter((row) => row.Compare !== 1), deletedRows: previous.filter((row) => row.Compare !== 1), newSections, deletedSections };
}
