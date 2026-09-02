import sql from "mssql";
import { getAccionaConfig, openAccionaPool } from "../db/acciona.js";
import { readFile } from "node:fs/promises";

const config = getAccionaConfig();
const model = process.argv[2];
if (!model) throw new Error("Usage: bun src/acciona/verify-images.ts <model>");
const pool = await openAccionaPool(config, config.targetDatabase);
try {
  const result = await pool.request().input("model", model).query("SELECT RutaFoto FROM dbo.DesSecciones WHERE Modelo=@model");
  let missing = 0;
  for (const row of result.recordset) {
    try { await readFile(String(row.RutaFoto)); }
    catch { missing++; }
  }
  console.log(JSON.stringify({ model, total: result.recordset.length, existing: result.recordset.length - missing, missing }));
  process.exitCode = missing ? 1 : 0;
} finally {
  await pool.close();
}
