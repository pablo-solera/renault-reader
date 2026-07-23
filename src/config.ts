export type Config = {
  port: number;
  redisUrl: string;
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
  stateTtlSeconds: number;
  renaultApiBase: string;
  gigyaApiBase: string;
  gigyaApiKey: string;
  defaultRenaultEmail?: string;
  defaultRenaultPassword?: string;
  jobConcurrency: number;
  pollIntervalMs: number;
  jobTimeoutMs: number;
};

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

export const config: Config = {
  port: numberEnv("PORT", 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  s3Endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3Bucket: process.env.S3_BUCKET ?? "renault-reader",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  stateTtlSeconds: numberEnv("STATE_TTL_SECONDS", 604800),
  renaultApiBase: (process.env.RENAULT_API_BASE ?? "https://opeeu.a5m.opeeu.asdh.aws.renault.com/api/").replace(/\/$/, "") + "/",
  gigyaApiBase: (process.env.GIGYA_API_BASE ?? "https://accounts.eu1.gigya.com").replace(/\/$/, ""),
  gigyaApiKey: process.env.GIGYA_API_KEY ?? "",
  defaultRenaultEmail: process.env.RENAULT_EMAIL,
  defaultRenaultPassword: process.env.RENAULT_PASSWORD,
  jobConcurrency: numberEnv("JOB_CONCURRENCY", 2),
  pollIntervalMs: numberEnv("POLL_INTERVAL_MS", 30000),
  jobTimeoutMs: numberEnv("JOB_TIMEOUT_MS", 86400000),
};
