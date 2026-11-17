import { NotAvailableError } from "@pablosla/core-reader/domain/errors";
import type { ModelOptions } from "@pablosla/core-reader/contract/v1";
import type { RenaultApi } from "../ports/renault-api.js";
import { LABOUR_QUERY_CODE } from "../../domain/exports.js";
import { discoverExport } from "./discover-export.js";

export type ModelOptionsQuery = { manufacturer?: string; range: string; exportType: string; includeRaw: boolean };

/**
 * Renault has no model catalogue endpoint: what an account may extract is expressed as authorised families (plus formats and languages),
 * so each family is offered as a model whose `selection` is a ready labour selection. The families of the other exports are discoverable too.
 */
export async function getModelOptionsUseCase(query: ModelOptionsQuery, api: RenaultApi): Promise<ModelOptions> {
  const discovered = await discoverExport(api, query.range, query.exportType);
  if (!discovered.families.length && discovered.query.familyFilter) throw new NotAvailableError("Renault returned no authorised families");
  const labourSelection = query.exportType === LABOUR_QUERY_CODE;
  return {
    manufacturer: query.manufacturer ?? String(discovered.profile.brand ?? "RENAULT"),
    appliedFilters: { range: query.range, exportType: query.exportType, ...(query.manufacturer ? { manufacturer: query.manufacturer } : {}) },
    filters: [
      { name: "format", values: discovered.formats.map(value => ({ value })) },
      ...(discovered.languages ? [{ name: "language", values: discovered.languages.map(value => ({ value })) }] : []),
    ],
    models: discovered.families.map(family => ({
      id: String(family.value),
      label: String(family.label ?? family.value),
      attributes: { ...(family.criteria != null ? { criteria: family.criteria } : {}), ...(family.brand != null ? { brand: family.brand } : {}), ...(family.ecuId != null ? { ecuId: family.ecuId } : {}) },
      selection: labourSelection ? { family: String(family.value), range: query.range } : { family: String(family.value) },
    })),
    complete: true,
    ...(query.includeRaw ? { raw: { queryCode: discovered.query.queryCode, queryDesc: discovered.query.queryDesc, profile: discovered.profile.value, formats: discovered.formats, languages: discovered.languages } } : {}),
  };
}
