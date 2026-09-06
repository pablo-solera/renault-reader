import sql from "mssql";

type Executor = sql.ConnectionPool | sql.Transaction;
type Row = Record<string, unknown>;

function request(executor: Executor): sql.Request {
  return "begin" in executor ? new sql.Request(executor as sql.Transaction) : new sql.Request(executor as sql.ConnectionPool);
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
    const result = await request(executor).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(batch)).query(`MERGE dbo.[${table}] AS target USING (SELECT ${columns.map((column) => `j.[${column}]`).join(", ")} FROM OPENJSON(@rows) WITH (${schema}) AS j) AS source ON ${match} WHEN MATCHED THEN UPDATE SET ${updates} WHEN NOT MATCHED THEN INSERT (${names}) VALUES (${source}); SELECT @@ROWCOUNT AS affected`);
    affected += Number(result.recordset[0]?.affected ?? 0);
  }
  return affected;
}

async function insertJsonBatch(executor: Executor, table: string, columns: string[], types: Record<string, string>, rows: Row[]): Promise<number> {
  const select = columns.map((column) => `j.[${column}]`).join(", ");
  const names = columns.map((column) => `[${column}]`).join(", ");
  // OPENJSON emits NUL-padded values for nchar; convert after parsing so SQL Server pads with spaces.
  const schema = columns.map((column) => `[${column}] ${(types[column] ?? "nvarchar(max)").replace(/\bnchar\b/gi, "nvarchar")}`).join(", ");
  const result = await request(executor).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`INSERT INTO dbo.[${table}] (${names}) SELECT ${select} FROM OPENJSON(@rows) WITH (${schema}) AS j; SELECT @@ROWCOUNT AS inserted`);
  return Number(result.recordset[0]?.inserted ?? 0);
}
