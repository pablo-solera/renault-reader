import { z } from "zod";

const emptyToUndefined = (value: unknown) => value === "" ? undefined : value;
const boolean = (fallback: "true" | "false") => z.enum(["true", "false"]).default(fallback);
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: positive(3000),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  STATE_TTL_SECONDS: positive(604800),
  RENAULT_MANUFACTURERS: z.string().default("RENAULT,DACIA"),
  RENAULT_API_BASE: z.string().url().default("https://opeeu.a5m.opeeu.asdh.aws.renault.com/api/"),
  GIGYA_API_BASE: z.string().url().default("https://accounts.eu1.gigya.com"),
  GIGYA_API_KEY: z.string().default(""),
  RENAULT_EMAIL: z.string().default(""),
  RENAULT_PASSWORD: z.string().default(""),
  RENAULT_API_TIMEOUT_MS: positive(60000),
  RENAULT_DOWNLOAD_TIMEOUT_MS: positive(1800000),
  RENAULT_TOKEN_TTL_SECONDS: positive(1800),
  JOB_CONCURRENCY: positive(2),
  POLL_INTERVAL_MS: positive(30000),
  JOB_TIMEOUT_MS: positive(86400000),
  WORKER_LOCK_DURATION_MS: positive(900000),
  WORKER_STALLED_INTERVAL_MS: positive(60000),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_BUCKET: z.string().default("magnets-reader-dev"),
  S3_PREFIX: z.string().default(""),
  S3_REQUEST_TIMEOUT_MS: positive(600000),
  S3_FORCE_PATH_STYLE: boolean("true"),
  S3_AUTO_CREATE_BUCKET: boolean("false"),
});

export type AppConfig = z.infer<typeof envSchema> & { s3ForcePathStyle: boolean; s3AutoCreateBucket: boolean; manufacturers: string[] };

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const raw = envSchema.parse(env);
  return {
    ...raw,
    s3ForcePathStyle: raw.S3_FORCE_PATH_STYLE === "true",
    s3AutoCreateBucket: raw.S3_AUTO_CREATE_BUCKET === "true",
    manufacturers: raw.RENAULT_MANUFACTURERS.split(",").map(item => item.trim()).filter(Boolean),
  };
}

/** Credentials come only from the environment; they are never accepted over HTTP or stored in Redis. */
export function requireRenaultCredentials(settings: Pick<AppConfig, "RENAULT_EMAIL" | "RENAULT_PASSWORD" | "GIGYA_API_KEY">) {
  const email = settings.RENAULT_EMAIL.trim();
  if (!email || !settings.RENAULT_PASSWORD) throw new Error("RENAULT_EMAIL and RENAULT_PASSWORD are required");
  if (!settings.GIGYA_API_KEY) throw new Error("GIGYA_API_KEY is required");
  return { email, password: settings.RENAULT_PASSWORD };
}
