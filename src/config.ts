export type Config = {
  host: string;
  port: number;
  redisUrl: string;
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3LaboursPrefix: string;
  s3PartsPrefix: string;
  s3SparePartPrefix: string;
  s3PartsSegment: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
  s3AutoCreateBucket: boolean;
  stateTtlSeconds: number;
  renaultApiBase: string;
  gigyaApiBase: string;
  gigyaApiKey: string;
  jobConcurrency: number;
  pollIntervalMs: number;
  jobTimeoutMs: number;
  workerLockDurationMs: number;
  workerStalledIntervalMs: number;
  manufacturerDescriptions: Record<string, string>;
};

export function getRenaultCredentials() {
  const email = process.env.RENAULT_EMAIL?.trim();
  const password = process.env.RENAULT_PASSWORD;
  if (!email || !password) throw new Error("RENAULT_EMAIL and RENAULT_PASSWORD are required");
  return { email, password };
}

/** Loopback unless told otherwise; the container sets HOST=0.0.0.0 so other containers can reach the API. */
export const listenHost = (value: string | undefined) => value?.trim() || "127.0.0.1";

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

export const config: Config = {
  host: listenHost(process.env.HOST),
  port: numberEnv("PORT", 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3Bucket: process.env.S3_BUCKET ?? "magnets-reader-dev",
  s3LaboursPrefix: process.env.S3_LABOURS_PREFIX ?? "RENAULT_GROUP/files_datasource/RENAULT/Labour_Time",
  s3PartsPrefix: process.env.S3_PARTS_PREFIX ?? "RENAULT_GROUP/files_datasource/RENAULT/Parts",
  s3SparePartPrefix: process.env.S3_SPARE_PART_PREFIX ?? "RENAULT_GROUP/files_datasource",
  s3PartsSegment: process.env.S3_PARTS_SEGMENT ?? "Parts",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "",
  s3SecretKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  s3AutoCreateBucket: process.env.S3_AUTO_CREATE_BUCKET === "true",
  stateTtlSeconds: numberEnv("STATE_TTL_SECONDS", 604800),
  renaultApiBase: (process.env.RENAULT_API_BASE ?? "https://opeeu.a5m.opeeu.asdh.aws.renault.com/api/").replace(/\/$/, "") + "/",
  gigyaApiBase: (process.env.GIGYA_API_BASE ?? "https://accounts.eu1.gigya.com").replace(/\/$/, ""),
  gigyaApiKey: process.env.GIGYA_API_KEY ?? "",
  jobConcurrency: numberEnv("JOB_CONCURRENCY", 2),
  pollIntervalMs: numberEnv("POLL_INTERVAL_MS", 30000),
  jobTimeoutMs: numberEnv("JOB_TIMEOUT_MS", 86400000),
  workerLockDurationMs: numberEnv("WORKER_LOCK_DURATION_MS", 900000),
  workerStalledIntervalMs: numberEnv("WORKER_STALLED_INTERVAL_MS", 60000),
  manufacturerDescriptions: (() => {
    const raw = process.env.RENAULT_MANUFACTURER_DESCRIPTIONS;
    if (!raw) return { RENAULT: "Renault" };
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      throw new Error("RENAULT_MANUFACTURER_DESCRIPTIONS must be valid JSON");
    }
  })(),
};
