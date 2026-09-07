import sql from "mssql";
import { getAccionaConfig, openAccionaPool } from "../db/acciona.js";
import { insertJsonRows, mergeJsonRows } from "./bulk.js";
import { assertAllowedDatabase, withTransaction } from "./writers.js";

export type AccionaDataset = {
  axCode: string;
  model: string;
  manufacturer: string;
  epc: string;
  tables: Record<string, { rows: Record<string, unknown>[]; types: Record<string, string> }>;
};

export type AccionaLoadOptions = { targetDatabase?: string; confirmProduction?: boolean; dryRun?: boolean; tables?: string[] };

async function cleanupTable(transaction: sql.Transaction, table: string, dataset: AccionaDataset, data: AccionaDataset["tables"][string]): Promise<void> {
  const request = new sql.Request(transaction);
  if (table === "Referencias") return void await request.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.Referencias WHERE IdModeloAudatex=@ax AND IdModelo=@model");
  if (table === "DesSecciones") return void await request.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.DesSecciones WHERE idAudatex=@ax AND Modelo=@model");
  if (table === "filtrosecciones") return void await request.input("model", dataset.model).query("DELETE FROM dbo.filtrosecciones WHERE Modelo=@model");
  if (table === "Descripciones") return void await request.input("manufacturer", String(data.rows[0]?.Fabricante ?? "")).input("prefix", `A_${dataset.model}_%`).query("DELETE FROM dbo.Descripciones WHERE Fabricante=@manufacturer AND Num LIKE @prefix");
  if (table === "Sustituciones") return void await request.input("model", dataset.model).query("DELETE FROM dbo.Sustituciones WHERE Modelo=@model");
  if (["ComparaPrevioReferencias", "ComparaReferencias"].includes(table)) return void await request.input("ax", dataset.axCode).input("model", dataset.model).query(`DELETE FROM dbo.[${table}] WHERE IdModeloAudatex=@ax AND IdModelo=@model`);
  if (["ComparaPrevioDesSecciones", "ComparaDesSecciones"].includes(table)) return void await request.input("ax", dataset.axCode).input("model", dataset.model).query(`DELETE FROM dbo.[${table}] WHERE idAudatex=@ax AND Modelo=@model`);
  if (table === "Audatex_TOYOTA") return void await request.input("ax", dataset.axCode).input("epc", dataset.epc).query("DELETE FROM dbo.Audatex_TOYOTA WHERE IdAudatex=@ax AND EPC=@epc");
  if (table === "CriteriaLabels" || table === "PartsData") return;
  throw new Error(`No model-scoped cleanup defined for ${table}`);
}


export async function loadAccionaDataset(dataset: AccionaDataset, options: AccionaLoadOptions = {}): Promise<Record<string, number>> {
  const config = getAccionaConfig();
  const targetDatabase = options.targetDatabase ?? config.targetDatabase;
  assertAllowedDatabase(targetDatabase, config.allowedDatabases, options.confirmProduction, options.dryRun);
  const selectedTables = options.tables ? new Set(options.tables) : new Set(Object.keys(dataset.tables));
  const extractionTables = new Set(["DesSecciones", "filtrosecciones", "Descripciones", "Sustituciones", "Referencias", "ComparaPrevioReferencias", "ComparaReferencias", "ComparaPrevioDesSecciones", "ComparaDesSecciones"]);
  const globalTables = new Set(["CriteriaLabels", "PartsData"]);
  const destinations = new Map<string, string[]>();
  for (const table of Object.keys(dataset.tables).filter((name) => selectedTables.has(name))) {
    const database = extractionTables.has(table) ? targetDatabase : globalTables.has(table) ? config.globalDatabase : config.toyotaConfigDatabase;
    destinations.set(database, [...(destinations.get(database) ?? []), table]);
  }
  for (const database of destinations.keys()) assertAllowedDatabase(database, config.allowedDatabases, options.confirmProduction, options.dryRun);
  if (options.dryRun) {
    return Object.fromEntries(Object.entries(dataset.tables).filter(([table]) => selectedTables.has(table)).map(([table, data]) => [table, data.rows.length]));
  }
  const pools = await Promise.all([...destinations.keys()].map(async (database) => [database, await openAccionaPool(config, database)] as const));
  try {
    const result: Record<string, number> = {};
    for (const [table, data] of Object.entries(dataset.tables).filter(([name]) => selectedTables.has(name))) {
      const database = extractionTables.has(table) ? targetDatabase : globalTables.has(table) ? config.globalDatabase : config.toyotaConfigDatabase;
      const pool = new Map(pools).get(database)!;
      result[table] = await withTransaction(pool, async (transaction) => {
        await cleanupTable(transaction, table, dataset, data);
        const columns = Object.keys(data.types);
        const globalKeys = ["CriteriaLabels", "PartsData"].includes(table) ? ["Hash"] : [];
        const inserted = globalKeys.length ? await mergeJsonRows(transaction, table, columns, data.types, globalKeys, data.rows) : await insertJsonRows(transaction, table, columns, data.types, data.rows);
        if (table === "CriteriaLabels") {
          const values = [...new Set(data.rows.map((row) => String(row.HTC ?? "")))].filter(Boolean);
          await new sql.Request(transaction).input("keys", sql.NVarChar(sql.MAX), JSON.stringify(values)).query(";WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY HTC, labels, lang ORDER BY insertDate DESC, Hash DESC) AS rn FROM dbo.CriteriaLabels WHERE HTC IN (SELECT value FROM OPENJSON(@keys))) UPDATE ranked SET active = CASE WHEN rn = 1 THEN 1 ELSE 0 END");
        }
        return inserted;
      });
    }
    return result;
  } finally {
    await Promise.all(pools.map(([, pool]) => pool.close()));
  }
}

if (import.meta.main) {
  throw new Error("The Acciona loader is a library entry point; provide a dataset through loadAccionaDataset");
}
