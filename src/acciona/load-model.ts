import { getState } from "../jobs.js";
import { downloadBytes } from "../storage.js";
import { selectPowertrain } from "../powertrain.js";
import {
  flattenCriteriaLabels,
  preprocessRenaultCatalog,
  toAccionaDescriptions,
  toAccionaDesSecciones,
  toAccionaFiltroSecciones,
  toAccionaPartsData,
  toAccionaReferences,
  toAccionaComparisonReferences,
  toAccionaComparisonSections,
  cleanAccionaComparisonReferences,
  cleanAccionaComparisonSections,
  toAccionaSustituciones,
} from "./transform.js";
import { loadAccionaDataset } from "./load.js";
import { epcFromDate } from "../parts.js";
import { getAccionaConfig } from "../db/acciona.js";
import { compareCatalogs, type ImageHashes } from "../preprocessing/compare-catalog.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type AnyRow = Record<string, any>;

const read = async (id: string) => {
  const state = await getState(id);
  if (!state?.structuredKey) throw new Error(`Missing structured output for ${id}`);
  return JSON.parse(new TextDecoder().decode(await downloadBytes(state.structuredKey))) as { records: Record<string, unknown>[] };
};
const types = (entries: Array<[string, string]>) => Object.fromEntries(entries);

export type DatasetBuildOptions = { tables?: string[]; useCache?: boolean };

