import { createWorkerLock } from "@pablosla/core-reader/infrastructure/redis/worker-lock";
import { AccessTokenPool, createAccessTokenProvider } from "@pablosla/core-reader/infrastructure/auth/token-pool";
import { createAwsObjectStorage } from "@pablosla/core-reader/infrastructure/s3/aws-storage";
import { createJsonLogger } from "@pablosla/core-reader/shared/logger";
import { UnavailableError } from "@pablosla/core-reader/domain/errors";
import { createRedisClient } from "@pablosla/core-reader/infrastructure/redis/client";
import { createCancellationFlags, createRunHeartbeat } from "@pablosla/core-reader/infrastructure/redis/run-state";
import { loadConfig, requireRenaultCredentials, type AppConfig } from "../config.js";
import { createApp } from "../app.js";
import { createRedisRequestRepository, redisNamespace } from "../infrastructure/redis/request-repository.js";
import { createRedisScopeLocks } from "../infrastructure/redis/scope-locks.js";
import { createBullMqRequestQueue } from "../infrastructure/bullmq/request-queue.js";
import { createGigyaTokenRequest, RenaultClient, type RenaultClientSettings } from "../infrastructure/renault/client.js";
import { readAllBytes } from "../infrastructure/s3/bytes.js";
import { getModelOptionsUseCase } from "../application/use-cases/get-model-options.js";
import type { RenaultApi } from "../application/ports/renault-api.js";
import { createModelOptionsHandler } from "../interfaces/http/model-options-handler.js";
import { buildRenaultOpenApi, docsHtml } from "../interfaces/http/openapi.js";
import { toRequestState, toRequestSummary } from "../interfaces/http/state-mapper.js";
import { createJobsRuntime } from "./jobs-runtime.js";

export function renaultClientSettings(settings: AppConfig): RenaultClientSettings {
  return {
    apiBase: settings.RENAULT_API_BASE.replace(/\/$/, "") + "/",
    gigyaBase: settings.GIGYA_API_BASE.replace(/\/$/, ""),
    gigyaApiKey: settings.GIGYA_API_KEY,
    email: settings.RENAULT_EMAIL.trim(),
    password: settings.RENAULT_PASSWORD,
    timeoutMs: settings.RENAULT_API_TIMEOUT_MS,
    downloadTimeoutMs: settings.RENAULT_DOWNLOAD_TIMEOUT_MS,
    tokenTtlSeconds: settings.RENAULT_TOKEN_TTL_SECONDS,
  };
}

export function createRenaultContainer(settings: AppConfig = loadConfig(process.env), options: { cancelPollMs?: number; api?: RenaultApi } = {}) {
  const logger = createJsonLogger();
  const redis = createRedisClient(settings.REDIS_URL, { maxRetriesPerRequest: null });
  const workerLock = createWorkerLock(redis, { namespace: redisNamespace });
  const clientSettings = renaultClientSettings(settings);
  // One Gigya session: the pool only deduplicates and renews it. Login is lazy, so the API starts without credentials.
  const tokenProvider = createAccessTokenProvider(new AccessTokenPool(1, () => {
    requireRenaultCredentials(settings);
    return createGigyaTokenRequest(clientSettings)();
  }));
  const api = options.api ?? new RenaultClient(clientSettings, tokenProvider);
  const objectStorage = createAwsObjectStorage({
    bucket: settings.S3_BUCKET, region: settings.S3_REGION, endpoint: settings.S3_ENDPOINT, forcePathStyle: settings.s3ForcePathStyle,
    accessKeyId: settings.S3_ACCESS_KEY, secretAccessKey: settings.S3_SECRET_ACCESS_KEY, prefix: settings.S3_PREFIX, autoCreateBucket: settings.s3AutoCreateBucket, requestTimeoutMs: settings.S3_REQUEST_TIMEOUT_MS, logger,
  });
  const store = {
    ...objectStorage,
    async getBytes(key: string) { return readAllBytes(await objectStorage.getObjectStream(key)); },
    async exists(key: string) { return (await objectStorage.listObjects(key)).includes(key); },
  };

  const requests = createRedisRequestRepository(redis, { ttlSeconds: settings.STATE_TTL_SECONDS });
  const queue = createBullMqRequestQueue(redis);
  const jobs = createJobsRuntime({
    settings, redis, logger, repository: requests.repository, requests,
    queue: queue.port,
    locks: createRedisScopeLocks(redis, { bucket: settings.S3_BUCKET, ttlMs: settings.STATE_TTL_SECONDS * 1000 }),
    flags: createCancellationFlags(redis, { namespace: redisNamespace, scope: "request", ttlSeconds: settings.STATE_TTL_SECONDS }),
    heartbeat: createRunHeartbeat(redis, { namespace: redisNamespace, scope: "request" }),
    store,
    api,
    queueCounts: queue.getJobCounts,
    assertWorkerAlive: () => workerLock.assertAlive(redis),
    cancelPollMs: options.cancelPollMs,
  });

  const app = createApp({
    readyChecks: { redis: () => redis.ping().then(() => undefined), s3: objectStorage.checkBucket, worker: () => workerLock.assertAlive(redis) },
    openApi: buildRenaultOpenApi(settings.PORT),
    docsHtml,
    manufacturers: () => settings.manufacturers,
    modelOptions: createModelOptionsHandler(async query => {
      try { return await getModelOptionsUseCase(query, api); }
      catch (error) {
        if (error instanceof Error && error.name === "TokenError") throw new UnavailableError(error.message, undefined, { cause: error });
        throw error;
      }
    }),
    createRequest: jobs.enqueueRequest,
    listRequests: jobs.listRequests,
    getState: jobs.state,
    cancelRequest: jobs.cancelRequest,
    resumeRequest: jobs.resumeRequest,
    downloadArtifact: jobs.downloadArtifact,
    mapSummary: state => toRequestSummary(state, objectStorage),
    async mapState(state) {
      const [worker, stalled] = await Promise.all([jobs.workerLiveness(), jobs.isRequestStalled(state.requestId, state)]);
      return toRequestState(state, objectStorage, { worker, stalled });
    },
  });

  return {
    config: settings, redis, objectStorage, workerLock, jobs, logger, app,
    close: async () => { await queue.close(); await redis.quit(); },
  };
}

export type RenaultContainer = ReturnType<typeof createRenaultContainer>;
