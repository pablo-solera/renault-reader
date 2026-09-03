import { buildCriteriaIndex } from "../preprocessing/criteria.js";
import { preprocessCatalog } from "../preprocessing/catalog.js";
import { createHash } from "node:crypto";

type AnyRow = Record<string, any>;

const crlf = (values: unknown[]) => values.map((value) => String(value ?? "").trim()).filter(Boolean).join("\r\n");
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const listText = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item) => typeof item === "object" && item !== null ? Object.values(item).flatMap((nested) => Array.isArray(nested) ? nested.map(String) : [String(nested)]) : [String(item)]) : value == null || value === "" ? [] : String(value).split(/\r?\n/).filter(Boolean);
const partNumbers = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item) => typeof item === "object" && item !== null ? [String((item as AnyRow).partNumber ?? (item as AnyRow).value ?? "")] : [String(item)]) : listText(value).flatMap((item) => item.split("|")[0] ? [item.split("|")[0]] : []);
const codifiedSigns = (value: unknown): string => Array.isArray(value) ? value.map((item) => typeof item === "object" && item !== null ? [String((item as AnyRow).labelType ?? ""), ...(Array.isArray((item as AnyRow).value) ? (item as AnyRow).value.map(String) : [String((item as AnyRow).value ?? "")])].filter(Boolean).join(" ") : String(item)).filter(Boolean).join("\r\n") : String(value ?? "");

export function flattenPartsCatalog(plates: AnyRow[]): AnyRow[] {
  return plates.flatMap((plate) => (Array.isArray(plate.lines) ? plate.lines : []).map((line: AnyRow) => ({
    ...line,
    plateId: plate.plateId,
    publishedDate: plate.publishedDate,
    plateStdId: plate.plateStdId,
    illustrationPlateNumber: plate.illustrationPlateNumber,
    illustrationFile: plate.illustrationFile,
    nodes: Array.isArray(plate.nodes) ? plate.nodes.join(",") : plate.nodes,
    sectionApplicability: crlf((plate.applicability ?? []).map((item: AnyRow) => item.mtc)),
    partsApplicability: crlf((line.applicability ?? []).map((item: AnyRow) => [
      item.mtc,
      first(item.manufacturingPlantCode),
      first(item.manufacturingPlantLabel),
      item.startDate,
      item.endDate,
    ].join("|"))),
    manufacturingPlantCode: crlf((line.applicability ?? []).flatMap((item: AnyRow) => item.manufacturingPlantCode ?? [])),
    manufacturingPlantLabel: crlf((line.applicability ?? []).flatMap((item: AnyRow) => item.manufacturingPlantLabel ?? [])),
        partCodifiedSigns: codifiedSigns(line.partCodifiedSigns),
    additionalParts: line.additionalParts ?? "",
    partKitList: line.partKitList ?? "",
  })));
}

export function flattenCriteriaLabels(records: AnyRow[], language = "EN"): AnyRow[] {
  return records.map((record) => {
    const groups = Array.isArray(record.labels) ? record.labels : [];
    const group = groups[0] ?? {};
    const labels = Object.keys(group);
    const labelValues = labels.length ? Object.values(group[labels[0]] ?? {})[0] : undefined;
    return {
    Hash: String(record.id ?? ""),
    HTC: String(record.id ?? ""),
    objectOriginCode: String(record.objectOriginCode ?? ""),
    labels: labels[0] ?? "",
    subLabels: "",
     lang: language,
     description: String((labelValues as AnyRow)?.[language.toLowerCase()] ?? labelValues ?? "").slice(0, 255),
    insertDate: new Date(),
    active: true,
    };
  });
}

function flattenTreeNode(node: AnyRow, result: AnyRow[]): void {
  const labels = Array.isArray(node.label) ? node.label : [];
  const row: AnyRow = { nodeId: node.nodeId, level: node.level, childNodes: node.childNodes };
  for (const item of labels) if (item.language) row[`label${String(item.language).replace("-", "")}`] = item.longLabel;
  result.push(row);
  for (const child of node.childNodes ?? []) flattenTreeNode(child, result);
}

