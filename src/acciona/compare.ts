import sql from "mssql";
import { getAccionaConfig, openAccionaPool, sqlConfig } from "../db/acciona.js";
import { createHash } from "node:crypto";

export type ComparableReference = Record<string, unknown>;
export type ReferenceComparison = { added: ComparableReference[]; deleted: ComparableReference[]; changed: Array<{ key: string; before: ComparableReference; after: ComparableReference }> };

const keyOf = (row: ComparableReference) => [row.Dato12, row.Dato1, row.Dato8, row.Dato9].map((value) => String(value ?? "").trim()).join("|");
export function normalizeComparisonValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function normalizedFingerprint(row: ComparableReference, ignoredFields = ["DatoFecha", "DatoFecha1"]): string {
  const normalized = Object.fromEntries(Object.entries(row).filter(([key]) => !ignoredFields.includes(key)).map(([key, value]) => [key, normalizeComparisonValue(value)]));
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
}

const fingerprint = (row: ComparableReference) => normalizedFingerprint(row);
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

export type TableComparison = ReferenceComparison & { table: string; keyFields: string[] };

export function compareTableRows(table: string, current: ComparableReference[], previous: ComparableReference[], keyFields: string[], ignoredFields: string[] = []): TableComparison {
  const key = (row: ComparableReference) => keyFields.map((field) => normalizeComparisonValue(row[field])).join("|");
  const currentByKey = groupBy(current, key);
  const previousByKey = groupBy(previous, key);
  const added: ComparableReference[] = [];
  const deleted: ComparableReference[] = [];
  const changed: TableComparison["changed"] = [];
  for (const rowKey of new Set([...currentByKey.keys(), ...previousByKey.keys()])) {
    const now = [...(currentByKey.get(rowKey) ?? [])];
    const old = [...(previousByKey.get(rowKey) ?? [])];
    for (const row of now) {
      const matchIndex = old.findIndex((candidate) => normalizedFingerprint(candidate, ignoredFields).toString() === normalizedFingerprint(row, ignoredFields).toString());
      if (matchIndex >= 0) old.splice(matchIndex, 1);
      else {
        const before = old.shift();
        if (before) changed.push({ key: rowKey, before, after: row });
        else added.push(row);
      }
    }
    deleted.push(...old);
  }
  return { table, keyFields, added, deleted, changed };
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
