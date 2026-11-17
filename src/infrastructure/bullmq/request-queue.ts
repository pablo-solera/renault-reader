import type { Redis } from "ioredis";
import { createBullMqQueue, type BullMqQueueClient } from "@pablosla/core-reader/infrastructure/bullmq/adapter";
import { requestJobId, type QueueJobState, type RequestJob, type RequestQueue } from "../../application/ports/request-queue.js";

export const REQUEST_QUEUE_NAME = "renault-extractions";
const REQUEST_JOB_NAME = "unit";

/** One attempt: a failed unit leaves the request `failed` and is retried explicitly with `/resume`, as the legacy service did. */
const REQUEST_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 1,
} as const;

function toQueueJobState(state: string): QueueJobState {
  if (state === "active") return "active";
  if (["waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return "pending";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "unknown";
}

type Client = BullMqQueueClient<RequestJob, unknown>;

/** The queue is created lazily so processes that never enqueue (the worker healthcheck) do not open it. */
export function createBullMqRequestQueue(redis: Redis) {
  let queue: Promise<Client> | undefined;
  const getQueue = () => queue ??= createBullMqQueue<RequestJob, unknown>(REQUEST_QUEUE_NAME, { connection: redis });
  const port: RequestQueue = {
    async enqueue(job) {
      const jobId = requestJobId(job);
      const added = await (await getQueue()).add(REQUEST_JOB_NAME, job, { ...REQUEST_JOB_OPTIONS, jobId });
      return String(added.id ?? jobId);
    },
    async getJob(jobId) {
      const job = await (await getQueue()).getJob(jobId);
      return job ? { id: String(job.id), state: toQueueJobState(await job.getState()) } : null;
    },
    async remove(jobId) {
      const job = await (await getQueue()).getJob(jobId);
      if (job) await job.remove();
    },
  };
  return {
    port,
    getJobCounts: async () => (await getQueue()).getJobCounts("active", "waiting", "delayed", "failed", "completed"),
    close: async () => { if (queue) await (await queue).close(); },
  };
}