export function flattenRepairTree(record: AnyRow): AnyRow[] {
  const result: AnyRow[] = [];
  for (const root of record.REPAIR_TREE ?? []) flattenTreeNode(root, result);
  return result;
}

export function preprocessRenaultCatalog(plates: AnyRow[], criteriaRecords: AnyRow[], powertrain: AnyRow[], models: AnyRow[], treeRecord: AnyRow) {
  const criteria = flattenCriteriaLabels(criteriaRecords);
  return preprocessCatalog(flattenPartsCatalog(plates), criteria, powertrain, models, flattenRepairTree(treeRecord));
}

function dateValue(value: unknown): Date | null {
  const raw = String(value ?? "");
  if (!/^\d{8}$/.test(raw)) return null;
  return new Date(Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8))));
}

export function toAccionaReferences(records: AnyRow[], axCode: string, model: string, replacements: AnyRow[] = []): AnyRow[] {
  const replacementByPart = new Map<string, AnyRow>();
  for (const replacement of replacements) replacementByPart.set(String(replacement.partNumberReplaced), replacement);
  return records.filter((record) => record.ActivePartsNumber === 1).flatMap((record) => {
    const replacement = replacementByPart.get(String(record.partNumber));
    const targets = Array.isArray(replacement?.target) ? replacement.target : [];
    const replacementPart = record.latestReplacementPart ?? (targets.length > 1 ? "Multi." : targets[0]?.partNumber ?? "");
    const applicability = String(record.partsApplicabilityCleaned ?? "").split(/\r?\n/).filter(Boolean);
    return applicability.map((line) => {
      const [, , plant, start, end] = line.split("|");
      return {
        IdModeloAudatex: axCode,
        IdModelo: model,
        IdSeccion: String(record.plateId ?? "").split("_")[1] ?? "",
        Dato1: record.hotSpotNumber,
        Dato2: record.genericPart,
        Dato3: record.partNumber,
         Dato5: replacementPart,
        Dato6: `A_${model}_${record.partNumber ?? ""}`,
        Dato8: start ? `${start.slice(6, 8)}/${start.slice(4, 6)}/${start.slice(0, 4)}` : "",
        Dato9: end ? `${end.slice(6, 8)}/${end.slice(4, 6)}/${end.slice(0, 4)}` : "",
        Dato12: record.plateId,
         Dato17: [listText(record.partCodifiedSigns).join("\r\n"), line.split("|")[0]].filter(Boolean).join("\r\n\r\n") + (plant ? `\r\n${plant}` : ""),
        Dato18: record.partKitFlag === "Y" && record.sourcing === "EXTERNAL" ? partNumbers(record.partKitList).map((part) => `A_${model}_${part}`).join(",") : "",
        Dato19: partNumbers(record.additionalParts).map((part) => `A_${model}_${part}`).join("\r\n"),
        DatoFecha: dateValue(start),
        DatoFecha1: dateValue(end),
         DescripcionTotal: [listText(record.partCodifiedSigns).join("\r\n"), line.split("|")[0]].filter(Boolean).join("\r\n\r\n") + (plant ? `\r\n${plant}` : ""),
      };
    });
  });
}

export function toAccionaComparisonReferences(records: AnyRow[], axCode: string, model: string, replacements: AnyRow[] = [], comparisonType = ""): AnyRow[] {
  return toAccionaReferences(records, axCode, model, replacements).map((row) => ({ ...row, Dato22: "", Dato23: comparisonType || String(records.find((record) => String(record.plateId) === String(row.Dato12) && String(record.hotSpotNumber) === String(row.Dato1) && String(record.partNumber) === String(row.Dato3))?.TypeCompare ?? "") }));
}

export function toAccionaComparisonSections(records: AnyRow[], axCode: string, model: string, epc: string, imagesRoot: string, performedFlag = "0"): AnyRow[] {
  return toAccionaDesSecciones(records, axCode, model, epc, imagesRoot, performedFlag).map((row) => ({ ...row, Estado: records.find((record) => String(record.plateId) === String(row.Audatex))?.TypeCompare === "NewSection" ? 1 : 2 }));
}

