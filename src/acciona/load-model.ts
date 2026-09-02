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
  toAccionaSustituciones,
} from "./transform.js";
import { loadAccionaDataset } from "./load.js";

const requestId = "4aa5bf62-acfc-4571-8938-9454dfaaf2ed";
const read = async (id: string) => {
  const state = await getState(id);
  if (!state?.structuredKey) throw new Error(`Missing structured output for ${id}`);
  return JSON.parse(new TextDecoder().decode(await downloadBytes(state.structuredKey))) as { records: Record<string, unknown>[] };
};
const types = (entries: Array<[string, string]>) => Object.fromEntries(entries);

export async function buildSandboxDataset() {
  const root = await getState(requestId);
  if (!root?.children) throw new Error(`Request ${requestId} not found`);
  const children = root.children;
  const [ref04, ref05, ref02, ref03, pr05, pr06] = await Promise.all([
    read(children.REF04.requestId), read(children.REF05.requestId), read(children.REF02.requestId),
    read(children.REF03.requestId), read(children.PR05.requestId), read(children.PR06.requestId),
  ]);
  const plates = (await Promise.all(Object.keys(children).filter((key) => key.startsWith("PR08_")).map((key) => read(children[key].requestId)))).flatMap((result) => result.records);
  const models = ref04.records;
  const processed = preprocessRenaultCatalog(plates, ref02.records, selectPowertrain(ref05.records, models) as Record<string, unknown>[], models, ref03.records[0]);
  const sections = toAccionaDesSecciones(processed, "5208", "X1310", "0826", "./sandbox-images/DACIA/0826/X1310");
  const references = toAccionaReferences(processed, "5208", "X1310").map((row, index) => ({ ...row, ID: 14441 + index }));
  const descriptionMap = new Map(pr06.records.map((row) => [`A_X1310_${row.partNumber}`, String(row.designation ?? "")]));
  return {
    axCode: "5208", model: "X1310",
    tables: {
      DesSecciones: { rows: sections, types: types([["CD", "nchar(10)"], ["idAudatex", "nchar(4)"], ["Modelo", "nvarchar(50)"], ["Seccion", "nchar(50)"], ["Descripcion", "nvarchar(max)"], ["Realizada", "nchar(1)"], ["Audatex", "nchar(50)"], ["DesOriginal", "nvarchar(max)"], ["DesSeccion", "nvarchar(max)"], ["DesSeccion1", "nvarchar(max)"], ["Filtrado", "nvarchar(max)"], ["SeccionOriginal", "nchar(50)"], ["RutaFoto", "nvarchar(max)"], ["ColorFondo", "nchar(12)"], ["Estado", "nchar(1)"]]) },
      filtrosecciones: { rows: toAccionaFiltroSecciones(sections, "X1310"), types: types([["Modelo", "nvarchar(50)"], ["Seccion", "nvarchar(max)"], ["Ordinal", "int"]]) },
      Descripciones: { rows: toAccionaDescriptions(processed, "DACIA", "X1310"), types: types([["Fabricante", "nvarchar(50)"], ["Num", "nvarchar(50)"], ["Idioma", "numeric"], ["Descripcion", "nvarchar(max)"]]) },
      Sustituciones: { rows: toAccionaSustituciones(processed, pr05.records, "X1310", descriptionMap), types: types([["partNoReferencia", "nvarchar(50)"], ["Aplicabilidad", "nvarchar(max)"], ["Quantity", "numeric"], ["RefTurca", "nvarchar(50)"], ["SuspartNoReferencia", "nvarchar(254)"], ["SusPartNoReferenciaDescripcion", "nchar(255)"], ["SusAplicabilidad", "nvarchar(max)"], ["SusQuantity", "nchar(2)"], ["SusRefTurca", "nvarchar(254)"], ["Modelo", "nvarchar(10)"]]) },
      CriteriaLabels: { rows: flattenCriteriaLabels(ref02.records), types: types([["Hash", "nchar(28)"], ["HTC", "nvarchar(10)"], ["objectOriginCode", "nvarchar(10)"], ["labels", "nvarchar(10)"], ["subLabels", "nvarchar(10)"], ["lang", "nvarchar(5)"], ["description", "nvarchar(255)"], ["insertDate", "datetime2"], ["active", "bit"]]) },
      PartsData: { rows: toAccionaPartsData(pr06.records), types: types([["Hash", "nchar(28)"], ["partNumber", "nchar(20)"], ["brandCode", "nchar(2)"], ["corporate", "nchar(10)"], ["familyCode", "nchar(10)"], ["productModelCode", "nchar(10)"], ["codifiedSigns", "nchar(255)"], ["types", "nchar(50)"], ["partsEquivalentRenault", "nchar(1000)"], ["equivalentParts", "nvarchar(max)"], ["designation", "nchar(255)"], ["insertDate", "datetime2"], ["active", "bit"]]) },
      Audatex_TOYOTA: { rows: [{ IdAudatex: "5208", IdToyota: "X1310", CodPais: "GEN", Descripcion: "Bigster (SVA)", EPC: "0826", Fabricante: "DACIA", Activo: "0", AccesoMex: null, mes: 8, ano: 2026 }], types: types([["IdAudatex", "nchar(50)"], ["IdToyota", "nchar(50)"], ["CodPais", "nchar(20)"], ["Descripcion", "nvarchar(70)"], ["EPC", "nchar(10)"], ["Fabricante", "varchar(50)"], ["Activo", "nchar(1)"], ["AccesoMex", "nchar(1)"], ["mes", "numeric"], ["ano", "numeric"]]) },
      Referencias: { rows: references, types: { ID: "int", IdModeloAudatex: "nchar(10)", IdModelo: "nvarchar(254)", IdSeccion: "nvarchar(254)", ...Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`Dato${index + 1}`, index >= 16 ? "nvarchar(max)" : "nvarchar(254)"])), DatoFecha: "date", DatoFecha1: "date", DescripcionTotal: "nvarchar(max)" } },
    },
  };
}

if (import.meta.main) {
  buildSandboxDataset().then(loadAccionaDataset).then((result) => { console.log(result); process.exit(0); }).catch((error) => { console.error(error.message); process.exit(1); });
}
