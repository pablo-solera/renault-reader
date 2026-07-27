import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config, getRenaultCredentials } from "./config.js";
import { redis } from "./redis.js";
import { buildFileName, buildLabourPayload, discoverLabourOptions, gigyaLogin, RenaultClient } from "./renault.js";
import { S3UploadError, uploadObject } from "./storage.js";
import type { JobState, LabourRequest } from "./types.js";

const queueName = "labours";
export const labourQueue = new Queue(queueName, { connection: redis });

const stateKey = (id: string) => `asmdor:job:${id}`;
const lockKey = (input: LabourRequest) => `asmdor:lock:renault:TM01:${input.family}:${input.format}:${input.language}:${input.range}:${input.publishedAfter ?? ""}`;

export function buildLabourObjectKey(requestId: string, fileName: string): string {
  const safeFileName = fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_");
  const prefix = config.s3LaboursPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_LABOURS_PREFIX is required");
  return `${prefix}/renault_${requestId}_${safeFileName}`;
}

export async function getState(requestId: string): Promise<JobState | null> {
  const raw = await redis.get(stateKey(requestId));
  return raw ? JSON.parse(raw) as JobState : null;
}

export async function updateState(requestId: string, patch: Partial<JobState>) {
  const current = await getState(requestId);
  if (!current) return;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await redis.set(stateKey(requestId), JSON.stringify(next), "EX", config.stateTtlSeconds);
  return next;
}

export async function enqueueLabour(input: LabourRequest) {
  const lock = lockKey(input);
  const acquired = await redis.set(lock, "1", "EX", 300, "NX");
  if (!acquired) throw new Error("An identical Labour Times export is already being prepared");
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const state: JobState = { requestId, status: "queued", stage: "queued", progress: null, createdAt: now, updatedAt: now };
  try {
    await redis.set(stateKey(requestId), JSON.stringify(state), "EX", config.stateTtlSeconds);
    await labourQueue.add("export", { requestId, input }, { jobId: requestId, removeOnComplete: true, removeOnFail: 100 });
    return state;
  } catch (error) {
    await redis.del(lock, stateKey(requestId));
    throw error;
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHistory(client: RenaultClient, email: string, remoteRequestId: string, fileName: string, requestId: string) {
  const deadline = Date.now() + config.jobTimeoutMs;
  while (Date.now() < deadline) {
    const response = await client.history(email);
    const rows = Array.isArray(response.responseData) ? response.responseData : [];
    const row = rows.find((candidate: any) => candidate.requestedQueryId === remoteRequestId && candidate.fileName === fileName) ?? rows.find((candidate: any) => candidate.queryLabel?.startsWith("TM01 ") && candidate.fileName === fileName);
    if (row && (row.exportStatus === "Completed" || row.exportStatus === "Unlocked")) return row;
    await updateState(requestId, { status: "waiting", stage: "waiting_for_renault", remoteRequestId });
    await wait(config.pollIntervalMs);
  }
  throw new Error("Timed out waiting for Renault History");
}

async function processLabour(job: Job<{ requestId: string; input: LabourRequest }>) {
  const { requestId } = job.data;
  const input = job.data.input;
  const { email, password } = getRenaultCredentials();
  await updateState(requestId, { status: "authenticating", stage: "gigya_login" });
  const auth = await gigyaLogin(email, password);
  const client = new RenaultClient(auth.token);
  await updateState(requestId, { status: "discovering", stage: "tm01_configuration" });
  const discovered = await discoverLabourOptions(client, email, input.range);
  const selectedFamily = discovered.families.find((family: any) => family.value === input.family);
  if (!selectedFamily) throw new Error("Family is not authorized for this account");
  if (!discovered.formats.includes(input.format)) throw new Error("Format is not authorized by TM01");
  if (discovered.languages && !discovered.languages.includes(input.language)) throw new Error("Language is not authorized by TM01");
  const fileName = buildFileName(discovered.query, input, String(discovered.profile.value));
  const payload = buildLabourPayload(discovered.query, discovered.profile, input, selectedFamily);
  await updateState(requestId, { status: "checking_remote", stage: "request_status", fileName });
  const current = await client.status(discovered.query, payload, fileName);
  let remoteRequestId = current.responseData?.requestQueryId as string | undefined;
  if (current.status === "AVAILABLE") {
    remoteRequestId = remoteRequestId ?? "available";
  } else if (current.status === "EXECUTE" || current.status === "PENDING") {
    if (!remoteRequestId) throw new Error("Renault did not return requestQueryId");
    await updateState(requestId, { status: "submitted", stage: "launching", remoteRequestId });
    await client.launch(discovered.query, { ...payload, queryRequestId: remoteRequestId });
  } else if (current.status !== "INPROGRESS") {
    throw new Error(current.responseData?.requestQueryStatusMsg ?? `Unexpected Renault status ${current.status}`);
  }
  const history = await waitForHistory(client, email, remoteRequestId ?? "available", fileName, requestId);
  const rawPath = String(history.filePath ?? discovered.query.queryDownloadPath);
  const filePath = rawPath.endsWith("/") ? rawPath.slice(0, -1).replace("biz/", "") : rawPath.replace("biz/", "");
  await updateState(requestId, { status: "downloading", stage: "presigned_url", remoteRequestId, fileName });
  const urlResponse = await client.downloadUrl(filePath, fileName, "TM01");
  const downloadUrl = urlResponse.responseData?.downloadUrl;
  if (typeof downloadUrl !== "string" || !downloadUrl) throw new Error("Renault did not return a download URL");
  const downloaded = await client.download(downloadUrl);
  if (!downloaded.body) throw new Error("Renault returned an empty download");
  const objectKey = buildLabourObjectKey(requestId, fileName);
  await updateState(requestId, { status: "uploading", stage: "s3_upload", progress: null });
  await uploadObject(objectKey, downloaded.body, downloaded.headers.get("content-type") ?? "application/zip");
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, objectKey, fileName });
  return { objectKey, fileName };
}

export function createLabourWorker() {
  return new Worker(queueName, processLabour, { connection: redis, concurrency: config.jobConcurrency });
}

export async function markFailed(requestId: string, error: unknown) {
  const current = await getState(requestId);
  const details = error instanceof S3UploadError ? error.details : undefined;
  await updateState(requestId, {
    status: "failed",
    stage: current?.stage ?? "failed",
    error: error instanceof Error ? error.message : "Unknown worker error",
    failureOperation: details?.operation,
    failureCode: details?.code,
    failureStatus: details?.status,
    failureRequestId: details?.requestId,
  });
}
