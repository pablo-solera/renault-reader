import sql from "mssql";
import { getAccionaConfig, openAccionaPool, sqlConfig } from "../db/acciona.js";
import { createHash } from "node:crypto";

export type ComparableReference = Record<string, unknown>;
export type ReferenceComparison = { added: ComparableReference[]; deleted: ComparableReference[]; changed: Array<{ key: string; before: ComparableReference; after: ComparableReference }> };

const keyOf = (row: ComparableReference) => [row.Dato12, row.Dato1, row.Dato8, row.Dato9].map((value) => String(value ?? "").trim()).join("|");
const fingerprint = (row: ComparableReference) => createHash("sha1").update(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !["DatoFecha", "DatoFecha1"].includes(key)))).replace(/\s+$/gm, "")).digest("hex");
const groupBy = <T>(rows: T[], key: (row: T) => string) => rows.reduce((groups, row) => groups.set(key(row), [...(groups.get(key(row)) ?? []), row]), new Map<string, T[]>());

export function compareReferences(current: ComparableReference[], previous: ComparableReference[]): ReferenceComparison {
  const currentByKey = groupBy(current, keyOf);
  const previousByKey = groupBy(previous, keyOf);
  const added: ComparableReference[] = [];
  const deleted: ComparableReference[] = [];
  const changed: ReferenceComparison["changed"] = [];
  for (const key of new Set([...currentByKey.keys(), ...previousByKey.keys()])) {
    const now = [...(currentByKey.get(key) ?? [])];
    const old = [...(previousByKey.get(key) ?? [])];
    for (const row of now) {
      const hash = fingerprint(row);
      const matchingIndex = old.findIndex((candidate) => fingerprint(candidate) === hash);
      if (matchingIndex >= 0) old.splice(matchingIndex, 1);
      else {
        const before = old.shift();
        if (before) changed.push({ key, before, after: row });
        else added.push(row);
      }
    }
    deleted.push(...old);
  }
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
