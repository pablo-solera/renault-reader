import type { Artifact, CreateRequest, RequestState, RequestSummary } from "@pablosla/core-reader/contract/v1";
import { manifestFileName } from "@pablosla/core-reader/contract/manifest";
import type { RenaultRequestState } from "../../domain/request.js";

export type ObjectLocator = { objectKey(...parts: string[]): string; bucket: string };

/** Rebuilds the original create request from the persisted state. */
function renaultRequestFrom(state: RenaultRequestState): CreateRequest {
  const { input } = state;
  const common = { manufacturer: input.manufacturer, ...(input.axCode ? { axCode: input.axCode } : {}), ...(input.edition ? { edition: input.edition } : {}), ...(input.language ? { language: input.language } : {}) };
  if (input.resource === "labours") return { ...common, selection: { family: input.family, format: input.format, range: input.range, ...(input.publishedAfter ? { publishedAfter: input.publishedAfter } : {}) } };
  return { ...common, selection: { description: input.description, family: input.family, modelIds: input.modelIds, range: input.range, ...(input.format ? { format: input.format } : {}), ...(input.exports ? { exports: input.exports } : {}) } };
}

function contentTypeOf(fileName: string) {
  if (/\.zip$/i.test(fileName)) return "application/zip";
  if (/\.(tar\.gz|tgz|gz)$/i.test(fileName)) return "application/gzip";
  if (/\.json$/i.test(fileName)) return "application/json";
  return "application/octet-stream";
}

/**
 * Each unit contributes its folder (a prefix, not downloadable) and, once stored, the raw export and its manifest.
 * A labour request has a single unit, so its raw export is the primary artifact; parts have many, so none is.
 */
export function requestArtifacts(state: RenaultRequestState, locator: ObjectLocator): Artifact[] {
  return state.units.flatMap(unit => {
    const artifacts: Artifact[] = [{ name: unit.unit, kind: "prefix", primary: false, location: { bucket: locator.bucket, key: locator.objectKey(unit.path) } }];
    if (unit.status === "completed" && unit.fileName) {
      artifacts.push(
        { name: unit.fileName, kind: "file", contentType: contentTypeOf(unit.fileName), primary: state.resource === "labours", location: { bucket: locator.bucket, key: locator.objectKey(unit.path, unit.fileName) } },
        { name: manifestFileName(unit.unit), kind: "file", contentType: "application/json", primary: false, location: { bucket: locator.bucket, key: locator.objectKey(unit.path, manifestFileName(unit.unit)) } },
      );
    }
    return artifacts;
  });
}

const errorOf = (state: RenaultRequestState) => state.error && state.status !== "completed" && state.status !== "cancelled" ? { code: state.errorCode ?? "INTERNAL_ERROR", message: state.error } : null;

function common(state: RenaultRequestState) {
  return {
    requestId: state.requestId,
    resource: state.resource,
    reader: "renault",
    status: state.status,
    stage: state.stage,
    progress: state.progress,
    request: renaultRequestFrom(state),
    error: errorOf(state),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.status === "completed" ? state.updatedAt : null,
  };
}

export type StateDetails = { worker?: unknown; stalled?: boolean };

export function toRequestState(state: RenaultRequestState, locator: ObjectLocator, extra: StateDetails = {}): RequestState {
  return { ...common(state), artifacts: requestArtifacts(state, locator), details: { units: state.units, families: state.families ?? null, familiesPending: state.familiesPending, ...extra } };
}

export function toRequestSummary(state: RenaultRequestState, locator: ObjectLocator): RequestSummary {
  return { ...common(state), artifactCount: requestArtifacts(state, locator).length };
}
