import { createBullMqWorker } from "@pablosla/core-reader/infrastructure/bullmq/adapter";
import type { Logger } from "@pablosla/core-reader/application/ports/runtime";
import type { CancellationFlags, RunHeartbeat } from "@pablosla/core-reader/infrastructure/redis/run-state";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import type { ArtifactStore } from "../application/ports/artifact-store.js";
import type { RenaultApi } from "../application/ports/renault-api.js";
import type { RequestRepository } from "../application/ports/request-repository.js";
import { isQueueJobPending, type RequestJob, type RequestQueue } from "../application/ports/request-queue.js";
import type { ScopeLocks } from "../application/ports/scope-locks.js";
import { enqueueRequestUseCase } from "../application/use-cases/enqueue-request.js";
import { extractUnit } from "../application/use-cases/extract-unit.js";
import { deriveFamiliesUseCase } from "../application/use-cases/derive-families.js";
import { processUnitUseCase } from "../application/use-cases/process-unit.js";
import { cancelRequestUseCase, finalizeCancelledRequest, requestLockPaths, type CancelRequestDependencies } from "../application/use-cases/cancel-request.js";
import { recoverRequests, resumeRequestUseCase, type ResumeRequestDependencies } from "../application/use-cases/resume-request.js";
import { listRequestsUseCase } from "../application/use-cases/list-requests.js";
import { downloadArtifactUseCase } from "../application/use-cases/download-artifact.js";
import type { RenaultRequestState, RequestListFilters, Resource } from "../domain/request.js";
import type { CreateRequest } from "@pablosla/core-reader/contract/v1";
import type { createRedisRequestRepository } from "../infrastructure/redis/request-repository.js";
import { REQUEST_QUEUE_NAME } from "../infrastructure/bullmq/request-queue.js";

export type JobsRuntimeServices = {
  settings: AppConfig;
  redis: Redis;
  logger: Logger;
  repository: RequestRepository;
  requests: ReturnType<typeof createRedisRequestRepository>;
  queue: RequestQueue;
  locks: ScopeLocks;
  flags: CancellationFlags;
  heartbeat: RunHeartbeat;
  store: ArtifactStore & { bucket: string; signedDownload(key: string, filename?: string): Promise<string>; exists(key: string): Promise<boolean> };
  api: RenaultApi;
  queueCounts?: () => Promise<Record<string, number>>;
  assertWorkerAlive(): Promise<void>;
  /** How often a running job renews its heartbeat and checks for a cancellation request. */
  cancelPollMs?: number;
};

