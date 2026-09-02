import sql from "mssql";
import { getAccionaConfig, openAccionaPool } from "../db/acciona.js";
import { insertJsonRows } from "./bulk.js";
import { assertSandboxDatabase, withSandboxTransaction } from "./writers.js";

export type AccionaDataset = {
  axCode: string;
  model: string;
  tables: Record<string, { rows: Record<string, unknown>[]; types: Record<string, string> }>;
};

export async function loadAccionaDataset(dataset: AccionaDataset): Promise<Record<string, number>> {
  const config = getAccionaConfig();
  assertSandboxDatabase(config.targetDatabase);
  const pool = await openAccionaPool(config, config.targetDatabase);
  try {
    const result: Record<string, number> = {};
    for (const [table, data] of Object.entries(dataset.tables)) {
      result[table] = await withSandboxTransaction(pool, async (transaction) => {
        const cleanup = new sql.Request(transaction);
        if (table === "Referencias") {
          await cleanup.input("ax", dataset.axCode).input("model", dataset.model).query("DELETE FROM dbo.Referencias WHERE IdModeloAudatex=@ax AND IdModelo=@model");
        } else {
          await cleanup.query(`DELETE FROM dbo.[${table}]`);
        }
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
