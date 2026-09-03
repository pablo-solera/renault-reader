export type LabourRequest = {
  family: string;
  format: string;
  language: string;
  range: string;
  publishedAfter?: string;
};

export const PARTS_EXPORT_CODES = ["REF01", "REF02", "REF03", "REF04", "REF05", "PR03", "PR05", "PR06", "PR08"] as const;
export type PartsExportCode = typeof PARTS_EXPORT_CODES[number];

export type PartsRequest = {
  exportType: PartsExportCode;
  axCode?: string;
  epc?: string;
  manufacturer?: string;
  description?: string;
  edition?: string;
  modelIds?: string[];
  previousRequestId?: string;
  illustrationsRequestId?: string;
  treeRequestId?: string;
  family?: string;
  format?: string;
  language?: string;
  range: string;
  publishedAfter?: string;
};

export type ModelExtractionRequest = {
  axCode: string;
  epc?: string;
  edition: string;
  manufacturer: string;
  description: string;
  family: string;
  modelIds: string[];
  range: string;
  language?: string;
  format?: string;
  exports?: Partial<Record<PartsExportCode, boolean>>;
  resumeRequestId?: string;
  previousRequestId?: string;
  referenceRequestId?: string;
};

export type JobStatus = "queued" | "authenticating" | "discovering" | "validating" | "checking_remote" | "submitted" | "waiting" | "downloading" | "uploading" | "completed" | "failed";

export type JobState = {
  requestId: string;
  status: JobStatus;
  stage: string;
  progress: number | null;
  remoteRequestId?: string;
  fileName?: string;
  objectKey?: string;
  rawObjectKey?: string;
  structuredKey?: string;
  reportObjectKey?: string;
  error?: string;
  failureOperation?: string;
  failureCode?: string;
  failureStatus?: number;
  failureRequestId?: string;
  createdAt: string;
  updatedAt: string;
  children?: Record<string, { requestId: string; status?: JobStatus }>;
  excelObjectKey?: string;
  modelInput?: ModelExtractionRequest;
};

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
  additionalFilter?: boolean;
  currentDateRequired?: boolean;
  [key: string]: unknown;
};
