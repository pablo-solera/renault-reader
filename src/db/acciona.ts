import sql from "mssql";

export type AccionaConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  extractionDatabasePattern: string;
  toyotaConfigDatabase: string;
  globalDatabase: string;
  targetDatabase: string;
  allowedDatabases: string[];
  imagesRoot: string;
  criteriaLanguage: string;
  descriptionLanguageId: number;
  countryCode: string;
  activeFlag: string;
  performedFlag: string;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
};

export function getAccionaConfig(env: NodeJS.ProcessEnv = process.env): AccionaConfig {
  const read = (name: string) => env[name]?.trim();
  const port = Number(read("ACCIONA_SQL_PORT") ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ACCIONA_SQL_PORT must be a valid port");
  return {
    host: requiredFrom(env, "ACCIONA_SQL_HOST"),
    port,
    user: requiredFrom(env, "ACCIONA_SQL_USER"),
    password: requiredFrom(env, "ACCIONA_SQL_PASSWORD"),
    encrypt: read("ACCIONA_SQL_ENCRYPT") !== "false",
    trustServerCertificate: read("ACCIONA_SQL_TRUST_SERVER_CERTIFICATE") === "true",
    extractionDatabasePattern: read("ACCIONA_SQL_EXTRACTION_DB_PATTERN") ?? "Extraccion_{manufacturer}{epc}",
    toyotaConfigDatabase: read("ACCIONA_SQL_TOYOTA_CONFIG_DB") ?? "Extraccion_TOYOTA_Config",
    globalDatabase: read("ACCIONA_SQL_GLOBAL_DB") ?? "Extraccion_RenaultGroup_Global",
    targetDatabase: read("ACCIONA_SQL_TARGET_DB") ?? "_MOK_MOK",
    allowedDatabases: (read("ACCIONA_ALLOWED_DATABASES") ?? "_MOK_MOK").split(",").map((value) => value.trim()).filter(Boolean),
    imagesRoot: requiredFrom(env, "ACCIONA_IMAGES_ROOT"),
    criteriaLanguage: read("ACCIONA_CRITERIA_LANGUAGE") ?? "EN",
    descriptionLanguageId: Number(read("ACCIONA_DESCRIPTION_LANGUAGE_ID") ?? 3),
    countryCode: read("ACCIONA_COUNTRY_CODE") ?? "GEN",
    activeFlag: read("ACCIONA_ACTIVE_FLAG") ?? "0",
    performedFlag: read("ACCIONA_PERFORMED_FLAG") ?? "0",
    connectionTimeoutMs: positiveTimeout(env, "ACCIONA_SQL_CONNECT_TIMEOUT_MS", 30000),
    requestTimeoutMs: positiveTimeout(env, "ACCIONA_SQL_REQUEST_TIMEOUT_MS", 120000),
  };
}

function positiveTimeout(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function requiredFrom(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Acciona SQL Server access`);
  return value;
}

export function extractionDatabaseName(config: AccionaConfig, manufacturer: string, epc: string): string {
  return config.extractionDatabasePattern
    .replaceAll("{manufacturer}", manufacturer.trim())
    .replaceAll("{epc}", epc.trim());
}

export function sqlConfig(config: AccionaConfig, database: string): sql.config {
  return {
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database,
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    options: { encrypt: config.encrypt, trustServerCertificate: config.trustServerCertificate },
  };
}

export async function openAccionaPool(config: AccionaConfig, database: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool(sqlConfig(config, database)).connect();
}
