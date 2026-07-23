import { createLabourWorker, markFailed } from "./jobs.js";

const worker = createLabourWorker();
worker.on("completed", (job) => console.log(`Labour job ${job.id} completed`));
worker.on("failed", async (job, error) => {
  if (job?.data?.requestId) await markFailed(job.data.requestId, error);
  console.error(`Labour job ${job?.id ?? "unknown"} failed: ${error.message}`);
});
console.log("Labour worker started");
