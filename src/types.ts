export type LabourRequest = {
  family: string;
  format: string;
  language: string;
  range: string;
  publishedAfter?: string;
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
  error?: string;
  failureOperation?: string;
  failureCode?: string;
  failureStatus?: number;
  failureRequestId?: string;
  createdAt: string;
  updatedAt: string;
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
