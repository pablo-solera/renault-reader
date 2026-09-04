import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getState } from "../jobs.js";
import { downloadBytes } from "../storage.js";
import { compareTableRows, type ComparableReference } from "./compare.js";
import { buildAccionaDataset } from "./load-model.js";
import { getAccionaConfig, openAccionaPool } from "../db/acciona.js";
import { sqlConfig } from "../db/acciona.js";
import sql from "mssql";

const requestId = process.argv[2];
const referenceDatabase = process.argv[3];
if (!requestId || !referenceDatabase) throw new Error("Usage: bun src/acciona/compare-edition.ts <requestId> <referenceDatabase>");

const tableConfig: Record<string, { key: string[]; ignored?: string[] }> = {
  Referencias: { key: ["Dato12", "Dato1", "Dato8", "Dato9"], ignored: ["ID", "DatoFecha", "DatoFecha1"] },
  DesSecciones: { key: ["Audatex"], ignored: ["CD", "Realizada", "RutaFoto"] },
  Descripciones: { key: ["Num"] },
  Sustituciones: { key: ["partNoReferencia", "SuspartNoReferencia"] },
  filtrosecciones: { key: ["Modelo", "Seccion"], ignored: ["Ordinal"] },
};

const config = getAccionaConfig();
const currentDataset = await buildAccionaDataset(requestId);
const historicalPool = await new sql.ConnectionPool(sqlConfig(config, referenceDatabase)).connect();

async function rows(pool: sql.ConnectionPool, table: string, filter: string, params: Array<[string, string]>) {
  const request = pool.request();
  for (const [name, value] of params) request.input(name, value);
  return (await request.query(`SELECT * FROM dbo.[${table}] WHERE ${filter}`)).recordset as ComparableReference[];
}

const input = currentDataset as typeof currentDataset & { tables: Record<string, { rows: ComparableReference[] }> };
const filters: Record<string, { sql: string; params: Array<[string, string]> }> = {
  Referencias: { sql: "IdModeloAudatex=@ax AND IdModelo=@model", params: [["ax", input.axCode], ["model", input.model]] },
  DesSecciones: { sql: "idAudatex=@ax AND Modelo=@model", params: [["ax", input.axCode], ["model", input.model]] },
  Descripciones: { sql: "Fabricante=@manufacturer AND Num LIKE @prefix", params: [["manufacturer", input.manufacturer], ["prefix", `A_${input.model}_%`]] },
  Sustituciones: { sql: "Modelo=@model", params: [["model", input.model]] },
  filtrosecciones: { sql: "Modelo=@model", params: [["model", input.model]] },
};

const tables: Record<string, unknown> = {};
for (const [table, definition] of Object.entries(tableConfig)) {
  const current = (input.tables[table]?.rows ?? []) as ComparableReference[];
  const previous = await rows(historicalPool, table, filters[table].sql, filters[table].params);
  tables[table] = compareTableRows(table, current, previous, definition.key, definition.ignored ?? []);
}

const imageNames = async (root: string) => {
  const result = new Map<string, string>();
  const state = await getState(requestId);
  for (const [key, child] of Object.entries(state?.children ?? {}).filter(([key]) => key.startsWith("PR03_"))) {
    const childState = await getState(child.requestId);
    if (!childState?.structuredKey) continue;
    const parsed = JSON.parse(new TextDecoder().decode(await downloadBytes(childState.structuredKey)));
    for (const image of parsed.images ?? []) result.set(String(image.name).split(/[\\/]/).pop()!, String(image.md5));
  }
  return result;
};

const currentImages = await imageNames("current");
const previousImages = new Map<string, string>();
const prodRoot = `//axesd-sr-BL111.int.audatex.com/Imagenes/${input.manufacturer}/${process.argv[4] ?? "0626"}/${input.model}`;
try {
  const { readdirSync, readFileSync } = await import("node:fs");
  for (const name of readdirSync(prodRoot).filter((name) => /\.svg$/i.test(name))) previousImages.set(name, createHash("md5").update(readFileSync(`${prodRoot}/${name}`)).digest("hex"));
} catch {}
const currentOnly = [...currentImages.keys()].filter((name) => !previousImages.has(name));
const previousOnly = [...previousImages.keys()].filter((name) => !currentImages.has(name));
const commonChanged = [...currentImages.keys()].filter((name) => previousImages.has(name) && currentImages.get(name) !== previousImages.get(name));
tables.images = { added: currentOnly, deleted: previousOnly, changed: commonChanged, current: currentImages.size, previous: previousImages.size };

await mkdir("compare-out", { recursive: true });
const output = { requestId, referenceDatabase, referenceEpc: process.argv[4] ?? "0626", generatedAt: new Date().toISOString(), normalized: true, tables };
await writeFile(`compare-out/${input.axCode}_${input.model}_edition.json`, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ requestId, referenceDatabase, tables: Object.fromEntries(Object.entries(tables).map(([name, value]: [string, any]) => [name, value.changed ? { added: value.added.length, deleted: value.deleted.length, changed: value.changed.length } : value])) }));
await historicalPool.close();
process.exit(0);
