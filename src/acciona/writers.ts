import sql from "mssql";

type Executor = sql.ConnectionPool | sql.Transaction;
type Row = Record<string, unknown>;

const value = (row: Row, ...names: string[]): unknown => {
  for (const name of names) if (row[name] !== undefined) return row[name];
  return null;
};

function request(executor: Executor, columns: string[], row: Row): sql.Request {
  const result = "begin" in executor ? new sql.Request(executor as sql.Transaction) : new sql.Request(executor as sql.ConnectionPool);
  for (const column of columns) result.input(column, value(row, column, column.toLowerCase(), column.toUpperCase()));
  return result;
}

async function insertRows(executor: Executor, table: string, columns: string[], rows: Row[]): Promise<number> {
  for (const row of rows) {
    const names = columns.map((column) => `[${column}]`).join(", ");
    const parameters = columns.map((column) => `@${column}`).join(", ");
    await request(executor, columns, row).query(`INSERT INTO dbo.[${table}] (${names}) VALUES (${parameters})`);
  }
  return rows.length;
}

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

export function assertSandboxDatabase(database: string): void {
  if (database !== "_MOK_MOK") throw new Error(`Acciona writes are restricted to _MOK_MOK, received ${database}`);
}

export async function writeAudatexToyota(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.audatexToyota, ["IdAudatex", "IdToyota", "CodPais", "Descripcion", "EPC", "Fabricante", "Activo", "AccesoMex", "mes", "ano"], rows);
}

export async function writeDesSecciones(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.desSecciones, ["CD", "idAudatex", "Modelo", "Seccion", "Descripcion", "Realizada", "Audatex", "DesOriginal", "DesSeccion", "DesSeccion1", "Filtrado", "SeccionOriginal", "RutaFoto", "ColorFondo", "Estado"], rows);
}

export async function writeFiltroSecciones(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.filtrosecciones, ["Modelo", "Seccion", "Ordinal"], rows);
}

export async function writeDescripciones(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.descripciones, ["Fabricante", "Num", "Idioma", "Descripcion"], rows);
}

export async function writeSustituciones(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.sustituciones, ["partNoReferencia", "Aplicabilidad", "Quantity", "RefTurca", "SuspartNoReferencia", "SusPartNoReferenciaDescripcion", "SusAplicabilidad", "SusQuantity", "SusRefTurca", "Modelo"], rows);
}

export async function writeReferencias(executor: Executor, rows: Row[]): Promise<number> {
  const columns = ["IdModeloAudatex", "IdModelo", "IdSeccion", "Dato1", "Dato2", "Dato3", "Dato4", "Dato5", "Dato6", "Dato7", "Dato8", "Dato9", "Dato10", "Dato11", "Dato12", "Dato13", "Dato14", "Dato15", "Dato16", "Dato17", "Dato18", "Dato19", "Dato20", "Dato21", "Dato22", "Dato23", "Dato24", "Dato25", "Dato26", "Dato27", "Dato28", "Dato29", "Dato30", "Dato31", "DatoFecha", "DatoFecha1", "DescripcionTotal"];
  return insertRows(executor, ACCIONA_TABLES.referencias, rows.some((row) => row.ID !== undefined) ? ["ID", ...columns] : columns, rows);
}

export async function writeCriteriaLabels(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.criteriaLabels, ["Hash", "HTC", "objectOriginCode", "labels", "subLabels", "lang", "description", "insertDate", "active"], rows);
}

export async function writePartsData(executor: Executor, rows: Row[]): Promise<number> {
  return insertRows(executor, ACCIONA_TABLES.partsData, ["Hash", "partNumber", "brandCode", "corporate", "familyCode", "productModelCode", "codifiedSigns", "types", "partsEquivalentRenault", "equivalentParts", "designation", "insertDate", "active"], rows);
}

export async function withSandboxTransaction<T>(pool: sql.ConnectionPool, callback: (transaction: sql.Transaction) => Promise<T>): Promise<T> {
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
