/** One BullMQ job is one unit (one Renault export) of a request. */
export type RequestJob = { requestId: string; runId: string; index: number };

export type QueueJobState = "pending" | "active" | "completed" | "failed" | "unknown";

export interface RequestQueue {
  enqueue(job: RequestJob): Promise<string>;
  /** Looks a job up by id without scanning the queue. */
  getJob(jobId: string): Promise<{ id: string; state: QueueJobState } | null>;
  remove(jobId: string): Promise<void>;
}

export const requestJobId = (job: RequestJob) => `${job.requestId}--${job.runId}--${job.index}`;
export const isQueueJobPending = (state: QueueJobState | undefined) => state === "pending" || state === "active";
