import { buildExtractionManifest, type ExtractionManifest } from "@pablosla/core-reader/contract/manifest";
import type { RequestInput } from "./request.js";

/** Renault-specific content of the manifest (`details`); the renault-transformer reads exactly these keys. */
export type UnitManifestDetails = {
  queryCode: string;
  queryDesc: string;
  fileName: string;
  contentType: string;
  size: number;
  range: string;
  family: string;
  format: string;
  language: string | null;
  publishedAfter: string | null;
  /** Id Renault gave the export request; `available` when Renault already had the file. */
  remoteRequestId: string;
  remoteStatus: string;
  profile: string;
  /** Parts only: the REF04 model ids the extraction was requested for. */
  modelIds?: string[];
  /** Parts only: families derived from REF04 and REF05 (PR08 and PR03 are requested once per family). */
  families?: string[];
};

export type UnitManifestInput = {
  input: RequestInput;
  requestId: string;
  unit: string;
  path: string;
  startedAt: string;
  completedAt: string;
  details: UnitManifestDetails;
};

/** Version 2 manifest written last in the unit folder: its presence means "unit complete". The raw archive is listed as the only file. */
export function buildUnitManifest(source: UnitManifestInput): ExtractionManifest {
  const { input, details } = source;
  return buildExtractionManifest({
    schemaVersion: 2,
    manufacturer: input.manufacturer,
    resource: input.resource === "labours" ? "labour" : "parts",
    unit: source.unit,
    path: source.path,
    date: input.date,
    requestId: source.requestId,
    ...(input.axCode ? { axCode: input.axCode } : {}),
    ...(input.edition ? { edition: input.edition } : {}),
    ...(input.language ? { language: input.language } : {}),
    dataVersion: null,
    startedAt: source.startedAt,
    completedAt: source.completedAt,
    durationMs: Math.max(0, Date.parse(source.completedAt) - Date.parse(source.startedAt)),
    files: [{ name: details.fileName, role: "export", unit: details.queryCode }],
    counts: { files: 1, bytes: details.size },
    details,
  });
}
