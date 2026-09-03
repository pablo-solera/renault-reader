import sql from "mssql";

type Executor = sql.ConnectionPool | sql.Transaction;
export const ACCIONA_TABLES = {
  audatexToyota: "Audatex_TOYOTA",
  desSecciones: "DesSecciones",
  filtrosecciones: "filtrosecciones",
  descripciones: "Descripciones",
  sustituciones: "Sustituciones",
  referencias: "Referencias",
  criteriaLabels: "CriteriaLabels",
  partsData: "PartsData",
} as const;

export function assertAllowedDatabase(database: string, allowedDatabases: string[], confirmed = false, readOnly = false): void {
  if (!allowedDatabases.includes(database)) throw new Error(`Acciona database is not allowlisted: ${database}`);
  if (database !== "_MOK_MOK" && !confirmed && !readOnly) throw new Error("Production Acciona writes require explicit confirmation");
}

export async function withTransaction<T>(pool: sql.ConnectionPool, callback: (transaction: sql.Transaction) => Promise<T>): Promise<T> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await callback(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