export async function buildAccionaDataset(requestId: string, options: DatasetBuildOptions = {}) {
  const requested = new Set(options.tables ?? ["DesSecciones", "filtrosecciones", "Descripciones", "Sustituciones", "CriteriaLabels", "PartsData", "Audatex_TOYOTA", "Referencias"]);
  const cacheRoot = join("data", "dataset-cache", requestId);
  const cached = options.useCache !== false ? await readCachedDataset(cacheRoot, requested) : undefined;
  if (cached) return cached;
  const root = await getState(requestId);
  if (!root?.children) throw new Error(`Request ${requestId} not found`);
  const children = root.children;
  const needsProcessed = ["DesSecciones", "filtrosecciones", "Descripciones", "Sustituciones", "Referencias"].some((table) => requested.has(table));
  const needsDescriptions = requested.has("Descripciones") || requested.has("Sustituciones");
  const [ref04, ref05, ref02, ref03, pr05, pr06] = await Promise.all([
    read(children.REF04.requestId), read(children.REF05.requestId), read(children.REF02.requestId),
    read(children.REF03.requestId), read(children.PR05.requestId), needsDescriptions ? read(children.PR06.requestId) : Promise.resolve({ records: [] }),
  ]);
  const plates = needsProcessed ? (await Promise.all(Object.keys(children).filter((key) => key.startsWith("PR08_")).map((key) => read(children[key].requestId)))).flatMap((result) => result.records) : [];
  const input = root.modelInput;
  if (!input) throw new Error(`Request ${requestId} has no modelInput; relaunch the model extraction with POST /models`);
  const models = ref04.records;
  const processed = needsProcessed ? preprocessRenaultCatalog(plates, ref02.records, selectPowertrain(ref05.records, models) as Record<string, unknown>[], models, ref03.records[0]) : [];
  const model = String(input.family);
  const axCode = String(input.axCode);
  const manufacturer = String(input.manufacturer);
  const epc = input.epc ?? epcFromDate(root.createdAt);
  const accionaConfig = getAccionaConfig();
  const imagesRoot = accionaConfig.imagesRoot.replace(/[\\/]+$/, "");
  const sections = requested.has("DesSecciones") || requested.has("filtrosecciones") ? toAccionaDesSecciones(processed, axCode, model, epc, `${imagesRoot}\\${manufacturer}\\${epc}\\${model}`, accionaConfig.performedFlag) : [];
  const references = requested.has("Referencias") ? toAccionaReferences(processed, axCode, model, pr05.records) : [];
  const descriptionMap = new Map(pr06.records.map((row) => [`A_${model}_${row.partNumber}`, String(row.designation ?? "")]));
  const activePartNumbers = new Set((processed as AnyRow[]).filter((record) => record.ActivePartsNumber === 1).map((record) => String(record.partNumber)));
  const replacementPartNumbers = new Set(pr05.records.filter((replacement) => activePartNumbers.has(String(replacement.partNumberReplaced))).flatMap((replacement) => (Array.isArray(replacement.target) ? replacement.target : []).map((target: AnyRow) => String(target.partNumber))));
  const replacementDescriptions = [...replacementPartNumbers].filter((partNumber) => !pr06.records.some((record) => String(record.partNumber) === partNumber)).map((partNumber) => ({ partNumber, designation: "" }));
  const descriptionSources = [...processed, ...pr06.records.filter((record) => replacementPartNumbers.has(String(record.partNumber))), ...replacementDescriptions];
  const previous = input.previousRequestId ? await buildComparisonCatalog(input.previousRequestId) : undefined;
  const reference = input.referenceRequestId ? await buildComparisonCatalog(input.referenceRequestId) : undefined;
  const currentImages = requested.has("ComparaPrevioReferencias") || requested.has("ComparaReferencias") ? await buildImageHashes(children) : {};
  const previousComparison = previous ? compareCatalogs(processed as AnyRow[], previous.records as AnyRow[], currentImages, previous.images) : undefined;
  const referenceComparison = reference ? compareCatalogs(processed as AnyRow[], reference.records as AnyRow[], currentImages, reference.images) : undefined;
  const referenceTypes = { IdModeloAudatex: "nchar(10)", IdModelo: "nvarchar(254)", IdSeccion: "nvarchar(254)", ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`Dato${index + 1}`, index >= 16 ? "nvarchar(max)" : "nvarchar(254)"])), Dato22: "nvarchar(50)", Dato23: "nvarchar(50)", DatoFecha: "date", DatoFecha1: "date", DescripcionTotal: "nvarchar(max)" };
  const sectionTypes = types([["CD", "nchar(10)"], ["idAudatex", "nchar(4)"], ["Modelo", "nvarchar(50)"], ["Seccion", "nchar(50)"], ["Descripcion", "nvarchar(max)"], ["Realizada", "nchar(1)"], ["Audatex", "nchar(50)"], ["DesOriginal", "nvarchar(max)"], ["DesSeccion", "nvarchar(max)"], ["DesSeccion1", "nvarchar(max)"], ["Filtrado", "nvarchar(max)"], ["SeccionOriginal", "nchar(50)"], ["RutaFoto", "nvarchar(max)"], ["ColorFondo", "nchar(12)"], ["Estado", "int"]]);
  const dataset = {
    axCode, model, manufacturer, epc,
    tables: Object.fromEntries(Object.entries({
      DesSecciones: { rows: sections, types: types([["CD", "nchar(10)"], ["idAudatex", "nchar(4)"], ["Modelo", "nvarchar(50)"], ["Seccion", "nchar(50)"], ["Descripcion", "nvarchar(max)"], ["Realizada", "nchar(1)"], ["Audatex", "nchar(50)"], ["DesOriginal", "nvarchar(max)"], ["DesSeccion", "nvarchar(max)"], ["DesSeccion1", "nvarchar(max)"], ["Filtrado", "nvarchar(max)"], ["SeccionOriginal", "nchar(50)"], ["RutaFoto", "nvarchar(max)"], ["ColorFondo", "nchar(12)"], ["Estado", "nchar(1)"]]) },
      filtrosecciones: { rows: toAccionaFiltroSecciones(sections, model), types: types([["Modelo", "nvarchar(50)"], ["Seccion", "nvarchar(max)"], ["Ordinal", "int"]]) },
       Descripciones: { rows: toAccionaDescriptions(descriptionSources, manufacturer, model, accionaConfig.descriptionLanguageId), types: types([["Fabricante", "nvarchar(50)"], ["Num", "nvarchar(50)"], ["Idioma", "numeric"], ["Descripcion", "nvarchar(max)"]]) },
      Sustituciones: { rows: toAccionaSustituciones(processed, pr05.records, model, descriptionMap), types: types([["partNoReferencia", "nvarchar(50)"], ["Aplicabilidad", "nvarchar(max)"], ["Quantity", "numeric"], ["RefTurca", "nvarchar(50)"], ["SuspartNoReferencia", "nvarchar(254)"], ["SusPartNoReferenciaDescripcion", "nchar(255)"], ["SusAplicabilidad", "nvarchar(max)"], ["SusQuantity", "nchar(2)"], ["SusRefTurca", "nvarchar(254)"], ["Modelo", "nvarchar(10)"]]) },
       CriteriaLabels: { rows: flattenCriteriaLabels(ref02.records), types: types([["Hash", "nchar(28)"], ["HTC", "nvarchar(10)"], ["objectOriginCode", "nvarchar(10)"], ["labels", "nvarchar(10)"], ["subLabels", "nvarchar(10)"], ["lang", "nvarchar(5)"], ["description", "nvarchar(255)"], ["insertDate", "datetime2"], ["active", "bit"]]) },
      PartsData: { rows: toAccionaPartsData(pr06.records), types: types([["Hash", "nchar(28)"], ["partNumber", "nchar(20)"], ["brandCode", "nchar(2)"], ["corporate", "nchar(10)"], ["familyCode", "nchar(10)"], ["productModelCode", "nchar(10)"], ["codifiedSigns", "nchar(255)"], ["types", "nchar(50)"], ["partsEquivalentRenault", "nchar(1000)"], ["equivalentParts", "nvarchar(max)"], ["designation", "nchar(255)"], ["insertDate", "datetime2"], ["active", "bit"]]) },
       Audatex_TOYOTA: { rows: [{ IdAudatex: axCode, IdToyota: model, CodPais: accionaConfig.countryCode, Descripcion: String(input.description), EPC: epc, Fabricante: manufacturer, Activo: accionaConfig.activeFlag, AccesoMex: null, mes: Number(epc.slice(0, 2)), ano: 2000 + Number(epc.slice(2)) }], types: types([["IdAudatex", "nchar(50)"], ["IdToyota", "nchar(50)"], ["CodPais", "nchar(20)"], ["Descripcion", "nvarchar(70)"], ["EPC", "nchar(10)"], ["Fabricante", "varchar(50)"], ["Activo", "nchar(1)"], ["AccesoMex", "nchar(1)"], ["mes", "numeric"], ["ano", "numeric"]]) },
      Referencias: { rows: references, types: { IdModeloAudatex: "nchar(10)", IdModelo: "nvarchar(254)", IdSeccion: "nvarchar(254)", ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`Dato${index + 1}`, index >= 16 ? "nvarchar(max)" : "nvarchar(254)"])), DatoFecha: "date", DatoFecha1: "date", DescripcionTotal: "nvarchar(max)" } },
      ...(previousComparison ? (() => { const rows = cleanAccionaComparisonReferences([...toAccionaComparisonReferences(previousComparison.previous.filter((row) => activeComparisonRow(row)), axCode, model, pr05.records), ...toAccionaComparisonReferences(previousComparison.current.filter((row) => row.Compare === 0 && row.TypeCompare), axCode, model, pr05.records)], references); return { ComparaPrevioReferencias: { rows, types: referenceTypes }, ComparaPrevioDesSecciones: { rows: cleanAccionaComparisonSections(toAccionaComparisonSections([...previousComparison.previous.filter((row) => row.TypeCompare), ...previousComparison.current.filter((row) => row.TypeCompare)], axCode, model, epc, `${imagesRoot}\\${manufacturer}\\${epc}\\${model}`, accionaConfig.performedFlag), rows), types: sectionTypes } }; })() : {}),
      ...(referenceComparison ? (() => { const rows = cleanAccionaComparisonReferences([...toAccionaComparisonReferences(referenceComparison.previous.filter((row) => activeComparisonRow(row)), axCode, model, pr05.records), ...toAccionaComparisonReferences(referenceComparison.current.filter((row) => row.Compare === 0 && row.TypeCompare), axCode, model, pr05.records)], references); return { ComparaReferencias: { rows, types: referenceTypes }, ComparaDesSecciones: { rows: cleanAccionaComparisonSections(toAccionaComparisonSections([...referenceComparison.previous.filter((row) => row.TypeCompare), ...referenceComparison.current.filter((row) => row.TypeCompare)], axCode, model, epc, `${imagesRoot}\\${manufacturer}\\${epc}\\${model}`, accionaConfig.performedFlag), rows), types: sectionTypes } }; })() : {}),
    }).filter(([table]) => requested.has(table))) as any,
  };
  if (options.useCache !== false) await writeCachedDataset(cacheRoot, dataset);
  return dataset;
}

