import { createCatalogHash } from "./hash.js";
import { createApplicabilityEvaluator, type ApplicabilityResult } from "./applicability.js";
import { buildTreeIndex, navigationPath } from "./tree.js";
import { buildCriteriaCodeIndex } from "./criteria.js";

export function preprocessCatalog(records: Record<string, unknown>[], criteria: Record<string, unknown>[], powertrain: Record<string, unknown>[], models: Record<string, unknown>[] = [], tree: Record<string, unknown>[] = []) {
  const criteriaIndex = buildCriteriaCodeIndex(criteria);
  const model = { ...models[0], manufacturerCode: models.map((item) => item.manufacturerCode).filter(Boolean).join(",") };
  const treeIndex = buildTreeIndex(tree);
  const applicabilityCache = new Map<string, ApplicabilityResult>();
  const evaluators = new Map<string, ReturnType<typeof createApplicabilityEvaluator>>();
  const evaluateCached = (value: unknown, familyType: string) => {
    const key = `${familyType}|${String(value ?? "")}`;
    const cached = applicabilityCache.get(key);
    if (cached) return cached;
    const evaluator = evaluators.get(familyType) ?? createApplicabilityEvaluator(criteriaIndex, powertrain, model, familyType);
    evaluators.set(familyType, evaluator);
    const result = evaluator(value);
    applicabilityCache.set(key, result);
    return result;
  };
  return records.map((record) => {
    const familyType = String(record.familyType ?? record.familytype ?? "POWERTRAIN").toUpperCase();
    const section = evaluateCached(record.sectionApplicability, familyType);
    const parts = evaluateCached(record.partsApplicability, familyType);
    const result = { ...record, ActiveSection: section.valid ? 1 : 2, ActivePartsNumber: section.valid && parts.valid ? 1 : 2, sectionApplicabilityCleaned: section.cleaned, sectionApplicabilityCleanedComparison: section.comparison, partsApplicabilityCleaned: parts.cleaned, partsApplicabilityCleanedComparison: parts.comparison, navigation_path: navigationPath(String(record.nodes ?? "").split(",").map((id) => id.trim()), treeIndex) };
    return { ...result, Hash: createCatalogHash(result) };
  });
}
