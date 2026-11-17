import { createLabourWorker, createPartsWorker, markFailed, releasePartsLock } from "./jobs.js";
import { getRenaultCredentials } from "./config.js";
import { ensureBucket } from "./storage.js";

getRenaultCredentials();
await ensureBucket();
const worker = createLabourWorker();
const partsWorker = createPartsWorker();
worker.on("completed", (job) => console.log(`Labour job ${job.id} completed`));
worker.on("failed", async (job, error) => {
  if (job?.data?.requestId) await markFailed(job.data.requestId, error);
  console.error(`Labour job ${job?.id ?? "unknown"} failed: ${error.message}`);
});
console.log("Labour worker started");
partsWorker.on("completed", async (job) => { await releasePartsLock(job.data.input); console.log(`Parts job ${job.id} completed`); });
partsWorker.on("failed", async (job, error) => {
  if (job?.data?.requestId) await markFailed(job.data.requestId, error);
  if (job?.data?.input) await releasePartsLock(job.data.input);
  console.error(`Parts job ${job?.id ?? "unknown"} failed: ${error.message}`);
});
console.log("Parts worker started");