async function writeCachedDataset(cacheRoot: string, dataset: any): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  const types = Object.fromEntries(Object.entries(dataset.tables).map(([table, data]: [string, any]) => [table, data.types]));
  await writeFile(join(cacheRoot, "meta.json"), JSON.stringify({ dataset: { axCode: dataset.axCode, model: dataset.model, manufacturer: dataset.manufacturer, epc: dataset.epc }, types }));
  await Promise.all(Object.entries(dataset.tables).map(([table, data]: [string, any]) => writeFile(join(cacheRoot, `${table}.json`), JSON.stringify(data.rows))));
}

async function readCachedDataset(cacheRoot: string, requested: Set<string>): Promise<any | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(cacheRoot, "meta.json"), "utf8"));
    const tables: Record<string, any> = {};
    for (const table of requested) tables[table] = { rows: JSON.parse(await readFile(join(cacheRoot, `${table}.json`), "utf8")), types: meta.types[table] };
    return { ...meta.dataset, tables };
  } catch { return undefined; }
}

const activeComparisonRow = (row: AnyRow) => row.Compare !== 1 && row.TypeCompare;

async function buildComparisonCatalog(requestId: string): Promise<{ records: Record<string, unknown>[]; images: ImageHashes }> {
  const root = await getState(requestId);
  if (!root?.children?.REF04 || !root.children.REF02 || !root.children.REF03 || !root.children.REF05) throw new Error(`Comparison request ${requestId} is incomplete`);
  const [ref04, ref05, ref02, ref03] = await Promise.all([read(root.children.REF04.requestId), read(root.children.REF05.requestId), read(root.children.REF02.requestId), read(root.children.REF03.requestId)]);
  const results = await Promise.all(Object.keys(root.children).filter((key) => key.startsWith("PR08_")).map((key) => read(root.children![key].requestId)));
  const imageResults = await Promise.all(Object.keys(root.children).filter((key) => key.startsWith("PR03_")).map((key) => read(root.children![key].requestId)));
  const images = Object.fromEntries(imageResults.flatMap((result) => (result as any).images ?? []).map((image: any) => [String(image.name).split(/[\\/]/).pop(), String(image.md5)]));
  const plates = results.flatMap((result) => result.records);
  return { records: preprocessRenaultCatalog(plates, ref02.records, selectPowertrain(ref05.records, ref04.records) as Record<string, unknown>[], ref04.records, ref03.records[0]) as Record<string, unknown>[], images };
}

async function buildImageHashes(children: Record<string, { requestId: string }>): Promise<ImageHashes> {
  const results = await Promise.all(Object.keys(children).filter((key) => key.startsWith("PR03_")).map((key) => read(children[key].requestId)));
  return Object.fromEntries(results.flatMap((result) => (result as any).images ?? []).map((image: any) => [String(image.name).split(/[\\/]/).pop(), String(image.md5)]));
}

if (import.meta.main) {
  const requestId = process.argv[2];
  if (!requestId) throw new Error("Usage: bun src/acciona/load-model.ts <requestId>");
  buildAccionaDataset(requestId).then((dataset) => loadAccionaDataset(dataset, { confirmProduction: process.env.ACCIONA_CONFIRM_PRODUCTION === "true", tables: process.env.ACCIONA_TABLES?.split(",").map((value) => value.trim()).filter(Boolean) })).then((result) => { console.log(result); process.exit(0); }).catch((error) => { console.error(error.message); process.exit(1); });
}
