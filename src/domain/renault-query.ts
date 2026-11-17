export type Json = Record<string, any>;

/** One entry of the profile's query catalogue (`rest/v1/query/get/profile/...`); every value comes from the authenticated upstream. */
export type RenaultQuery = {
  id: string;
  queryCode: string;
  queryDesc: string;
  queryService: string;
  queryDownloadPath: string;
  domain?: string;
  familyFilter?: boolean;
  familyType?: "All" | "VEHICLE" | "POWERTRAIN" | string;
  language?: string[] | null;
  formatList?: Array<{ value: string; label?: string }>;
  contentFormat?: Array<{ value: string; label?: string }> | string[] | null;
  selectedContentFormat?: string;
  exportType?: string;
  additionalFilter?: boolean;
  currentDateRequired?: boolean;
  [key: string]: unknown;
};

export type ExportParams = {
  family: string;
  format: string;
  language?: string;
  range: string;
  publishedAfter?: string;
};

export function buildFileName(query: RenaultQuery, input: Pick<ExportParams, "family" | "format" | "language" | "publishedAfter">, profileValue: string): string {
  const source = query.queryDownloadPath.split("/").pop();
  if (!source) throw new Error(`${query.queryCode} queryDownloadPath has no file name`);
  const base = source.replace(/\.(tar\.gz|zip|json)$/i, "");
  const familyPart = query.familyFilter ? (input.family === "All" ? "All" : input.family) : "All";
  let name = `${base}_${familyPart}_${profileValue.toLowerCase()}`;
  if (query.language) name += `_${input.language ?? ""}`;
  if (input.publishedAfter) name += `_after${input.publishedAfter.replaceAll("-", "")}`;
  const suffix = input.format.startsWith(".") || input.format.startsWith("_") ? input.format : `.${input.format}`;
  return `${name}${suffix}`;
}

export function getPartnerFamilies(applicability: Json, query: RenaultQuery, range: string): Json[] {
  if (!["active", "old", "future"].includes(range)) throw new Error(`Unsupported range ${range}; use active, old or future`);
  const collection = query.familyType === "VEHICLE" ? "vehicleFamilyList" : query.familyType === "POWERTRAIN" ? "powertrainFamilyList" : query.familyType === "All" ? "allfamilyList" : null;
  if (!collection) throw new Error(`Unsupported ${query.queryCode ?? "export"} familyType ${String(query.familyType)}`);
  const source = applicability.responseData?.[collection];
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`Renault response has no ${collection} object`);
  if (!(range in source)) throw new Error(`${collection} has no ${range} range; available: ${Object.keys(source).join(", ") || "none"}`);
  const list = source[range];
  if (list === null) throw new Error(`${collection}.${range} is null`);
  if (!Array.isArray(list)) throw new Error(`${collection}.${range} is not an array`);
  if (list.length === 0) throw new Error(`${collection}.${range} is empty`);
  return list.filter(item => item && typeof item === "object").sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

export function getEditorFamilies(response: Json, query: RenaultQuery): Json[] {
  const list = response.responseData;
  if (!Array.isArray(list)) throw new Error(`Renault returned no non-confidential families for ${String(query.familyType)}`);
  if (list.length === 0) throw new Error(`Renault returned an empty non-confidential family list for ${String(query.familyType)}`);
  return list.filter(item => item && typeof item === "object").sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

export function buildExportPayload(query: RenaultQuery, profile: Json, input: ExportParams, selectedFamily?: Json): Json {
  const family = selectedFamily ?? (!query.familyFilter || input.family === "All" ? { value: "All", criteria: "All" } : { value: input.family, criteria: input.family });
  const contentFormat = typeof query.selectedContentFormat === "string"
    ? query.selectedContentFormat
    : Array.isArray(query.contentFormat)
      ? typeof query.contentFormat[0] === "string" ? query.contentFormat[0] : query.contentFormat[0]?.value ?? null
      : query.contentFormat ?? null;
  return {
    queryLabel: `${query.queryCode} - ${query.queryDesc}`,
    queryid: query.id,
    family: family.value,
    criteria: family.criteria,
    exportType: query.familyFilter ? (input.family === "All" ? "F" : "P") : (query.exportType ?? "F"),
    exportFormat: input.format,
    profile: String(profile.value).toLowerCase(),
    commercialName: profile.user,
    // ASMDOR rejects the literal "All" for powertrain families; Access falls back to the profile brands.
    brand: !family.brand || family.brand === "All" ? profile.brand : family.brand,
    applicabilityFilter: [],
    editorApplicabilityFilter: [],
    contentFormat,
    language: input.language ?? null,
    publishedDate: input.publishedAfter?.replaceAll("-", "") ?? "",
    countryCode: null,
    interpretModEvent: profile.interpretModEvent,
    userFilterId: null,
    range: input.range,
    role: null,
    ecu: null,
  };
}

/** A completed export row of the History, which is when the file can be downloaded. */
export const isHistoryDownloadable = (row: Json) => row.exportStatus === "Completed" || row.exportStatus === "Unlocked";

/** ASMDOR reports `rest/s3/get/downloadURL` paths with a `biz/` prefix and a trailing slash that the request must not repeat. */
export function downloadPath(rawPath: string): string {
  return rawPath.endsWith("/") ? rawPath.slice(0, -1).replace("biz/", "") : rawPath.replace("biz/", "");
}
