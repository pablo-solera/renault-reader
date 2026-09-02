import sql from "mssql";
import { getAccionaConfig, openAccionaPool } from "../db/acciona.js";
import { insertJsonRows } from "./bulk.js";
import { assertAllowedDatabase, withTransaction } from "./writers.js";

export type AccionaDataset = {
  axCode: string;
  model: string;
  tables: Record<string, { rows: Record<string, unknown>[]; types: Record<string, string> }>;
};

export type AccionaLoadOptions = { targetDatabase?: string; confirmProduction?: boolean; dryRun?: boolean };

async function cleanupTable(transaction: sql.Transaction, table: string, dataset: AccionaDataset, data: AccionaDataset["tables"][string]): Promise<void> {
  const request = new sql.Request(transaction);
  if (table === "Referencias") return void await request.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.Referencias WHERE IdModeloAudatex=@ax AND IdModelo=@model");
  if (table === "DesSecciones") return void await request.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.DesSecciones WHERE idAudatex=@ax AND Modelo=@model");
  if (table === "filtrosecciones") return void await request.input("model", dataset.model).query("DELETE FROM dbo.filtrosecciones WHERE Modelo=@model");
  if (table === "Descripciones") return void await request.input("manufacturer", String(data.rows[0]?.Fabricante ?? "")).input("prefix", `A_${dataset.model}_%`).query("DELETE FROM dbo.Descripciones WHERE Fabricante=@manufacturer AND Num LIKE @prefix");
  if (table === "Sustituciones") return void await request.input("model", dataset.model).query("DELETE FROM dbo.Sustituciones WHERE Modelo=@model");
  if (table === "Audatex_TOYOTA") return void await request.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.Audatex_TOYOTA WHERE IdAudatex=@ax OR IdToyota=@model");
  const key = table === "CriteriaLabels" ? "HTC" : table === "PartsData" ? "partNumber" : undefined;
  if (key) {
    const values = [...new Set(data.rows.map((row) => String(row[key] ?? ""))).values()].filter(Boolean);
    if (values.length) await request.input("keys", sql.NVarChar(sql.MAX), JSON.stringify(values)).query(`DELETE FROM dbo.[${table}] WHERE [${key}] IN (SELECT value FROM OPENJSON(@keys))`);
    return;
  }
  throw new Error(`No model-scoped cleanup defined for ${table}`);
}

export async function loadAccionaDataset(dataset: AccionaDataset, options: AccionaLoadOptions = {}): Promise<Record<string, number>> {
  const config = getAccionaConfig();
  const targetDatabase = options.targetDatabase ?? config.targetDatabase;
  assertAllowedDatabase(targetDatabase, config.allowedDatabases, options.confirmProduction);
  const pool = await openAccionaPool(config, targetDatabase);
  if (options.dryRun) {
    await pool.close();
    return Object.fromEntries(Object.entries(dataset.tables).map(([table, data]) => [table, data.rows.length]));
  }
  try {
    const result: Record<string, number> = {};
    for (const [table, data] of Object.entries(dataset.tables)) {
      result[table] = await withTransaction(pool, async (transaction) => {
        await cleanupTable(transaction, table, dataset, data);
        const inserted = await insertJsonRows(transaction, table, Object.keys(data.types), data.types, data.rows);
        if (table === "CriteriaLabels") {
          await new sql.Request(transaction).query("WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY HTC, labels, lang ORDER BY insertDate DESC, Hash DESC) AS rn FROM dbo.CriteriaLabels) UPDATE ranked SET active = CASE WHEN rn = 1 THEN 1 ELSE 0 END");
        }
        return inserted;
      });
    }
    return result;
  } finally {
    await pool.close();
  }
}

if (import.meta.main) {
  throw new Error("The Acciona loader is a library entry point; provide a dataset through loadAccionaDataset");
}