export function createJobsRuntime(services: JobsRuntimeServices) {
  const { settings, repository, queue, locks, flags, heartbeat, store, logger } = services;
  const ttlMs = settings.STATE_TTL_SECONDS * 1000;
  let shuttingDown = false;
  const running = new Set<AbortController>();

  const cancelDeps: CancelRequestDependencies = { repository, queue, locks, flags, logger };
  const resumeDeps: ResumeRequestDependencies = { repository, queue, locks, isHeartbeatAlive: id => heartbeat.isAlive(id), queueName: REQUEST_QUEUE_NAME };

  async function isRequestStalled(requestId: string, current?: RenaultRequestState): Promise<boolean> {
    const state = current ?? await repository.get(requestId);
    if (!state || ["completed", "cancelled", "cancelling", "failed"].includes(state.status)) return false;
    if (await heartbeat.isAlive(requestId)) return false;
    const job = state.queueJobId ? await queue.getJob(state.queueJobId) : null;
    return !job || !isQueueJobPending(job.state);
  }

  async function workerLiveness() {
    const alive = await services.assertWorkerAlive().then(() => true, () => false);
    const queueCounts = await services.queueCounts?.().catch(() => null) ?? null;
    return { alive, queue: REQUEST_QUEUE_NAME, queueCounts };
  }

  return {
    /** A shutdown interrupts the Renault waits; the interrupted request becomes `paused` and is requeued by the next worker. */
    setWorkerShuttingDown(value: boolean) {
      shuttingDown = value;
      if (value) for (const controller of running) controller.abort();
    },
    isShuttingDown: () => shuttingDown,
    isRequestStalled,
    workerLiveness,
    state: (requestId: string) => repository.get(requestId),
    enqueueRequest: (resource: Resource, input: CreateRequest) => enqueueRequestUseCase(resource, input, { repository, locks, queue }),
    listRequests: (resource: Resource, filters: RequestListFilters, cursor: string | undefined, limit: number) => listRequestsUseCase(resource, filters, cursor, limit, {
      ensureIndex: target => services.requests.indexes[target].ensure(),
      fetchRequestIds: (target, cutoff, after, count) => services.requests.indexes[target].fetchRequestIds(cutoff, after, count),
      fetchStates: services.requests.fetchStates,
      removeMissing: (target, ids) => services.requests.indexes[target].remove(ids),
      pruneExpired: (target, cutoff) => services.requests.indexes[target].pruneExpired(cutoff),
      ttlMs,
    }),
    cancelRequest: (requestId: string) => cancelRequestUseCase(requestId, cancelDeps),
    resumeRequest: (requestId: string, force: boolean) => resumeRequestUseCase(requestId, force, resumeDeps),
    downloadArtifact: (resource: Resource, requestId: string, artifact?: string) => downloadArtifactUseCase(resource, requestId, artifact, {
      getState: id => repository.get(id), exists: key => store.exists(key),
      signDownload: (key, filename) => store.signedDownload(key, filename), objectKey: store.objectKey, bucket: store.bucket,
    }),
    /** Startup recovery: requeue orphaned requests and finalize cancellations the previous worker never finished. */
    recover: () => recoverRequests({ ...resumeDeps, ...cancelDeps, requestIds: () => services.requests.allRequestIds(), logger }),

    /** BullMQ processor: one job is one unit. A background timer keeps the heartbeat alive and turns a cancellation flag into an abort. */
    async processJob(job: { id?: string; data: RequestJob }) {
      const { requestId, runId } = job.data;
      const controller = new AbortController();
      running.add(controller);
      const beat = () => heartbeat.beat(requestId, runId).catch(() => undefined);
      await beat();
      const timer = setInterval(() => {
        void beat();
        void flags.isRequested(requestId).then(requested => { if (requested) controller.abort(); }).catch(() => undefined);
      }, services.cancelPollMs ?? 5000);
      try {
        return await processUnitUseCase(job.data, {
          state: { get: id => repository.get(id), update: (id, patch, deletedKeys) => repository.patch(id, patch, deletedKeys) },
          cancellation: { isRequested: id => flags.isRequested(id), finalize: id => finalizeCancelledRequest(id, cancelDeps) },
          worker: { isShuttingDown: () => shuttingDown },
          extract: (state, index, hooks) => extractUnit({ requestId, input: state.input, unit: state.units[index]!, families: state.families }, {
            api: services.api, store, pollIntervalMs: settings.POLL_INTERVAL_MS, timeoutMs: settings.JOB_TIMEOUT_MS, signal: controller.signal, onStage: hooks.onStage,
          }),
          families: state => {
            if (state.input.resource !== "parts") throw new Error("Only parts requests derive families");
            return deriveFamiliesUseCase(state.input, state.units, store);
          },
          queue: { next: next => queue.enqueue(next) },
          locks: { releaseAll: state => locks.release(requestLockPaths(state), state.requestId) },
          logger,
        });
      } finally {
        clearInterval(timer);
        running.delete(controller);
        await heartbeat.clear(requestId, runId).catch(() => undefined);
      }
    },

    createWorker() {
      return createBullMqWorker<RequestJob, unknown>(REQUEST_QUEUE_NAME, job => this.processJob(job as never), {
        connection: services.redis, concurrency: settings.JOB_CONCURRENCY, stalledInterval: settings.WORKER_STALLED_INTERVAL_MS, lockDuration: settings.WORKER_LOCK_DURATION_MS, maxStalledCount: 1,
      });
    },
  };
}

export type JobsRuntime = ReturnType<typeof createJobsRuntime>;
