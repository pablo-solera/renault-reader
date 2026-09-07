import sql from "mssql";

type Executor = sql.ConnectionPool | sql.Transaction;
type Row = Record<string, unknown>;

function request(executor: Executor): sql.Request {
  return "begin" in executor ? new sql.Request(executor as sql.Transaction) : new sql.Request(executor as sql.ConnectionPool);
}

function bulkType(type: string): any {
  const normalized = type.toLowerCase();
  const nchar = normalized.match(/nchar\((\d+)\)/);
  const nvarchar = normalized.match(/nvarchar\((\d+|max)\)/);
  if (normalized === "int") return sql.Int;
  if (normalized === "bit") return sql.Bit;
  if (normalized === "date") return sql.Date;
  if (normalized.startsWith("datetime")) return sql.DateTime2;
  if (normalized.startsWith("numeric")) return sql.Numeric(18, 4);
  if (nchar) return sql.NVarChar(Number(nchar[1]));
  if (nvarchar) return nvarchar[1] === "max" ? sql.NVarChar(sql.MAX) : sql.NVarChar(Number(nvarchar[1]));
  return sql.NVarChar(sql.MAX);
}

function bulkValue(value: unknown, type: string): any {
  if (value == null) return null;
  const normalized = type.toLowerCase();
  if (normalized.includes("char") || normalized.includes("text")) return typeof value === "string" ? value : JSON.stringify(value);
  if (normalized === "bit") return Boolean(value);
  if (normalized === "date" || normalized.startsWith("datetime")) return value instanceof Date ? value : new Date(String(value));
  if (normalized.startsWith("numeric") || normalized === "int") return Number(value);
  return value;
}

export async function bulkInsertRows(executor: Executor, table: string, columns: string[], types: Record<string, string>, rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  const batchSize = 2000;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const bulk = new sql.Table(`dbo.${table}`);
    bulk.create = false;
    for (const column of columns) bulk.columns.add(column, bulkType(types[column] ?? "nvarchar(max)"), { nullable: true });
    for (const row of batch) bulk.rows.add(...columns.map((column) => bulkValue(row[column], types[column] ?? "nvarchar(max)")));
    await request(executor).bulk(bulk);
    inserted += batch.length;
  }
  return inserted;
}

export async function insertJsonRows(executor: Executor, table: string, columns: string[], types: Record<string, string>, rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  const batchSize = 2000;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    inserted += await insertJsonBatch(executor, table, columns, types, batch);
  }
  return inserted;
}

export async function mergeJsonRows(executor: Executor, table: string, columns: string[], types: Record<string, string>, keys: string[], rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  const schema = columns.map((column) => `[${column}] ${(types[column] ?? "nvarchar(max)").replace(/\bnchar\b/gi, "nvarchar")}`).join(", ");
  const names = columns.map((column) => `[${column}]`).join(", ");
  const source = columns.map((column) => `source.[${column}]`).join(", ");
  const match = keys.map((column) => `target.[${column}] = source.[${column}]`).join(" AND ");
  const updates = columns.filter((column) => !keys.includes(column)).map((column) => `target.[${column}] = source.[${column}]`).join(", ");
  let affected = 0;
  for (let offset = 0; offset < rows.length; offset += 2000) {
    const batch = rows.slice(offset, offset + 2000);
    const selectJson = columns.map((column) => `JSON_VALUE(raw.[value], '$.${column}')`).join(", ");
    const result = await request(executor).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(batch)).query(`DECLARE @source TABLE (${schema}); INSERT INTO @source (${names}) SELECT ${selectJson} FROM OPENJSON(@rows) AS raw; UPDATE target SET ${updates} FROM dbo.[${table}] AS target INNER JOIN @source AS source ON ${match}; INSERT INTO dbo.[${table}] (${names}) SELECT ${source} FROM @source AS source WHERE NOT EXISTS (SELECT 1 FROM dbo.[${table}] AS target WHERE ${match}); SELECT @@ROWCOUNT AS affected`);
    affected += Number(result.recordset[0]?.affected ?? 0);
  }
  return affected;
}

async function insertJsonBatch(executor: Executor, table: string, columns: string[], types: Record<string, string>, rows: Row[]): Promise<number> {
  const select = columns.map((column) => `j.[${column}]`).join(", ");
  const names = columns.map((column) => `[${column}]`).join(", ");
  // OPENJSON emits NUL-padded values for nchar; convert after parsing so SQL Server pads with spaces.
  const schema = columns.map((column) => `[${column}] ${(types[column] ?? "nvarchar(max)").replace(/\bnchar\b/gi, "nvarchar")}`).join(", ");
  const selectJson = columns.map((column) => `JSON_VALUE(raw.[value], '$.${column}')`).join(", ");
  const result = await request(executor).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`INSERT INTO dbo.[${table}] (${names}) SELECT ${selectJson} FROM OPENJSON(@rows) AS raw; SELECT @@ROWCOUNT AS inserted`);
  return Number(result.recordset[0]?.inserted ?? 0);
}
