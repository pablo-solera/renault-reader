import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config, getRenaultCredentials } from "./config.js";
import { redis } from "./redis.js";
import { buildExportPayload, buildFileName, buildPartsFileName, buildLabourPayload, discoverExportOptions, discoverLabourOptions, gigyaLogin, RenaultClient } from "./renault.js";
import { S3UploadError, downloadBytes, uploadBytes, uploadObject } from "./storage.js";
import { buildReportZip, buildTapvWorkbook, compareCatalogRecords, compareImageHashes, currentEpc, normalizeAxCode, normalizeDescription, normalizeEdition, normalizeManufacturer, parsePartsArchive, preprocessCatalogRecords, preprocessModelVehicleRecords, structuredBytes } from "./parts.js";
import type { JobState, LabourRequest, PartsRequest } from "./types.js";
import type { ModelExtractionRequest } from "./types.js";
import { deriveFamilies, selectPowertrain } from "./powertrain.js";

const queueName = "labours";
export const labourQueue = new Queue(queueName, { connection: redis });
const partsQueueName = "parts";
export const partsQueue = new Queue(partsQueueName, { connection: redis });
const modelsQueueName = "models";
export const modelsQueue = new Queue(modelsQueueName, { connection: redis });

const stateKey = (id: string) => `asmdor:job:${id}`;
const lockKey = (input: LabourRequest) => `asmdor:lock:renault:TM01:${input.family}:${input.format}:${input.language}:${input.range}:${input.publishedAfter ?? ""}`;
const partsLockKey = (input: PartsRequest) => `asmdor:lock:renault:${input.exportType}:${input.family ?? "All"}:${input.format ?? "default"}:${input.language ?? ""}:${input.range}:${input.publishedAfter ?? ""}:${input.previousRequestId ?? ""}:${input.illustrationsRequestId ?? ""}:${input.modelIds?.join(",") ?? ""}`;

export async function releasePartsLock(input: PartsRequest) {
  await redis.del(partsLockKey(input));
}

export function buildLabourObjectKey(requestId: string, fileName: string): string {
  const safeFileName = fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_");
  const prefix = config.s3LaboursPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_LABOURS_PREFIX is required");
  return `${prefix}/renault_${requestId}_${safeFileName}`;
}

