import { NotAvailableError, UnavailableError, UpstreamError } from "@pablosla/core-reader/domain/errors";
import { RequestAbortedError, sleepWithSignal } from "@pablosla/core-reader/shared/retry";
import { manifestFileName, readExtractionManifest } from "@pablosla/core-reader/contract/manifest";
import type { RenaultApi } from "../ports/renault-api.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { buildExportPayload, buildFileName, downloadPath, isHistoryDownloadable, type Json } from "../../domain/renault-query.js";
import { buildUnitManifest } from "../../domain/manifest.js";
import { normalizeContentType } from "../../domain/normalize.js";
import type { RequestInput, UnitSummary } from "../../domain/request.js";
import { discoverExport } from "./discover-export.js";

export type ExtractUnitContext = {
  requestId: string;
  input: RequestInput;
  unit: UnitSummary;
  /** Families derived from REF04 and REF05, once known; recorded in the manifest of the units that depend on them. */
  families?: string[];
};

export type ExtractUnitDependencies = {
  api: RenaultApi;
  store: ArtifactStore;
  pollIntervalMs: number;
  timeoutMs: number;
  /** Cancellation and shutdown: stops new Renault requests and interrupts the waits. */
  signal?: AbortSignal;
  onStage(stage: string, details?: { remoteRequestId?: string; fileName?: string }): Promise<void>;
  now?: () => Date;
};

export type ExtractUnitResult = { fileName: string; reused: boolean; remoteStatus: string };

const safeFileName = (fileName: string) => fileName.replace(/[\\/]/g, "_").replace(/^\.+/, "_");

function stopIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RequestAbortedError();
}

async function waitForHistory(api: RenaultApi, remoteRequestId: string, fileName: string, queryCode: string, dependencies: ExtractUnitDependencies): Promise<Json> {
  const deadline = Date.now() + dependencies.timeoutMs;
  while (Date.now() < deadline) {
    stopIfAborted(dependencies.signal);
    const response = await api.history();
    const rows: Json[] = Array.isArray(response.responseData) ? response.responseData : [];
    const row = rows.find(candidate => candidate.requestedQueryId === remoteRequestId && candidate.fileName === fileName)
      ?? rows.find(candidate => candidate.queryLabel?.startsWith(`${queryCode} `) && candidate.fileName === fileName);
    if (row && isHistoryDownloadable(row)) return row;
    await dependencies.onStage("waiting_for_renault", { remoteRequestId });
    await sleepWithSignal(dependencies.pollIntervalMs, dependencies.signal);
  }
  throw new UnavailableError("Timed out waiting for Renault History", { remoteRequestId, fileName });
}

/**
 * Extracts one Renault export and stores it raw: ASMDOR status check, launch, History polling, presigned URL, download,
 * upload of the archive exactly as received, and the manifest written last. A unit whose manifest already exists is reused untouched.
 */