export function toAccionaDesSecciones(records: AnyRow[], axCode: string, model: string, epc: string, imagesRoot: string, performedFlag = "0"): AnyRow[] {
  const seen = new Set<string>();
  return records.filter((record) => record.ActiveSection === 1 && !seen.has(String(record.plateId)) && seen.add(String(record.plateId))).map((record) => {
    const section = String(record.plateId ?? "").split("_")[1] ?? "";
    const navigation = String(record.navigation_path ?? "");
    return {
      CD: epc,
      idAudatex: axCode,
      Modelo: model,
      Seccion: section,
      Descripcion: ` Applicability: ${record.sectionApplicabilityCleaned ?? ""}\r\n\r\n${navigation}`,
       Realizada: performedFlag,
      Audatex: record.plateId,
      DesOriginal: null,
      DesSeccion: null,
      DesSeccion1: null,
      Filtrado: null,
      SeccionOriginal: null,
      RutaFoto: `${imagesRoot.replace(/[\\/]+$/, "")}\\${record.illustrationFile ?? ""}`,
      ColorFondo: null,
      Estado: null,
    };
  });
}

export function toAccionaFiltroSecciones(sections: AnyRow[], model: string): AnyRow[] {
  const seen = new Set<string>();
  let ordinal = 1;
  const values = sections.map((section) => String(section.Descripcion ?? "").split(/\r?\n/).slice(2).find(Boolean)?.trim()).filter((section): section is string => Boolean(section));
  return values.filter((section) => !seen.has(section) && (seen.add(section), true)).map((section) => ({ Modelo: model, Seccion: section, Ordinal: ordinal++ }));
}

export function toAccionaDescriptions(records: AnyRow[], manufacturer: string, model = "", languageId = 3): AnyRow[] {
  const seen = new Set<string>();
  return records.filter((record) => (record.ActivePartsNumber === 1 || record.ActivePartsNumber == null) && record.partNumber && !seen.has(String(record.partNumber)) && seen.add(String(record.partNumber))).map((record) => ({ Fabricante: manufacturer, Num: `A_${model ? `${model}_` : ""}${record.partNumber}`, Idioma: languageId, Descripcion: record.designationEN ?? record.genericPartDesignationEN ?? record.designation ?? "" }));
}

export function toAccionaSustituciones(records: AnyRow[], replacements: AnyRow[], model: string, descriptions: Map<string, string>): AnyRow[] {
  const partNumbers = new Set(records.filter((record) => record.ActivePartsNumber === 1).map((record) => String(record.partNumber)));
  return replacements.filter((replacement) => partNumbers.has(String(replacement.partNumberReplaced))).flatMap((replacement) => (replacement.target ?? []).map((target: AnyRow) => ({
    partNoReferencia: replacement.partNumberReplaced,
    Aplicabilidad: null,
    Quantity: target.quantity ?? null,
    RefTurca: null,
    SuspartNoReferencia: target.partNumber,
    SusPartNoReferenciaDescripcion: descriptions.get(`A_${model}_${target.partNumber}`) ?? `A_${model}_${target.partNumber}`,
    SusAplicabilidad: null,
    SusQuantity: target.quantity == null ? "" : String(target.quantity),
    SusRefTurca: null,
    Modelo: model,
  })));
}

export function toAccionaPartsData(records: AnyRow[]): AnyRow[] {
  return records.map((record) => ({
    Hash: createHash("sha1").update([record.partNumber, record.brandCode, record.corporate, record.familyCode, record.productModelCode, record.designation].map((value) => String(value ?? "").replaceAll(" ", "")).join("")).digest("base64"),
    partNumber: record.partNumber,
    brandCode: record.brandCode,
    corporate: record.corporate,
    familyCode: record.familyCode,
    productModelCode: record.productModelCode,
    codifiedSigns: record.codifiedSigns ?? "",
    types: record.types ?? "",
    partsEquivalentRenault: record.partsEquivalentRenault ?? "",
    equivalentParts: record.equivalentParts ?? "",
    designation: record.designation ?? "",
    insertDate: new Date(),
    active: true,
  }));
}

export { buildCriteriaIndex };