export function buildPartsBaseKey(input: PartsRequest, date = new Date()): string | null {
  if (!input.manufacturer || !input.axCode || !input.description || !input.family || !input.edition) return null;
  const prefix = config.s3SparePartPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_SPARE_PART_PREFIX is required");
  const manufacturer = normalizeManufacturer(input.manufacturer);
  const description = normalizeDescription(input.description);
  const edition = normalizeEdition(input.edition).replace("/", "-");
  const datePart = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}/${manufacturer}/${config.s3PartsSegment}/${normalizeAxCode(input.axCode)}_${description}_${input.family}/${edition}/${datePart}`;
}

export function buildPartsObjectKey(requestId: string, exportType: string, fileName: string, input?: PartsRequest, date = new Date()): string {
  const safeFileName = fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_");
  const base = input && buildPartsBaseKey(input, date);
  if (base) return `${base}/${exportType}/renault_${requestId}_${safeFileName}`;
  const prefix = config.s3PartsPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_PARTS_PREFIX is required");
  return `${prefix}/${exportType}/renault_${requestId}_${safeFileName}`;
}

function buildPartsDerivedKey(requestId: string, exportType: string, name: string, baseKey?: string | null): string {
  if (baseKey) return `${baseKey}/${exportType}/${name}/${requestId}.json`;
  const prefix = config.s3PartsPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_PARTS_PREFIX is required");
  return `${prefix}/${exportType}/${name}/${requestId}.json`;
}

function buildPartsReportKey(requestId: string, exportType: string, fileName: string, baseKey?: string | null): string {
  if (baseKey) return `${baseKey}/${exportType}/reports/renault_${requestId}_${fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_")}.zip`;
  const prefix = config.s3PartsPrefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3_PARTS_PREFIX is required");
  const safe = fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_");
  return `${prefix}/${exportType}/reports/renault_${requestId}_${safe}.zip`;
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

export async function enqueueParts(input: PartsRequest) {
  const lock = partsLockKey(input);
  const acquired = await redis.set(lock, "1", "EX", 300, "NX");
  if (!acquired) throw new Error("An identical Parts export is already being prepared");
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const state: JobState = { requestId, status: "queued", stage: "queued", progress: null, createdAt: now, updatedAt: now };
  try {
    await redis.set(stateKey(requestId), JSON.stringify(state), "EX", config.stateTtlSeconds);
    await partsQueue.add("export", { requestId, input }, { jobId: requestId, removeOnComplete: true, removeOnFail: 100 });
    return state;
  } catch (error) {
    await redis.del(lock, stateKey(requestId));
    throw error;
  }
}

export async function enqueueModel(input: ModelExtractionRequest) {
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const state: JobState = { requestId, status: "queued", stage: "queued", progress: 0, createdAt: now, updatedAt: now, children: {} };
  await redis.set(stateKey(requestId), JSON.stringify(state), "EX", config.stateTtlSeconds);
  try {
    await modelsQueue.add("extract", { requestId, input }, { jobId: requestId, removeOnComplete: true, removeOnFail: 100 });
    return state;
  } catch (error) {
    await redis.del(stateKey(requestId));
    throw error;
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForHistory(client: RenaultClient, email: string, remoteRequestId: string, fileName: string, requestId: string, queryCode: string) {
  const deadline = Date.now() + config.jobTimeoutMs;
  while (Date.now() < deadline) {
    const response = await client.history(email);
    const rows = Array.isArray(response.responseData) ? response.responseData : [];
    const row = rows.find((candidate: any) => candidate.requestedQueryId === remoteRequestId && candidate.fileName === fileName) ?? rows.find((candidate: any) => candidate.queryLabel?.startsWith(`${queryCode} `) && candidate.fileName === fileName);
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
    // ASMDOR can report a stale duplicate as a status error while History already has the file.
    const statusMessage = String(current.responseData?.requestQueryStatusMsg ?? current.errorMessage ?? "");
    if (!/failed to get the status/i.test(statusMessage)) {
      throw new Error(statusMessage || `Unexpected Renault status ${current.status}`);
    }
    remoteRequestId = "available";
  }
  const history = await waitForHistory(client, email, remoteRequestId ?? "available", fileName, requestId, "TM01");
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

async function processParts(job: Job<{ requestId: string; input: PartsRequest }>) {
  const { requestId, input } = job.data;
  const { email, password } = getRenaultCredentials();
  await updateState(requestId, { status: "authenticating", stage: "gigya_login" });
  const auth = await gigyaLogin(email, password);
  const client = new RenaultClient(auth.token);
  await updateState(requestId, { status: "discovering", stage: `${input.exportType.toLowerCase()}_configuration` });
  const discovered = await discoverExportOptions(client, email, input.range, input.exportType);
  const selectedFamily = discovered.query.familyFilter
    ? discovered.families.find((family: any) => family.value === (input.family ?? "All"))
    : undefined;
  if (discovered.query.familyFilter && !selectedFamily) throw new Error("Family is not authorized for this Parts export");
  const format = input.format ?? discovered.formats[0];
  if (!format || !discovered.formats.includes(format)) throw new Error(`Format is not authorized by ${input.exportType}`);
  if (discovered.languages && discovered.languages.length > 0 && (!input.language || !discovered.languages.includes(input.language))) {
    throw new Error(`Language is not authorized by ${input.exportType}`);
  }
  // Queries without a language filter must receive null, as Access does.
  const language = discovered.languages ? input.language ?? discovered.languages[0] : undefined;
  const effectiveInput = { ...input, format, family: input.family ?? "All", language };
  const fileName = buildPartsFileName(discovered.query, effectiveInput, String(discovered.profile.value));
  const payload = buildExportPayload(discovered.query, discovered.profile, effectiveInput, selectedFamily);
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
  const history = await waitForHistory(client, email, remoteRequestId ?? "available", fileName, requestId, input.exportType);
  const rawPath = String(history.filePath ?? discovered.query.queryDownloadPath);
  const filePath = rawPath.endsWith("/") ? rawPath.slice(0, -1).replace("biz/", "") : rawPath.replace("biz/", "");
  await updateState(requestId, { status: "downloading", stage: "presigned_url", remoteRequestId, fileName });
  const urlResponse = await client.downloadUrl(filePath, fileName, input.exportType);
  const downloadUrl = urlResponse.responseData?.downloadUrl;
  if (typeof downloadUrl !== "string" || !downloadUrl) throw new Error("Renault did not return a download URL");
  const downloaded = await client.download(downloadUrl);
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  if (!bytes.length) throw new Error("Renault returned an empty download");
  const baseKey = buildPartsBaseKey(input);
  const objectKey = buildPartsObjectKey(requestId, input.exportType, fileName, input);
  await updateState(requestId, { status: "uploading", stage: "s3_upload", progress: null });
  await uploadBytes(objectKey, bytes, downloaded.headers.get("content-type") ?? "application/zip");
  await updateState(requestId, { status: "uploading", stage: "parsing_archive", objectKey });
  const parsed = await parsePartsArchive(input.exportType, bytes);
  const effectiveEpc = input.epc ?? currentEpc();
  if (input.exportType === "REF04") parsed.records = preprocessModelVehicleRecords(parsed.records, input.modelIds, input.manufacturer);
  if (input.exportType === "PR08") {
    await updateState(requestId, { status: "uploading", stage: "preprocessing_catalog" });
    let treeRecords: unknown[] = [];
    if (input.treeRequestId) {
      const treeState = await getState(input.treeRequestId);
      if (treeState?.structuredKey) {
        const tree = JSON.parse(new TextDecoder().decode(await downloadBytes(treeState.structuredKey)));
        treeRecords = Array.isArray(tree.records) ? tree.records : [];
      }
    }
    parsed.records = preprocessCatalogRecords(parsed.records, treeRecords, input.language ?? "EN");
  }
  const structuredKey = buildPartsDerivedKey(requestId, input.exportType, "structured", baseKey);
  let imageComparison: ReturnType<typeof compareImageHashes> | undefined;
  if (input.exportType === "PR03" && input.previousRequestId) {
    const previousState = await getState(input.previousRequestId);
    const previousKey = previousState?.structuredKey ?? buildPartsDerivedKey(input.previousRequestId, "PR03", "structured", baseKey);
    const previousParsed = JSON.parse(new TextDecoder().decode(await downloadBytes(previousKey)));
    imageComparison = compareImageHashes(parsed, previousParsed);
  }
  let catalogComparison: ReturnType<typeof compareCatalogRecords> | undefined;
  if (input.exportType === "PR08" && input.previousRequestId) {
    const previousState = await getState(input.previousRequestId);
    const previousKey = previousState?.structuredKey ?? buildPartsDerivedKey(input.previousRequestId, "PR08", "structured", baseKey);
    const previousParsed = JSON.parse(new TextDecoder().decode(await downloadBytes(previousKey)));
    catalogComparison = compareCatalogRecords(parsed.records, Array.isArray(previousParsed.records) ? previousParsed.records : []);
  }
  const structured = structuredBytes(parsed, { requestId, axCode: input.axCode, epc: effectiveEpc, manufacturer: input.manufacturer, description: input.description, edition: input.edition, family: input.family, modelIds: input.modelIds, range: input.range, previousRequestId: input.previousRequestId, imageComparison, catalogComparison });
  await uploadBytes(structuredKey, structured, "application/json");

  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, objectKey, rawObjectKey: objectKey, structuredKey, fileName });
  return { objectKey, fileName, structuredKey };
}

async function waitForChild(requestId: string) {
  const deadline = Date.now() + config.jobTimeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(requestId);
    if (state?.status === "completed") return state;
    if (state?.status === "failed") throw new Error(`Child Parts job ${requestId} failed: ${state.error ?? "unknown error"}`);
    await wait(config.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Parts job ${requestId}`);
}

async function processModel(job: Job<{ requestId: string; input: ModelExtractionRequest }>) {
  const { requestId, input } = job.data;
  const enabled = (code: string) => input.exports?.[code as keyof typeof input.exports] !== false;
  const children: Record<string, { requestId: string; status?: JobState["status"] }> = {};
  const previous = input.resumeRequestId ? await getState(input.resumeRequestId) : undefined;
  const runChild = async (key: string, child: PartsRequest) => {
    const previousChild = previous?.children?.[key];
    if (previousChild?.status === "completed") {
      children[key] = previousChild;
      await updateState(requestId, { stage: `reusing_${key}`, children });
      const state = await getState(previousChild.requestId);
      if (state?.status === "completed") return state;
    }
    const childState = await enqueueParts(child);
    children[key] = { requestId: childState.requestId, status: childState.status };
    await updateState(requestId, { stage: `waiting_${key}`, children, progress: null });
    const completed = await waitForChild(childState.requestId);
    children[key].status = completed.status;
    await updateState(requestId, { children });
    return completed;
  };
  const base = { ...input, language: input.language ?? "", format: input.format };
  await updateState(requestId, { status: "discovering", stage: "family_exports", children });
  const ref04 = await runChild("REF04", { ...base, exportType: "REF04", modelIds: input.modelIds });
  const ref05 = await runChild("REF05", { ...base, exportType: "REF05", modelIds: input.modelIds });
  for (const code of ["REF01", "REF02", "REF03", "PR05", "PR06"] as const) {
    if (enabled(code)) await runChild(code, { ...base, exportType: code, modelIds: input.modelIds });
  }
  const ref04Parsed = JSON.parse(new TextDecoder().decode(await downloadBytes(ref04.structuredKey!)));
  const ref05Parsed = JSON.parse(new TextDecoder().decode(await downloadBytes(ref05.structuredKey!)));
  const ref03 = children.REF03 ? await getState(children.REF03.requestId) : undefined;
  const models = Array.isArray(ref04Parsed.records) ? ref04Parsed.records : [];
  const selected = selectPowertrain(Array.isArray(ref05Parsed.records) ? ref05Parsed.records : [], models);
  const families = deriveFamilies(selected);
  const familyCodes = ["PR08", "PR03"] as const;
  for (const code of familyCodes) {
    if (!enabled(code)) continue;
    for (const family of families) await runChild(`${code}_${family}`, { ...base, exportType: code, family, treeRequestId: code === "PR08" ? ref03?.requestId : undefined });
  }
  await updateState(requestId, { status: "uploading", stage: "generating_tapv_report", children });
  const workbook = await buildTapvWorkbook(selected);
  const structured = new TextEncoder().encode(JSON.stringify({ requestId, input, families, records: selected, children }));
  const reportZip = buildReportZip(`Powertrain_${input.axCode}.xlsx`, workbook, structured);
  const baseKey = buildPartsBaseKey({ ...base, exportType: "REF05" });
  const reportKey = buildPartsReportKey(requestId, "MODEL", `Powertrain_${input.axCode}`, baseKey);
  await uploadBytes(reportKey, reportZip, "application/zip");
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, objectKey: reportKey, excelObjectKey: reportKey, children });
  return { objectKey: reportKey };
}

export function createLabourWorker() {
  return new Worker(queueName, processLabour, { connection: redis, concurrency: config.jobConcurrency });
}

export function createPartsWorker() {
  return new Worker(partsQueueName, processParts, { connection: redis, concurrency: config.jobConcurrency });
}

export function createModelsWorker() {
  return new Worker(modelsQueueName, processModel, { connection: redis, concurrency: 1 });
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
