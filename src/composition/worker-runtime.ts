import { createWorkerRuntime as startWorkerRuntime } from "@pablosla/core-reader/infrastructure/redis/worker-runtime";
import type { RenaultContainer } from "./container.js";
import { REQUEST_QUEUE_NAME } from "../infrastructure/bullmq/request-queue.js";
import { requireRenaultCredentials } from "../config.js";

/** Starts the single worker: singleton lock + heartbeat, startup recovery, the BullMQ worker and a graceful shutdown. */
export async function createWorkerRuntime(container: RenaultContainer) {
  const { redis, workerLock, jobs, logger } = container;
  requireRenaultCredentials(container.config);
  const runtime = await startWorkerRuntime({
    service: "renault-reader", queueName: REQUEST_QUEUE_NAME, workerLock, logger,
    prepare: () => container.objectStorage.ensureBucket(),
    createWorker: () => jobs.createWorker() as Promise<import("bullmq").Worker>,
    recover: () => jobs.recover(),
    onShuttingDown: () => jobs.setWorkerShuttingDown(true),
    close: () => container.close(),
  });
  return { worker: runtime.worker, shutdown: runtime.shutdown, redis };
}
