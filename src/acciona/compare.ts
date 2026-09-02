import sql from "mssql";
import { getAccionaConfig, openAccionaPool, sqlConfig } from "../db/acciona.js";
import { createHash } from "node:crypto";

export type ComparableReference = Record<string, unknown>;
export type ReferenceComparison = { added: ComparableReference[]; deleted: ComparableReference[]; changed: Array<{ key: string; before: ComparableReference; after: ComparableReference }> };

const keyOf = (row: ComparableReference) => [row.Dato12, row.Dato1, row.Dato8, row.Dato9].map((value) => String(value ?? "").trim()).join("|");
const fingerprint = (row: ComparableReference) => createHash("sha1").update(JSON.stringify(row)).digest("hex");

export function compareReferences(current: ComparableReference[], previous: ComparableReference[]): ReferenceComparison {
  const currentByKey = new Map(current.map((row) => [keyOf(row), row]));
  const previousByKey = new Map(previous.map((row) => [keyOf(row), row]));
  const added = current.filter((row) => !previousByKey.has(keyOf(row)));
  const deleted = previous.filter((row) => !currentByKey.has(keyOf(row)));
  const changed = current.flatMap((row) => {
    const key = keyOf(row);
    const before = previousByKey.get(key);
    return before && fingerprint(before) !== fingerprint(row) ? [{ key, before, after: row }] : [];
  });
  return { added, deleted, changed };
}

const referenceColumns = ["IdModeloAudatex", "IdModelo", "IdSeccion", ...Array.from({ length: 31 }, (_, index) => `Dato${index + 1}`), "DatoFecha", "DatoFecha1", "DescripcionTotal"];
const selectReferences = `SELECT ${referenceColumns.map((column) => `[${column}]`).join(", ")} FROM dbo.Referencias WHERE IdModeloAudatex=@ax AND IdModelo=@model`;

async function readReferences(pool: sql.ConnectionPool, axCode: string, model: string): Promise<ComparableReference[]> {
  const result = await pool.request().input("ax", axCode).input("model", model).query(selectReferences);
  return result.recordset as ComparableReference[];
}

export async function compareSandboxWithDatabase(axCode: string, model: string, referenceDatabase: string): Promise<ReferenceComparison> {
  const config = getAccionaConfig();
  const sandbox = await openAccionaPool(config, config.targetDatabase);
  const historical = await new sql.ConnectionPool(sqlConfig(config, referenceDatabase)).connect();
  try {
    return compareReferences(await readReferences(sandbox, axCode, model), await readReferences(historical, axCode, model));
  } finally {
    await Promise.all([sandbox.close(), historical.close()]);
  }
}
