import { createCatalogHash } from "./hash.js";
import { evaluateApplicability } from "./applicability.js";
import { buildTreeIndex, navigationPath } from "./tree.js";
import { buildCriteriaIndex } from "./criteria.js";

export function preprocessCatalog(records: Record<string, unknown>[], criteria: Record<string, unknown>[], powertrain: Record<string, unknown>[], models: Record<string, unknown>[] = [], tree: Record<string, unknown>[] = []) {
  const criteriaIndex = buildCriteriaIndex(criteria);
  const model = { ...models[0], manufacturerCode: models.map((item) => item.manufacturerCode).filter(Boolean).join(",") };
  const treeIndex = buildTreeIndex(tree);
  return records.map((record) => {
    const familyType = String(record.familyType ?? record.familytype ?? "POWERTRAIN").toUpperCase();
    const section = evaluateApplicability(record.sectionApplicability, criteriaIndex, powertrain, model, familyType);
    const parts = evaluateApplicability(record.partsApplicability, criteriaIndex, powertrain, model, familyType);
    const result = { ...record, ActiveSection: section.valid ? 1 : 2, ActivePartsNumber: section.valid && parts.valid ? 1 : 2, sectionApplicabilityCleaned: section.cleaned, sectionApplicabilityCleanedComparison: section.comparison, partsApplicabilityCleaned: parts.cleaned, partsApplicabilityCleanedComparison: parts.comparison, navigation_path: navigationPath(String(record.nodes ?? "").split(",").map((id) => id.trim()), treeIndex) };
    return { ...result, Hash: createCatalogHash(result) };
  });
}