export async function extractUnit(context: ExtractUnitContext, dependencies: ExtractUnitDependencies): Promise<ExtractUnitResult> {
  const { requestId, input, unit } = context;
  const { api, store } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  const existing = await readExtractionManifest(store, unit.path, unit.unit);
  if (existing?.ok && existing.version === 2) {
    const details = (existing.manifest.details ?? {}) as { fileName?: string; remoteStatus?: string };
    return { fileName: details.fileName ?? existing.manifest.files[0]?.name ?? unit.unit, reused: true, remoteStatus: details.remoteStatus ?? "stored" };
  }

  const startedAt = now().toISOString();
  stopIfAborted(dependencies.signal);
  await dependencies.onStage(`${unit.queryCode.toLowerCase()}_configuration`);
  const discovered = await discoverExport(api, input.range, unit.queryCode);
  const { query, profile } = discovered;
  const selectedFamily = query.familyFilter ? discovered.families.find(family => family.value === unit.family) : undefined;
  if (query.familyFilter && !selectedFamily) throw new NotAvailableError(`Family ${unit.family} is not authorized for ${unit.queryCode}`);
  const format = input.format ?? discovered.formats[0];
  if (!format || !discovered.formats.includes(format)) throw new NotAvailableError(`Format ${format ?? "(none)"} is not authorized by ${unit.queryCode}`, { formats: discovered.formats });
  if (discovered.languages && discovered.languages.length > 0 && (!input.language || !discovered.languages.includes(input.language))) {
    throw new NotAvailableError(`Language is not authorized by ${unit.queryCode}`, { languages: discovered.languages });
  }
  // Queries without a language filter must receive null, as Access does.
  const language = discovered.languages ? input.language ?? discovered.languages[0] : undefined;
  const params = { family: unit.family, format, language, range: input.range, publishedAfter: input.resource === "labours" ? input.publishedAfter : undefined };
  const fileName = buildFileName(query, params, String(profile.value));
  const payload = buildExportPayload(query, profile, params, selectedFamily);

  stopIfAborted(dependencies.signal);
  await dependencies.onStage("request_status", { fileName });
  const current = await api.status(query, payload, fileName);
  let remoteRequestId = current.responseData?.requestQueryId as string | undefined;
  if (current.status === "AVAILABLE") {
    remoteRequestId = remoteRequestId ?? "available";
  } else if (current.status === "EXECUTE" || current.status === "PENDING") {
    if (!remoteRequestId) throw new UpstreamError("Renault did not return requestQueryId");
    stopIfAborted(dependencies.signal);
    await dependencies.onStage("launching", { remoteRequestId });
    await api.launch(query, { ...payload, queryRequestId: remoteRequestId });
  } else if (current.status !== "INPROGRESS") {
    const statusMessage = String(current.responseData?.requestQueryStatusMsg ?? current.errorMessage ?? "");
    // ASMDOR can report a stale duplicate of a Labour export as a status error while History already has the file.
    if (unit.queryCode === "TM01" && /failed to get the status/i.test(statusMessage)) remoteRequestId = "available";
    else throw new UpstreamError(statusMessage || `Unexpected Renault status ${String(current.status)}`);
  }

  const history = await waitForHistory(api, remoteRequestId ?? "available", fileName, unit.queryCode, dependencies);
  stopIfAborted(dependencies.signal);
  await dependencies.onStage("presigned_url", { remoteRequestId, fileName });
  const urlResponse = await api.downloadUrl(downloadPath(String(history.filePath ?? query.queryDownloadPath)), fileName, unit.queryCode);
  const downloadUrl = urlResponse.responseData?.downloadUrl;
  if (typeof downloadUrl !== "string" || !downloadUrl) throw new UpstreamError("Renault did not return a download URL");
  stopIfAborted(dependencies.signal);
  await dependencies.onStage("downloading", { remoteRequestId, fileName });
  const downloaded = await api.download(downloadUrl);
  if (!downloaded.bytes.length) throw new UpstreamError("Renault returned an empty download");

  await dependencies.onStage("s3_upload", { fileName });
  const contentType = normalizeContentType(downloaded.contentType);
  const storedName = safeFileName(fileName);
  await store.putObject(store.objectKey(unit.path, storedName), downloaded.bytes, contentType);

  const remoteStatus = String(current.status ?? "UNKNOWN");
  const manifest = buildUnitManifest({
    input, requestId, unit: unit.unit, path: unit.path, startedAt, completedAt: now().toISOString(),
    details: {
      queryCode: unit.queryCode, queryDesc: query.queryDesc, fileName: storedName, contentType, size: downloaded.bytes.length,
      range: input.range, family: unit.family, format, language: language ?? null, publishedAfter: params.publishedAfter ?? null,
      remoteRequestId: remoteRequestId ?? "available", remoteStatus, profile: String(profile.value),
      ...(input.resource === "parts" ? { modelIds: input.modelIds, ...(context.families ? { families: context.families } : {}) } : {}),
    },
  });
  await store.putJson(store.objectKey(unit.path, manifestFileName(unit.unit)), manifest);
  return { fileName: storedName, reused: false, remoteStatus };
}
